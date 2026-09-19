import {
  MODEL_CACHE_MANIFEST_SCHEMA_VERSION,
  MODEL_CACHE_MAX_FILE_BYTES,
  MODEL_CACHE_MAX_FILES,
  MODEL_CACHE_MAX_PACKAGE_BYTES,
  type ModelCacheInventory,
  type ModelCacheManifestFile,
  type ModelCacheManifestFileRole,
  type ModelCacheProgressPhase,
  type ModelCacheStatus,
  type ModelCacheWarning,
} from './types';
import {
  isCanonicalModelCacheFilePath,
  isCanonicalModelCacheRootPath,
  normalizeModelCacheOrigin,
} from './routing';

export const MODEL_CACHE_PROTOCOL_VERSION = 1 as const;
export const MODEL_CACHE_MAX_MESSAGE_BYTES = 64 * 1024;
export const MODEL_CACHE_LOAD_LEASE_IDLE_MS = 5 * 60 * 1000;
export const MODEL_CACHE_LOAD_LEASE_ABSOLUTE_MS = 6 * 60 * 60 * 1000;

const MAX_REQUEST_ID_BYTES = 128;
const MAX_CLIENT_ID_BYTES = 256;
const MAX_MANIFEST_VERSION_BYTES = 512;
const MAX_NONCE_BYTES = 256;
const MAX_CONTENT_TYPE_BYTES = 256;
const MAX_MESSAGE_TEXT_BYTES = 2 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,256}$/;
const STRONG_ETAG_PATTERN = /^"[\x21\x23-\x7e\x80-\xff]*"$/;
const textEncoder = new TextEncoder();

const FILE_ROLES: ReadonlySet<ModelCacheManifestFileRole> = new Set([
  'tokenizer',
  'tokenizer-config',
  'model-config',
  'generation-config',
  'onnx-graph',
  'onnx-external-data',
]);
const PROGRESS_PHASES: ReadonlySet<ModelCacheProgressPhase> = new Set([
  'queued',
  'downloading',
  'retrying',
  'verifying',
  'committing',
  'serving',
]);
const WARNING_CODES = new Set([
  'service-worker-unavailable',
  'storage-unavailable',
  'persistence-denied',
  'quota-insufficient',
  'write-failed',
  'cache-corrupt',
  'manifest-revalidation',
  'manifest-updated',
  'network-only',
  'remove-failed',
  'protocol',
  'cache-service-restarted', 'browser-evicted', 'host-contract', 'connection-lost', 'integrity-failed',
]);

interface ModelCacheClientMessageBase {
  protocolVersion: typeof MODEL_CACHE_PROTOCOL_VERSION;
  requestId: string;
  modelOrigin: string;
  modelRootPath: string;
  manifestVersion: string | null;
}

export interface ModelCacheConfigureMessage extends ModelCacheClientMessageBase {
  type: 'CONFIGURE';
  inventory: ModelCacheInventory | null;
}

export interface ModelCacheGetStatusMessage extends ModelCacheClientMessageBase {
  type: 'GET_STATUS';
}

export interface ModelCacheReverifyMessage extends ModelCacheClientMessageBase {
  type: 'REVERIFY';
  manifestVersion: string;
}

export interface ModelCacheBeginLoadMessage extends ModelCacheClientMessageBase {
  type: 'BEGIN_LOAD' | 'BEGIN_DISK_LOAD';
  manifestVersion: string;
  nonce: string;
  concurrency?: 2 | 4;
  chunkBytes?: number;
}

export interface ModelCacheClaimLoadMessage extends ModelCacheClientMessageBase {
  type: 'CLAIM_LOAD';
  manifestVersion: string;
  nonce: string;
}

export interface ModelCacheRenewLoadMessage extends ModelCacheClientMessageBase {
  type: 'RENEW_LOAD';
  manifestVersion: string;
  nonce: string;
}

