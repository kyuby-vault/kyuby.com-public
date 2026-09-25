/// <reference lib="webworker" />

import * as transformers from '@huggingface/transformers';
import { requireWebGpu } from '../lib/eva/webgpu-admission';
import { deriveEvaBudgets, generationFinishReason, generationTokenBudget, isEvaKvAllowance, probeEvaDevice } from '../lib/eva/generation-budget';
import { tokenTail } from '../lib/eva/continuation';
import { estimateContextTokens } from '../lib/eva/context-manager';
import { createEvaModelBaseUrl, createEvaModelLoadOptions } from '../lib/eva/manifest';
import { MODEL_CACHE_PROTOCOL_VERSION } from '../lib/eva/model-cache/protocol';
import {
  EVA_WORKER_PROTOCOL_VERSION,
  type EvaFunctionToolDefinition,
  type EvaModelMessage,
  type EvaWorkerRequest,
  type EvaWorkerResponse,
  type EvaWorkerState,
} from '../lib/eva/worker-protocol';

const {
  AutoModelForCausalLM,
  AutoTokenizer,
  InterruptableStoppingCriteria,
  PreTrainedTokenizer,
  TextStreamer,
  env,
} = transformers;

const workerScope = self as DedicatedWorkerGlobalScope;
const stoppingCriteria = new InterruptableStoppingCriteria();
const CACHE_MESSAGE_TIMEOUT_MS = 5_000;
const PINNED_ORT_WASM_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/';

type LoadedTokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type LoadedModel = Awaited<ReturnType<typeof AutoModelForCausalLM.from_pretrained>>;
type BatchDecodeInput = Parameters<LoadedTokenizer['batch_decode']>[0];
type TokenizedInputs = Record<string, unknown> & { input_ids?: unknown };

let tokenizer: LoadedTokenizer | null = null;
let model: LoadedModel | null = null;
let state: EvaWorkerState = 'idle';
let activeGenerationRequestId: string | null = null;
let modelCacheFixtureLoaded = false;
let budgets = deriveEvaBudgets();
let generationCancelled = false;

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;

if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.numThreads = 1;
  // Let this exact runtime build select its matching WASM/glue flavor.
  env.backends.onnx.wasm.wasmPaths = PINNED_ORT_WASM_BASE;
}

function post(response: EvaWorkerResponse): void {
  workerScope.postMessage(response);
}

function setState(requestId: string, nextState: EvaWorkerState): void {
  state = nextState;
  post({
    protocolVersion: EVA_WORKER_PROTOCOL_VERSION,
    type: 'state',
    requestId,
    state,
  });
}

