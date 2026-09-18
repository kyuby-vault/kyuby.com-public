import type {
  ModelCacheInventory,
  ModelCachePersistenceState,
  ModelCacheStatus,
  ModelCacheStorageEstimate,
  ModelCacheWarning,
} from './types';
import {
  MODEL_CACHE_PROTOCOL_VERSION,
  isModelCacheWorkerMessage,
  type ModelCacheClientMessage,
  type ModelCacheWorkerMessage,
} from './protocol';

export type { ModelCacheWorkerMessage } from './protocol';

const SERVICE_WORKER_URL = '/eva-model-cache-sw.js';
const SERVICE_WORKER_SCOPE = '/';
const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 10_000;
const REMOVE_MODEL_RPC_TIMEOUT_MS = 10 * 60 * 1_000;

export interface ModelCacheRoot {
  modelOrigin: string;
  modelRootPath: string;
}

type ModelCacheMessageBase = Pick<
  ModelCacheClientMessage,
  'protocolVersion' | 'requestId' | 'modelOrigin' | 'modelRootPath' | 'manifestVersion'
>;

type ModelCacheMessageListener = (message: ModelCacheWorkerMessage) => void;

interface PendingRpc {
  expectedType: ModelCacheWorkerMessage['type'];
  resolve: (message: ModelCacheWorkerMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
  port: MessagePort;
}

export interface ModelCacheClientAvailability {
  available: boolean;
  warning: ModelCacheWarning | null;
}

export interface BrowserStorageStatus {
  persistence: ModelCachePersistenceState;
  estimate: ModelCacheStorageEstimate;
}

function serviceWorkerWarning(message: string): ModelCacheWarning {
  return {
    code: 'service-worker-unavailable',
    message,
    recoverable: true,
  };
}

function waitForController(container: ServiceWorkerContainer): Promise<ServiceWorker> {
  if (container.controller) {
    return Promise.resolve(container.controller);
  }

  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      container.removeEventListener('controllerchange', handleControllerChange);
      reject(new Error('The Eva model cache did not take control of this page in time.'));
    }, SERVICE_WORKER_READY_TIMEOUT_MS);

    function handleControllerChange(): void {
      if (!container.controller) {
        return;
      }
      globalThis.clearTimeout(timeout);
      container.removeEventListener('controllerchange', handleControllerChange);
      resolve(container.controller);
    }

    container.addEventListener('controllerchange', handleControllerChange);
  });
}

async function waitForReadyRegistration(container: ServiceWorkerContainer): Promise<ServiceWorkerRegistration> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      container.ready,
      new Promise<never>((_resolve, reject) => {
        timeout = globalThis.setTimeout(() => {
          reject(new Error('The Eva model cache Service Worker did not activate in time.'));
        }, SERVICE_WORKER_READY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
    }
  }
}

/**
 * Owns root Service Worker registration/control. Cache protocol RPC is added on
 * top of this lifecycle so callers can fail closed to a normal network load.
 */