export interface ModelCacheEndLoadMessage extends ModelCacheClientMessageBase {
  type: 'END_LOAD';
  manifestVersion: string;
  nonce: string;
}

export interface ModelCacheCancelLoadMessage extends ModelCacheClientMessageBase {
  type: 'CANCEL_LOAD';
  manifestVersion: string;
  nonce: string;
}

export interface ModelCacheRemoveModelMessage extends ModelCacheClientMessageBase {
  type: 'REMOVE_MODEL';
  manifestVersion: null;
}

export type ModelCacheClientMessage =
  | ModelCacheConfigureMessage
  | ModelCacheGetStatusMessage
  | ModelCacheReverifyMessage
  | ModelCacheBeginLoadMessage
  | ModelCacheClaimLoadMessage
  | ModelCacheRenewLoadMessage
  | ModelCacheEndLoadMessage
  | ModelCacheCancelLoadMessage
  | ModelCacheRemoveModelMessage;

interface ModelCacheWorkerMessageBase {
  protocolVersion: typeof MODEL_CACHE_PROTOCOL_VERSION;
  requestId: string;
  clientId: string;
  modelOrigin: string;
  modelRootPath: string;
  manifestVersion: string | null;
}

export interface ModelCacheStatusMessage extends ModelCacheWorkerMessageBase {
  type: 'STATUS';
  status: ModelCacheStatus;
}

export interface ModelCacheFileProgressMessage extends ModelCacheWorkerMessageBase {
  type: 'FILE_PROGRESS';
  manifestVersion: string;
  file: string;
  source: 'disk' | 'network';
  phase: ModelCacheProgressPhase;
  loadedBytes: number;
  totalBytes: number;
  receivedBytes: number;
  verifiedBytes: number;
  attempt?: number;
  transfer?: { durableBytes: number; networkBytes: number; resumedBytes: number };
}

export interface ModelCacheVerifyResultMessage extends ModelCacheWorkerMessageBase {
  type: 'VERIFY_RESULT';
  files: Array<{ file: string; status: 'passed' | 'failed' }>;
  status: ModelCacheStatus;
}

export interface ModelCacheSourceChangedMessage extends ModelCacheWorkerMessageBase {
  type: 'SOURCE_CHANGED';
  manifestVersion: string;
  source: 'disk' | 'network';
  reason: 'cache-miss' | 'corruption' | 'storage-unavailable' | 'quota';
}

export interface ModelCacheWarningMessage extends ModelCacheWorkerMessageBase {
  type: 'CACHE_WARNING';
  warning: ModelCacheWarning;
}

export interface ModelCacheManifestUpdatedMessage extends ModelCacheWorkerMessageBase {
  type: 'MANIFEST_UPDATED';
  previousManifestVersion: string;
  newManifestVersion: string;
}

export interface ModelCacheRemoveResultMessage extends ModelCacheWorkerMessageBase {
  type: 'REMOVE_RESULT';
  manifestVersion: null;
  removed: boolean;
  removedBytes: number;
  status: ModelCacheStatus;
}

export interface ModelCacheErrorMessage extends ModelCacheWorkerMessageBase {
  type: 'ERROR';
  code:
    | 'BAD_MESSAGE'
    | 'NOT_CONFIGURED'
    | 'LEASE_REJECTED'
    | 'CACHE_FAILED'
    | 'REMOVE_FAILED';
  message: string;
  recoverable: boolean;
}

export type ModelCacheWorkerMessage =
  | ModelCacheStatusMessage
  | ModelCacheVerifyResultMessage
  | ModelCacheFileProgressMessage
  | ModelCacheSourceChangedMessage
  | ModelCacheWarningMessage
  | ModelCacheManifestUpdatedMessage
  | ModelCacheRemoveResultMessage
  | ModelCacheErrorMessage;

export interface BoundModelCacheClientMessage {
  message: ModelCacheClientMessage;
  senderClientId: string;
}

