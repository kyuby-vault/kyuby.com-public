import { hashBytes, verifyBlobIntegrity } from './integrity';
import { normalizeStrongModelCacheEtag } from './manifest';
import {
  MODEL_CACHE_MAX_MANIFEST_BYTES,
  type ModelCacheInventory,
  type ModelCacheManifestFile,
} from './types';

export const MODEL_CACHE_MANIFEST_FRESHNESS_MS = 24 * 60 * 60 * 1_000;
export const MODEL_CACHE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export type ModelCacheBackendKind = 'opfs';

export interface ModelCachePackageDescriptor {
  inventory: ModelCacheInventory;
  manifestVersion?: string;
}

export interface ModelCachePackageRecord {
  key: string;
  modelOrigin: string;
  modelRootPath: string;
  manifestVersion: string;
  state: 'incomplete' | 'complete' | 'removing';
  expectedPaths: string[];
  optionalAbsentPaths: string[];
  packageBytes: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
}

export interface ModelCacheFileRecord {
  key: string;
  packageKey: string;
  modelOrigin: string;
  modelRootPath: string;
  manifestVersion: string;
  path: string;
  bytes: number;
  sha256: string;
  contentType: string;
  backend: ModelCacheBackendKind;
  locator: string;
  state: 'complete';
  createdAt: number;
  lastAccessedAt: number;
}

export interface ModelCacheManifestRecord {
  key: string;
  modelOrigin: string;
  modelRootPath: string;
  manifestVersion: string;
  strongEtag: string | null;
  rawSha256: string;
  rawBytes: Uint8Array;
  contentType: string;
  inventory: ModelCacheInventory;
  fetchedAt: number;
  freshUntil: number;
}

export interface ModelCacheTemporaryRecord {
  id: string;
  packageKey: string;
  fileKey: string;
  backend: ModelCacheBackendKind;
  locator: string;
  createdAt: number;
  // Identity is pinned to the validated manifest SHA-256; host ETags are NOT
  // trusted for shard identity. Closed prefixes are durable, never verified files.
  resume?: { bytes: number; sha256: string; offset: number; verifiedPrefix?: false };
}

export interface ModelCacheMetadataRepository {
  getPackage(key: string): Promise<ModelCachePackageRecord | undefined>;
  putPackage(record: ModelCachePackageRecord): Promise<void>;
  listPackages(): Promise<ModelCachePackageRecord[]>;
  deletePackage(key: string): Promise<void>;
  getFile(key: string): Promise<ModelCacheFileRecord | undefined>;
  putFile(record: ModelCacheFileRecord): Promise<void>;
  listFiles(packageKey?: string): Promise<ModelCacheFileRecord[]>;
  deleteFile(key: string): Promise<void>;
  getManifest(key: string): Promise<ModelCacheManifestRecord | undefined>;
  putManifest(record: ModelCacheManifestRecord): Promise<void>;
  listManifests(): Promise<ModelCacheManifestRecord[]>;
  deleteManifest(key: string): Promise<void>;
  listTemporary(): Promise<ModelCacheTemporaryRecord[]>;
  putTemporary(record: ModelCacheTemporaryRecord): Promise<void>;
  deleteTemporary(id: string): Promise<void>;
  close(): void;
}

export type ModelCacheBodySource = Blob | ReadableStream<Uint8Array>;

export interface ModelCacheWriteOptions {
  assertCanCommit?: () => void;
  onVerifyProgress?: (hashedBytes: number, totalBytes: number) => void | Promise<void>;
  acquire?: (handle: FileSystemFileHandle, offset: number, checkpoint: (offset: number) => Promise<void>) => Promise<void>;
  onQuotaFailure?: (neededBytes: number) => Promise<number>;
  onPartialEvicted?: () => void | Promise<void>;
}

