const MiB = 1024 * 1024;
const MAX_CONTEXT = 131_072;
export const MAX_GENERATED_TOKENS = 4096;
export const MAX_CONTINUATIONS = 3;
export const EVA_KV_ALLOWANCES = { conservative: 1024 * MiB, balanced: 1536 * MiB, max: 2048 * MiB } as const;
export type EvaKvAllowance = keyof typeof EVA_KV_ALLOWANCES;
export function isEvaKvAllowance(value: unknown): value is EvaKvAllowance {
  return value === 'conservative' || value === 'balanced' || value === 'max';
}

export interface EvaDeviceProbe {
  maxBufferSize: number | null;
  maxStorageBufferBindingSize: number | null;
  storageUsage: number | null;
  storageQuota: number | null;
  heapHeadroom: number | null;
}

export interface EvaBudgets {
  source: 'model-device' | 'conservative-defaults';
  configMax: number | null;
  slidingWindow: number | null;
  layers: number | null;
  kvHeads: number | null;
  headDim: number | null;
  kvBytesPerToken: number | null;
  kvBudgetBytes: number | null;
  deviceCeiling: number | null;
  contextLength: number;
  maxNewTokens: number;
  probe: EvaDeviceProbe;
  explanation: string;
}

export const EMPTY_DEVICE_PROBE: EvaDeviceProbe = {
  maxBufferSize: null, maxStorageBufferBindingSize: null,
  storageUsage: null, storageQuota: null, heapHeadroom: null,
};

function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : null;
}

/** Allocation limits are not free VRAM. This is a bounded admission heuristic. */
export function deriveEvaBudgets(
  config: Record<string, unknown> = {},
  probe: EvaDeviceProbe = { ...EMPTY_DEVICE_PROBE },
  generationConfig: Record<string, unknown> = {},
  allowance: EvaKvAllowance = 'conservative',
): EvaBudgets {
  if (!isEvaKvAllowance(allowance)) throw new Error('Unknown KV allowance.');
  const configMax = positive(config.max_position_embeddings, 16_777_216);
  const slidingWindow = positive(config.sliding_window, 16_777_216);
  const effectiveMax = configMax === null ? null : Math.min(configMax,
    config.use_sliding_window !== false && slidingWindow !== null ? slidingWindow : configMax);
  const layers = positive(config.num_hidden_layers, 1024);
  const kvHeads = positive(config.num_key_value_heads, 1024);
  const headDim = positive(config.head_dim, 4096);
  const kvBytesPerToken = layers && kvHeads && headDim ? 2 * kvHeads * headDim * 2 * layers : null;
  const result: EvaBudgets = {
    source: 'conservative-defaults', configMax, slidingWindow, layers, kvHeads, headDim,
    kvBytesPerToken, kvBudgetBytes: null, deviceCeiling: null,
    contextLength: Math.min(effectiveMax ?? 8192, 8192), maxNewTokens: 640, probe,
    explanation: `Conservative defaults: model architecture or required device/storage probe unavailable. Requested KV policy: ${allowance}.`,
  };
  result.maxNewTokens = Math.min(640, Math.max(1, result.contextLength - 1));
  if (!effectiveMax || !kvBytesPerToken || !positive(probe.maxBufferSize)
    || !positive(probe.maxStorageBufferBindingSize) || !positive(probe.storageQuota)
    || probe.storageUsage === null || !Number.isSafeInteger(probe.storageUsage) || probe.storageUsage < 0) return result;

  // Reserve half the reported allocation limit, with a 2 GiB KV policy ceiling.
  // Optional JS-heap headroom can only lower this estimate. Disk quota is never RAM.
  const kvBudgetBytes = Math.floor(Math.min(probe.maxBufferSize! / 2, EVA_KV_ALLOWANCES[allowance],
    probe.heapHeadroom !== null && Number.isSafeInteger(probe.heapHeadroom) && probe.heapHeadroom >= 0
      ? probe.heapHeadroom / 2 : Infinity));
  const perLayerTensorBytes = kvBytesPerToken / (2 * layers!);
  const deviceCeiling = Math.floor(Math.min(kvBudgetBytes / kvBytesPerToken,
    probe.maxStorageBufferBindingSize! / perLayerTensorBytes, MAX_CONTEXT));
  const contextLength = Math.min(effectiveMax, deviceCeiling);
  if (contextLength < 2) throw new Error('Device limits leave no safe room for Eva context.');
  const sensibleMax = positive(generationConfig.max_new_tokens)
    ?? Math.max(1, Math.floor(contextLength / 4));
  return {
    ...result, source: 'model-device', kvBudgetBytes, deviceCeiling, contextLength,
    maxNewTokens: Math.min(sensibleMax, MAX_GENERATED_TOKENS, contextLength - 1),
    explanation: `KV policy: ${allowance} (${(EVA_KV_ALLOWANCES[allowance] / (1024 * MiB)).toFixed(2)} GiB requested); capped by half adapter buffer limit, per-tensor binding limit and optional half JS-heap headroom. fp16 KV estimate, not free VRAM. Storage quota is disk only.`,
  };
}