export interface ModelCacheLoadLease {
  modelOrigin: string;
  modelRootPath: string;
  manifestVersion: string;
  nonce: string;
  pageClientId: string;
  workerClientId: string | null;
  diskOnly: boolean;
  chunkBytes?: number;
  createdAt: number;
  lastActivityAt: number;
}

export type ModelCacheLeaseResult =
  | { ok: true; lease: ModelCacheLoadLease }
  | {
      ok: false;
      reason: 'expired' | 'identity' | 'nonce' | 'client' | 'already-claimed';
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && utf8Length(value) <= maxBytes;
}

function isSafeIntegerInRange(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function isStrongEtag(value: unknown): value is string {
  return typeof value === 'string'
    && utf8Length(value) <= MAX_MANIFEST_VERSION_BYTES
    && STRONG_ETAG_PATTERN.test(value);
}

function isManifestVersion(value: unknown): value is string {
  return isStrongEtag(value)
    || (typeof value === 'string'
      && value.length === 'sha256:'.length + 64
      && value.startsWith('sha256:')
      && SHA256_PATTERN.test(value.slice('sha256:'.length)));
}

function isNullableManifestVersion(value: unknown): value is string | null {
  return value === null || isManifestVersion(value);
}

function isNonce(value: unknown): value is string {
  return typeof value === 'string'
    && utf8Length(value) <= MAX_NONCE_BYTES
    && NONCE_PATTERN.test(value);
}

function isMessageWithinBound(value: unknown): boolean {
  try {
    const encoded = textEncoder.encode(JSON.stringify(value));
    return encoded.byteLength <= MODEL_CACHE_MAX_MESSAGE_BYTES;
  } catch {
    return false;
  }
}

function isClientBase(value: Record<string, unknown>): boolean {
  return value.protocolVersion === MODEL_CACHE_PROTOCOL_VERSION
    && isBoundedString(value.requestId, MAX_REQUEST_ID_BYTES)
    && normalizeModelCacheOrigin(String(value.modelOrigin)) === value.modelOrigin
    && isCanonicalModelCacheRootPath(String(value.modelRootPath))
    && isNullableManifestVersion(value.manifestVersion);
}

function isWorkerBase(value: Record<string, unknown>): boolean {
  return isClientBase(value)
    && isBoundedString(value.clientId, MAX_CLIENT_ID_BYTES);
}

function isManifestFile(value: unknown): value is ModelCacheManifestFile {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'path',
      'role',
      'required',
      'contentType',
      'present',
      'bytes',
      'sha256',
    ])
    || typeof value.path !== 'string'
    || !isCanonicalModelCacheFilePath(value.path)
    || !FILE_ROLES.has(value.role as ModelCacheManifestFileRole)
    || typeof value.required !== 'boolean'
    || !isBoundedString(value.contentType, MAX_CONTENT_TYPE_BYTES)
    || !isSafeIntegerInRange(value.bytes, MODEL_CACHE_MAX_FILE_BYTES)) {
    return false;
  }
  if (value.present === false) {
    return value.required === false && value.bytes === 0 && value.sha256 === null;
  }
  return value.present === true
    && typeof value.sha256 === 'string'
    && SHA256_PATTERN.test(value.sha256);
}

