import {
  createEvaManifestUrl,
  createEvaModelBaseUrl,
  MAX_EVA_MANIFEST_BYTES,
  normalizeEvaModelHost,
  parseEvaArtifactManifest,
  validateEvaModelId,
} from './manifest';
import {
  createModelCacheManifestIdentity,
} from './model-cache/manifest';
import type { EvaModelConfig } from './worker-protocol';

export {
  createModelCacheManifestIdentity as createManifestIdentity,
  normalizeStrongModelCacheEtag as normalizeStrongEtag,
} from './model-cache/manifest';

export const DEFAULT_EVA_MODEL_HOST = 'https://models.kyuby.com';
export const DEFAULT_EVA_MODEL_ID = 'qwen3-4b-element4-eva-holy-grail-browser-q4f16-sharded';

export interface EvaRuntimeSettings {
  modelHost: string;
  modelId: string;
}

export function getEvaRuntimeSettings(): EvaRuntimeSettings {
  return {
    modelHost: import.meta.env.PUBLIC_EVA_MODEL_HOST?.trim() || DEFAULT_EVA_MODEL_HOST,
    modelId: import.meta.env.PUBLIC_EVA_MODEL_ID?.trim() || DEFAULT_EVA_MODEL_ID,
  };
}

export function normalizeEvaRuntimeSettings(settings: EvaRuntimeSettings): EvaRuntimeSettings {
  return {
    modelHost: normalizeEvaModelHost(settings.modelHost),
    modelId: validateEvaModelId(settings.modelId),
  };
}

export function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

async function readBoundedManifest(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_EVA_MANIFEST_BYTES) {
    throw new Error('Eva manifest exceeds the 1 MiB browser limit.');
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_EVA_MANIFEST_BYTES) {
      throw new Error('Eva manifest exceeds the 1 MiB browser limit.');
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_EVA_MANIFEST_BYTES) {
        await reader.cancel('manifest too large');
        throw new Error('Eva manifest exceeds the 1 MiB browser limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fetchEvaModelConfig(
  settings: EvaRuntimeSettings,
  timeoutMs = 12_000,
): Promise<EvaModelConfig> {
  const normalized = normalizeEvaRuntimeSettings(settings);
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const manifestUrl = createEvaManifestUrl(normalized.modelHost, normalized.modelId);

  try {
    const response = await fetch(manifestUrl, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Eva manifest returned HTTP ${response.status} from ${normalized.modelHost}.`);
    }
    if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.redirected) {
      throw new Error('Eva manifest response was opaque or redirected.');
    }

    const rawBytes = await readBoundedManifest(response);
    let rawValue: unknown;
    try {
      rawValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes));
    } catch {
      throw new Error('Eva manifest did not contain valid UTF-8 JSON.');
    }
    const manifest = parseEvaArtifactManifest(rawValue);
    const identity = createModelCacheManifestIdentity(rawBytes, response.headers.get('ETag'));
    const modelBase = new URL(createEvaModelBaseUrl(normalized.modelHost, normalized.modelId));
    return {
      modelHost: modelBase.origin,
      modelId: normalized.modelId,
      manifestUrl,
      manifestVersion: identity.manifestVersion,
      manifestEtag: identity.strongEtag,
      manifestRawSha256: identity.rawSha256,
      manifestFetchedAt: Date.now(),
      cacheLeaseNonce: null,
      manifest,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Eva manifest did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
