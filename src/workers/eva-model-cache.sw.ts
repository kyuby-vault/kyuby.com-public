/// <reference lib="webworker" />

import { ModelIntegrityError, verifyBlobIntegrity } from '../lib/eva/model-cache/integrity';
import { ModelDigestTimeoutError } from '../lib/eva/model-cache/digest-scheduler';
import { acquireModelChunks, RangeUnavailableError } from '../lib/eva/model-cache/acquisition';
import { acquireWithRetry, acquisitionNetworkOperation, isAcquisitionNetworkError, AcquisitionNetworkError, DESKTOP_CHUNK_BYTES } from '../lib/eva/model-cache/resilience';
import { writeOpfsStream } from '../lib/eva/model-cache/opfs-files';
import { arbitrateModelLeases, sameLeasePackage } from '../lib/eva/model-cache/arbitration';
import { parseModelCacheManifestBytes } from '../lib/eva/model-cache/manifest';
import {
  MODEL_CACHE_PROTOCOL_VERSION,
  MODEL_CACHE_LOAD_LEASE_IDLE_MS,
  MODEL_CACHE_LOAD_LEASE_ABSOLUTE_MS,
  bindModelCacheClientMessage,
  claimModelCacheLoadLease,
  createModelCacheLoadLease,
  isModelCacheLoadLeaseExpired,
  modelCacheLoadLeaseBelongsToClient,
  renewModelCacheLoadLease,
  type BoundModelCacheClientMessage,
  type ModelCacheClientMessage,
  type ModelCacheLoadLease,
  type ModelCacheWorkerMessage,
} from '../lib/eva/model-cache/protocol';
import { createModelBlobResponse } from '../lib/eva/model-cache/range';
import {
  checkModelCacheNetworkResponse,
  createModelCacheRouteConfig,
  routeModelCacheRequest,
  type ModelCacheRoute,
  type ModelCacheRouteConfig,
} from '../lib/eva/model-cache/routing';
import {
  ModelCacheStore,
  createModelCacheManifestKey,
  createModelCachePackageKey,
  createStoredManifestResponse,
  isEvaModelCacheWorkerClientUrl,
  openPersistentModelCacheStore,
  readBoundedManifestBytes,
  type ModelCachePackageDescriptor,
} from '../lib/eva/model-cache/store';
import type {
  ModelCacheInventory,
  ModelCachePresentManifestFile,
  ModelCacheStatus,
  ModelCacheWarning,
} from '../lib/eva/model-cache/types';

declare const self: ServiceWorkerGlobalScope;
declare const __EVA_CONFIGURED_DEVELOPMENT_MODEL_ORIGIN__: string;
declare const __EVA_MODEL_CACHE_DEV__: boolean;

const MAX_ACTIVE_LOAD_LEASES = 8;
const MAX_ARTIFACT_TRANSFERS = 2;
const PROGRESS_INTERVAL_MS = 250;
const MODEL_CACHE_MINIMUM_HEADROOM_BYTES = 256 * 1024 * 1024;
const reverifyingRoots = new Map<string, string>();

interface ConfiguredVersion {
  inventory: ModelCacheInventory;
  route: ModelCacheRouteConfig;
}

interface ConfiguredRoot {
  modelOrigin: string;
  modelRootPath: string;
  manifestRoute: ModelCacheRouteConfig;
  versions: Map<string, ConfiguredVersion>;
  activeVersion: string | null;
  networkInventory: ModelCacheInventory | null;
  clientIds: Set<string>;
}

interface MatchedFetchRoute {
  root: ConfiguredRoot;
  version: ConfiguredVersion | null;
  route: Exclude<ModelCacheRoute, { kind: 'bypass' }>;
  lease: ModelCacheLoadLease | null;
}

interface ArtifactResult {
  blob: Blob;
  source: 'disk' | 'network';
}

interface ArtifactAcquisitionContext {
  controller: AbortController;
  leaseNonces: Set<string>;
  rootKey: string;
  modelOrigin: string;
  modelRootPath: string;
  manifestVersion: string;
  hashReports: Map<string, { phase: string; at: number }>;
}

interface ArtifactAcquisition extends ArtifactAcquisitionContext {
  promise: Promise<ArtifactResult>;
}

class AsyncSemaphore {
  #active = 0;
  #limit: number;
  #waiting: Array<() => void> = [];

  constructor(size: number) {
    this.#limit = size;
  }

  setLimit(limit: number): void { this.#limit = limit; this.#drain(); }
  #drain(): void {
    while (this.#active < this.#limit && this.#waiting.length) { this.#active += 1; this.#waiting.shift()!(); }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => { this.#waiting.push(resolve); this.#drain(); });
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#drain();
    }
  }
}

const configuredRoots = new Map<string, ConfiguredRoot>();
const selectedVersions = new Map<string, string>();
const loadLeases = new Map<string, ModelCacheLoadLease>();
const completedLeases = new Set<string>();
let clientCheckAt = 0;
const leaseFailures = new Map<string, Map<string, unknown>>();
const artifactAcquisitions = new Map<string, ArtifactAcquisition>();
const transferSemaphore = new AsyncSemaphore(MAX_ARTIFACT_TRANSFERS);
let storePromise: Promise<ModelCacheStore | null> | null = null;
let developmentBackend: 'auto' | 'opfs' | 'none' = 'auto';
let developmentFailNextWriteWithQuota = false;
let developmentQuotaAfterOffset = 0;
let developmentStateReset: Promise<void> | null = null;
let developmentDropRenew = false;

function modelRootKey(modelOrigin: string, modelRootPath: string): string {
  return JSON.stringify([modelOrigin, modelRootPath]);
}

function clientRootKey(clientId: string, rootKey: string): string {
  return JSON.stringify([clientId, rootKey]);
}

function getStore(): Promise<ModelCacheStore | null> {
  if (__EVA_MODEL_CACHE_DEV__ && developmentBackend === 'none') {
    return Promise.resolve(null);
  }
  storePromise ??= openPersistentModelCacheStore(
    Date.now,
    __EVA_MODEL_CACHE_DEV__ && developmentBackend !== 'none' ? developmentBackend : 'auto',
  ).catch(() => null);
  return storePromise;
}