function isInventory(value: unknown): value is ModelCacheInventory {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'files',
      'totalBytes',
      'modelOrigin',
      'modelRootPath',
      'manifestIdentity',
    ])
    || value.schemaVersion !== MODEL_CACHE_MANIFEST_SCHEMA_VERSION
    || !Array.isArray(value.files)
    || value.files.length === 0
    || value.files.length > MODEL_CACHE_MAX_FILES
    || !value.files.every(isManifestFile)
    || !isSafeIntegerInRange(value.totalBytes, MODEL_CACHE_MAX_PACKAGE_BYTES)
    || normalizeModelCacheOrigin(String(value.modelOrigin)) !== value.modelOrigin
    || !isCanonicalModelCacheRootPath(String(value.modelRootPath))
    || !isRecord(value.manifestIdentity)
    || !hasExactKeys(value.manifestIdentity, ['manifestVersion', 'strongEtag', 'rawSha256'])
    || !isManifestVersion(value.manifestIdentity.manifestVersion)
    || !(value.manifestIdentity.strongEtag === null || isStrongEtag(value.manifestIdentity.strongEtag))
    || typeof value.manifestIdentity.rawSha256 !== 'string'
    || !SHA256_PATTERN.test(value.manifestIdentity.rawSha256)) {
    return false;
  }

  const paths = value.files.map((file) => file.path);
  const totalBytes = value.files.reduce(
    (total, file) => total + (file.present ? file.bytes : 0),
    0,
  );
  const identity = value.manifestIdentity;
  return new Set(paths).size === paths.length
    && Number.isSafeInteger(totalBytes)
    && totalBytes === value.totalBytes
    && (identity.strongEtag === null || identity.manifestVersion === identity.strongEtag)
    && (identity.strongEtag !== null
      || identity.manifestVersion === `sha256:${identity.rawSha256}`);
}

function isWarning(value: unknown): value is ModelCacheWarning {
  return isRecord(value)
    && hasExactKeys(value, ['code', 'message', 'recoverable'])
    && WARNING_CODES.has(String(value.code))
    && isBoundedString(value.message, MAX_MESSAGE_TEXT_BYTES)
    && typeof value.recoverable === 'boolean';
}

function isStorageEstimate(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['usage', 'quota'])
    && (value.usage === null || isSafeIntegerInRange(value.usage, Number.MAX_SAFE_INTEGER))
    && (value.quota === null || isSafeIntegerInRange(value.quota, Number.MAX_SAFE_INTEGER));
}

function isStatus(value: unknown): value is ModelCacheStatus {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'modelOrigin',
      'modelRootPath',
      'manifestVersion',
      'totalBytes',
      'cachedBytes',
      'residency',
      'backend',
      'persistence',
      'estimate',
      'cacheAction',
      'integrity',
      'warning',
    ])
    || normalizeModelCacheOrigin(String(value.modelOrigin)) !== value.modelOrigin
    || !isCanonicalModelCacheRootPath(String(value.modelRootPath))
    || !isNullableManifestVersion(value.manifestVersion)
    || !(value.totalBytes === null
      || isSafeIntegerInRange(value.totalBytes, MODEL_CACHE_MAX_PACKAGE_BYTES))
    || !isSafeIntegerInRange(value.cachedBytes, MODEL_CACHE_MAX_PACKAGE_BYTES)
    || !new Set(['unknown', 'network-only', 'on-disk']).has(String(value.residency))
    || !new Set(['opfs', 'unavailable']).has(String(value.backend))
    || !new Set(['persistent', 'best-effort', 'browser-managed']).has(String(value.persistence))
    || !isStorageEstimate(value.estimate)
    || !new Set(['idle', 'verifying', 'removing']).has(String(value.cacheAction))
    || !new Set(['unverified', 'verifying', 'verified', 'failed']).has(String(value.integrity))
    || !(value.warning === null || isWarning(value.warning))) {
    return false;
  }
  return value.totalBytes === null || (value.cachedBytes as number) <= value.totalBytes;
}

function hasIdentity(
  value: Record<string, unknown>,
  inventory: ModelCacheInventory,
): boolean {
  return value.modelOrigin === inventory.modelOrigin
    && value.modelRootPath === inventory.modelRootPath
    && value.manifestVersion === inventory.manifestIdentity.manifestVersion;
}

