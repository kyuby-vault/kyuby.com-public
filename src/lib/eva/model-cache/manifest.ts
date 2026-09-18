import { parseEvaArtifactManifest } from '../manifest';
import { sha256Bytes } from './integrity';
import {
  isCanonicalModelCacheRootPath,
  normalizeModelCacheOrigin,
} from './routing';
import {
  MODEL_CACHE_MAX_MANIFEST_BYTES,
  type ModelCacheInventory,
  type ModelCacheManifestIdentity,
} from './types';

export interface ParsedModelCacheManifest {
  inventory: ModelCacheInventory;
  artifactManifest: ReturnType<typeof parseEvaArtifactManifest>;
}

export function normalizeStrongModelCacheEtag(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const etag = value.trim();
  if (etag.length < 2
    || etag.length > 256
    || etag.startsWith('W/')
    || etag[0] !== '"'
    || etag.at(-1) !== '"'
    || /[\u0000-\u001f\u007f]/.test(etag)) {
    return null;
  }
  return etag;
}

export function createModelCacheManifestIdentity(
  rawBytes: Uint8Array,
  etagHeader: string | null,
): ModelCacheManifestIdentity {
  if (rawBytes.byteLength > MODEL_CACHE_MAX_MANIFEST_BYTES) {
    throw new Error('Eva manifest exceeds the 1 MiB browser limit.');
  }
  const rawSha256 = sha256Bytes(rawBytes);
  const strongEtag = normalizeStrongModelCacheEtag(etagHeader);
  return {
    manifestVersion: strongEtag ?? `sha256:${rawSha256}`,
    strongEtag,
    rawSha256,
  };
}

export function parseModelCacheManifestBytes(
  rawBytes: Uint8Array,
  options: {
    modelOrigin: string;
    modelRootPath: string;
    etag: string | null;
  },
): ParsedModelCacheManifest {
  if (rawBytes.byteLength === 0 || rawBytes.byteLength > MODEL_CACHE_MAX_MANIFEST_BYTES) {
    throw new Error('Eva manifest has an invalid bounded body.');
  }
  const modelOrigin = normalizeModelCacheOrigin(options.modelOrigin);
  if (!modelOrigin || !isCanonicalModelCacheRootPath(options.modelRootPath)) {
    throw new Error('Eva manifest was configured for a noncanonical model root.');
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes));
  } catch {
    throw new Error('Eva manifest did not contain valid UTF-8 JSON.');
  }
  const artifactManifest = parseEvaArtifactManifest(value);
  if (!artifactManifest.cacheInventory) {
    throw new Error('Eva manifest does not provide the v2 verified cache inventory.');
  }
  const manifestIdentity = createModelCacheManifestIdentity(rawBytes, options.etag);
  return {
    artifactManifest,
    inventory: {
      ...artifactManifest.cacheInventory,
      modelOrigin,
      modelRootPath: options.modelRootPath,
      manifestIdentity,
    },
  };
}