export function generationTokenBudget(budget: EvaBudgets, inputTokens: number, override?: number): number {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new Error('Input token count is unavailable.');
  if (override !== undefined && (!Number.isSafeInteger(override) || override < 1 || override > MAX_GENERATED_TOKENS)) {
    throw new Error('Token override must be between 1 and 4096.');
  }
  const remaining = budget.contextLength - inputTokens;
  if (remaining < 1) throw new Error(`Context is full (${inputTokens}/${budget.contextLength} tokens). Start a new conversation or shorten context.`);
  return Math.min(budget.maxNewTokens, remaining, override ?? budget.maxNewTokens);
}

export function heapHeadroom(): number | null {
  const memory = (performance as Performance & { memory?: { jsHeapSizeLimit?: number; usedJSHeapSize?: number } }).memory;
  return positive(memory?.jsHeapSizeLimit) && typeof memory?.usedJSHeapSize === 'number'
    ? Math.max(0, Math.floor(memory.jsHeapSizeLimit! - memory.usedJSHeapSize)) : null;
}

export async function probeEvaDevice(pageHeapHeadroom?: number | null): Promise<EvaDeviceProbe> {
  const probe = { ...EMPTY_DEVICE_PROBE, heapHeadroom: heapHeadroom() ?? pageHeapHeadroom ?? null };
  // Bound probes: neither permission prompts nor a new GPUDevice/allocation is needed.
  const work = async () => {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ limits: { maxBufferSize: number; maxStorageBufferBindingSize: number } } | null> } }).gpu;
      const adapter = await gpu?.requestAdapter();
      probe.maxBufferSize = adapter?.limits.maxBufferSize ?? null;
      probe.maxStorageBufferBindingSize = adapter?.limits.maxStorageBufferBindingSize ?? null;
      const storage = await navigator.storage?.estimate();
      probe.storageQuota = storage?.quota ?? null;
      probe.storageUsage = storage?.usage ?? null;
    } catch { /* Explicitly labeled conservative fallback. */ }
    return { ...probe };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<EvaDeviceProbe>((resolve) => {
      timer = setTimeout(() => resolve({ ...EMPTY_DEVICE_PROBE, heapHeadroom: probe.heapHeadroom }), 3000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function generationFinishReason(cancelled: boolean, lastToken: number | null, eos: number[], generated: number, limit: number): 'length' | 'stop' {
  if (cancelled || (lastToken !== null && eos.includes(lastToken))) return 'stop';
  return generated >= limit ? 'length' : 'stop';
}

export function isEvaBudgets(value: unknown): value is EvaBudgets {
  if (!value || typeof value !== 'object') return false;
  const item = value as EvaBudgets;
  return (item.source === 'model-device' || item.source === 'conservative-defaults')
    && positive(item.contextLength, MAX_CONTEXT) !== null
    && positive(item.maxNewTokens, MAX_GENERATED_TOKENS) !== null
    && typeof item.explanation === 'string' && item.explanation.length < 1024
    && !!item.probe && typeof item.probe === 'object'
    && ['configMax', 'slidingWindow', 'layers', 'kvHeads', 'headDim', 'kvBytesPerToken', 'kvBudgetBytes', 'deviceCeiling']
      .every((key) => (item as unknown as Record<string, unknown>)[key] === null
        || positive((item as unknown as Record<string, unknown>)[key]) !== null)
    && Object.keys(EMPTY_DEVICE_PROBE).every((key) => {
      const entry = (item.probe as unknown as Record<string, unknown>)[key];
      return entry === null || (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0);
    });
}