export function isModelCacheClientMessage(value: unknown): value is ModelCacheClientMessage {
  if (!isRecord(value) || !isMessageWithinBound(value) || !isClientBase(value)) {
    return false;
  }
  switch (value.type) {
    case 'CONFIGURE': {
      if (!hasExactKeys(value, [
        'protocolVersion',
        'type',
        'requestId',
        'modelOrigin',
        'modelRootPath',
        'manifestVersion',
        'inventory',
      ])) {
        return false;
      }
      if (value.inventory === null) {
        return value.manifestVersion === null;
      }
      return isInventory(value.inventory) && hasIdentity(value, value.inventory);
    }
    case 'REVERIFY':
    case 'GET_STATUS':
      return (value.type !== 'REVERIFY' || isManifestVersion(value.manifestVersion)) && hasExactKeys(value, [
        'protocolVersion',
        'type',
        'requestId',
        'modelOrigin',
        'modelRootPath',
        'manifestVersion',
      ]);
    case 'BEGIN_LOAD':
    case 'BEGIN_DISK_LOAD':
      return hasExactKeys(value, ['protocolVersion', 'type', 'requestId', 'modelOrigin', 'modelRootPath', 'manifestVersion', 'nonce',
        ...(value.concurrency !== undefined ? ['concurrency'] : []),
        ...(value.chunkBytes !== undefined ? ['chunkBytes'] : [])])
        && (value.concurrency === undefined || value.concurrency === 2 || value.concurrency === 4)
        && (value.chunkBytes === undefined || value.chunkBytes === 4 * 1024 * 1024 || value.chunkBytes === 8 * 1024 * 1024)
        && isManifestVersion(value.manifestVersion) && isNonce(value.nonce);
    case 'CLAIM_LOAD':
    case 'RENEW_LOAD':
    case 'END_LOAD':
    case 'CANCEL_LOAD':
      return hasExactKeys(value, [
        'protocolVersion',
        'type',
        'requestId',
        'modelOrigin',
        'modelRootPath',
        'manifestVersion',
        'nonce',
      ]) && isManifestVersion(value.manifestVersion) && isNonce(value.nonce);
    case 'REMOVE_MODEL':
      return value.manifestVersion === null && hasExactKeys(value, [
        'protocolVersion',
        'type',
        'requestId',
        'modelOrigin',
        'modelRootPath',
        'manifestVersion',
      ]);
    default:
      return false;
  }
}

export function parseModelCacheClientMessage(value: unknown): ModelCacheClientMessage | null {
  return isModelCacheClientMessage(value) ? value : null;
}

export function bindModelCacheClientMessage(
  value: unknown,
  senderClientId: string,
): BoundModelCacheClientMessage | null {
  const message = parseModelCacheClientMessage(value);
  if (!message || !isBoundedString(senderClientId, MAX_CLIENT_ID_BYTES)) {
    return null;
  }
  return { message, senderClientId };
}

function workerMessageMatchesBase(
  message: Record<string, unknown>,
  nested: ModelCacheStatus,
): boolean {
  return message.modelOrigin === nested.modelOrigin
    && message.modelRootPath === nested.modelRootPath
    && message.manifestVersion === nested.manifestVersion;
}