export interface ModelCacheBlobBackend {
  readonly kind: ModelCacheBackendKind;
  writeVerifiedFile(
    record: Omit<ModelCacheFileRecord, 'backend' | 'locator' | 'state'>,
    source: ModelCacheBodySource,
    options?: ModelCacheWriteOptions,
  ): Promise<ModelCacheFileRecord>;
  readFile(record: ModelCacheFileRecord): Promise<Blob | null>;
  deleteFile(record: ModelCacheFileRecord): Promise<void>;
  deleteTemporary(record: ModelCacheTemporaryRecord): Promise<void>;
  corruptFileForDevelopment?(record: ModelCacheFileRecord): Promise<void>;
  reconcile(validFiles: ModelCacheFileRecord[], now: number): Promise<Set<string>>;
}

export interface ModelCacheStoreOptions {
  metadata: ModelCacheMetadataRepository;
  backend: ModelCacheBlobBackend;
  now?: () => number;
}

export interface ModelCacheReadOptions {
  verificationScope?: string;
  reverify?: boolean;
  onVerifyProgress?: (hashedBytes: number, totalBytes: number) => void | Promise<void>;
}

export interface ModelCacheManifestFetchRequest {
  etag: string | null;
  unconditional: boolean;
}

export interface ResolveModelCacheManifestOptions {
  modelOrigin: string;
  modelRootPath: string;
  fetchManifest: (request: ModelCacheManifestFetchRequest) => Promise<Response>;
  validateManifest: (rawBytes: Uint8Array, response: Response) => ModelCacheInventory | Promise<ModelCacheInventory>;
  schedule?: (work: Promise<void>) => void;
  now?: number;
  freshnessMs?: number;
}

export interface ResolvedModelCacheManifest {
  record: ModelCacheManifestRecord;
  source: 'network' | 'stored-fresh' | 'stored-stale';
  revalidation: Promise<ModelCacheManifestRecord> | null;
}

export function createModelCachePackageKey(
  modelOrigin: string,
  modelRootPath: string,
  manifestVersion: string,
): string {
  return JSON.stringify([modelOrigin, modelRootPath, manifestVersion]);
}

export function createModelCacheFileKey(packageKey: string, path: string): string {
  return JSON.stringify([packageKey, path]);
}

export function createModelCacheManifestKey(modelOrigin: string, modelRootPath: string): string {
  return JSON.stringify([modelOrigin, modelRootPath]);
}