function postError(
  requestId: string,
  code: Extract<EvaWorkerResponse, { type: 'error' }>['code'],
  error: unknown,
  recoverable: boolean,
): void {
  post({
    protocolVersion: EVA_WORKER_PROTOCOL_VERSION,
    type: 'error',
    requestId,
    code,
    message: error instanceof Error ? error.message : String(error),
    recoverable,
    ...(code === 'GENERATION_FAILED' ? { finishReason: 'error' as const } : {}),
  });
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}.`);
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${url} did not contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

async function postCacheMessage(message: Record<string, unknown>): Promise<boolean> {
  const serviceWorker = (navigator as WorkerNavigator & {
    serviceWorker?: { controller: ServiceWorker | null };
  }).serviceWorker;
  const controller = serviceWorker?.controller;
  if (!controller) {
    return false;
  }

  const channel = new MessageChannel();
  return new Promise<boolean>((resolve) => {
    const timeout = globalThis.setTimeout(() => {
      channel.port1.close();
      resolve(false);
    }, CACHE_MESSAGE_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      globalThis.clearTimeout(timeout);
      channel.port1.close();
      const value = event.data as { ok?: unknown; type?: unknown } | null;
      resolve(Boolean(value?.ok) || value?.type === 'STATUS');
    };
    controller.postMessage(message, [channel.port2]);
  });
}

async function claimCacheLoad(config: Extract<EvaWorkerRequest, { type: 'load' }>['config']): Promise<boolean> {
  if (!config.cacheLeaseNonce || !config.manifest.cacheInventory) {
    return false;
  }
  const modelUrl = new URL(createEvaModelBaseUrl(config.modelHost, config.modelId));
  return postCacheMessage({
    protocolVersion: MODEL_CACHE_PROTOCOL_VERSION,
    type: 'CLAIM_LOAD',
    requestId: crypto.randomUUID(),
    modelOrigin: modelUrl.origin,
    modelRootPath: `${modelUrl.pathname}/`,
    manifestVersion: config.manifestVersion,
    nonce: config.cacheLeaseNonce,
  });
}

async function loadModelCacheFixture(
  request: Extract<EvaWorkerRequest, { type: 'load' }>,
  baseUrl: string,
): Promise<void> {
  if (!import.meta.env.DEV || request.config.testFixture !== 'model-cache') {
    throw new Error('Eva model cache fixture is available only in development tests.');
  }
  const files = request.config.manifest.cacheInventory?.files.filter((file) => file.present) ?? [];
  if (files.length === 0) {
    throw new Error('Eva model cache fixture requires a complete v2 inventory.');
  }

  let completed = 0;
  for (const file of files) {
    const response = await fetch(`${baseUrl}/${file.path}`, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`Eva fixture ${file.path} returned ${response.status}.`);
    }
    await response.arrayBuffer();
    completed += 1;
    post({
      protocolVersion: EVA_WORKER_PROTOCOL_VERSION,
      type: 'progress',
      requestId: request.requestId,
      file: file.path,
      loaded: completed,
      total: files.length,
      progress: (completed / files.length) * 100,
      status: 'loading',
    });
  }
}

async function createTokenizerFallback(baseUrl: string): Promise<LoadedTokenizer> {
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    fetchJson(`${baseUrl}/tokenizer.json`),
    fetchJson(`${baseUrl}/tokenizer_config.json`),
  ]);
  const configuredClass = typeof tokenizerConfig.tokenizer_class === 'string'
    ? tokenizerConfig.tokenizer_class.replace(/Fast$/, '')
    : 'PreTrainedTokenizer';
  const availableTransformers = transformers as unknown as Record<string, unknown>;
  const TokenizerClass = availableTransformers[configuredClass] ?? PreTrainedTokenizer;
  const Constructor = TokenizerClass as new (
    tokenizerJSON: Record<string, unknown>,
    tokenizerConfig: Record<string, unknown>,
  ) => LoadedTokenizer;
  return new Constructor(tokenizerJson, tokenizerConfig);
}

function normalizeProgress(progress: unknown): Omit<Extract<EvaWorkerResponse, { type: 'progress' }>,
  'protocolVersion' | 'type' | 'requestId'> {
  const value = progress && typeof progress === 'object'
    ? progress as Record<string, unknown>
    : {};
  return {
    file: typeof value.file === 'string' ? value.file : null,
    loaded: typeof value.loaded === 'number' ? value.loaded : null,
    total: typeof value.total === 'number' ? value.total : null,
    progress: typeof value.progress === 'number' ? value.progress : null,
    status: typeof value.status === 'string' ? value.status : 'loading',
  };
}

async function disposeModel(): Promise<void> {
  stoppingCriteria.interrupt();
  if (model && typeof model.dispose === 'function') {
    await model.dispose();
  }
  tokenizer = null;
  model = null;
  modelCacheFixtureLoaded = false;
  budgets = deriveEvaBudgets();
  activeGenerationRequestId = null;
}

async function loadModel(request: Extract<EvaWorkerRequest, { type: 'load' }>): Promise<void> {
  if (request.config.testFixture !== 'model-cache') await requireWebGpu();

  await disposeModel();
  setState(request.requestId, 'loading');

  const host = new URL(request.config.modelHost).origin;
  const baseUrl = createEvaModelBaseUrl(host, request.config.modelId);
  env.localModelPath = `${host}/`;
  await claimCacheLoad(request.config);
  const loadOptions = createEvaModelLoadOptions(request.config.manifest);
  const progressCallback = (value: unknown) => {
    post({
      protocolVersion: EVA_WORKER_PROTOCOL_VERSION,
      type: 'progress',
      requestId: request.requestId,
      ...normalizeProgress(value),
    });
  };

  try {
    if (request.config.testFixture === 'model-cache') {
      await loadModelCacheFixture(request, baseUrl);
      modelCacheFixtureLoaded = true;
      setState(request.requestId, 'ready');
      return;
    }

    try {
      tokenizer = await AutoTokenizer.from_pretrained(request.config.modelId, {
        progress_callback: progressCallback,
      });
    } catch {
      tokenizer = await createTokenizerFallback(baseUrl);
    }

    model = await AutoModelForCausalLM.from_pretrained(request.config.modelId, {
      ...loadOptions,
      progress_callback: progressCallback,
    });
    // Reuse the config already fetched/validated by the model loader: no extra upstream request.
    const loaded = model as unknown as { config: Record<string, unknown>; generation_config?: Record<string, unknown> };
    budgets = deriveEvaBudgets(loaded.config, await probeEvaDevice(request.config.pageHeapHeadroom), loaded.generation_config ?? {}, request.config.kvAllowance);
    post({ protocolVersion: EVA_WORKER_PROTOCOL_VERSION, type: 'budgets', requestId: request.requestId, budgets });
    setState(request.requestId, 'ready');
  } catch (error) {
    throw error;
  }
}

function foldSystemPrompt(messages: EvaModelMessage[]): EvaModelMessage[] {
  const systemText = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n');
  if (!systemText) {
    return messages;
  }

  const remaining = messages.filter((message) => message.role !== 'system');
  const firstUserIndex = remaining.findIndex((message) => message.role === 'user');
  if (firstUserIndex < 0) {
    return [{ role: 'user', content: `System:\n${systemText}` }, ...remaining];
  }
  return remaining.map((message, index) => index === firstUserIndex
    ? { ...message, content: `System:\n${systemText}\n\nUser:\n${message.content}` }
    : message);
}

function plainPrompt(messages: EvaModelMessage[]): string {
  const content = messages.map((message) => {
    if (message.role === 'tool') {
      return `Tool ${message.name ?? ''}: ${message.content}`;
    }
    const label = message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : 'User';
    return `${label}: ${message.content}`;
  }).join('\n\n');
  return `${content}\n\nAssistant:`;
}

function createInputs(messages: EvaModelMessage[], tools: EvaFunctionToolDefinition[]): TokenizedInputs {
  if (!tokenizer) {
    throw new Error('Eva tokenizer is not loaded.');
  }

  if (typeof tokenizer.apply_chat_template === 'function' && tokenizer.chat_template) {
    try {
      return tokenizer.apply_chat_template(messages, {
        tools,
        add_generation_prompt: true,
        return_dict: true,
      }) as TokenizedInputs;
    } catch {
      return tokenizer.apply_chat_template(foldSystemPrompt(messages), {
        tools,
        add_generation_prompt: true,
        return_dict: true,
      }) as TokenizedInputs;
    }
  }

  return tokenizer(plainPrompt(messages)) as TokenizedInputs;
}

function estimateTokenCount(inputIds: unknown): number | null {
  if (!inputIds || typeof inputIds !== 'object') {
    return Array.isArray(inputIds) ? inputIds.length : null;
  }
  const value = inputIds as { dims?: unknown; size?: unknown; data?: unknown };
  if (Array.isArray(value.dims) && typeof value.dims.at(-1) === 'number') {
    return value.dims.at(-1) as number;
  }
  if (typeof value.size === 'number') {
    return value.size;
  }
  if (value.data && typeof value.data === 'object' && 'length' in value.data
    && typeof value.data.length === 'number') {
    return value.data.length;
  }
  return null;
}

function firstDecodedText(value: unknown): string {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : String(value[0] ?? '');
  }
  return typeof value === 'string' ? value : String(value ?? '');
}

async function generate(request: Extract<EvaWorkerRequest, { type: 'generate' }>): Promise<void> {
  if (modelCacheFixtureLoaded && state === 'ready' && import.meta.env.DEV) {
    const startedAt = performance.now();
    const prompt = [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const text = `Fixture response: ${prompt}`;
    setState(request.requestId, 'generating');
    post({
      protocolVersion: EVA_WORKER_PROTOCOL_VERSION,
      type: 'token',
      requestId: request.requestId,
      text,
    });
    post({
      protocolVersion: EVA_WORKER_PROTOCOL_VERSION,
      type: 'done',
      requestId: request.requestId,
      text,
      inputTokens: Math.ceil(prompt.length / 4),
      generatedTokens: Math.ceil(text.length / 4),
      elapsedMs: Math.round(performance.now() - startedAt),
      finishReason: 'stop', cancelled: false, tokenLimit: budgets.maxNewTokens,
    });
    setState(request.requestId, 'ready');
    return;
  }

  if (!model || !tokenizer || state !== 'ready') {
    postError(request.requestId, 'NOT_READY', 'Load Eva before sending a message.', true);
    return;
  }

  const startedAt = performance.now();
  activeGenerationRequestId = request.requestId;
  stoppingCriteria.reset();
  generationCancelled = false;
  setState(request.requestId, 'generating');

  try {
    const inputs = createInputs(request.messages, request.tools);
    const inputTokens = estimateTokenCount(inputs.input_ids);
    if (inputTokens === null) throw new Error('Cannot safely determine the input token count.');
    // The worker owns the cap; a caller cannot enlarge the loaded model's budget.
    const tokenLimit = generationTokenBudget(budgets, inputTokens, request.options.maxNewTokens);

    let streamedText = '';
    let generatedTokens = 0;
    let lastToken: number | null = null;
    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      token_callback_function: (tokens: bigint[]) => {
        generatedTokens += tokens.length;
        if (tokens.length) lastToken = Number(tokens.at(-1));
      },
      callback_function: (chunk: string) => {
        streamedText += chunk;
        post({
          protocolVersion: EVA_WORKER_PROTOCOL_VERSION,
          type: 'token',
          requestId: request.requestId,
          text: streamedText,
        });
      },
    });

    const output = await model.generate({
      ...inputs,
      max_new_tokens: tokenLimit,
      max_length: inputTokens + tokenLimit,
      do_sample: request.options.temperature > 0,
      temperature: request.options.temperature,
      top_p: 0.95,
      repetition_penalty: 1.05,
      return_dict_in_generate: true,
      streamer,
      stopping_criteria: [stoppingCriteria],
    });

    const outputRecord = output as unknown as { sequences?: unknown };
    const sequences = outputRecord.sequences ?? output;
    let text = streamedText;
    if (!text) {
      const decoded = firstDecodedText(tokenizer.batch_decode(sequences as BatchDecodeInput, {
        skip_special_tokens: true,
      }));
      const decodedPrompt = firstDecodedText(tokenizer.batch_decode(inputs.input_ids as BatchDecodeInput, {
        skip_special_tokens: true,
      }));
      text = decoded.startsWith(decodedPrompt) ? decoded.slice(decodedPrompt.length).trim() : decoded.trim();
    }
    const sequenceTokens = estimateTokenCount(sequences);
    generatedTokens = sequenceTokens !== null ? Math.max(0, sequenceTokens - inputTokens) : generatedTokens;
    const loaded = model as unknown as { config: { eos_token_id?: unknown }; generation_config?: { eos_token_id?: unknown } };
    const eosValue = loaded.generation_config?.eos_token_id ?? loaded.config.eos_token_id ?? tokenizer.eos_token_id;
    const eos = (Array.isArray(eosValue) ? eosValue : [eosValue]).filter((token): token is number => typeof token === 'number');

    post({
      protocolVersion: EVA_WORKER_PROTOCOL_VERSION,
      type: 'done',
      requestId: request.requestId,
      text,
      inputTokens,
      generatedTokens,
      finishReason: generationFinishReason(generationCancelled, lastToken, eos, generatedTokens, tokenLimit),
      cancelled: generationCancelled,
      tokenLimit,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    setState(request.requestId, 'ready');
  } catch (error) {
    setState(request.requestId, 'error');
    postError(request.requestId, 'GENERATION_FAILED', error, true);
    setState(request.requestId, 'ready');
  } finally {
    activeGenerationRequestId = null;
  }
}

workerScope.addEventListener('message', (event: MessageEvent<EvaWorkerRequest>) => {
  const request = event.data;
  if (!request || request.protocolVersion !== EVA_WORKER_PROTOCOL_VERSION || typeof request.requestId !== 'string') {
    postError('unknown', 'BAD_REQUEST', 'Unsupported Eva worker request.', false);
    return;
  }

  if (request.type === 'measure' || request.type === 'tail' || request.type === 'set-budget') {
    try {
      if (import.meta.env.DEV && modelCacheFixtureLoaded && state === 'ready') {
        if (request.type === 'measure') {
          post({ protocolVersion: EVA_WORKER_PROTOCOL_VERSION, type: 'measured', requestId: request.requestId,
            inputTokens: estimateContextTokens(request.messages) + (request.tools.length ? new TextEncoder().encode(JSON.stringify(request.tools)).length : 0) });
        } else if (request.type === 'tail') {
          post({ protocolVersion: EVA_WORKER_PROTOCOL_VERSION, type: 'text-window', requestId: request.requestId,
            window: tokenTail(request.text, (text) => Array.from(text).map((char) => char.codePointAt(0)!), (tokens) => String.fromCodePoint(...tokens)) });
        } else {
          budgets = deriveEvaBudgets({}, undefined, {}, request.allowance);
          post({ protocolVersion: EVA_WORKER_PROTOCOL_VERSION, type: 'budgets', requestId: request.requestId, budgets });
        }
        return;
      }
      if (state !== 'ready' || !model || !tokenizer) throw new Error('Load Eva and wait for the current generation to finish first.');
      if (request.type === 'measure') {
        const inputTokens = estimateTokenCount(createInputs(request.messages, request.tools).input_ids);
        if (inputTokens === null) throw new Error('Tokenizer could not measure this prompt.');
        post({ protocolVersion: EVA_WORKER_PROTOCOL_VERSION, type: 'measured', requestId: request.requestId, inputTokens });
      } else if (request.type === 'tail') {
        const window = tokenTail(request.text, (text) => tokenizer!.encode(text, { add_special_tokens: false }),
          (tokens) => tokenizer!.decode(tokens, { skip_special_tokens: true }));
        post({ protocolVersion: EVA_WORKER_PROTOCOL_VERSION, type: 'text-window', requestId: request.requestId, window });
      } else {
        if (!isEvaKvAllowance(request.allowance)) throw new Error('Unknown KV allowance.');
        const loaded = model as unknown as { config: Record<string, unknown>; generation_config?: Record<string, unknown> };
        budgets = deriveEvaBudgets(loaded.config, budgets.probe, loaded.generation_config ?? {}, request.allowance);
        post({ protocolVersion: EVA_WORKER_PROTOCOL_VERSION, type: 'budgets', requestId: request.requestId, budgets });
      }
    } catch (error) { postError(request.requestId, 'BAD_REQUEST', error, true); }
  } else if (request.type === 'load') {
    void loadModel(request).catch((error) => {
      setState(request.requestId, 'error');
      postError(request.requestId, 'LOAD_FAILED', error, true);
    });
  } else if (request.type === 'generate') {
    void generate(request);
  } else if (request.type === 'cancel') {
    if (activeGenerationRequestId) {
      generationCancelled = true;
      stoppingCriteria.interrupt();
    }
  } else if (request.type === 'dispose') {
    void disposeModel()
      .then(() => setState(request.requestId, 'disposed'))
      .catch((error) => postError(request.requestId, 'LOAD_FAILED', error, false));
  }
});