export function isModelCacheWorkerMessage(value: unknown): value is ModelCacheWorkerMessage {
  if (!isRecord(value) || !isMessageWithinBound(value) || !isWorkerBase(value)) {
    return false;
  }
  const base = [
    'protocolVersion',
    'type',
    'requestId',
    'clientId',
    'modelOrigin',
    'modelRootPath',
    'manifestVersion',
  ];
  switch (value.type) {
    case 'VERIFY_RESULT':
      return hasExactKeys(value, [...base, 'files', 'status'])
        && isManifestVersion(value.manifestVersion)
        && Array.isArray(value.files) && value.files.length > 0 && value.files.length <= MODEL_CACHE_MAX_FILES
        && value.files.every((file) => isRecord(file) && hasExactKeys(file, ['file', 'status'])
          && typeof file.file === 'string' && isCanonicalModelCacheFilePath(file.file)
          && (file.status === 'passed' || file.status === 'failed'))
        && new Set(value.files.map((file) => file.file)).size === value.files.length
        && isStatus(value.status) && workerMessageMatchesBase(value, value.status);
    case 'STATUS':
      return hasExactKeys(value, [...base, 'status'])
        && isStatus(value.status)
        && workerMessageMatchesBase(value, value.status);
    case 'FILE_PROGRESS':
      return hasExactKeys(value, [
        ...base,
        'file',
        'source',
        'phase',
        'loadedBytes',
        'totalBytes',
        'receivedBytes',
        'verifiedBytes',
        ...(value.transfer !== undefined ? ['transfer'] : []),
        ...(value.attempt !== undefined ? ['attempt'] : []),
      ])
        && (value.phase === 'retrying'
          ? Number.isInteger(value.attempt) && (value.attempt as number) >= 1 && (value.attempt as number) <= 4
          : value.attempt === undefined)
        && isSafeIntegerInRange(value.totalBytes, MODEL_CACHE_MAX_FILE_BYTES)
        && isSafeIntegerInRange(value.receivedBytes, value.totalBytes)
        && (value.transfer === undefined || (isRecord(value.transfer)
          && hasExactKeys(value.transfer, ['durableBytes', 'networkBytes', 'resumedBytes'])
          && isSafeIntegerInRange(value.transfer.durableBytes, value.totalBytes)
          && isSafeIntegerInRange(value.transfer.networkBytes, value.totalBytes)
          && isSafeIntegerInRange(value.transfer.resumedBytes, value.totalBytes)
          && value.transfer.resumedBytes <= value.transfer.durableBytes
          && value.transfer.durableBytes <= value.receivedBytes
          && value.transfer.resumedBytes + value.transfer.networkBytes === value.receivedBytes))
        && isManifestVersion(value.manifestVersion)
        && typeof value.file === 'string'
        && isCanonicalModelCacheFilePath(value.file)
        && (value.source === 'disk' || value.source === 'network')
        && PROGRESS_PHASES.has(value.phase as ModelCacheProgressPhase)
        && isSafeIntegerInRange(value.loadedBytes, MODEL_CACHE_MAX_FILE_BYTES)
        && isSafeIntegerInRange(value.totalBytes, MODEL_CACHE_MAX_FILE_BYTES)
        && isSafeIntegerInRange(value.receivedBytes, value.totalBytes)
        && isSafeIntegerInRange(value.verifiedBytes, value.totalBytes)
        && (value.verifiedBytes === 0 || value.phase === 'serving')
        && value.loadedBytes <= value.totalBytes;
    case 'SOURCE_CHANGED':
      return hasExactKeys(value, [...base, 'source', 'reason'])
        && isManifestVersion(value.manifestVersion)
        && (value.source === 'disk' || value.source === 'network')
        && new Set([
          'cache-miss',
          'corruption',
          'storage-unavailable',
          'quota',
        ]).has(String(value.reason));
    case 'CACHE_WARNING':
      return hasExactKeys(value, [...base, 'warning']) && isWarning(value.warning);
    case 'MANIFEST_UPDATED':
      return hasExactKeys(value, [
        ...base,
        'previousManifestVersion',
        'newManifestVersion',
      ])
        && isManifestVersion(value.previousManifestVersion)
        && isManifestVersion(value.newManifestVersion)
        && value.previousManifestVersion !== value.newManifestVersion;
    case 'REMOVE_RESULT':
      return hasExactKeys(value, [...base, 'removed', 'removedBytes', 'status'])
        && value.manifestVersion === null
        && typeof value.removed === 'boolean'
        && isSafeIntegerInRange(value.removedBytes, MODEL_CACHE_MAX_PACKAGE_BYTES)
        && isStatus(value.status)
        && workerMessageMatchesBase(value, value.status);
    case 'ERROR':
      return hasExactKeys(value, [...base, 'code', 'message', 'recoverable'])
        && new Set([
          'BAD_MESSAGE',
          'NOT_CONFIGURED',
          'LEASE_REJECTED',
          'CACHE_FAILED',
          'REMOVE_FAILED',
        ]).has(String(value.code))
        && isBoundedString(value.message, MAX_MESSAGE_TEXT_BYTES)
        && typeof value.recoverable === 'boolean';
    default:
      return false;
  }
}