export function isEvaModelCacheWorkerClientUrl(clientUrl: string, appOrigin: string): boolean {
  try {
    const client = new URL(clientUrl);
    const app = new URL(appOrigin);
    if (client.origin !== app.origin || client.username || client.password || client.hash) {
      return false;
    }
    if (/^\/_astro\/eva\.worker-[A-Za-z0-9_-]+\.js$/.test(client.pathname)) {
      return client.search === '';
    }
    if (client.pathname !== '/src/workers/eva.worker.ts') {
      return false;
    }
    const keys = [...client.searchParams.keys()];
    return keys.length === 2
      && new Set(keys).size === 2
      && client.searchParams.get('type') === 'module'
      && client.searchParams.has('worker_file')
      && client.searchParams.get('worker_file') === '';
  } catch {
    return false;
  }
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function findExpectedFile(inventory: ModelCacheInventory, path: string): ModelCacheManifestFile | undefined {
  return inventory.files.find((file) => file.path === path);
}

function isPresentFile(file: ModelCacheManifestFile | undefined): file is Extract<ModelCacheManifestFile, { present: true }> {
  return file?.present === true;
}

function descriptorVersion(descriptor: ModelCachePackageDescriptor): string {
  const inventoryVersion = descriptor.inventory.manifestIdentity.manifestVersion;
  if (descriptor.manifestVersion && descriptor.manifestVersion !== inventoryVersion) {
    throw new Error('The pinned manifest version does not match the validated inventory.');
  }
  return inventoryVersion;
}

function sameFileContract(
  record: ModelCacheFileRecord,
  file: Extract<ModelCacheManifestFile, { present: true }>,
): boolean {
  return record.path === file.path
    && record.bytes === file.bytes
    && record.sha256 === file.sha256
    && record.contentType === file.contentType;
}

function responseContentType(response: Response): string {
  return response.headers.get('Content-Type')?.trim() || 'application/json';
}

export async function readBoundedManifestBytes(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get('Content-Length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MODEL_CACHE_MAX_MANIFEST_BYTES) {
      throw new Error('Eva model manifest exceeds its bounded response size.');
    }
  }
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MODEL_CACHE_MAX_MANIFEST_BYTES) {
        await reader.cancel('Manifest body exceeded the cache limit.').catch(() => undefined);
        throw new Error('Eva model manifest exceeds its bounded response size.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function manifestVersionFor(rawBytes: Uint8Array, response: Response): Promise<{
  manifestVersion: string;
  strongEtag: string | null;
  rawSha256: string;
}> {
  const rawSha256 = await hashBytes(rawBytes);
  const strongEtag = normalizeStrongModelCacheEtag(response.headers.get('ETag'));
  return {
    manifestVersion: strongEtag ?? `sha256:${rawSha256}`,
    strongEtag,
    rawSha256,
  };
}

export class ModelCacheStore {
  readonly backendKind: ModelCacheBackendKind;

  #metadata: ModelCacheMetadataRepository;
  #backend: ModelCacheBlobBackend;
  #now: () => number;
  #fileWrites = new Map<string, Promise<ModelCacheFileRecord>>();
  #fileReads = new Set<Promise<Blob | null>>();
  #fileVerifications = new Map<string, Promise<Blob | null>>();
  #activeVerifications = 0;
  #verificationWaiters: Array<() => void> = [];
  #verifiedByScope = new Map<string, Set<string>>();
  #packageLocks = new Map<string, Promise<void>>();
  #removingPackages = new Set<string>();
  #removingModelRoots = new Set<string>();
  #modelRootGenerations = new Map<string, number>();

  constructor({ metadata, backend, now = Date.now }: ModelCacheStoreOptions) {
    this.#metadata = metadata;
    this.#backend = backend;
    this.#now = now;
    this.backendKind = backend.kind;
  }

  async preparePackage(descriptor: ModelCachePackageDescriptor): Promise<ModelCachePackageRecord> {
    const { inventory } = descriptor;
    const manifestVersion = descriptorVersion(descriptor);
    const key = createModelCachePackageKey(inventory.modelOrigin, inventory.modelRootPath, manifestVersion);
    return this.#withPackageLock(key, async () => {
      const now = this.#now();
      const existing = await this.#metadata.getPackage(key);
      if (existing?.state === 'removing' || this.#removingPackages.has(key)) {
        throw new Error('The model cache package is awaiting removal. Retry removal before loading it.');
      }
      const expectedPaths = inventory.files.filter((file) => file.present).map((file) => file.path);
      const optionalAbsentPaths = inventory.files
        .filter((file) => !file.present)
        .map((file) => file.path);
      const record: ModelCachePackageRecord = {
        key,
        modelOrigin: inventory.modelOrigin,
        modelRootPath: inventory.modelRootPath,
        manifestVersion,
        state: 'incomplete',
        expectedPaths,
        optionalAbsentPaths,
        packageBytes: inventory.totalBytes,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastAccessedAt: now,
      };
      await this.#metadata.putPackage(record);
      return this.#refreshCompleteness(record, inventory);
    });
  }

  async getPackage(descriptor: ModelCachePackageDescriptor): Promise<ModelCachePackageRecord | null> {
    const key = createModelCachePackageKey(
      descriptor.inventory.modelOrigin,
      descriptor.inventory.modelRootPath,
      descriptorVersion(descriptor),
    );
    const record = await this.#metadata.getPackage(key);
    if (!record || record.state === 'removing') {
      return null;
    }
    return this.#refreshCompleteness(record, descriptor.inventory);
  }

  getStoredManifest(modelOrigin: string, modelRootPath: string): Promise<ModelCacheManifestRecord | undefined> {
    return this.#metadata.getManifest(createModelCacheManifestKey(modelOrigin, modelRootPath));
  }

  async listModelPackages(modelOrigin: string, modelRootPath: string): Promise<ModelCachePackageRecord[]> {
    return (await this.#metadata.listPackages()).filter((record) => (
      record.modelOrigin === modelOrigin && record.modelRootPath === modelRootPath
    ));
  }

  async getPackageCachedBytes(packageKey: string): Promise<number> {
    return (await this.#metadata.listFiles(packageKey)).reduce((total, file) => total + file.bytes, 0);
  }

  async putFile(
    descriptor: ModelCachePackageDescriptor,
    path: string,
    source: ModelCacheBodySource,
    options: ModelCacheWriteOptions = {},
  ): Promise<ModelCacheFileRecord> {
    const modelRootKey = createModelCacheManifestKey(
      descriptor.inventory.modelOrigin,
      descriptor.inventory.modelRootPath,
    );
    if (this.#removingModelRoots.has(modelRootKey)) {
      throw new Error('The model cache is being removed.');
    }
    const expected = findExpectedFile(descriptor.inventory, path);
    if (!isPresentFile(expected)) {
      throw new Error(`The model cache manifest does not declare ${path}.`);
    }
    const packageKey = createModelCachePackageKey(
      descriptor.inventory.modelOrigin,
      descriptor.inventory.modelRootPath,
      descriptorVersion(descriptor),
    );
    const fileKey = createModelCacheFileKey(packageKey, path);
    const inFlight = this.#fileWrites.get(fileKey);
    if (inFlight) {
      return inFlight;
    }
    if (this.#removingPackages.has(packageKey)) {
      throw new Error('The model cache package is being removed.');
    }

    const operation = (async () => {
      const packageRecord = await this.preparePackage(descriptor);
      if (this.#removingModelRoots.has(modelRootKey)) {
        throw new Error('The model cache is being removed.');
      }
      options.assertCanCommit?.();
      const now = this.#now();
      const stored = await this.#metadata.getFile(fileKey);
      if (stored && sameFileContract(stored, expected)) {
        const blob = await this.#backend.readFile(stored);
        if (blob && blob.size === expected.bytes) {
          options.assertCanCommit?.();
          return stored;
        }
        await this.#dropFile(stored);
      }

      const record = await this.#backend.writeVerifiedFile({
        key: fileKey,
        packageKey: packageRecord.key,
        modelOrigin: packageRecord.modelOrigin,
        modelRootPath: packageRecord.modelRootPath,
        manifestVersion: packageRecord.manifestVersion,
        path,
        bytes: expected.bytes,
        sha256: expected.sha256,
        contentType: expected.contentType,
        createdAt: now,
        lastAccessedAt: now,
      }, source, options);

      if (this.#removingModelRoots.has(modelRootKey)) {
        await this.#dropFile(record);
        throw new Error('The model cache was removed while a write was completing.');
      }
      options.assertCanCommit?.();

      await this.#refreshCompleteness(packageRecord, descriptor.inventory);
      return record;
    })().finally(() => {
      this.#fileWrites.delete(fileKey);
    });

    this.#fileWrites.set(fileKey, operation);
    return operation;
  }

  async markOptionalAbsent(descriptor: ModelCachePackageDescriptor, path: string): Promise<void> {
    const expected = findExpectedFile(descriptor.inventory, path);
    if (!expected || expected.present || expected.required) {
      throw new Error(`${path} is not an optional manifested file.`);
    }
    const packageRecord = await this.preparePackage(descriptor);
    await this.#withPackageLock(packageRecord.key, async () => {
      const current = await this.#metadata.getPackage(packageRecord.key);
      if (!current || current.state === 'removing') {
        throw new Error('The model cache package is unavailable.');
      }
      current.optionalAbsentPaths = [...new Set([...current.optionalAbsentPaths, path])];
      current.updatedAt = this.#now();
      await this.#metadata.putPackage(current);
      await this.#refreshCompleteness(current, descriptor.inventory);
    });
  }

  async readFile(
    descriptor: ModelCachePackageDescriptor,
    path: string,
    options: ModelCacheReadOptions = {},
  ): Promise<Blob | null> {
    const expected = findExpectedFile(descriptor.inventory, path);
    if (!isPresentFile(expected)) {
      return null;
    }
    const packageKey = createModelCachePackageKey(
      descriptor.inventory.modelOrigin,
      descriptor.inventory.modelRootPath,
      descriptorVersion(descriptor),
    );
    const modelRootKey = createModelCacheManifestKey(
      descriptor.inventory.modelOrigin,
      descriptor.inventory.modelRootPath,
    );
    if (this.#removingModelRoots.has(modelRootKey) || this.#removingPackages.has(packageKey)) {
      return null;
    }
    if ((await this.#metadata.getPackage(packageKey))?.state === 'removing') {
      return null;
    }
    const modelRootGeneration = this.#modelRootGenerations.get(modelRootKey) ?? 0;
    const fileKey = createModelCacheFileKey(packageKey, path);
    const record = await this.#metadata.getFile(fileKey);
    if (!record || !sameFileContract(record, expected)) {
      return null;
    }

    const scope = options.verificationScope;
    const alreadyVerified = scope ? this.#verifiedByScope.get(scope)?.has(fileKey) === true : false;
    const mustVerify = options.reverify === true || (scope !== undefined && !alreadyVerified);
    const verificationKey = `${scope ?? 'read'}\u0000${fileKey}`;
    const existing = mustVerify ? this.#fileVerifications.get(verificationKey) : undefined;
    if (existing) {
      return existing;
    }

    const operation = (async () => {
      const blob = await this.#backend.readFile(record);
      if (!blob || blob.size !== expected.bytes) {
        await this.#dropFile(record);
        return null;
      }
      if (mustVerify) {
        try {
          await this.#runVerification(() => verifyBlobIntegrity(
            blob,
            { bytes: expected.bytes, sha256: expected.sha256 },
            { onProgress: options.onVerifyProgress },
          ));
        } catch {
          await this.#dropFile(record);
          return null;
        }
        if (scope) {
          const verified = this.#verifiedByScope.get(scope) ?? new Set<string>();
          verified.add(fileKey);
          this.#verifiedByScope.set(scope, verified);
        }
      }
      if (this.#removingModelRoots.has(modelRootKey)
        || (this.#modelRootGenerations.get(modelRootKey) ?? 0) !== modelRootGeneration) {
        return null;
      }
      const accessedAt = this.#now();
      record.lastAccessedAt = accessedAt;
      await this.#metadata.putFile(record);
      await this.#withPackageLock(packageKey, async () => {
        const packageRecord = await this.#metadata.getPackage(packageKey);
        if (packageRecord && packageRecord.state !== 'removing') {
          packageRecord.lastAccessedAt = accessedAt;
          await this.#metadata.putPackage(packageRecord);
        }
      });
      return blob;
    })().finally(() => {
      this.#fileVerifications.delete(verificationKey);
      this.#fileReads.delete(operation);
    });

    this.#fileReads.add(operation);
    if (mustVerify) {
      this.#fileVerifications.set(verificationKey, operation);
    }
    return operation;
  }

  async invalidateFile(descriptor: ModelCachePackageDescriptor, path: string): Promise<void> {
    const packageKey = createModelCachePackageKey(
      descriptor.inventory.modelOrigin,
      descriptor.inventory.modelRootPath,
      descriptorVersion(descriptor),
    );
    const record = await this.#metadata.getFile(createModelCacheFileKey(packageKey, path));
    if (record) {
      await this.#dropFile(record);
    }
  }

  async corruptFileForDevelopment(descriptor: ModelCachePackageDescriptor, path: string): Promise<void> {
    const packageKey = createModelCachePackageKey(
      descriptor.inventory.modelOrigin,
      descriptor.inventory.modelRootPath,
      descriptorVersion(descriptor),
    );
    const record = await this.#metadata.getFile(createModelCacheFileKey(packageKey, path));
    if (!record || !this.#backend.corruptFileForDevelopment) {
      throw new Error('The requested development cache entry is unavailable.');
    }
    await this.#backend.corruptFileForDevelopment(record);
  }

  endVerificationScope(scope: string): void {
    this.#verifiedByScope.delete(scope);
    for (const key of this.#fileVerifications.keys()) {
      if (key.startsWith(`${scope}\u0000`)) {
        this.#fileVerifications.delete(key);
      }
    }
  }

  async removeModel(modelOrigin: string, modelRootPath: string): Promise<number> {
    const modelRootKey = createModelCacheManifestKey(modelOrigin, modelRootPath);
    if (this.#removingModelRoots.has(modelRootKey)) {
      return 0;
    }
    this.#removingModelRoots.add(modelRootKey);
    this.#modelRootGenerations.set(
      modelRootKey,
      (this.#modelRootGenerations.get(modelRootKey) ?? 0) + 1,
    );
    try {
      await Promise.allSettled(this.#fileWrites.values());
      await Promise.allSettled(this.#fileReads);
      const packages = (await this.#metadata.listPackages()).filter((record) => (
        record.modelOrigin === modelOrigin && record.modelRootPath === modelRootPath
      ));
      let removedBytes = 0;
      for (const packageRecord of packages) {
        const bytes = await this.getPackageCachedBytes(packageRecord.key);
        await this.#removePackage(packageRecord);
        removedBytes += bytes;
      }
      const manifests = (await this.#metadata.listManifests()).filter((record) => (
        record.modelOrigin === modelOrigin && record.modelRootPath === modelRootPath
      ));
      await Promise.all(manifests.map((record) => this.#metadata.deleteManifest(record.key)));
      const temporaries = (await this.#metadata.listTemporary()).filter((record) => {
        try {
          const parsed = JSON.parse(record.packageKey) as unknown;
          return Array.isArray(parsed)
            && parsed.length === 3
            && parsed[0] === modelOrigin
            && parsed[1] === modelRootPath;
        } catch {
          return false;
        }
      });
      for (const temporary of temporaries) {
        await this.#backend.deleteTemporary(temporary);
        await this.#metadata.deleteTemporary(temporary.id);
      }
      return removedBytes;
    } finally {
      this.#removingModelRoots.delete(modelRootKey);
    }
  }

  async evictOwned(
    bytesNeeded: number,
    pinnedPackageKeys: ReadonlySet<string> = new Set(),
  ): Promise<number> {
    if (!Number.isFinite(bytesNeeded) || bytesNeeded <= 0) {
      return 0;
    }
    const packages = (await this.#metadata.listPackages())
      .filter((record) => !pinnedPackageKeys.has(record.key) && !this.#removingPackages.has(record.key))
      .sort((left, right) => {
        const incompleteOrder = Number(left.state === 'complete') - Number(right.state === 'complete');
        return incompleteOrder || left.lastAccessedAt - right.lastAccessedAt;
      });
    let freed = 0;
    for (const packageRecord of packages) {
      const files = await this.#metadata.listFiles(packageRecord.key);
      await this.#removePackage(packageRecord);
      freed += files.reduce((total, file) => total + file.bytes, 0);
      if (freed >= bytesNeeded) {
        break;
      }
    }
    return freed;
  }

  async reconcile(): Promise<void> {
    const now = this.#now();
    const files = await this.#metadata.listFiles();
    const missingFileKeys = await this.#backend.reconcile(files, now);
    for (const file of files) {
      if (missingFileKeys.has(file.key)) {
        await this.#metadata.deleteFile(file.key);
      }
    }

    const staleTemps = (await this.#metadata.listTemporary()).filter(
      (temp) => now - temp.createdAt > MODEL_CACHE_TEMP_MAX_AGE_MS,
    );
    for (const temp of staleTemps) {
      await this.#backend.deleteTemporary(temp);
      await this.#metadata.deleteTemporary(temp.id);
    }

    const packages = await this.#metadata.listPackages();
    for (const packageRecord of packages) {
      if (packageRecord.state === 'removing') {
        await this.#removePackage(packageRecord);
        continue;
      }
      const manifest = await this.#metadata.getManifest(
        createModelCacheManifestKey(packageRecord.modelOrigin, packageRecord.modelRootPath),
      );
      if (!manifest || manifest.manifestVersion !== packageRecord.manifestVersion) {
        packageRecord.state = 'incomplete';
        packageRecord.updatedAt = now;
        await this.#metadata.putPackage(packageRecord);
        continue;
      }
      await this.#refreshCompleteness(packageRecord, manifest.inventory);
    }
  }

  close(): void {
    this.#metadata.close();
    this.#verifiedByScope.clear();
  }

  async expireStoredManifestForDevelopment(modelOrigin: string, modelRootPath: string): Promise<void> {
    const record = await this.getStoredManifest(modelOrigin, modelRootPath);
    if (!record) {
      throw new Error('The development manifest cache entry is unavailable.');
    }
    await this.#metadata.putManifest({ ...record, freshUntil: 0 });
  }

  async resolveManifest(options: ResolveModelCacheManifestOptions): Promise<ResolvedModelCacheManifest> {
    const key = createModelCacheManifestKey(options.modelOrigin, options.modelRootPath);
    const now = options.now ?? this.#now();
    const stored = await this.#metadata.getManifest(key);
    if (!stored) {
      const record = await this.#revalidateManifest(null, options, now);
      return { record, source: 'network', revalidation: null };
    }
    if (stored.freshUntil > now) {
      return { record: stored, source: 'stored-fresh', revalidation: null };
    }

    const revalidation = this.#revalidateManifest(stored, options, now);
    options.schedule?.(revalidation.then(() => undefined).catch(() => undefined));
    return { record: stored, source: 'stored-stale', revalidation };
  }

  async #revalidateManifest(
    stored: ModelCacheManifestRecord | null,
    options: ResolveModelCacheManifestOptions,
    now: number,
  ): Promise<ModelCacheManifestRecord> {
    let response: Response;
    const attemptedConditional = Boolean(stored?.strongEtag);
    let usedUnconditionalFallback = false;
    try {
      response = await options.fetchManifest({ etag: stored?.strongEtag ?? null, unconditional: false });
    } catch (error) {
      if (!attemptedConditional) {
        throw error;
      }
      usedUnconditionalFallback = true;
      response = await options.fetchManifest({ etag: null, unconditional: true });
    }

    if (response.status === 304 && stored?.strongEtag) {
      const refreshed = {
        ...stored,
        fetchedAt: now,
        freshUntil: now + (options.freshnessMs ?? MODEL_CACHE_MANIFEST_FRESHNESS_MS),
      };
      await this.#metadata.putManifest(refreshed);
      return refreshed;
    }
    if (!response.ok || response.type === 'opaque' || response.redirected) {
      if (attemptedConditional && !usedUnconditionalFallback) {
        usedUnconditionalFallback = true;
        response = await options.fetchManifest({ etag: null, unconditional: true });
      }
      if (!response.ok || response.type === 'opaque' || response.redirected) {
        throw new Error(`Eva model manifest returned HTTP ${response.status}.`);
      }
    }

    const rawBytes = await readBoundedManifestBytes(response);
    const validatedInventory = await options.validateManifest(rawBytes, response);
    if (validatedInventory.modelOrigin !== options.modelOrigin
      || validatedInventory.modelRootPath !== options.modelRootPath) {
      throw new Error('Eva model manifest identity does not match the configured model root.');
    }
    const identity = await manifestVersionFor(rawBytes, response);
    const inventory: ModelCacheInventory = {
      ...validatedInventory,
      manifestIdentity: identity,
    };
    const record: ModelCacheManifestRecord = {
      key: createModelCacheManifestKey(options.modelOrigin, options.modelRootPath),
      modelOrigin: options.modelOrigin,
      modelRootPath: options.modelRootPath,
      ...identity,
      rawBytes: cloneBytes(rawBytes),
      contentType: responseContentType(response),
      inventory,
      fetchedAt: now,
      freshUntil: now + (options.freshnessMs ?? MODEL_CACHE_MANIFEST_FRESHNESS_MS),
    };
    await this.#metadata.putManifest(record);
    return record;
  }

  async #refreshCompleteness(
    packageRecord: ModelCachePackageRecord,
    inventory: ModelCacheInventory,
  ): Promise<ModelCachePackageRecord> {
    const current = await this.#metadata.getPackage(packageRecord.key);
    if (current?.state === 'removing') return current;
    const files = await this.#metadata.listFiles(packageRecord.key);
    const storedByPath = new Map(files.map((file) => [file.path, file]));
    const absent = new Set(packageRecord.optionalAbsentPaths);
    const complete = inventory.files.every((expected) => {
      if (!expected.present) {
        return !expected.required && absent.has(expected.path);
      }
      const stored = storedByPath.get(expected.path);
      return stored !== undefined && sameFileContract(stored, expected);
    });
    const nextState = complete ? 'complete' : 'incomplete';
    if (packageRecord.state !== nextState) {
      packageRecord.state = nextState;
      packageRecord.updatedAt = this.#now();
      await this.#metadata.putPackage(packageRecord);
    }
    return packageRecord;
  }

  async #dropFile(record: ModelCacheFileRecord): Promise<void> {
    const packageRecord = await this.#metadata.getPackage(record.packageKey);
    const wasRemoving = packageRecord?.state === 'removing';
    if (packageRecord) {
      packageRecord.state = 'removing';
      packageRecord.updatedAt = this.#now();
      await this.#metadata.putPackage(packageRecord);
    }
    await this.#backend.deleteFile(record);
    await this.#metadata.deleteFile(record.key);
    for (const verified of this.#verifiedByScope.values()) verified.delete(record.key);
    if (packageRecord && !wasRemoving) {
      packageRecord.state = 'incomplete';
      packageRecord.updatedAt = this.#now();
      await this.#metadata.putPackage(packageRecord);
    }
  }

  async #removePackage(packageRecord: ModelCachePackageRecord): Promise<void> {
    if (this.#removingPackages.has(packageRecord.key)) {
      return;
    }
    this.#removingPackages.add(packageRecord.key);
    try {
      packageRecord.state = 'removing';
      packageRecord.updatedAt = this.#now();
      await this.#metadata.putPackage(packageRecord);
      const files = await this.#metadata.listFiles(packageRecord.key);
      for (const file of files) {
        await this.#backend.deleteFile(file);
        await this.#metadata.deleteFile(file.key);
        for (const verified of this.#verifiedByScope.values()) verified.delete(file.key);
      }
      const temporaries = (await this.#metadata.listTemporary())
        .filter((record) => record.packageKey === packageRecord.key);
      for (const temporary of temporaries) {
        await this.#backend.deleteTemporary(temporary);
        await this.#metadata.deleteTemporary(temporary.id);
      }
      await this.#metadata.deletePackage(packageRecord.key);
    } finally {
      this.#removingPackages.delete(packageRecord.key);
    }
  }

  async #withPackageLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#packageLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.#packageLocks.set(key, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#packageLocks.get(key) === queued) {
        this.#packageLocks.delete(key);
      }
    }
  }

  async #runVerification<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#activeVerifications >= 2) {
      await new Promise<void>((resolve) => this.#verificationWaiters.push(resolve));
    }
    this.#activeVerifications += 1;
    try {
      return await operation();
    } finally {
      this.#activeVerifications -= 1;
      this.#verificationWaiters.shift()?.();
    }
  }
}

