import type {
  ModelCacheFileRole,
  ModelCacheManifestInventory,
  ModelCacheManifestFile,
} from './model-cache/types';
import type { EvaArtifactManifest } from './worker-protocol';

export const EVA_CACHE_MANIFEST_SCHEMA = 'eva-browser-package/v2' as const;
export const EVA_LEGACY_CACHE_MANIFEST_SCHEMA = 'browser-model-package/v1' as const;
export const MAX_EVA_MANIFEST_BYTES = 1024 * 1024;
export const MAX_EVA_MANIFEST_FILES = 32;
export const MAX_EVA_MANIFEST_PATH_BYTES = 512;
export const MAX_EXTERNAL_DATA_SHARD_BYTES = 512 * 1024 * 1024;
export const MAX_EVA_PACKAGE_BYTES = 4 * 1024 * 1024 * 1024;
export const EVA_ONNX_ENTRY_FILE = 'onnx/model_q4f16.onnx';

const JSON_CONTENT_TYPE = 'application/json';
const BINARY_CONTENT_TYPE = 'application/octet-stream';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MODEL_ID_SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;

interface RawManifestFile {
  path?: unknown;
  role?: unknown;
  bytes?: unknown;
  sha256?: unknown;
  required?: unknown;
  present?: unknown;
  content_type?: unknown;
  media_type?: unknown;
}

interface RawManifest {
  schema_version?: unknown;
  prepare_mode?: unknown;
  files?: unknown;
  file_inventory?: unknown;
  onnx?: {
    entry_file?: unknown;
    runtime_dtype?: unknown;
    quantization_backend?: unknown;
    data_files?: unknown;
    data_file_sizes?: unknown;
  };
}