export function parseModelCacheWorkerMessage(value: unknown): ModelCacheWorkerMessage | null {
  return isModelCacheWorkerMessage(value) ? value : null;
}

function hasLeaseIdentity(
  lease: ModelCacheLoadLease,
  identity: Pick<ModelCacheLoadLease, 'modelOrigin' | 'modelRootPath' | 'manifestVersion'>,
): boolean {
  return lease.modelOrigin === identity.modelOrigin
    && lease.modelRootPath === identity.modelRootPath
    && lease.manifestVersion === identity.manifestVersion;
}

export function isModelCacheLoadLeaseExpired(
  lease: ModelCacheLoadLease,
  now: number,
): boolean {
  return !Number.isFinite(now)
    || now < lease.createdAt
    || now - lease.lastActivityAt >= MODEL_CACHE_LOAD_LEASE_IDLE_MS
    || now - lease.createdAt >= MODEL_CACHE_LOAD_LEASE_ABSOLUTE_MS;
}

export function createModelCacheLoadLease(
  message: ModelCacheBeginLoadMessage,
  pageClientId: string,
  now: number,
): ModelCacheLoadLease {
  if (!isBoundedString(pageClientId, MAX_CLIENT_ID_BYTES)
    || !Number.isFinite(now)
    || now < 0) {
    throw new TypeError('Cannot create an Eva cache load lease from invalid inputs.');
  }
  return {
    modelOrigin: message.modelOrigin,
    modelRootPath: message.modelRootPath,
    manifestVersion: message.manifestVersion,
    nonce: message.nonce,
    pageClientId,
    workerClientId: null,
    diskOnly: message.type === 'BEGIN_DISK_LOAD',
    createdAt: now,
    lastActivityAt: now,
  };
}

export function claimModelCacheLoadLease(
  lease: ModelCacheLoadLease,
  message: ModelCacheClaimLoadMessage,
  workerClientId: string,
  now: number,
): ModelCacheLeaseResult {
  if (isModelCacheLoadLeaseExpired(lease, now)) {
    return { ok: false, reason: 'expired' };
  }
  if (!hasLeaseIdentity(lease, message)) {
    return { ok: false, reason: 'identity' };
  }
  if (lease.nonce !== message.nonce) {
    return { ok: false, reason: 'nonce' };
  }
  if (!isBoundedString(workerClientId, MAX_CLIENT_ID_BYTES)
    || workerClientId === lease.pageClientId) {
    return { ok: false, reason: 'client' };
  }
  if (lease.workerClientId !== null) {
    return { ok: false, reason: 'already-claimed' };
  }
  return {
    ok: true,
    lease: {
      ...lease,
      workerClientId,
      lastActivityAt: now,
    },
  };
}

export function renewModelCacheLoadLease(
  lease: ModelCacheLoadLease,
  identity: Pick<ModelCacheLoadLease, 'modelOrigin' | 'modelRootPath' | 'manifestVersion' | 'nonce'>,
  senderClientId: string,
  now: number,
): ModelCacheLeaseResult {
  if (isModelCacheLoadLeaseExpired(lease, now)) {
    return { ok: false, reason: 'expired' };
  }
  if (!hasLeaseIdentity(lease, identity)) {
    return { ok: false, reason: 'identity' };
  }
  if (lease.nonce !== identity.nonce) {
    return { ok: false, reason: 'nonce' };
  }
  if (senderClientId !== lease.pageClientId && senderClientId !== lease.workerClientId) {
    return { ok: false, reason: 'client' };
  }
  return {
    ok: true,
    lease: { ...lease, lastActivityAt: now },
  };
}

export function modelCacheLoadLeaseBelongsToClient(
  lease: ModelCacheLoadLease,
  senderClientId: string,
): boolean {
  return senderClientId === lease.pageClientId || senderClientId === lease.workerClientId;
}
