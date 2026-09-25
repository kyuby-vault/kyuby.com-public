/** Mandatory WebGPU admission. No model fetches, persistent writes or CPU EP.
 * A successful small device probe is NOT proof that the model fits in memory.
 */
export type WebGpuAdmissionCode = 'gpu-insecure-context' | 'gpu-api-unavailable'
  | 'gpu-adapter-unavailable' | 'gpu-feature-unavailable' | 'gpu-device-unavailable' | 'gpu-check-interrupted';

export const WEBGPU_ADMISSION_COPY: Record<WebGpuAdmissionCode, string> = {
  'gpu-insecure-context': 'WebGPU requires a secure connection. No model download was started.',
  'gpu-api-unavailable': 'This browser does not expose WebGPU. No model download was started.',
  'gpu-adapter-unavailable': 'The browser could not provide a GPU. Your saved model and conversations are unchanged.',
  'gpu-feature-unavailable': 'This GPU does not provide the features required by this model. No model download was started.',
  'gpu-device-unavailable': 'The browser could not initialize the GPU. Your saved files are unchanged. Close other GPU workloads and retry.',
  'gpu-check-interrupted': 'The GPU check did not finish. Return to this tab and retry. Your saved files are unchanged.',
};

export class WebGpuAdmissionError extends Error {
  constructor(readonly code: WebGpuAdmissionCode) { super(WEBGPU_ADMISSION_COPY[code]); this.name = 'WebGpuAdmissionError'; }
}

// Structural API subsets keep this module usable in Window and DedicatedWorker.
export interface AdmissionDevice {
  destroy(): void;
  limits: { maxBufferSize: number; maxStorageBufferBindingSize: number };
}
export interface AdmissionAdapter {
  features: { has(feature: string): boolean };
  limits: { maxBufferSize: number; maxStorageBufferBindingSize: number };
  requestDevice(descriptor: { requiredFeatures: string[] }): Promise<AdmissionDevice>;
}
export interface AdmissionGpu { requestAdapter(): Promise<AdmissionAdapter | null> }
export interface WebGpuAdmission {
  status: 'available';
  requiredFeatures: string[];
  adapterLimits: { maxBufferSize: number; maxStorageBufferBindingSize: number };
  probeDeviceLimits: { maxBufferSize: number; maxStorageBufferBindingSize: number };
}

export async function requireWebGpu(options: {
  gpu?: AdmissionGpu;
  secure?: boolean;
  requiredFeatures?: readonly string[];
  timeoutMs?: number;
} = {}): Promise<WebGpuAdmission> {
  const secure = options.secure ?? globalThis.isSecureContext;
  if (!secure) throw new WebGpuAdmissionError('gpu-insecure-context');
  const gpu = options.gpu ?? (typeof navigator === 'undefined' ? undefined
    : (navigator as unknown as { gpu?: AdmissionGpu }).gpu);
  if (!gpu) throw new WebGpuAdmissionError('gpu-api-unavailable');
  const requiredFeatures = [...(options.requiredFeatures ?? ['shader-f16'])];
  const timeoutMs = options.timeoutMs ?? 8_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid GPU probe deadline.');
  let expired = false;
  let device: AdmissionDevice | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async (): Promise<WebGpuAdmission> => {
    let adapter: AdmissionAdapter | null;
    try { adapter = await gpu.requestAdapter(); }
    catch { throw new WebGpuAdmissionError('gpu-adapter-unavailable'); }
    if (expired) throw new WebGpuAdmissionError('gpu-check-interrupted');
    if (!adapter) throw new WebGpuAdmissionError('gpu-adapter-unavailable');
    if (requiredFeatures.some(feature => !adapter!.features.has(feature))) throw new WebGpuAdmissionError('gpu-feature-unavailable');
    try { device = await adapter.requestDevice({ requiredFeatures }); }
    catch { throw new WebGpuAdmissionError('gpu-device-unavailable'); }
    try {
      if (expired) throw new WebGpuAdmissionError('gpu-check-interrupted');
      return { status: 'available', requiredFeatures,
        adapterLimits: { maxBufferSize: adapter.limits.maxBufferSize,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
        probeDeviceLimits: { maxBufferSize: device.limits.maxBufferSize,
          maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize } };
    } finally { device.destroy(); device = undefined; }
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new WebGpuAdmissionError('gpu-check-interrupted')); }, timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // A requestDevice resolving after timeout is destroyed in work().
  }
}