export function createStoredManifestResponse(record: ModelCacheManifestRecord, method: 'GET' | 'HEAD'): Response {
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type, ETag',
    'Cache-Control': 'no-store',
    'Content-Length': String(record.rawBytes.byteLength),
    'Content-Type': record.contentType,
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  if (record.strongEtag) {
    headers.set('ETag', record.strongEtag);
  }
  const bytes = cloneBytes(record.rawBytes);
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(method === 'HEAD' ? null : body, {
    status: 200,
    headers,
  });
}

export async function openPersistentModelCacheStore(
  now: () => number = Date.now,
  backendPreference: 'auto' | ModelCacheBackendKind = 'auto',
): Promise<ModelCacheStore> {
  if (backendPreference !== 'auto' && backendPreference !== 'opfs') {
    throw new Error('Model storage supports OPFS only.');
  }
  const { openOpfsModelRoot } = await import('./opfs-files');
  const { OpfsModelCacheRepository } = await import('./opfs-metadata');
  const { OpfsModelCacheBackend } = await import('./opfs-store');
  const root = await openOpfsModelRoot();
  const metadata = new OpfsModelCacheRepository(root);
  const backend = new OpfsModelCacheBackend(root, metadata, now);
  return new ModelCacheStore({ metadata, backend, now });
}