export class EvaModelCacheClient extends EventTarget {
  #availability: ModelCacheClientAvailability = {
    available: false,
    warning: null,
  };

  #controller: ServiceWorker | null = null;
  #initializePromise: Promise<ModelCacheClientAvailability> | null = null;
  #root: ModelCacheRoot | null = null;
  #manifestVersion: string | null = null;
  #pending = new Map<string, PendingRpc>();
  #listeners = new Set<ModelCacheMessageListener>();

  get availability(): ModelCacheClientAvailability {
    return this.#availability;
  }

  get controller(): ServiceWorker | null {
    return this.#controller;
  }

  initialize(): Promise<ModelCacheClientAvailability> {
    this.#initializePromise ??= this.#initialize();
    return this.#initializePromise;
  }

  subscribe(listener: ModelCacheMessageListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async configureRoot(root: ModelCacheRoot): Promise<ModelCacheStatus> {
    this.#root = root;
    this.#manifestVersion = null;
    const response = await this.#rpc({
      ...this.#baseMessage(null),
      type: 'CONFIGURE',
      inventory: null,
    }, 'STATUS');
    return response.status;
  }

  async configureInventory(inventory: ModelCacheInventory): Promise<ModelCacheStatus> {
    this.#root = {
      modelOrigin: inventory.modelOrigin,
      modelRootPath: inventory.modelRootPath,
    };
    this.#manifestVersion = inventory.manifestIdentity.manifestVersion;
    const response = await this.#rpc({
      ...this.#baseMessage(this.#requireManifestVersion()),
      type: 'CONFIGURE',
      inventory,
    }, 'STATUS');
    return response.status;
  }

  async getStatus(): Promise<ModelCacheStatus> {
    const response = await this.#rpc({
      ...this.#baseMessage(this.#manifestVersion),
      type: 'GET_STATUS',
    }, 'STATUS');
    return response.status;
  }

  async beginLoad(diskOnly = false, concurrency: 2 | 4 = 2): Promise<string> {
    const nonce = crypto.randomUUID();
    await this.#rpc({
      ...this.#baseMessage(this.#requireManifestVersion()),
      type: diskOnly ? 'BEGIN_DISK_LOAD' : 'BEGIN_LOAD',
      nonce,
      concurrency,
    }, 'STATUS');
    return nonce;
  }

  async endLoad(nonce: string): Promise<ModelCacheStatus> {
    const response = await this.#rpc({
      ...this.#baseMessage(this.#requireManifestVersion()),
      type: 'END_LOAD',
      nonce,
    }, 'STATUS');
    return response.status;
  }

  async renewLoad(nonce: string): Promise<ModelCacheStatus> {
    const response = await this.#rpc({
      ...this.#baseMessage(this.#requireManifestVersion()),
      type: 'RENEW_LOAD',
      nonce,
    }, 'STATUS');
    return response.status;
  }

  async cancelLoad(nonce: string): Promise<ModelCacheStatus> {
    const response = await this.#rpc({
      ...this.#baseMessage(this.#requireManifestVersion()),
      type: 'CANCEL_LOAD',
      nonce,
    }, 'STATUS');
    return response.status;
  }

  async removeModel(): Promise<Extract<ModelCacheWorkerMessage, { type: 'REMOVE_RESULT' }>> {
    const response = await this.#rpc({
      ...this.#baseMessage(null),
      type: 'REMOVE_MODEL',
    }, 'REMOVE_RESULT', REMOVE_MODEL_RPC_TIMEOUT_MS);
    return response;
  }

  async reverify(): Promise<Extract<ModelCacheWorkerMessage, { type: 'VERIFY_RESULT' }>> {
    return this.#rpc({ ...this.#baseMessage(this.#requireManifestVersion()), type: 'REVERIFY' },
      'VERIFY_RESULT', 30 * 60 * 1000);
  }

  dispose(): void {
    navigator.serviceWorker?.removeEventListener('message', this.#handleServiceWorkerMessage);
    for (const pending of this.#pending.values()) {
      globalThis.clearTimeout(pending.timeout);
      pending.port.close();
      pending.reject(new Error('Eva model cache client was disposed.'));
    }
    this.#pending.clear();
    this.#listeners.clear();
    this.#controller = null;
  }

  async #initialize(): Promise<ModelCacheClientAvailability> {
    if (!('serviceWorker' in navigator)) {
      return this.#setUnavailable('Persistent model caching is unavailable in this browser. Eva will load from the network.');
    }

    try {
      await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
        type: 'module',
        scope: SERVICE_WORKER_SCOPE,
        updateViaCache: 'none',
      });
      await waitForReadyRegistration(navigator.serviceWorker);
      this.#controller = await waitForController(navigator.serviceWorker);
      navigator.serviceWorker.addEventListener('message', this.#handleServiceWorkerMessage);
      this.#availability = { available: true, warning: null };
      return this.#availability;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.#setUnavailable(`Persistent model caching is unavailable (${reason}). Eva will load from the network.`);
    }
  }

  #setUnavailable(message: string): ModelCacheClientAvailability {
    this.#controller = null;
    this.#availability = {
      available: false,
      warning: serviceWorkerWarning(message),
    };
    return this.#availability;
  }

  #baseMessage<T extends string | null>(
    manifestVersion: T,
  ): Omit<ModelCacheMessageBase, 'manifestVersion'> & { manifestVersion: T } {
    if (!this.#root) {
      throw new Error('Eva model cache has not been configured for a model root.');
    }
    if (!this.#controller) {
      throw new Error('Eva model cache Service Worker is not controlling this page.');
    }
    return {
      protocolVersion: MODEL_CACHE_PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      modelOrigin: this.#root.modelOrigin,
      modelRootPath: this.#root.modelRootPath,
      manifestVersion,
    };
  }

  #requireManifestVersion(): string {
    if (!this.#manifestVersion) {
      throw new Error('Eva model cache does not have a validated manifest identity.');
    }
    return this.#manifestVersion;
  }

  #rpc<T extends ModelCacheWorkerMessage['type']>(
    message: ModelCacheClientMessage,
    expectedType: T,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<Extract<ModelCacheWorkerMessage, { type: T }>> {
    if (!this.#controller) {
      return Promise.reject(new Error('Eva model cache Service Worker is not controlling this page.'));
    }

    const channel = new MessageChannel();
    const completion = new Promise<ModelCacheWorkerMessage>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.#pending.delete(message.requestId);
        channel.port1.close();
        reject(new Error(`Eva model cache ${message.type} request timed out.`));
      }, timeoutMs);
      this.#pending.set(message.requestId, {
        expectedType,
        resolve,
        reject,
        timeout,
        port: channel.port1,
      });
      channel.port1.addEventListener('message', this.#handlePortMessage);
      channel.port1.start();
    });

    try {
      this.#controller.postMessage(message, [channel.port2]);
    } catch (error) {
      this.#settleRpcError(message.requestId, error instanceof Error ? error : new Error(String(error)));
    }
    return completion as Promise<Extract<ModelCacheWorkerMessage, { type: T }>>;
  }

  #handlePortMessage = (event: MessageEvent<unknown>): void => {
    this.#handleIncomingMessage(event.data);
  };

  #handleServiceWorkerMessage = (event: MessageEvent<unknown>): void => {
    this.#handleIncomingMessage(event.data);
  };

  #handleIncomingMessage(value: unknown): void {
    if (!isModelCacheWorkerMessage(value)) {
      return;
    }
    if (this.#root
      && (value.modelOrigin !== this.#root.modelOrigin
        || value.modelRootPath !== this.#root.modelRootPath)) {
      return;
    }

    for (const listener of this.#listeners) {
      listener(value);
    }
    this.dispatchEvent(new CustomEvent<ModelCacheWorkerMessage>('message', { detail: value }));

    const pending = this.#pending.get(value.requestId);
    if (!pending) {
      return;
    }
    if (value.type === 'ERROR') {
      this.#settleRpcError(value.requestId, new Error(value.message));
      return;
    }
    if (value.type !== pending.expectedType) {
      return;
    }
    globalThis.clearTimeout(pending.timeout);
    pending.port.close();
    this.#pending.delete(value.requestId);
    pending.resolve(value);
  }

  #settleRpcError(requestId: string, error: Error): void {
    const pending = this.#pending.get(requestId);
    if (!pending) {
      return;
    }
    globalThis.clearTimeout(pending.timeout);
    pending.port.close();
    this.#pending.delete(requestId);
    pending.reject(error);
  }
}

export async function inspectBrowserStorage(): Promise<BrowserStorageStatus> {
  const storage = navigator.storage;
  let persistence: ModelCachePersistenceState = 'browser-managed';
  let estimate: ModelCacheStorageEstimate = { usage: null, quota: null };

  if (storage?.persisted) {
    try {
      persistence = await storage.persisted() ? 'persistent' : 'best-effort';
    } catch {
      persistence = 'browser-managed';
    }
  }

  if (storage?.estimate) {
    try {
      const result = await storage.estimate();
      estimate = {
        usage: typeof result.usage === 'number' ? result.usage : null,
        quota: typeof result.quota === 'number' ? result.quota : null,
      };
    } catch {
      // The Runtime tab reports that the estimate is unavailable.
    }
  }

  return { persistence, estimate };
}

/** Call synchronously from the explicit Runtime-tab button so user activation is kept. */
export async function requestBrowserStoragePersistence(): Promise<boolean | null> {
  if (!navigator.storage?.persist) {
    return null;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
