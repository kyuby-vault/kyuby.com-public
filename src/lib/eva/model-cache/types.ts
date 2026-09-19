export const MODEL_CACHE_MANIFEST_SCHEMA_VERSION = 'eva-browser-package/v2' as const;

export const MODEL_CACHE_MAX_MANIFEST_BYTES = 1024 * 1024;
export const MODEL_CACHE_MAX_FILES = 32;
export const MODEL_CACHE_MAX_PATH_BYTES = 512;
export const MODEL_CACHE_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const MODEL_CACHE_MAX_PACKAGE_BYTES = 4 * 1024 * 1024 * 1024;

export type ModelCacheManifestFileRole =
  | 'tokenizer'
  | 'tokenizer-config'
  | 'model-config'
  | 'generation-config'
  | 'onnx-graph'
  | 'onnx-external-data';

export type ModelCacheFileRole = ModelCacheManifestFileRole;

interface ModelCacheManifestFileBase {
  path: string;
  role: ModelCacheManifestFileRole;
  required: boolean;
  contentType: string;
}

export interface ModelCachePresentManifestFile extends ModelCacheManifestFileBase {
  present: true;
  bytes: number;
  sha256: string;
}

export interface ModelCacheAbsentManifestFile extends ModelCacheManifestFileBase {
  present: false;
  required: false;
  bytes: 0;
  sha256: null;
}

export type ModelCacheManifestFile =
  | ModelCachePresentManifestFile
  | ModelCacheAbsentManifestFile;

export interface ModelCacheManifestIdentity {
  manifestVersion: string;
  strongEtag: string | null;
  rawSha256: string;
}

export interface ModelCacheManifestInventory {
  schemaVersion: typeof MODEL_CACHE_MANIFEST_SCHEMA_VERSION;
  files: readonly ModelCacheManifestFile[];
  totalBytes: number;
}

export interface ModelCacheInventory extends ModelCacheManifestInventory {
  modelOrigin: string;
  modelRootPath: string;
  manifestIdentity: ModelCacheManifestIdentity;
}

export type ModelCacheBackend = 'opfs' | 'unavailable';
export type ModelCacheStoredBackend = Exclude<ModelCacheBackend, 'unavailable'>;
export type ModelCacheFileRecordState = 'writing' | 'complete' | 'corrupt' | 'deleting';
export type ModelCachePackageRecordState = 'incomplete' | 'complete' | 'deleting';

export interface ModelCacheFileMetadata {
  cacheKey: string;
  modelOrigin: string;
  pathname: string;
  manifestVersion: string;
  state: ModelCacheFileRecordState;
  backend: ModelCacheStoredBackend;
  backendLocator: string;
  bytes: number;
  sha256: string;
  contentType: string;
  temporaryOwner: string | null;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
}

export interface ModelCachePackageMetadata {
  modelOrigin: string;
  modelRootPath: string;
  manifestVersion: string;
  state: ModelCachePackageRecordState;
  totalBytes: number;
  cachedBytes: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
}

export type ModelCachePreflightState = 'checking' | 'usable' | 'unavailable';
export type ModelCacheResidency = 'unknown' | 'network-only' | 'on-disk';
export type ModelCacheSessionState = 'unloaded' | 'loading' | 'ready' | 'unloading';
export type ModelCacheLoadSource = 'disk' | 'network';
export type ModelCacheAction = 'idle' | 'verifying' | 'removing';
export type ModelCacheIntegrityState = 'unverified' | 'verifying' | 'verified' | 'failed';
export type ModelCachePersistenceState = 'persistent' | 'best-effort' | 'browser-managed';
export type ModelCacheProgressPhase =
  | 'queued'
  | 'downloading'
  | 'retrying'
  | 'verifying'
  | 'committing'
  | 'serving';

export type ModelCacheWarningCode =
  | 'service-worker-unavailable'
  | 'storage-unavailable'
  | 'persistence-denied'
  | 'quota-insufficient'
  | 'write-failed'
  | 'cache-corrupt'
  | 'manifest-revalidation'
  | 'manifest-updated'
  | 'network-only'
  | 'remove-failed'
  | 'cache-service-restarted'
  | 'browser-evicted'
  | 'host-contract'
  | 'connection-lost'
  | 'integrity-failed'
  | 'protocol';

export interface ModelCacheWarning {
  code: ModelCacheWarningCode;
  message: string;
  recoverable: boolean;
}

export interface ModelCacheStorageEstimate {
  usage: number | null;
  quota: number | null;
}

export interface ModelCacheStatus {
  modelOrigin: string;
  modelRootPath: string;
  manifestVersion: string | null;
  totalBytes: number | null;
  cachedBytes: number;
  residency: ModelCacheResidency;
  backend: ModelCacheBackend;
  persistence: ModelCachePersistenceState;
  estimate: ModelCacheStorageEstimate;
  cacheAction: ModelCacheAction;
  integrity: ModelCacheIntegrityState;
  warning: ModelCacheWarning | null;
}

export interface ModelCacheUiState {
  preflight: ModelCachePreflightState;
  residency: ModelCacheResidency;
  session: ModelCacheSessionState;
  loadSource: ModelCacheLoadSource | null;
  cacheAction: ModelCacheAction;
  warning: ModelCacheWarning | null;
  error: string | null;
  manifestUpdateAvailable: boolean;
}