function isLoopbackClient(client: Client): boolean {
  try {
    const hostname = new URL(client.url).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

async function handleDevelopmentFault(event: ExtendableMessageEvent, client: Client): Promise<boolean> {
  if (!__EVA_MODEL_CACHE_DEV__ || !isLoopbackClient(client)) {
    return false;
  }
  const value = event.data;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  if (message.protocolVersion !== MODEL_CACHE_PROTOCOL_VERSION
    || message.type !== 'DEV_CACHE_FAULT'
    || typeof message.requestId !== 'string'
    || message.requestId.length === 0
    || message.requestId.length > 128
    || typeof message.modelOrigin !== 'string'
    || typeof message.modelRootPath !== 'string') {
    return false;
  }
  const root = configuredRoots.get(modelRootKey(message.modelOrigin, message.modelRootPath));
  if (!root) {
    postRpcResponse(event, client, { ok: false, reason: 'NOT_CONFIGURED' });
    return true;
  }

  if (message.action === 'force-backend'
    && (message.backend === 'auto'
      || message.backend === 'opfs'
      || message.backend === 'none')) {
    const previous = await storePromise?.catch(() => null);
    previous?.close();
    developmentBackend = message.backend;
    storePromise = null;
    const selected = await getStore();
    const ok = message.backend === 'none' || selected?.backendKind === message.backend || message.backend === 'auto';
    postRpcResponse(event, client, { ok, backend: selected?.backendKind ?? 'unavailable' });
    return true;
  }
  if (message.action === 'fail-next-write-quota') {
    developmentFailNextWriteWithQuota = true;
    developmentQuotaAfterOffset = typeof message.afterOffset === 'number' && Number.isSafeInteger(message.afterOffset)
      ? Math.max(0, message.afterOffset) : 0;
    postRpcResponse(event, client, { ok: true });
    return true;
  }
  if (message.action === 'restart-sw-state') {
    // DEV only: mimic loss of the global, not deletion of durable bytes/metadata.
    const pending = [...artifactAcquisitions.values()].map((entry) => entry.promise);
    abortArtifactAcquisitions(() => true, 'Injected cache service restart.');
    configuredRoots.clear(); selectedVersions.clear(); loadLeases.clear(); leaseFailures.clear(); completedLeases.clear();
    const previousStore = storePromise;
    developmentStateReset = (async () => {
      await Promise.allSettled(pending);
      (await previousStore)?.close();
      storePromise = null;
      artifactAcquisitions.clear();
    })();
    await developmentStateReset;
    developmentStateReset = null;
    postRpcResponse(event, client, { ok: true });
    return true;
  }
  if (message.action === 'drop-next-renew') {
    developmentDropRenew = true;
    postRpcResponse(event, client, { ok: true });
    return true;
  }
  if (message.action === 'expire-manifest') {
    const store = await getStore();
    if (!store) {
      postRpcResponse(event, client, { ok: false, reason: 'ENTRY_UNAVAILABLE' });
      return true;
    }
    await store.expireStoredManifestForDevelopment(root.modelOrigin, root.modelRootPath);
    postRpcResponse(event, client, { ok: true });
    return true;
  }
  if ((message.action === 'delete-entry' || message.action === 'mutate-entry')
    && typeof message.manifestVersion === 'string'
    && typeof message.path === 'string'
    && message.path.length <= 512) {
    const version = root.versions.get(message.manifestVersion);
    const store = await getStore();
    if (!version || !store) {
      postRpcResponse(event, client, { ok: false, reason: 'ENTRY_UNAVAILABLE' });
      return true;
    }
    if (message.action === 'mutate-entry') {
      await store.corruptFileForDevelopment({ inventory: version.inventory }, message.path);
    } else {
      await store.invalidateFile({ inventory: version.inventory }, message.path);
    }
    postRpcResponse(event, client, { ok: true });
    return true;
  }
  postRpcResponse(event, client, { ok: false, reason: 'BAD_FAULT' });
  return true;
}

function configuredDevelopmentOrigin(): string | null {
  const configured = __EVA_CONFIGURED_DEVELOPMENT_MODEL_ORIGIN__.trim();
  if (!configured) {
    return null;
  }
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

function sourceClient(event: ExtendableMessageEvent): Client | null {
  const source = event.source;
  if (!source || typeof source !== 'object' || !('id' in source) || !('url' in source)) {
    return null;
  }
  return source as Client;
}

function pruneExpiredLeases(now = Date.now()): void {
  for (const [nonce, lease] of loadLeases) {
    if (isModelCacheLoadLeaseExpired(lease, now)) {
      loadLeases.delete(nonce);
      releaseLeaseFromArtifactAcquisitions(nonce, 'The explicit Eva model load lease expired.');
      void getStore().then((store) => store?.endVerificationScope(nonce));
    }
  }
  for (const nonce of leaseFailures.keys()) if (!loadLeases.has(nonce)) leaseFailures.delete(nonce);
}

function releaseLeaseFromArtifactAcquisitions(nonce: string, reason: string): void {
  leaseFailures.delete(nonce);
  completedLeases.delete(nonce);
  arbitrateModelLeases(loadLeases.values());
  for (const acquisition of artifactAcquisitions.values()) {
    if (acquisition.leaseNonces.delete(nonce)
      && acquisition.leaseNonces.size === 0
      && !acquisition.controller.signal.aborted) {
      acquisition.controller.abort(new DOMException(reason, 'AbortError'));
    }
  }
}

async function acquisitionActivity(context: ArtifactAcquisitionContext): Promise<ModelCacheLoadLease[]> {
  const now = Date.now();
  // Client liveness is separate from idle work liveness. Do not renew a dead
  // owner's authority forever merely because an attached tab is downloading.
  if (now - clientCheckAt >= 1_000) {
    clientCheckAt = now;
    const clients = new Set((await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).map(client => client.id));
    for (const [nonce, lease] of loadLeases) {
      if (!clients.has(lease.pageClientId)) {
        loadLeases.delete(nonce);
        releaseLeaseFromArtifactAcquisitions(nonce, 'Acquiring page closed.');
      }
    }
  }
  const leases = liveAcquisitionLeases(context);
  for (const lease of leases) lease.lastActivityAt = now;
  return leases;
}

async function packageComplete(root: ConfiguredRoot, version: string): Promise<void> {
  const inventory = root.versions.get(version)?.inventory;
  if (!inventory || (await (await getStore())?.getPackage({ inventory }))?.state !== 'complete') return;
  for (const lease of loadLeases.values()) {
    if (!sameLeasePackage(lease, { ...root, manifestVersion: version }) || completedLeases.has(lease.nonce)) continue;
    completedLeases.add(lease.nonce); // before any await: exactly once per lease
    await postToClient(lease.pageClientId, {
      ...workerMessageBase(lease.pageClientId, lease, version), type: 'PACKAGE_COMPLETE', nonce: lease.nonce,
    });
  }
}

function abortArtifactAcquisitions(
  matches: (acquisition: ArtifactAcquisition) => boolean,
  reason: string,
): void {
  for (const acquisition of artifactAcquisitions.values()) {
    if (matches(acquisition) && !acquisition.controller.signal.aborted) {
      acquisition.controller.abort(new DOMException(reason, 'AbortError'));
    }
  }
}

function requireLiveLease(
  expected: ModelCacheLoadLease,
  signal?: AbortSignal,
): ModelCacheLoadLease {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The Eva model transfer was aborted.', 'AbortError');
  }
  const active = loadLeases.get(expected.nonce);
  if (!active
    || active.modelOrigin !== expected.modelOrigin
    || active.modelRootPath !== expected.modelRootPath
    || active.manifestVersion !== expected.manifestVersion
    || isModelCacheLoadLeaseExpired(active, Date.now())) {
    throw new DOMException('The explicit Eva model load lease is no longer active.', 'AbortError');
  }
  return active;
}

function liveAcquisitionLeases(context: ArtifactAcquisitionContext): ModelCacheLoadLease[] {
  if (context.controller.signal.aborted) {
    throw context.controller.signal.reason
      ?? new DOMException('The Eva model transfer was aborted.', 'AbortError');
  }
  const now = Date.now();
  const active: ModelCacheLoadLease[] = [];
  for (const nonce of [...context.leaseNonces]) {
    const lease = loadLeases.get(nonce);
    if (!lease
      || lease.modelOrigin !== context.modelOrigin
      || lease.modelRootPath !== context.modelRootPath
      || lease.manifestVersion !== context.manifestVersion
      || isModelCacheLoadLeaseExpired(lease, now)) {
      context.leaseNonces.delete(nonce);
      if (lease && isModelCacheLoadLeaseExpired(lease, now)) {
        loadLeases.delete(nonce);
        arbitrateModelLeases(loadLeases.values());
        void getStore().then((store) => store?.endVerificationScope(nonce));
      }
      continue;
    }
    active.push(lease);
  }
  if (active.length === 0) {
    if (!context.controller.signal.aborted) {
      context.controller.abort(new DOMException(
        'No explicit Eva model load lease remains active.',
        'AbortError',
      ));
    }
    throw context.controller.signal.reason;
  }
  return active;
}

function requireLiveAcquisitionLease(context: ArtifactAcquisitionContext): ModelCacheLoadLease {
  return liveAcquisitionLeases(context)[0];
}

function leaseForClient(clientId: string, root: ConfiguredRoot): ModelCacheLoadLease | null {
  pruneExpiredLeases();
  for (const lease of loadLeases.values()) {
    if (lease.modelOrigin === root.modelOrigin
      && lease.modelRootPath === root.modelRootPath
      && modelCacheLoadLeaseBelongsToClient(lease, clientId)) {
      return lease;
    }
  }
  return null;
}

function bindLeaseToWorker(lease: ModelCacheLoadLease, workerClientId: string): ModelCacheLoadLease {
  const bound = {
    ...lease,
    workerClientId,
    lastActivityAt: Date.now(),
  };
  loadLeases.set(lease.nonce, bound);
  const root = configuredRoots.get(modelRootKey(lease.modelOrigin, lease.modelRootPath));
  root?.clientIds.add(workerClientId);
  return bound;
}

async function observeInferenceWorkerCreation(event: FetchEvent): Promise<void> {
  if (event.request.destination !== 'worker'
    || !event.clientId
    || !event.resultingClientId
    || !isEvaModelCacheWorkerClientUrl(event.request.url, self.location.origin)) {
    return;
  }
  pruneExpiredLeases();
  const candidates = [...loadLeases.values()].filter((lease) => (
    lease.pageClientId === event.clientId && lease.workerClientId === null
  ));
  if (candidates.length !== 1 || event.resultingClientId === event.clientId) {
    return;
  }
  bindLeaseToWorker(candidates[0], event.resultingClientId);
}

async function claimLeaseFromFirstArtifact(
  matched: MatchedFetchRoute,
  clientId: string,
): Promise<ModelCacheLoadLease | null> {
  if (matched.lease || !matched.version || !clientId) {
    return matched.lease;
  }
  pruneExpiredLeases();
  const version = matched.version.inventory.manifestIdentity.manifestVersion;
  let candidates = [...loadLeases.values()].filter((lease) => (
    lease.modelOrigin === matched.root.modelOrigin
    && lease.modelRootPath === matched.root.modelRootPath
    && lease.manifestVersion === version
    && lease.workerClientId === null
  ));
  if (candidates.length !== 1) {
    return null;
  }
  const client = await self.clients.get(clientId);
  if (!client
    || client.type !== 'worker'
    || !isEvaModelCacheWorkerClientUrl(client.url, self.location.origin)) {
    return null;
  }

  // Recheck after the asynchronous Client lookup so two concurrent shard
  // requests cannot claim two different explicit page leases.
  pruneExpiredLeases();
  candidates = [...loadLeases.values()].filter((lease) => (
    lease.modelOrigin === matched.root.modelOrigin
    && lease.modelRootPath === matched.root.modelRootPath
    && lease.manifestVersion === version
    && lease.workerClientId === null
  ));
  if (candidates.length !== 1) {
    return leaseForClient(clientId, matched.root);
  }
  return bindLeaseToWorker(candidates[0], clientId);
}

function findFetchRoute(request: Request, clientId: string): MatchedFetchRoute | null {
  for (const [rootKey, root] of configuredRoots) {
    const manifestRoute = routeModelCacheRequest(request, root.manifestRoute);
    if (manifestRoute.kind === 'manifest') {
      return { root, version: null, route: manifestRoute, lease: null };
    }

    const lease = clientId ? leaseForClient(clientId, root) : null;
    const selectedVersion = lease?.manifestVersion
      ?? selectedVersions.get(clientRootKey(clientId, rootKey))
      ?? root.activeVersion;
    const version = selectedVersion ? root.versions.get(selectedVersion) ?? null : null;
    if (!version) {
      continue;
    }
    const artifactRoute = routeModelCacheRequest(request, version.route);
    if (artifactRoute.kind === 'artifact') {
      return { root, version, route: artifactRoute, lease };
    }
  }
  return null;
}

function postRpcResponse(
  event: ExtendableMessageEvent,
  client: Client,
  response: unknown,
): void {
  if (event.ports[0]) {
    event.ports[0].postMessage(response);
  } else {
    client.postMessage(response);
  }
}

async function postToClient(clientId: string, message: ModelCacheWorkerMessage): Promise<void> {
  const client = await self.clients.get(clientId);
  client?.postMessage(message);
}

function workerMessageBase<T extends string | null>(
  clientId: string,
  root: Pick<ConfiguredRoot, 'modelOrigin' | 'modelRootPath'>,
  manifestVersion: T,
  requestId = `cache-${crypto.randomUUID()}`,
) {
  return {
    protocolVersion: MODEL_CACHE_PROTOCOL_VERSION,
    requestId,
    clientId,
    modelOrigin: root.modelOrigin,
    modelRootPath: root.modelRootPath,
    manifestVersion,
  } as const;
}

async function inspectStoragePolicy(): Promise<Pick<ModelCacheStatus, 'persistence' | 'estimate'>> {
  let persistence: ModelCacheStatus['persistence'] = 'browser-managed';
  let estimate: ModelCacheStatus['estimate'] = { usage: null, quota: null };
  try {
    if (navigator.storage?.persisted) {
      persistence = await navigator.storage.persisted() ? 'persistent' : 'best-effort';
    }
  } catch {
    // Browser-managed remains the truthful fallback.
  }
  try {
    if (navigator.storage?.estimate) {
      const value = await navigator.storage.estimate();
      estimate = {
        usage: typeof value.usage === 'number' ? value.usage : null,
        quota: typeof value.quota === 'number' ? value.quota : null,
      };
    }
  } catch {
    // Null numbers explicitly mean unavailable.
  }
  return { persistence, estimate };
}

async function createStatus(
  root: ConfiguredRoot,
  requestedVersion: string | null,
  warning: ModelCacheWarning | null = null,
  cacheAction: ModelCacheStatus['cacheAction'] = 'idle',
): Promise<ModelCacheStatus> {
  const store = await getStore();
  const version = requestedVersion ?? root.activeVersion;
  const configured = version ? root.versions.get(version) ?? null : null;
  const packageRecord = store && configured
    ? await store.getPackage({ inventory: configured.inventory })
    : null;
  const cachedBytes = store && packageRecord
    ? await store.getPackageCachedBytes(packageRecord.key)
    : 0;
  const policy = await inspectStoragePolicy();
  return {
    modelOrigin: root.modelOrigin,
    modelRootPath: root.modelRootPath,
    manifestVersion: configured?.inventory.manifestIdentity.manifestVersion ?? version,
    totalBytes: configured?.inventory.totalBytes ?? null,
    cachedBytes,
    residency: packageRecord?.state === 'complete' ? 'on-disk' : 'network-only',
    backend: store?.backendKind ?? 'unavailable',
    ...policy,
    cacheAction,
    integrity: packageRecord?.state === 'complete' ? 'verified' : 'unverified',
    warning,
  };
}

async function replyStatus(
  event: ExtendableMessageEvent,
  client: Client,
  message: ModelCacheClientMessage,
  root: ConfiguredRoot,
  warning: ModelCacheWarning | null = null,
): Promise<void> {
  const status = await createStatus(root, message.manifestVersion, warning);
  const response: ModelCacheWorkerMessage = {
    ...workerMessageBase(client.id, root, status.manifestVersion, message.requestId),
    type: 'STATUS',
    status,
  };
  postRpcResponse(event, client, response);
}

function replyError(
  event: ExtendableMessageEvent,
  client: Client,
  message: ModelCacheClientMessage,
  code: Extract<ModelCacheWorkerMessage, { type: 'ERROR' }>['code'],
  text: string,
): void {
  const response: ModelCacheWorkerMessage = {
    ...workerMessageBase(
      client.id,
      { modelOrigin: message.modelOrigin, modelRootPath: message.modelRootPath },
      message.manifestVersion,
      message.requestId,
    ),
    type: 'ERROR',
    code,
    message: text,
    recoverable: true,
  };
  postRpcResponse(event, client, response);
}

function inventoriesMatch(left: ModelCacheInventory, right: ModelCacheInventory): boolean {
  if (left.schemaVersion !== right.schemaVersion
    || left.modelOrigin !== right.modelOrigin
    || left.modelRootPath !== right.modelRootPath
    || left.totalBytes !== right.totalBytes
    || left.manifestIdentity.manifestVersion !== right.manifestIdentity.manifestVersion
    || left.manifestIdentity.strongEtag !== right.manifestIdentity.strongEtag
    || left.manifestIdentity.rawSha256 !== right.manifestIdentity.rawSha256
    || left.files.length !== right.files.length) {
    return false;
  }
  return left.files.every((file, index) => {
    const expected = right.files[index];
    return Boolean(expected)
      && file.path === expected.path
      && file.role === expected.role
      && file.required === expected.required
      && file.present === expected.present
      && file.bytes === expected.bytes
      && file.sha256 === expected.sha256
      && file.contentType === expected.contentType;
  });
}

async function configureRoot(
  bound: BoundModelCacheClientMessage,
  client: Client,
): Promise<ConfiguredRoot> {
  const { message } = bound;
  if (message.type !== 'CONFIGURE') {
    throw new TypeError('Expected CONFIGURE.');
  }
  const inventoryPaths = message.inventory?.files.map((file) => file.path) ?? [];
  const route = createModelCacheRouteConfig({
    appUrl: client.url,
    modelOrigin: message.modelOrigin,
    modelRootPath: message.modelRootPath,
    inventoryPaths,
    configuredDevelopmentModelOrigin: configuredDevelopmentOrigin(),
  });
  const key = modelRootKey(message.modelOrigin, message.modelRootPath);
  if (message.inventory) {
    const store = await getStore();
    const stored = await store?.getStoredManifest(message.modelOrigin, message.modelRootPath);
    const validated = [stored?.inventory, configuredRoots.get(key)?.networkInventory]
      .find((inventory) => inventory?.manifestIdentity.manifestVersion === message.manifestVersion
        && inventoriesMatch(inventory, message.inventory!));
    if (!validated) {
      throw new Error('The configured Eva inventory does not match the Service Worker validated manifest.');
    }
  }
  const existing = configuredRoots.get(key);
  const root: ConfiguredRoot = existing ?? {
    modelOrigin: message.modelOrigin,
    modelRootPath: message.modelRootPath,
    manifestRoute: createModelCacheRouteConfig({
      appUrl: client.url,
      modelOrigin: message.modelOrigin,
      modelRootPath: message.modelRootPath,
      inventoryPaths: [],
      configuredDevelopmentModelOrigin: configuredDevelopmentOrigin(),
    }),
    versions: new Map(),
    activeVersion: null,
    networkInventory: null,
    clientIds: new Set(),
  };
  root.clientIds.add(client.id);
  if (message.inventory) {
    const version = message.inventory.manifestIdentity.manifestVersion;
    root.versions.set(version, { inventory: message.inventory, route });
    root.activeVersion = version;
    selectedVersions.set(clientRootKey(client.id, key), version);
  }
  configuredRoots.set(key, root);
  return root;
}

async function handleClientMessage(event: ExtendableMessageEvent): Promise<void> {
  const client = sourceClient(event);
  if (!client) {
    return;
  }
  if (developmentStateReset) await developmentStateReset;
  if (__EVA_MODEL_CACHE_DEV__ && await handleDevelopmentFault(event, client)) {
    return;
  }
  const bound = bindModelCacheClientMessage(event.data, client.id);
  if (!bound) {
    postRpcResponse(event, client, { ok: false, reason: 'BAD_MESSAGE' });
    return;
  }
  const { message } = bound;
  const key = modelRootKey(message.modelOrigin, message.modelRootPath);

  if (message.type === 'CONFIGURE') {
    try {
      const root = await configureRoot(bound, client);
      await replyStatus(event, client, message, root);
    } catch (error) {
      replyError(event, client, message, 'NOT_CONFIGURED', error instanceof Error ? error.message : String(error));
    }
    return;
  }

  const root = configuredRoots.get(key);
  if (!root) {
    if (message.type === 'CLAIM_LOAD') {
      postRpcResponse(event, client, { ok: false, reason: 'NOT_CONFIGURED' });
    } else {
      replyError(event, client, message, 'NOT_CONFIGURED', 'The Eva model cache root is not configured.');
    }
    return;
  }
  root.clientIds.add(client.id);

  if (message.type === 'GET_STATUS') {
    await replyStatus(event, client, message, root);
    return;
  }
  if ((message.type === 'BEGIN_LOAD' || message.type === 'BEGIN_DISK_LOAD' || message.type === 'REMOVE_MODEL' || message.type === 'REVERIFY')
    && reverifyingRoots.has(key)) {
    replyError(event, client, message, 'CACHE_FAILED', 'Local verification is already running. Please wait.');
    return;
  }
  if (message.type === 'REVERIFY') {
    pruneExpiredLeases();
    const version = root.versions.get(message.manifestVersion);
    if (client.type !== 'window' || !version
      || selectedVersions.get(clientRootKey(client.id, key)) !== message.manifestVersion
      || [...loadLeases.values()].some((lease) => modelRootKey(lease.modelOrigin, lease.modelRootPath) === key)) {
      replyError(event, client, message, 'CACHE_FAILED', 'Re-verification requires a configured page and no active model load.');
      return;
    }
    const descriptor = { inventory: version.inventory };
    reverifyingRoots.set(key, createModelCachePackageKey(root.modelOrigin, root.modelRootPath, message.manifestVersion));
    try {
      const store = await getStore();
      if (!store) throw new Error('Durable model storage is unavailable.');
      const files: Array<{ file: string; status: 'passed' | 'failed' }> = [];
      for (const file of version.inventory.files.filter((entry) => entry.present)) {
        // Deliberately no fetch and no lease: a mismatch is dropped, repaired only on explicit Load.
        const blob = await store.readFile(descriptor, file.path, {
          reverify: true,
          onVerifyProgress: async (loadedBytes) => {
            await postToClient(client.id, {
              ...workerMessageBase(client.id, root, message.manifestVersion, message.requestId),
              type: 'FILE_PROGRESS', file: file.path, source: 'disk', phase: 'verifying',
              loadedBytes, totalBytes: file.bytes, receivedBytes: 0, verifiedBytes: 0,
            });
          },
        });
        files.push({ file: file.path, status: blob ? 'passed' : 'failed' });
      }
      const failed = files.some((file) => file.status === 'failed');
      const warning: ModelCacheWarning | null = failed ? {
        code: 'cache-corrupt', message: 'Local verification failed. Invalid files were removed. Unload Eva if needed, then explicitly Load to repair missing files.', recoverable: true,
      } : null;
      const status = await createStatus(root, message.manifestVersion, warning);
      if (failed) status.integrity = 'failed';
      postRpcResponse(event, client, {
        ...workerMessageBase(client.id, root, message.manifestVersion, message.requestId),
        type: 'VERIFY_RESULT', files, status,
      } satisfies ModelCacheWorkerMessage);
    } catch (error) {
      replyError(event, client, message, 'CACHE_FAILED', error instanceof Error ? error.message : String(error));
    } finally { reverifyingRoots.delete(key); }
    return;
  }
  if (message.type === 'BEGIN_LOAD' || message.type === 'BEGIN_DISK_LOAD') {
    pruneExpiredLeases();
    if (client.type !== 'window' || selectedVersions.get(clientRootKey(client.id, key)) !== message.manifestVersion) {
      replyError(event, client, message, 'LEASE_REJECTED', 'An explicitly configured page must request the load lease.');
      return;
    }
    const previous = loadLeases.get(message.nonce);
    // A lost ACK is replayed with the SAME explicit nonce, never a new lease.
    if (previous && previous.pageClientId === client.id && sameLeasePackage(previous, message)
      && previous.diskOnly === (message.type === 'BEGIN_DISK_LOAD')) {
      await replyStatus(event, client, message, root);
      return;
    }
    if (!root.versions.has(message.manifestVersion)
      || loadLeases.has(message.nonce)
      || loadLeases.size >= MAX_ACTIVE_LOAD_LEASES) {
      replyError(event, client, message, 'LEASE_REJECTED', 'The Eva model-cache load lease was rejected.');
      return;
    }
    if (message.type === 'BEGIN_DISK_LOAD') {
      const store = await getStore();
      const inventory = root.versions.get(message.manifestVersion)!.inventory;
      if (client.type !== 'window' || selectedVersions.get(clientRootKey(client.id, key)) !== message.manifestVersion
        || (await store?.getPackage({ inventory }))?.state !== 'complete') {
        replyError(event, client, message, 'LEASE_REJECTED', 'A complete local package is required for disk-only loading.');
        return;
      }
    }
    const lease = createModelCacheLoadLease(message, client.id, Date.now());
    lease.chunkBytes = message.chunkBytes;
    if (loadLeases.size === 0) transferSemaphore.setLimit(message.concurrency ?? 2);
    loadLeases.set(lease.nonce, lease);
    arbitrateModelLeases(loadLeases.values());
    for (const acquisition of artifactAcquisitions.values()) {
      if (!lease.diskOnly && sameLeasePackage(lease, acquisition) && !acquisition.controller.signal.aborted) {
        acquisition.leaseNonces.add(lease.nonce);
      }
    }
    await postToClient(client.id, {
      ...workerMessageBase(client.id, lease, lease.manifestVersion), type: 'LEASE_STATE', nonce: lease.nonce, kind: lease.kind,
    });
    await replyStatus(event, client, message, root);
    return;
  }
  if (message.type === 'CLAIM_LOAD') {
    const lease = loadLeases.get(message.nonce);
    const result = lease
      ? claimModelCacheLoadLease(lease, message, client.id, Date.now())
      : { ok: false as const, reason: 'nonce' as const };
    if (result.ok) {
      loadLeases.set(message.nonce, result.lease);
      root.clientIds.add(client.id);
    }
    postRpcResponse(event, client, result.ok ? { ok: true } : { ok: false, reason: result.reason });
    return;
  }
  if (message.type === 'RENEW_LOAD') {
    if (__EVA_MODEL_CACHE_DEV__ && developmentDropRenew) { developmentDropRenew = false; return; }
    const lease = loadLeases.get(message.nonce);
    const result = lease
      ? renewModelCacheLoadLease(lease, message, client.id, Date.now())
      : { ok: false as const, reason: 'nonce' as const };
    if (!result.ok) {
      replyError(event, client, message, 'LEASE_REJECTED', `The Eva model-cache lease is ${result.reason}.`);
      return;
    }
    loadLeases.set(message.nonce, result.lease);
    // Liveness only: deliberately no store lookup or storage.estimate roundtrip.
    postRpcResponse(event, client, {
      ...workerMessageBase(client.id, root, message.manifestVersion, message.requestId),
      type: 'RENEW_ACK', nonce: message.nonce,
      expiresAt: Math.min(result.lease.lastActivityAt + MODEL_CACHE_LOAD_LEASE_IDLE_MS,
        result.lease.createdAt + MODEL_CACHE_LOAD_LEASE_ABSOLUTE_MS),
    } satisfies ModelCacheWorkerMessage);
    return;
  }
  if (message.type === 'END_LOAD' || message.type === 'CANCEL_LOAD') {
    const lease = loadLeases.get(message.nonce);
    const result = lease
      ? renewModelCacheLoadLease(lease, message, client.id, Date.now())
      : { ok: false as const, reason: 'nonce' as const };
    if (!result.ok) {
      replyError(event, client, message, 'LEASE_REJECTED', `The Eva model-cache lease is ${result.reason}.`);
      return;
    }
    const ending = [...artifactAcquisitions.values()].filter((entry) => entry.leaseNonces.has(message.nonce) && entry.leaseNonces.size === 1).map((entry) => entry.promise);
    loadLeases.delete(message.nonce);
    releaseLeaseFromArtifactAcquisitions(
      message.nonce,
      `The Eva model transfer was ${message.type === 'END_LOAD' ? 'ended' : 'cancelled'}.`,
    );
    await Promise.allSettled(ending);
    (await getStore())?.endVerificationScope(message.nonce);
    await replyStatus(event, client, message, root);
    return;
  }
  if (message.type === 'REMOVE_MODEL') {
    const store = await getStore();
    if (!store) {
      replyError(event, client, message, 'REMOVE_FAILED', 'Durable model storage is unavailable.');
      return;
    }
    try {
      abortArtifactAcquisitions(
        (acquisition) => acquisition.rootKey === key,
        'Eva was removed from this device.',
      );
      for (const [nonce, lease] of loadLeases) {
        if (lease.modelOrigin === root.modelOrigin && lease.modelRootPath === root.modelRootPath) {
          loadLeases.delete(nonce);
          store.endVerificationScope(nonce);
        }
      }
      const removedBytes = await store.removeModel(root.modelOrigin, root.modelRootPath);
      const status = await createStatus(root, root.activeVersion);
      const response: ModelCacheWorkerMessage = {
        ...workerMessageBase(client.id, root, null, message.requestId),
        type: 'REMOVE_RESULT',
        removed: removedBytes > 0,
        removedBytes,
        status: { ...status, manifestVersion: null, totalBytes: null },
      };
      postRpcResponse(event, client, response);
    } catch (error) {
      replyError(event, client, message, 'REMOVE_FAILED', error instanceof Error ? error.message : String(error));
    }
  }
}

async function broadcastManifestUpdate(
  root: ConfiguredRoot,
  previousManifestVersion: string,
  newManifestVersion: string,
): Promise<void> {
  await Promise.all([...root.clientIds].map((clientId) => postToClient(clientId, {
    ...workerMessageBase(clientId, root, newManifestVersion),
    type: 'MANIFEST_UPDATED',
    previousManifestVersion,
    newManifestVersion,
  })));
}

async function broadcastWarning(
  root: ConfiguredRoot,
  manifestVersion: string | null,
  warning: ModelCacheWarning,
): Promise<void> {
  await Promise.all([...root.clientIds].map((clientId) => postToClient(clientId, {
    ...workerMessageBase(clientId, root, manifestVersion),
    type: 'CACHE_WARNING',
    warning,
  })));
}

async function handleManifestFetch(
  request: Request,
  root: ConfiguredRoot,
  schedule: (work: Promise<void>) => void,
): Promise<Response> {
  const store = await getStore();
  const manifestUrl = `${root.modelOrigin}${root.manifestRoute.manifestPathname}`;
  if (!store) {
    if (request.method === 'HEAD') return fetch(request);
    const response = await fetch(manifestUrl, {
      method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const check = checkModelCacheNetworkResponse(response, manifestUrl);
    if (!check.ok) throw new Error(`Eva manifest response was rejected (${check.reason}).`);
    const rawBytes = await readBoundedManifestBytes(response);
    const { inventory } = parseModelCacheManifestBytes(rawBytes, {
      modelOrigin: root.modelOrigin, modelRootPath: root.modelRootPath, etag: response.headers.get('ETag'),
    });
    root.networkInventory = inventory;
    return createStoredManifestResponse({
      key: createModelCacheManifestKey(root.modelOrigin, root.modelRootPath),
      modelOrigin: root.modelOrigin, modelRootPath: root.modelRootPath,
      ...inventory.manifestIdentity, inventory, rawBytes,
      contentType: 'application/json', fetchedAt: Date.now(), freshUntil: 0,
    }, 'GET');
  }
  if (request.method === 'HEAD') {
    const stored = await store.getStoredManifest(root.modelOrigin, root.modelRootPath);
    return stored ? createStoredManifestResponse(stored, 'HEAD') : fetch(request);
  }

  const hadStoredManifest = Boolean(await store.getStoredManifest(root.modelOrigin, root.modelRootPath));
  let initialNetworkResponse: Response | null = null;
  try {
    const resolved = await store.resolveManifest({
      modelOrigin: root.modelOrigin,
      modelRootPath: root.modelRootPath,
      fetchManifest: async ({ etag }) => {
        const headers = new Headers({ Accept: 'application/json' });
        if (etag) {
          headers.set('If-None-Match', etag);
        }
        const response = await fetch(manifestUrl, {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          headers,
        });
        if (!hadStoredManifest && response.status !== 304) {
          initialNetworkResponse = response.clone();
        }
        if (response.status !== 304) {
          const check = checkModelCacheNetworkResponse(response, manifestUrl);
          if (!check.ok) {
            throw new Error(`Eva manifest response was rejected (${check.reason}).`);
          }
        }
        return response;
      },
      validateManifest: (rawBytes, response) => {
        const { inventory } = parseModelCacheManifestBytes(rawBytes, {
          modelOrigin: root.modelOrigin,
          modelRootPath: root.modelRootPath,
          etag: response.headers.get('ETag'),
        });
        root.networkInventory = inventory;
        return inventory;
      },
      schedule,
    });

    if (resolved.revalidation) {
      const previousVersion = resolved.record.manifestVersion;
      schedule(resolved.revalidation.then(async (updated) => {
        if (updated.manifestVersion !== previousVersion) {
          await broadcastManifestUpdate(root, previousVersion, updated.manifestVersion);
        }
      }).catch(async () => {
        await broadcastWarning(root, previousVersion, {
          code: 'manifest-revalidation',
          message: 'Eva is using the last valid local manifest because revalidation failed.',
          recoverable: true,
        });
      }));
    }
    return createStoredManifestResponse(resolved.record, 'GET');
  } catch (error) {
    await broadcastWarning(root, root.activeVersion, {
      code: 'manifest-revalidation',
      message: error instanceof Error ? error.message : 'Eva manifest validation failed.',
      recoverable: true,
    });
    return initialNetworkResponse ?? fetch(request);
  }
}

function findPresentFile(
  inventory: ModelCacheInventory,
  path: string,
): ModelCachePresentManifestFile | null {
  const file = inventory.files.find((candidate) => candidate.path === path);
  return file?.present ? file : null;
}

function absentFileResponse(method: string): Response {
  return new Response(method === 'HEAD' ? null : '', {
    status: 404,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Length': '0',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

function explicitLoadRequiredResponse(method: string): Response {
  const body = 'An explicit Eva load lease is required for this model file.';
  return new Response(method === 'HEAD' ? null : body, {
    status: 409,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Length': String(new TextEncoder().encode(body).byteLength),
      'Content-Type': 'text/plain; charset=utf-8',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
}

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

async function postLeaseMessage(
  lease: ModelCacheLoadLease,
  messageFor: (clientId: string) => ModelCacheWorkerMessage,
): Promise<void> {
  const ids = [lease.pageClientId, lease.workerClientId].filter((value): value is string => Boolean(value));
  await Promise.all([...new Set(ids)].map((clientId) => postToClient(clientId, messageFor(clientId))));
}

async function reportSourceChange(
  lease: ModelCacheLoadLease,
  reason: Extract<ModelCacheWorkerMessage, { type: 'SOURCE_CHANGED' }>['reason'],
): Promise<void> {
  await postLeaseMessage(lease, (clientId) => ({
    ...workerMessageBase(clientId, lease, lease.manifestVersion),
    type: 'SOURCE_CHANGED',
    source: 'network',
    reason,
  }));
}

async function reportAcquisitionSourceChange(
  acquisition: ArtifactAcquisitionContext,
  reason: Extract<ModelCacheWorkerMessage, { type: 'SOURCE_CHANGED' }>['reason'],
): Promise<void> {
  await Promise.all(liveAcquisitionLeases(acquisition).map((lease) => reportSourceChange(lease, reason)));
}

function withDownloadProgress(
  body: ReadableStream<Uint8Array>,
  file: ModelCachePresentManifestFile,
  acquisition: ArtifactAcquisitionContext,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let loaded = 0;
  let lastReportAt = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        liveAcquisitionLeases(acquisition);
        const result = await acquisitionNetworkOperation(() => reader.read());
        const activeLeases = liveAcquisitionLeases(acquisition);
        if (result.done) {
          if (loaded !== file.bytes) {
            controller.error(new ModelIntegrityError(
              'LENGTH_MISMATCH',
              `Eva model file ${file.path} ended at ${loaded} of ${file.bytes} bytes.`,
            ));
            return;
          }
          controller.close();
          return;
        }
        loaded += result.value.byteLength;
        if (loaded > file.bytes) {
          await reader.cancel('Model body exceeded its manifested length.').catch(() => undefined);
          controller.error(new ModelIntegrityError(
            'LENGTH_MISMATCH',
            `Eva model file ${file.path} exceeded ${file.bytes} bytes.`,
          ));
          return;
        }
        const now = Date.now();
        for (const activeLease of activeLeases) {
          activeLease.lastActivityAt = now;
        }
        if (now - lastReportAt >= PROGRESS_INTERVAL_MS || loaded >= file.bytes) {
          lastReportAt = now;
          for (const activeLease of activeLeases) {
            void postLeaseMessage(activeLease, (clientId) => ({
              ...workerMessageBase(clientId, activeLease, activeLease.manifestVersion),
              type: 'FILE_PROGRESS',
              file: file.path,
              source: 'network',
              phase: 'downloading',
              loadedBytes: Math.min(loaded, file.bytes),
              totalBytes: file.bytes,
              receivedBytes: Math.min(loaded, file.bytes),
              verifiedBytes: 0,
              transfer: { durableBytes: 0, networkBytes: Math.min(loaded, file.bytes), resumedBytes: 0 },
            }));
          }
        }
        controller.enqueue(result.value);
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason?: unknown) {
      return reader.cancel(reason);
    },
  });
}

async function fetchFullArtifact(
  url: string,
  file: ModelCachePresentManifestFile,
  acquisition: ArtifactAcquisitionContext,
): Promise<Response> {
  const response = await acquisitionNetworkOperation(() => fetch(url, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: acquisition.controller.signal,
    headers: { Accept: file.contentType },
  }));
  const check = checkModelCacheNetworkResponse(response, url);
  if (response.status >= 500 && response.status <= 599) {
    await response.body?.cancel();
    throw new AcquisitionNetworkError('Model download service temporarily unavailable.');
  }
  if (!check.ok || response.status !== 200 || !response.body) {
    throw new Error(`Eva model file ${file.path} returned an unusable response.`);
  }
  return new Response(withDownloadProgress(response.body, file, acquisition), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function reportHashProgress(
  file: ModelCachePresentManifestFile,
  acquisition: ArtifactAcquisitionContext,
  loadedBytes: number,
  complete = false,
  phase: 'verifying' | 'committing' = 'verifying',
): Promise<void> {
  const leases = await acquisitionActivity(acquisition);
  const previous = acquisition.hashReports.get(file.path);
  const now = Date.now();
  if (!complete && loadedBytes !== file.bytes && previous?.phase === phase
    && now - previous.at < PROGRESS_INTERVAL_MS) return;
  acquisition.hashReports.set(file.path, { phase, at: now });
  for (const lease of leases) {
    await postLeaseMessage(lease, (clientId) => ({
      ...workerMessageBase(clientId, lease, lease.manifestVersion),
      type: 'FILE_PROGRESS', file: file.path, source: 'network',
      phase: complete ? 'done' : phase, loadedBytes, totalBytes: file.bytes,
      receivedBytes: file.bytes, verifiedBytes: complete ? file.bytes : 0,
    }));
  }
}

async function verifiedNetworkBlob(
  url: string,
  file: ModelCachePresentManifestFile,
  acquisition: ArtifactAcquisitionContext,
): Promise<Blob> {
  const response = await fetchFullArtifact(url, file, acquisition);
  const blob = await response.blob();
  await verifyBlobIntegrity(blob, file, {
    onProgress: (bytes) => reportHashProgress(file, acquisition, bytes),
  });
  return blob.slice(0, blob.size, file.contentType);
}

async function hasCapacityForPackage(
  store: ModelCacheStore,
  descriptor: ModelCachePackageDescriptor,
): Promise<boolean> {
  if (!navigator.storage?.estimate) {
    return true;
  }
  const packageRecord = await store.preparePackage(descriptor);
  const cachedBytes = await store.getPackageCachedBytes(packageRecord.key);
  const remainingBytes = Math.max(0, descriptor.inventory.totalBytes - cachedBytes);
  const headroom = Math.max(
    Math.ceil(descriptor.inventory.totalBytes * 0.1),
    MODEL_CACHE_MINIMUM_HEADROOM_BYTES,
  );
  const requiredAvailable = remainingBytes + headroom;

  let estimate: StorageEstimate;
  try {
    estimate = await navigator.storage.estimate();
  } catch {
    return true;
  }
  if (typeof estimate.usage !== 'number' || typeof estimate.quota !== 'number') {
    return true;
  }
  let available = Math.max(0, estimate.quota - estimate.usage);
  if (available >= requiredAvailable) {
    return true;
  }

  await store.evictOwned(requiredAvailable - available, pinnedPackageKeys(descriptor));
  try {
    estimate = await navigator.storage.estimate();
  } catch {
    return false;
  }
  if (typeof estimate.usage !== 'number' || typeof estimate.quota !== 'number') {
    return false;
  }
  available = Math.max(0, estimate.quota - estimate.usage);
  return available >= requiredAvailable;
}

function pinnedPackageKeys(current?: ModelCachePackageDescriptor): Set<string> {
  pruneExpiredLeases();
  const pinned = new Set<string>(reverifyingRoots.values());
  for (const lease of loadLeases.values()) {
    pinned.add(createModelCachePackageKey(
      lease.modelOrigin,
      lease.modelRootPath,
      lease.manifestVersion,
    ));
  }
  if (current) {
    pinned.add(createModelCachePackageKey(
      current.inventory.modelOrigin,
      current.inventory.modelRootPath,
      current.inventory.manifestIdentity.manifestVersion,
    ));
  }
  return pinned;
}

async function acquireArtifact(
  matched: MatchedFetchRoute,
): Promise<ArtifactResult | null> {
  if (matched.route.kind !== 'artifact' || !matched.version) {
    return null;
  }
  const { inventory } = matched.version;
  const file = findPresentFile(inventory, matched.route.relativePath);
  if (!file) {
    return null;
  }
  const descriptor: ModelCachePackageDescriptor = { inventory };
  const store = await getStore();
  let packageWasComplete = false;
  if (store) {
    const packageRecord = await store.getPackage(descriptor);
    packageWasComplete = packageRecord?.state === 'complete';
    let cached: Blob | null = null;
    let lastVerifyReport = 0;
    try {
      cached = await store.readFile(descriptor, file.path, {
        verificationScope: matched.lease?.nonce,
        reverify: !matched.lease,
        onVerifyProgress: matched.lease ? async (loadedBytes) => {
          const lease = requireLiveLease(matched.lease!);
          lease.lastActivityAt = Date.now();
          if (loadedBytes !== file.bytes && Date.now() - lastVerifyReport < PROGRESS_INTERVAL_MS) return;
          lastVerifyReport = Date.now();
          await postLeaseMessage(lease, (clientId) => ({
            ...workerMessageBase(clientId, lease, lease.manifestVersion),
            type: 'FILE_PROGRESS', file: file.path, source: 'disk', phase: 'verifying',
            loadedBytes, totalBytes: file.bytes, receivedBytes: 0, verifiedBytes: 0,
          }));
        } : undefined,
      });
    } catch (error) {
      if (error instanceof ModelDigestTimeoutError || error instanceof DOMException && error.name === 'AbortError') throw error;
      await store.invalidateFile(descriptor, file.path).catch(() => undefined);
      packageWasComplete = true;
    }
    if (cached) {
      if (matched.lease) {
        const activeLease = requireLiveLease(matched.lease);
        await postLeaseMessage(activeLease, (clientId) => ({
          ...workerMessageBase(clientId, activeLease, activeLease.manifestVersion),
          type: 'FILE_PROGRESS',
          file: file.path,
          source: 'disk',
          phase: 'serving',
          loadedBytes: file.bytes,
          totalBytes: file.bytes,
          receivedBytes: 0,
          verifiedBytes: file.bytes,
        }));
      }
      await packageComplete(matched.root, inventory.manifestIdentity.manifestVersion);
      return { blob: cached, source: 'disk' };
    }
  }
  if (!matched.lease) {
    return null;
  }

  const lease = requireLiveLease(matched.lease);
  if (lease.diskOnly) throw new Error('Disk-only load stopped: a verified local model file is unavailable.');
  await reportSourceChange(lease, packageWasComplete ? 'corruption' : 'cache-miss');
  const acquisitionKey = JSON.stringify([
    inventory.modelOrigin,
    inventory.modelRootPath,
    inventory.manifestIdentity.manifestVersion,
    file.path,
  ]);
  // Loader-internal retries cannot reset a shard's exhausted retry budget or
  // retry failed integrity. Only a new explicit lease can attempt it again.
  if (leaseFailures.get(lease.nonce)?.has(acquisitionKey)) throw leaseFailures.get(lease.nonce)!.get(acquisitionKey);
  const existing = artifactAcquisitions.get(acquisitionKey);
  if (existing && !existing.controller.signal.aborted) {
    existing.leaseNonces.add(lease.nonce);
    return existing.promise;
  }
  if (existing) {
    artifactAcquisitions.delete(acquisitionKey);
  }

  const controller = new AbortController();
  const acquisitionContext: ArtifactAcquisitionContext = {
    hashReports: new Map(),
    controller,
    leaseNonces: new Set([...loadLeases.values()].filter(other => !other.diskOnly && sameLeasePackage(other, lease)).map(other => other.nonce)),
    rootKey: modelRootKey(inventory.modelOrigin, inventory.modelRootPath),
    modelOrigin: inventory.modelOrigin,
    modelRootPath: inventory.modelRootPath,
    manifestVersion: inventory.manifestIdentity.manifestVersion,
  };
  const acquisition = transferSemaphore.run(async (): Promise<ArtifactResult> => {
    let activeLease = requireLiveAcquisitionLease(acquisitionContext);
    if (!store) {
      await reportAcquisitionSourceChange(acquisitionContext, 'storage-unavailable');
      return {
        blob: await verifiedNetworkBlob(matched.route.url, file, acquisitionContext),
        source: 'network',
      };
    }
    if (!(await hasCapacityForPackage(store, descriptor))) {
      activeLease = requireLiveAcquisitionLease(acquisitionContext);
      await reportAcquisitionSourceChange(acquisitionContext, 'quota');
      await broadcastWarning(matched.root, activeLease.manifestVersion, {
        code: 'quota-insufficient',
        message: 'There is not enough site storage to save Eva. This load will use the network only.',
        recoverable: true,
      });
      return {
        blob: await verifiedNetworkBlob(matched.route.url, file, acquisitionContext),
        source: 'network',
      };
    }
    let durableOffset = 0;
    let quotaRecovered = false;
    const chunked = file.bytes >= 64 * 1024;
    const fallback = async (): Promise<ArtifactResult> => {
      requireLiveAcquisitionLease(acquisitionContext);
      const blob = await verifiedNetworkBlob(matched.route.url, file, acquisitionContext);
      try {
        await store.putFile(descriptor, file.path, blob, {
          assertCanCommit: () => requireLiveAcquisitionLease(acquisitionContext),
          onVerifyProgress: (bytes) => reportHashProgress(file, acquisitionContext, bytes),
          onCommitProgress: (bytes) => reportHashProgress(file, acquisitionContext, bytes, false, 'committing'),
        });
        requireLiveAcquisitionLease(acquisitionContext);
        return { blob: await store.readFile(descriptor, file.path) ?? blob, source: 'network' };
      } catch (error) {
        requireLiveAcquisitionLease(acquisitionContext);
        if (error instanceof ModelIntegrityError) throw error;
        return { blob, source: 'network' };
      }
    };
    const attempt = async (): Promise<ArtifactResult> => {
      requireLiveAcquisitionLease(acquisitionContext);
      const response = chunked ? null : await fetchFullArtifact(matched.route.url, file, acquisitionContext);
      if (__EVA_MODEL_CACHE_DEV__ && developmentFailNextWriteWithQuota && !developmentQuotaAfterOffset) {
        developmentFailNextWriteWithQuota = false;
        await response?.body?.cancel('Injected model-cache quota failure.').catch(() => undefined);
        throw new DOMException('Injected model-cache quota failure.', 'QuotaExceededError');
      }
      const stored = await store.putFile(descriptor, file.path, response?.body ?? new Blob(), {
        assertCanCommit: () => requireLiveAcquisitionLease(acquisitionContext),
        onVerifyProgress: (bytes) => reportHashProgress(file, acquisitionContext, bytes),
        onCommitProgress: (bytes) => reportHashProgress(file, acquisitionContext, bytes, false, 'committing'),
        onResumeProgress: async (bytes, prefix) => {
          for (const lease of await acquisitionActivity(acquisitionContext)) {
            await postLeaseMessage(lease, clientId => ({
              ...workerMessageBase(clientId, lease, lease.manifestVersion), type: 'FILE_PROGRESS',
              file: file.path, source: 'network', phase: bytes === 0 ? 'resuming' : 'verifying-resumed-prefix',
              loadedBytes: bytes, totalBytes: file.bytes, receivedBytes: prefix, verifiedBytes: 0,
              transfer: { durableBytes: prefix, resumedBytes: prefix, networkBytes: 0 },
            }));
          }
        },
        onQuotaFailure: async (needed) => {
          const freed = await store.evictOwned(needed, pinnedPackageKeys(descriptor)).catch(() => 0);
          quotaRecovered = freed >= needed;
          return freed;
        },
        onPartialEvicted: () => broadcastWarning(matched.root, activeLease.manifestVersion, {
          code: 'browser-evicted', recoverable: true,
          message: 'Browser cleared partial download; resuming what survived.',
        }),
        acquire: chunked ? async (handle, offset, checkpoint) => {
          durableOffset = offset;
          let lastReport = 0;
          try {
            await acquireModelChunks(handle, offset, {
              total: file.bytes, signal: acquisitionContext.controller.signal,
              // Small deterministic fixtures keep their eight-chunk cadence.
              chunkBytes: Math.min(activeLease.chunkBytes ?? DESKTOP_CHUNK_BYTES, Math.max(16 * 1024, Math.ceil(file.bytes / 8))),
              checkpoint: async (completed) => {
                await checkpoint(completed); durableOffset = completed;
                await acquisitionActivity(acquisitionContext);
              },
              fetch: async (start, end) => {
                requireLiveAcquisitionLease(acquisitionContext);
                const result = await fetch(matched.route.url, { mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
                  signal: acquisitionContext.controller.signal, headers: { Accept: file.contentType, Range: `bytes=${start}-${end}` } });
                if (result.type === 'opaque' || (result.url && result.url !== matched.route.url)) {
                  await result.body?.cancel();
                  throw new Error('Unusable range origin or response.');
                }
                return result;
              },
              progress: async (received, durable) => {
                if (__EVA_MODEL_CACHE_DEV__ && developmentFailNextWriteWithQuota && developmentQuotaAfterOffset > 0
                  && durable >= developmentQuotaAfterOffset && received > durable) {
                  developmentFailNextWriteWithQuota = false;
                  // Throw after a write in the NEXT chunk, before its close or
                  // checkpoint. Exercises reader cancellation and writer abort.
                  throw new DOMException('Injected mid-chunk quota failure.', 'QuotaExceededError');
                }
                const leases = await acquisitionActivity(acquisitionContext);
                const now = Date.now();
                for (const lease of leases) lease.lastActivityAt = now;
                if (now - lastReport < PROGRESS_INTERVAL_MS && received !== durable) return;
                lastReport = now;
                await Promise.all(leases.map((lease) => postLeaseMessage(lease, (clientId) => ({
                  ...workerMessageBase(clientId, lease, lease.manifestVersion), type: 'FILE_PROGRESS', file: file.path,
                  source: 'network', phase: 'downloading', loadedBytes: received, totalBytes: file.bytes,
                  receivedBytes: received, verifiedBytes: 0,
                  transfer: { durableBytes: durable, networkBytes: received - offset, resumedBytes: offset },
                }))));
              },
            });
          } catch (error) {
            if (!(error instanceof RangeUnavailableError)) throw error;
            requireLiveAcquisitionLease(acquisitionContext);
            await broadcastWarning(matched.root, activeLease.manifestVersion, { code: 'host-contract', recoverable: true,
              message: 'The model host does not return valid byte ranges. Using a full-file verified download; pausing this file will restart it. SHA-256 verification remains required.' });
            const full = await fetchFullArtifact(matched.route.url, file, acquisitionContext);
            await writeOpfsStream(handle, full.body!);
            await checkpoint(file.bytes);
          }
        } : undefined,
      });
      requireLiveAcquisitionLease(acquisitionContext);
      const blob = await store.readFile(descriptor, stored.path);
      if (!blob) {
        throw new Error('The committed Eva model file could not be reopened.');
      }
      return { blob, source: 'network' };
    };
    try {
      return await acquireWithRetry({
        signal: controller.signal, attempt, fallback,
        activity: async () => { await acquisitionActivity(acquisitionContext); },
        retrying: async (attempt) => {
          for (const lease of await acquisitionActivity(acquisitionContext)) {
            lease.lastActivityAt = Date.now();
            await postLeaseMessage(lease, (clientId) => ({
              ...workerMessageBase(clientId, lease, lease.manifestVersion), type: 'FILE_PROGRESS',
              file: file.path, source: 'network', phase: 'retrying', attempt,
              loadedBytes: durableOffset, receivedBytes: durableOffset, verifiedBytes: 0, totalBytes: file.bytes,
              transfer: { durableBytes: durableOffset, networkBytes: 0, resumedBytes: durableOffset },
            }));
          }
        },
      });
    } catch (error) {
      activeLease = requireLiveAcquisitionLease(acquisitionContext);
      if (error instanceof ModelIntegrityError || controller.signal.aborted) {
        throw error;
      }
      if (isQuotaError(error)) {
        await reportAcquisitionSourceChange(acquisitionContext, 'quota');
        // One storage-specific retry, separate from network backoff. Re-entry
        // reads the same checkpoint only when eviction freed the required bytes.
        if (quotaRecovered) return attempt();
        await store.evictOwned(file.bytes, pinnedPackageKeys(descriptor)).catch(() => 0);
      } else if (isAcquisitionNetworkError(error)) {
        await broadcastWarning(matched.root, activeLease.manifestVersion, {
          code: 'connection-lost', message: 'The connection dropped. Resume continues from durable checkpoints.', recoverable: true,
        });
        throw error;
      } else {
        await reportAcquisitionSourceChange(acquisitionContext, 'storage-unavailable');
        throw error;
      }
      return fallback();
    }
  }).then(async (result) => {
    await reportHashProgress(file, acquisitionContext, file.bytes, true);
    await packageComplete(matched.root, inventory.manifestIdentity.manifestVersion);
    return result;
  }).catch(async (error: unknown) => {
    if (!controller.signal.aborted) {
      for (const nonce of acquisitionContext.leaseNonces) {
        const failures = leaseFailures.get(nonce) ?? new Map<string, unknown>();
        failures.set(acquisitionKey, error); leaseFailures.set(nonce, failures);
      }
      if (error instanceof ModelIntegrityError) {
        for (const lease of liveAcquisitionLeases(acquisitionContext)) {
          await postLeaseMessage(lease, clientId => ({
            ...workerMessageBase(clientId, lease, lease.manifestVersion), type: 'CACHE_WARNING',
            warning: { code: 'integrity-failed', message: 'Downloaded model data failed integrity verification. No model was loaded.', recoverable: false },
          }));
        }
      }
    }
    throw error;
  }).finally(() => {
    if (artifactAcquisitions.get(acquisitionKey)?.promise === acquisition) {
      artifactAcquisitions.delete(acquisitionKey);
    }
  });
  artifactAcquisitions.set(acquisitionKey, {
    ...acquisitionContext,
    promise: acquisition,
  });
  return acquisition;
}

async function handleArtifactFetch(
  request: Request,
  matched: MatchedFetchRoute,
  clientId: string,
): Promise<Response> {
  if (matched.route.kind !== 'artifact' || !matched.version) {
    return fetch(request);
  }
  const relativePath = matched.route.relativePath;
  const declared = matched.version.inventory.files.find((file) => file.path === relativePath);
  if (!declared) {
    return fetch(request);
  }
  if (!declared.present) {
    return absentFileResponse(request.method);
  }
  if (!matched.lease) {
    matched.lease = await claimLeaseFromFirstArtifact(matched, clientId);
  }
  const result = await acquireArtifact(matched);
  if (!result) {
    return explicitLoadRequiredResponse(request.method);
  }
  return createModelBlobResponse(result.blob, {
    method: request.method as 'GET' | 'HEAD',
    rangeHeader: request.headers.get('Range'),
    contentType: declared.contentType,
    sha256: declared.sha256,
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const store = await getStore();
    await store?.reconcile();
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  event.waitUntil(handleClientMessage(event));
});

self.addEventListener('fetch', (event) => {
  if (event.request.destination === 'worker'
    && isEvaModelCacheWorkerClientUrl(event.request.url, self.location.origin)) {
    event.waitUntil(observeInferenceWorkerCreation(event));
    return;
  }
  const matched = findFetchRoute(event.request, event.clientId);
  if (!matched) {
    return;
  }
  const background: Promise<void>[] = [];
  const schedule = (work: Promise<void>) => background.push(work);
  const response = matched.route.kind === 'manifest'
    ? handleManifestFetch(event.request, matched.root, schedule)
    : handleArtifactFetch(event.request, matched, event.clientId);
  event.respondWith(response);
  event.waitUntil(response.then(async () => Promise.allSettled(background).then(() => undefined)).catch(() => undefined));
});

export {};