export interface EvaModelLoadOptions {
  dtype: 'q4f16';
  device: 'webgpu';
  model_file_name: 'model';
  use_external_data_format: false;
  session_options: {
    externalData: Array<{
      path: string;
      data: string;
    }>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isSafeEvaRelativePath(value: string): boolean {
  if (value.length === 0
    || utf8Length(value) > MAX_EVA_MANIFEST_PATH_BYTES
    || value.startsWith('/')
    || value.startsWith('\\')
    || value.includes('\\')
    || value.includes('?')
    || value.includes('#')
    || value.includes('%')
    || /^[a-zA-Z]:/.test(value)) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && MODEL_ID_SEGMENT_PATTERN.test(segment));
}

export function validateEvaModelId(modelId: string): string {
  const normalized = modelId.trim();
  if (!isSafeEvaRelativePath(normalized)) {
    throw new Error('Eva model id must contain only canonical URL-unreserved path segments.');
  }
  return normalized;
}

export function normalizeEvaModelHost(modelHost: string): string {
  let url: URL;
  try {
    url = new URL(modelHost.trim());
  } catch {
    throw new Error('Eva model host must be an absolute HTTP(S) origin.');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search
    || url.hash) {
    throw new Error('Eva model host must be an absolute HTTP(S) origin.');
  }
  return url.origin;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeExternalDataName(value: unknown): string {
  if (typeof value !== 'string'
    || !MODEL_ID_SEGMENT_PATTERN.test(value)
    || value === '.'
    || value === '..') {
    throw new Error('Eva manifest contains an invalid external-data path.');
  }
  return value;
}

function validateShardSizes(value: unknown, dataFiles: string[]): void {
  if (!isRecord(value)) {
    return;
  }

  for (const file of dataFiles) {
    const size = value[file];
    if (typeof size === 'number' && size > MAX_EXTERNAL_DATA_SHARD_BYTES) {
      throw new Error(`Eva shard ${file} exceeds the 512 MiB browser limit.`);
    }
  }
}

function expectedInventory(dataFiles: string[]): Map<string, {
  role: ModelCacheFileRole;
  required: boolean;
  contentType: string;
}> {
  const expected = new Map<string, {
    role: ModelCacheFileRole;
    required: boolean;
    contentType: string;
  }>();
  expected.set('tokenizer.json', { role: 'tokenizer', required: true, contentType: JSON_CONTENT_TYPE });
  expected.set('tokenizer_config.json', {
    role: 'tokenizer-config',
    required: true,
    contentType: JSON_CONTENT_TYPE,
  });
  expected.set('config.json', { role: 'model-config', required: true, contentType: JSON_CONTENT_TYPE });
  expected.set('generation_config.json', {
    role: 'generation-config',
    required: false,
    contentType: JSON_CONTENT_TYPE,
  });
  expected.set(EVA_ONNX_ENTRY_FILE, {
    role: 'onnx-graph',
    required: true,
    contentType: BINARY_CONTENT_TYPE,
  });
  for (const file of dataFiles) {
    expected.set(`onnx/${file}`, {
      role: 'onnx-external-data',
      required: true,
      contentType: BINARY_CONTENT_TYPE,
    });
  }
  return expected;
}

function validateFileIntegrity(raw: RawManifestFile, path: string): void {
  if (!Number.isSafeInteger(raw.bytes)
    || (raw.bytes as number) < 0
    || (raw.bytes as number) > MAX_EXTERNAL_DATA_SHARD_BYTES
    || typeof raw.sha256 !== 'string'
    || !SHA256_PATTERN.test(raw.sha256)) {
    throw new Error(`Eva cache inventory has invalid length or SHA-256 for ${path}.`);
  }
}

// These are the only non-runtime files in the published v1 text package. Keep
// this adapter narrow: a new graph, executable, or unknown artifact is not a
// provenance file merely because the runtime does not currently request it.
const V1_PROVENANCE_FILES = new Map([
  ['README.md', { role: 'model_card', mediaType: 'text/markdown' }],
  ['chat_template.jinja', { role: 'tokenizer', mediaType: 'text/plain' }],
  ['external-data-sharding-report.json', { role: 'validation_report', mediaType: JSON_CONTENT_TYPE }],
  ['genai_config.json', { role: 'configuration', mediaType: JSON_CONTENT_TYPE }],
  ['onnx/config.json', { role: 'configuration', mediaType: JSON_CONTENT_TYPE }],
  ['source-inspection.json', { role: 'validation_report', mediaType: JSON_CONTENT_TYPE }],
]);

function v1RuntimeRole(role: ModelCacheFileRole): string {
  if (role === 'onnx-graph') return 'onnx_graph';
  if (role === 'onnx-external-data') return 'onnx_external_data';
  if (role === 'tokenizer' || role === 'tokenizer-config') return 'tokenizer';
  return 'configuration';
}

function normalizeV1CacheManifest(raw: RawManifest, dataFiles: string[]): RawManifest {
  if (!Array.isArray(raw.files)
    || raw.files.length === 0
    || raw.files.length > MAX_EVA_MANIFEST_FILES) {
    throw new Error('Eva v1 cache manifest has an invalid file inventory.');
  }
  if (!isRecord(raw.file_inventory)
    || raw.file_inventory.hash_algorithm !== 'sha256'
    || !Array.isArray(raw.file_inventory.excludes)
    || raw.file_inventory.excludes.length !== 1
    || raw.file_inventory.excludes[0] !== 'artifact-manifest.json') {
    throw new Error('Eva v1 cache manifest must declare an exhaustive SHA-256 inventory.');
  }

  const expected = expectedInventory(dataFiles);
  const paths = new Set<string>();
  const files = new Map<string, RawManifestFile>();
  for (const value of raw.files) {
    if (!isRecord(value)
      || typeof value.path !== 'string'
      || !isSafeEvaRelativePath(value.path)) {
      throw new Error('Eva v1 cache inventory contains an invalid file path.');
    }
    const path = value.path;
    if (paths.has(path)) {
      throw new Error('Eva v1 cache inventory contains duplicate paths.');
    }
    paths.add(path);
    validateFileIntegrity(value, path);

    const contract = expected.get(path);
    if (!contract) {
      const provenance = V1_PROVENANCE_FILES.get(path);
      if (!provenance || value.role !== provenance.role || value.media_type !== provenance.mediaType) {
        throw new Error(`Eva v1 cache inventory contains an unknown provenance path or role: ${path}.`);
      }
      continue;
    }
    const mediaType = contract.role === 'onnx-graph' ? 'application/onnx' : contract.contentType;
    if (value.role !== v1RuntimeRole(contract.role)
      || value.media_type !== mediaType
      || (value.present !== undefined && value.present !== true)
      || (value.required !== undefined && value.required !== contract.required)
      || (value.content_type !== undefined && value.content_type !== contract.contentType)) {
      throw new Error(`Eva v1 cache inventory contract does not match ${path}.`);
    }
    files.set(path, {
      path,
      role: contract.role,
      bytes: value.bytes,
      sha256: value.sha256,
      required: contract.required,
      present: true,
      content_type: contract.contentType,
    });
  }

  // Only the optional generation config may be absent from an exhaustive v1
  // inventory. Never manufacture lengths or hashes for a required artifact.
  for (const [path, contract] of expected) {
    if (files.has(path)) continue;
    if (contract.required) {
      throw new Error(`Eva v1 cache inventory is missing the required file ${path}.`);
    }
    files.set(path, {
      path,
      role: contract.role,
      required: false,
      present: false,
      bytes: 0,
      sha256: null,
      content_type: contract.contentType,
    });
  }

  if (!isRecord(raw.onnx?.data_file_sizes)) {
    throw new Error('Eva v1 cache manifest must declare every external-data size.');
  }
  const sizes = new Map<string, unknown>();
  for (const [path, size] of Object.entries(raw.onnx.data_file_sizes)) {
    const name = path.startsWith('onnx/') ? path.slice('onnx/'.length) : path;
    if (!dataFiles.includes(name) || sizes.has(name)) {
      throw new Error('Eva v1 cache manifest contains unknown or duplicate external-data sizes.');
    }
    sizes.set(name, size);
  }

  // Both native v2 and adapted v1 pass the same validator below. The caller
  // retains the original response bytes for manifest hash/ETag identity.
  return {
    ...raw,
    schema_version: EVA_CACHE_MANIFEST_SCHEMA,
    files: [...files.values()],
    onnx: {
      ...raw.onnx,
      data_files: dataFiles,
      data_file_sizes: Object.fromEntries(sizes),
    },
  };
}

function parseManifestFile(
  value: unknown,
  expected: Map<string, { role: ModelCacheFileRole; required: boolean; contentType: string }>,
): ModelCacheManifestFile {
  if (!isRecord(value)) {
    throw new Error('Eva cache inventory contains an invalid file entry.');
  }
  const raw = value as RawManifestFile;
  if (typeof raw.path !== 'string' || !isSafeEvaRelativePath(raw.path)) {
    throw new Error('Eva cache inventory contains an invalid file path.');
  }
  const contract = expected.get(raw.path);
  if (!contract
    || raw.role !== contract.role
    || raw.required !== contract.required
    || raw.content_type !== contract.contentType
    || typeof raw.present !== 'boolean') {
    throw new Error(`Eva cache inventory contract does not match ${raw.path}.`);
  }

  if (!raw.present) {
    if (raw.required || raw.bytes !== 0 || raw.sha256 !== null) {
      throw new Error(`Eva cache inventory has an invalid absence marker for ${raw.path}.`);
    }
    return {
      path: raw.path,
      role: contract.role,
      required: false,
      present: false,
      bytes: 0,
      sha256: null,
      contentType: contract.contentType,
    };
  }

  validateFileIntegrity(raw, raw.path);
  return {
    path: raw.path,
    role: contract.role,
    required: contract.required,
    present: true,
    bytes: raw.bytes as number,
    sha256: raw.sha256 as string,
    contentType: contract.contentType,
  };
}

function parseCacheInventory(raw: RawManifest, dataFiles: string[]): ModelCacheManifestInventory | null {
  if (raw.schema_version !== EVA_CACHE_MANIFEST_SCHEMA) {
    return null;
  }
  if (!Array.isArray(raw.files)
    || raw.files.length === 0
    || raw.files.length > MAX_EVA_MANIFEST_FILES) {
    throw new Error('Eva v2 cache manifest has an invalid file inventory.');
  }

  const expected = expectedInventory(dataFiles);
  if (raw.files.length !== expected.size) {
    throw new Error('Eva v2 cache inventory does not exactly cover the runtime request set.');
  }
  const files = raw.files.map((file) => parseManifestFile(file, expected));
  const paths = new Set(files.map((file) => file.path));
  if (paths.size !== files.length || [...expected.keys()].some((path) => !paths.has(path))) {
    throw new Error('Eva v2 cache inventory contains duplicate, missing, or unknown paths.');
  }

  const totalBytes = files.reduce((total, file) => total + (file.present ? file.bytes : 0), 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_EVA_PACKAGE_BYTES) {
    throw new Error('Eva v2 cache package exceeds the 4 GiB browser limit.');
  }

  if (!isRecord(raw.onnx?.data_file_sizes)) {
    throw new Error('Eva v2 cache manifest must declare every external-data size.');
  }
  if (Object.keys(raw.onnx.data_file_sizes).length !== dataFiles.length
    || Object.keys(raw.onnx.data_file_sizes).some((name) => !dataFiles.includes(name))) {
    throw new Error('Eva v2 cache manifest must use exactly the declared shard basenames for sizes.');
  }
  for (const name of dataFiles) {
    const file = files.find((candidate) => candidate.path === `onnx/${name}`);
    if (!file?.present || raw.onnx?.data_file_sizes?.[name] !== file.bytes) {
      throw new Error(`Eva v2 shard size does not agree with the inventory for ${name}.`);
    }
  }

  return {
    schemaVersion: EVA_CACHE_MANIFEST_SCHEMA,
    files,
    totalBytes,
  };
}

export function parseEvaArtifactManifest(value: unknown): EvaArtifactManifest {
  if (!isRecord(value) || !isRecord(value.onnx)) {
    throw new Error('Eva artifact manifest is missing the ONNX contract.');
  }

  let raw = value as RawManifest;
  if (raw.schema_version !== 1
    && raw.schema_version !== EVA_CACHE_MANIFEST_SCHEMA
    && raw.schema_version !== EVA_LEGACY_CACHE_MANIFEST_SCHEMA) {
    throw new Error('Eva artifact manifest has an unsupported schema version.');
  }
  const entryFile = readOptionalString(raw.onnx?.entry_file);
  const runtimeDtype = readOptionalString(raw.onnx?.runtime_dtype);
  const dataFiles = raw.onnx?.data_files;

  if (entryFile !== EVA_ONNX_ENTRY_FILE) {
    throw new Error(`Eva manifest entry file must be ${EVA_ONNX_ENTRY_FILE}.`);
  }
  if (runtimeDtype !== 'q4f16') {
    throw new Error(`Eva requires q4f16, received ${runtimeDtype ?? 'no runtime dtype'}.`);
  }
  if (!Array.isArray(dataFiles) || dataFiles.length === 0) {
    throw new Error('Eva requires a sharded external-data package.');
  }
  if (dataFiles.length > MAX_EVA_MANIFEST_FILES - 5) {
    throw new Error('Eva manifest contains too many external-data paths.');
  }

  const normalizedDataFiles = dataFiles.map((name) => normalizeExternalDataName(
    raw.schema_version === EVA_LEGACY_CACHE_MANIFEST_SCHEMA
      && typeof name === 'string'
      && name.startsWith('onnx/')
      ? name.slice('onnx/'.length)
      : name,
  ));
  if (new Set(normalizedDataFiles).size !== normalizedDataFiles.length) {
    throw new Error('Eva manifest contains duplicate external-data paths.');
  }

  if (raw.schema_version === EVA_LEGACY_CACHE_MANIFEST_SCHEMA) {
    raw = normalizeV1CacheManifest(raw, normalizedDataFiles);
  }
  validateShardSizes(raw.onnx?.data_file_sizes, normalizedDataFiles);
  const cacheInventory = parseCacheInventory(raw, normalizedDataFiles);

  return {
    schemaVersion:
      typeof raw.schema_version === 'string' || typeof raw.schema_version === 'number'
        ? raw.schema_version
        : null,
    prepareMode: readOptionalString(raw.prepare_mode),
    cacheInventory,
    onnx: {
      entryFile,
      runtimeDtype: 'q4f16',
      quantizationBackend: readOptionalString(raw.onnx?.quantization_backend),
      dataFiles: normalizedDataFiles,
    },
  };
}

export function createEvaModelLoadOptions(manifest: EvaArtifactManifest): EvaModelLoadOptions {
  return {
    dtype: manifest.onnx.runtimeDtype,
    device: 'webgpu',
    model_file_name: 'model',
    use_external_data_format: false,
    session_options: {
      externalData: manifest.onnx.dataFiles.map((file) => ({
        path: file,
        data: `onnx/${file}`,
      })),
    },
  };
}

export function createEvaModelBaseUrl(modelHost: string, modelId: string): string {
  const host = normalizeEvaModelHost(modelHost);
  const normalizedModelId = validateEvaModelId(modelId);
  return `${host}/${normalizedModelId}`;
}

export function createEvaManifestUrl(modelHost: string, modelId: string): string {
  return `${createEvaModelBaseUrl(modelHost, modelId)}/artifact-manifest.json`;
}
