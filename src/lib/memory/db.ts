import { deleteDB, openDB, unwrap, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { EvaChatRole } from '../eva/worker-protocol';
import type { SandboxObservabilityRecord } from '../sandbox/telemetry';
import { parseEvaDataImport, previewEvaDataImport, validateEvaMemoryRecord } from './serialization';
import { indexRecordKey, type CatalogTable, type IndexEntry, type IndexEvent, type MemoryIndexSource } from './index-source';
import {
  contextKey,
  defaultEvaProfile,
  DEFAULT_EVA_CONTEXT_SCOPE,
  EVA_CONTEXT_LIMITS,
  validateEvaContextScope,
  type EvaContextExport,
  type EvaContextScope,
  type EvaDataExport,
  type EvaExportOptions,
  type EvaMemoryRecord,
  type EvaMessage,
  type EvaProfile,
  type EvaRecoveryRecord,
  type EvaSession,
} from './types';

export * from './types';
export { previewEvaDataImport } from './serialization';
export const MAX_EVA_IMPORT_BYTES = EVA_CONTEXT_LIMITS.importBytes;

const DATABASE_NAME = 'kyuby-eva';
const DATABASE_VERSION = 5;
const MAX_SESSIONS = EVA_CONTEXT_LIMITS.sessions;
const MAX_MESSAGES_PER_SESSION = EVA_CONTEXT_LIMITS.messagesPerSession;
const MAX_MEMORY_RECORDS = EVA_CONTEXT_LIMITS.memory;
const MEMORY_STORAGE_FULL_MESSAGE = 'Local memory storage is full. Free browser storage, then retry memory.store.';
const CONTEXT_STORES = ['sessions', 'messages', 'memory', 'profile', 'recovery'] as const;
const CATALOG_STORES = [...CONTEXT_STORES, 'kv', 'indexOutbox', 'indexRevisions'] as const;
const indexListeners = new Set<(events: IndexEvent[]) => void>();
type CatalogTransaction = IDBPTransaction<EvaDatabase, typeof CATALOG_STORES, 'readwrite'>;
type ScopeKey = [string, string];
type RecordKey = [string, string, string];

export interface CreateEvaSessionOptions {
  id?: string;
  createdAt?: number;
}

interface EvaDatabase extends DBSchema {
  observability: { key: string; value: SandboxObservabilityRecord; indexes: { 'by-recorded-at': number } };
  kv: { key: string; value: { key: string; value: string | number } };
  indexOutbox: { key: number; value: IndexEvent; indexes: { 'by-index-seq': number } };
  indexRevisions: { key: string; value: IndexEvent };
  sessions: {
    key: RecordKey;
    value: EvaSession;
    indexes: { 'by-updated-at': number; 'by-scope': ScopeKey };
  };
  messages: {
    key: RecordKey;
    value: EvaMessage;
    indexes: {
      'by-scope': ScopeKey;
      'by-session': RecordKey;
      'by-session-created-at': [string, string, string, number];
    };
  };
  memory: {
    key: RecordKey;
    value: EvaMemoryRecord;
    indexes: { 'by-updated-at': number; 'by-scope': ScopeKey };
  };
  profile: {
    key: RecordKey;
    value: EvaProfile;
    indexes: { 'by-scope': ScopeKey };
  };
  recovery: {
    key: RecordKey;
    value: EvaRecoveryRecord;
    indexes: { 'by-scope': ScopeKey };
  };
}

let databasePromise: Promise<IDBPDatabase<EvaDatabase>> | null = null;

function scopeKey(scope: EvaContextScope): ScopeKey {
  const validated = validateEvaContextScope(scope);
  return [validated.model_id, validated.context_partition_id];
}

function recordKey(scope: EvaContextScope, id: string): RecordKey {
  return [...scopeKey(scope), id];
}

function messageRange(scope: EvaContextScope, sessionId: string): IDBKeyRange {
  const key = recordKey(scope, sessionId);
  return IDBKeyRange.bound([...key, 0], [...key, Number.MAX_SAFE_INTEGER]);
}

async function abortWrite(transaction: { abort(): void; done: Promise<unknown> }, error: unknown): Promise<never> {
  try { transaction.abort(); } catch {}
  await transaction.done.catch(() => undefined);
  throw error;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function validateExplicitSessionId(value: string): string {
  if (value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('Explicit Eva session ID is invalid.');
  }
  return value;
}

function normalizeTitle(title: string): string {
  const compact = title.trim().replace(/\s+/g, ' ');
  return compact.length > 48 ? `${compact.slice(0, 47)}...` : compact || 'New conversation';
}

function getDatabase(): Promise<IDBPDatabase<EvaDatabase>> {
  if (!databasePromise) {
    databasePromise = openDB<EvaDatabase>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(database, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          // Immutable v1 schema: later migrations must not change this creation block.
          const sessions = database.createObjectStore('sessions', { keyPath: 'id' });
          sessions.createIndex('by-updated-at', 'updatedAt');

          const messages = database.createObjectStore('messages', { keyPath: 'id' });
          messages.createIndex('by-session', 'sessionId');
          messages.createIndex('by-session-created-at', ['sessionId', 'createdAt']);

          const memory = database.createObjectStore('memory', { keyPath: 'id' });
          memory.createIndex('by-updated-at', 'updatedAt');

          database.createObjectStore('profile', { keyPath: 'id' });
        }

        if (oldVersion < 2) {
          // v2 hardens memory writes against quota exhaustion without changing the schema.
        }

        if (oldVersion < 3) {
          const nativeDatabase = unwrap(database);
          const nativeTransaction = unwrap(transaction);
          for (const name of ['sessions', 'messages', 'memory', 'profile']) {
            const request = nativeTransaction.objectStore(name).getAll();
            request.onsuccess = () => {
              nativeDatabase.deleteObjectStore(name);
              const store = nativeDatabase.createObjectStore(name, {
                keyPath: ['model_id', 'context_partition_id', 'id'],
              });
              store.createIndex('by-scope', ['model_id', 'context_partition_id']);
              if (name === 'sessions' || name === 'memory') store.createIndex('by-updated-at', 'updatedAt');
              if (name === 'messages') {
                store.createIndex('by-session', ['model_id', 'context_partition_id', 'sessionId']);
                store.createIndex('by-session-created-at', ['model_id', 'context_partition_id', 'sessionId', 'createdAt']);
              }
              for (const record of request.result) store.put({ ...record, ...DEFAULT_EVA_CONTEXT_SCOPE });
            };
          }
          const recovery = database.createObjectStore('recovery', {
            keyPath: ['model_id', 'context_partition_id', 'id'],
          });
          recovery.createIndex('by-scope', ['model_id', 'context_partition_id']);
        }
        if (oldVersion < 4) {
          const kv = database.createObjectStore('kv', { keyPath: 'key' });
          kv.put({ key: 'indexSeq', value: 0 });
          kv.put({ key: 'indexEpoch', value: crypto.randomUUID() });
          const outbox = database.createObjectStore('indexOutbox', { keyPath: 'indexSeq' });
          outbox.createIndex('by-index-seq', 'indexSeq');
          database.createObjectStore('indexRevisions', { keyPath: 'key' });
        }
        if (oldVersion < 5) {
          const observability = database.createObjectStore('observability', { keyPath: 'probeId' });
          observability.createIndex('by-recorded-at', 'recordedAt');
        }
      },
      blocking() {
        void databasePromise?.then((database) => database.close());
        databasePromise = null;
      },
      terminated() { databasePromise = null; },
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

const transactionEvents = new WeakMap<CatalogTransaction, IndexEvent[]>();

/** Host-only sandbox storage; deliberately outside canonical stores, exports and the index journal. */
export async function sandboxObservabilityTransaction<Mode extends IDBTransactionMode>(mode: Mode) {
  return (await getDatabase()).transaction('observability', mode);
}

function catalogTransaction(database: IDBPDatabase<EvaDatabase>): CatalogTransaction {
  const transaction = database.transaction(CATALOG_STORES, 'readwrite');
  const events: IndexEvent[] = [];
  transactionEvents.set(transaction, events);
  void transaction.done.then(() => {
    for (const listener of indexListeners) {
      try { listener(events); } catch { console.warn('Memory index notification failed; durable replay remains available.'); }
    }
  }, () => undefined);
  return transaction;
}

async function indexMutation(transaction: CatalogTransaction, table: CatalogTable, record: EvaContextScope & { id: string; sessionId?: string }, op: IndexEvent['op']): Promise<void> {
  const kv = transaction.objectStore('kv');
  const indexSeq = Number((await kv.get('indexSeq'))?.value ?? 0) + 1;
  if (!Number.isSafeInteger(indexSeq) || indexSeq < 1) throw new Error('Invalid memory index sequence.');
  const sessionId = table === 'sessions' ? record.id : record.sessionId ?? null;
  const event: IndexEvent = { ...validateEvaContextScope(record), indexSeq, table, id: record.id, sessionId, op,
    key: indexRecordKey(record, sessionId, table, record.id) };
  const outbox = transaction.objectStore('indexOutbox');
  const revisions = transaction.objectStore('indexRevisions');
  await kv.put({ key: 'indexSeq', value: indexSeq });
  await outbox.add(event);
  await revisions.put(event);
  if (indexSeq > 100_000) {
    const expired = await outbox.get(indexSeq - 100_000);
    await outbox.delete(indexSeq - 100_000);
    if (expired?.op === 'delete' && (await revisions.get(expired.key))?.indexSeq === expired.indexSeq) {
      await revisions.delete(expired.key);
    }
  }
  transactionEvents.get(transaction)!.push(event);
}

async function catalogPut<Table extends CatalogTable>(transaction: CatalogTransaction, table: Table, record: EvaDatabase[Table]['value'], add = false): Promise<void> {
  try {
    const store = transaction.objectStore(table);
    if (add) await store.add(record);
    else await store.put(record);
    await indexMutation(transaction, table, record, 'put');
  } catch (error) { await abortWrite(transaction, error); }
}

async function catalogDelete(transaction: CatalogTransaction, table: CatalogTable, key: RecordKey): Promise<void> {
  try {
    const store = transaction.objectStore(table);
    const record = await store.get(key);
    if (!record) return;
    await store.delete(key);
    await indexMutation(transaction, table, record, 'delete');
  } catch (error) { await abortWrite(transaction, error); }
}

export const memoryIndexSource: MemoryIndexSource = {
  async state() {
    const transaction = (await getDatabase()).transaction('kv');
    const [epoch, sequence] = await Promise.all([transaction.store.get('indexEpoch'), transaction.store.get('indexSeq')]);
    await transaction.done;
    return { epoch: String(epoch!.value), highWaterSeq: Number(sequence!.value) };
  },
  async events(after, limit) {
    return (await getDatabase()).getAllFromIndex('indexOutbox', 'by-index-seq', IDBKeyRange.lowerBound(after, true), Math.max(1, Math.min(100, limit)));
  },
  async snapshot() {
    const transaction = (await getDatabase()).transaction(['memory', 'kv', 'indexRevisions']);
    const [records, revisions, epoch, sequence] = await Promise.all([
      transaction.objectStore('memory').getAll(), transaction.objectStore('indexRevisions').getAll(),
      transaction.objectStore('kv').get('indexEpoch'), transaction.objectStore('kv').get('indexSeq'),
    ]);
    await transaction.done;
    const byKey = new Map(revisions.map((event) => [event.key, event]));
    return { epoch: String(epoch!.value), highWaterSeq: Number(sequence!.value), entries: records.map((record) => {
      const key = indexRecordKey(record, record.sessionId ?? null, 'memory', record.id);
      return { key, indexSeq: byKey.get(key)?.indexSeq ?? 0, record };
    }) };
  },
  async read(event) {
    if (event.table !== 'memory') return null;
    const transaction = (await getDatabase()).transaction(['memory', 'indexRevisions']);
    const [record, revision] = await Promise.all([
      transaction.objectStore('memory').get(recordKey(event, event.id)), transaction.objectStore('indexRevisions').get(event.key),
    ]);
    await transaction.done;
    if (!record || (record.sessionId ?? null) !== event.sessionId || revision?.op === 'delete') return null;
    return { record, key: event.key, indexSeq: revision?.indexSeq ?? 0 } satisfies IndexEntry;
  },
  subscribe(listener) { indexListeners.add(listener); return () => { indexListeners.delete(listener); }; },
};

async function removeSession(database: IDBPDatabase<EvaDatabase>, sessionId: string, scope: EvaContextScope): Promise<void> {
  const transaction = catalogTransaction(database);
  try {
    const key = recordKey(scope, sessionId);
    const messageIds = await transaction.objectStore('messages').index('by-session').getAllKeys(key);
    for (const id of messageIds) await catalogDelete(transaction, 'messages', id);
    await catalogDelete(transaction, 'sessions', key);
    await transaction.objectStore('recovery').delete(key);
    await transaction.done;
  } catch (error) { await abortWrite(transaction, error); }
}

async function pruneSessions(database: IDBPDatabase<EvaDatabase>, scope: EvaContextScope): Promise<void> {
  const sessions = (await database.getAllFromIndex('sessions', 'by-scope', scopeKey(scope)))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  await Promise.all(sessions.slice(MAX_SESSIONS).map((session) => removeSession(database, session.id, scope)));
}

async function pruneMessages(database: IDBPDatabase<EvaDatabase>, sessionId: string, scope: EvaContextScope): Promise<void> {
  const messages = await database.getAllFromIndex('messages', 'by-session-created-at', messageRange(scope, sessionId));
  const staleMessages = messages.slice(0, Math.max(0, messages.length - MAX_MESSAGES_PER_SESSION));
  const transaction = catalogTransaction(database);
  for (const message of staleMessages) await catalogDelete(transaction, 'messages', recordKey(scope, message.id));
  await transaction.done;
}

/** Keep canonical memory before disposable views, then retain the newest records in each class. */
function memoryRetentionOrder(left: EvaMemoryRecord, right: EvaMemoryRecord): number {
  return Number(left.provenance === 'synthesized') - Number(right.provenance === 'synthesized')
    || right.updatedAt - left.updatedAt;
}

async function pruneMemory(database: IDBPDatabase<EvaDatabase>, scope: EvaContextScope): Promise<void> {
  const records = (await database.getAllFromIndex('memory', 'by-scope', scopeKey(scope)))
    .sort(memoryRetentionOrder);
  const transaction = catalogTransaction(database);
  for (const record of records.slice(MAX_MEMORY_RECORDS)) await catalogDelete(transaction, 'memory', recordKey(scope, record.id));
  await transaction.done;
}

function isQuotaExceededError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'QuotaExceededError';
}

async function retryMemoryPutAfterCapPrune(
  database: IDBPDatabase<EvaDatabase>,
  record: EvaMemoryRecord,
): Promise<void> {
  const transaction = catalogTransaction(database);
  try {
    const records = (await transaction.objectStore('memory').index('by-scope').getAll(scopeKey(record)))
      .sort(memoryRetentionOrder);
    const staleRecords = records.slice(Math.max(0, MAX_MEMORY_RECORDS - 1));
    // Quota retry must not bypass synthesized-first retention when no disposable slot remains.
    if (record.provenance === 'synthesized' && staleRecords.some((stale) => stale.provenance !== 'synthesized')) {
      throw new DOMException('No disposable memory slot is available.', 'QuotaExceededError');
    }
    for (const staleRecord of staleRecords) await catalogDelete(transaction, 'memory', recordKey(record, staleRecord.id));
    await catalogPut(transaction, 'memory', record);
    await transaction.done;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // A native quota failure may already have aborted the transaction.
    }
    try {
      await transaction.done;
    } catch {
      // Preserve the original storage failure below.
    }
    throw error;
  }
}

export async function createSession(
  title = 'New conversation',
  options: CreateEvaSessionOptions = {},
  scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE,
): Promise<EvaSession> {
  const database = await getDatabase();
  const now = options.createdAt ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('Eva session creation time is invalid.');
  }
  const session: EvaSession = {
    ...validateEvaContextScope(scope),
    id: options.id ? validateExplicitSessionId(options.id) : createId('session'),
    title: normalizeTitle(title),
    createdAt: now,
    updatedAt: now,
  };
  const transaction = catalogTransaction(database);
  try { await catalogPut(transaction, 'sessions', session, true); await transaction.done; }
  catch (error) { return abortWrite(transaction, error); }
  await pruneSessions(database, scope);
  return session;
}

export async function retagEmptySession(
  sessionId: string,
  replacementId: string,
  scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE,
): Promise<EvaSession | null> {
  if (sessionId === replacementId) {
    const database = await getDatabase();
    return (await database.get('sessions', recordKey(scope, sessionId))) ?? null;
  }
  const database = await getDatabase();
  const validatedReplacementId = validateExplicitSessionId(replacementId);
  const transaction = catalogTransaction(database);
  const sessions = transaction.objectStore('sessions');
  const messages = transaction.objectStore('messages');
  const [session, replacement, messageCount] = await Promise.all([
    sessions.get(recordKey(scope, sessionId)),
    sessions.get(recordKey(scope, validatedReplacementId)),
    messages.index('by-session').count(recordKey(scope, sessionId)),
  ]);
  if (!session || replacement || messageCount > 0) {
    await transaction.done;
    return null;
  }
  const retagged = { ...session, id: validatedReplacementId };
  const recovery = transaction.objectStore('recovery');
  const savedRecovery = await recovery.get(recordKey(scope, sessionId));
  if (savedRecovery) {
    await recovery.put({ ...savedRecovery, id: validatedReplacementId, sessionId: validatedReplacementId });
    await recovery.delete(recordKey(scope, sessionId));
  }
  await catalogPut(transaction, 'sessions', retagged);
  await catalogDelete(transaction, 'sessions', recordKey(scope, sessionId));
  await transaction.done;
  return retagged;
}

export async function listSessions(scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE): Promise<EvaSession[]> {
  const database = await getDatabase();
  return (await database.getAllFromIndex('sessions', 'by-scope', scopeKey(scope)))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function renameSession(sessionId: string, title: string, scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE): Promise<void> {
  const database = await getDatabase();
  const session = await database.get('sessions', recordKey(scope, sessionId));
  if (!session) {
    return;
  }
  const transaction = catalogTransaction(database);
  await catalogPut(transaction, 'sessions', {
    ...session,
    title: normalizeTitle(title),
    updatedAt: Date.now(),
  });
  await transaction.done;
}

export async function deleteSession(sessionId: string, scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE): Promise<void> {
  await removeSession(await getDatabase(), sessionId, scope);
}

export async function listMessages(sessionId: string, scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE): Promise<EvaMessage[]> {
  const database = await getDatabase();
  return database.getAllFromIndex('messages', 'by-session-created-at', messageRange(scope, sessionId));
}

export async function appendMessage(
  sessionId: string,
  role: EvaChatRole,
  content: string,
  name?: string,
  scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE,
): Promise<EvaMessage> {
  const owner = validateEvaContextScope(scope);
  if (content.length > EVA_CONTEXT_LIMITS.messageChars) throw new TypeError('Eva message exceeds its storage limit.');
  const database = await getDatabase();
  const transaction = catalogTransaction(database);
  try {
    const session = await transaction.objectStore('sessions').get(recordKey(owner, sessionId));
    if (!session) throw new Error('The Eva session is unavailable in this context partition.');
    const messageStore = transaction.objectStore('messages');
    const latest = await messageStore.index('by-session-created-at').openCursor(messageRange(owner, sessionId), 'prev');
    const previousTurn = latest?.value.turn ?? (await messageStore.index('by-session').getAll(recordKey(owner, sessionId)))
      .filter((message) => message.role === 'user').length;
    const now = Math.max(Date.now(), session.createdAt, (latest?.value.createdAt ?? -1) + 1);
    const message: EvaMessage = {
      ...owner,
      id: createId('message'),
      sessionId,
      role,
      content,
      ...(name ? { name } : {}),
      createdAt: now,
      turn: Math.max(1, previousTurn + (role === 'user' ? 1 : 0)),
    };
    await catalogPut(transaction, 'messages', message);
    await catalogPut(transaction, 'sessions', { ...session, updatedAt: now });
    await transaction.done;
    await pruneMessages(database, sessionId, owner);
    return message;
  } catch (error) { return abortWrite(transaction, error); }
}

export async function storeMemory(content: string, tags: string[] = [], scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE,
  metadata: Pick<EvaMemoryRecord, 'sessionId' | 'provenance' | 'sourceMessageIds' | 'pagingTurnId'> = {}): Promise<EvaMemoryRecord> {
  const database = await getDatabase();
  const now = Date.now();
  const record: EvaMemoryRecord = {
    ...validateEvaContextScope(scope),
    id: createId('memory'),
    content: content.trim(),
    tags: metadata.provenance === 'auto' ? [...tags] : [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))],
    createdAt: now,
    updatedAt: now,
    ...metadata,
  };
  validateEvaMemoryRecord(record, scope);
  try {
    const transaction = catalogTransaction(database);
    try { await catalogPut(transaction, 'memory', record); await transaction.done; }
    catch (error) { await abortWrite(transaction, error); }
  } catch (error) {
    if (!isQuotaExceededError(error)) {
      throw error;
    }
    try {
      await retryMemoryPutAfterCapPrune(database, record);
    } catch (retryError) {
      if (isQuotaExceededError(retryError)) {
        throw new Error(MEMORY_STORAGE_FULL_MESSAGE);
      }
      throw retryError;
    }
    return record;
  }
  await pruneMemory(database, scope);
  return record;
}

export async function listMemory(scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE): Promise<EvaMemoryRecord[]> {
  const database = await getDatabase();
  return (await database.getAllFromIndex('memory', 'by-scope', scopeKey(scope)))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

/** Compare the completed source and commit its raw copy + synopsis in one transaction. */
export async function storeChapterSynopsis(source: EvaMessage, content: string, synopsis: NonNullable<EvaMemoryRecord['synopsis']>): Promise<EvaMemoryRecord> {
  const database = await getDatabase();
  const record: EvaMemoryRecord = { ...validateEvaContextScope(source), id: createId('memory'), content,
    tags: ['chapter-synopsis', `session:${source.sessionId}`, `chapter:${synopsis.chapter}`],
    createdAt: Date.now(), updatedAt: Date.now(), sessionId: source.sessionId,
    provenance: 'synopsis', sourceMessageIds: [source.id], synopsis };
  validateEvaMemoryRecord(record, source);
  const transaction = catalogTransaction(database);
  try {
    const stored = await transaction.objectStore('messages').get(recordKey(source, source.id));
    if (stored?.role !== 'assistant' || stored.content !== synopsis.raw || stored.content !== source.content
      || stored.sessionId !== source.sessionId || stored.createdAt !== source.createdAt
      || !await transaction.objectStore('sessions').get(recordKey(source, source.sessionId))) {
      throw new Error('Completed synopsis source changed or disappeared. Nothing was compressed.');
    }
    const memories = await transaction.objectStore('memory').index('by-scope').getAll(scopeKey(source));
    const previous = memories.find((item) => item.provenance === 'synopsis' && item.sessionId === source.sessionId && item.sourceMessageIds?.[0] === source.id);
    if (previous) { record.id = previous.id; record.createdAt = previous.createdAt; }
    else if (memories.length >= EVA_CONTEXT_LIMITS.memory) throw new Error('Memory record limit reached. Export and remove an old memory before creating a synopsis.');
    await catalogPut(transaction, 'memory', record);
    await transaction.done;
    return record;
  } catch (error) { return abortWrite(transaction, isQuotaExceededError(error) ? new Error(MEMORY_STORAGE_FULL_MESSAGE) : error); }
}

let memorySearchIndex: Promise<import('./memory-index').MemorySearchIndex> | undefined;
let memoryIndexBusy = () => false;
let memoryIndexPersistence = 'memory-only';
let memoryIndexActivity: (message: string) => void = () => {};

export function setMemoryIndexBusyProbe(probe: () => boolean): void { memoryIndexBusy = probe; }
export function setMemoryIndexActivitySink(sink: (message: string) => void): void { memoryIndexActivity = sink; }

async function waitForIndexIdle(): Promise<void> {
  if (typeof window === 'undefined') return;
  do {
    await new Promise<void>((resolve) => {
      if ('requestIdleCallback' in window) window.requestIdleCallback(() => resolve(), { timeout: 250 });
      else setTimeout(resolve, 0);
    });
  } while (memoryIndexBusy());
}

async function getMemorySearchIndex() {
  memorySearchIndex ??= (async () => {
    const { MemorySearchIndex } = await import('./memory-index');
    let storage: import('./index-storage').IndexStorage | undefined;
    if (typeof window !== 'undefined') {
      const { OpfsIndexStorage } = await import('./index-storage');
      const opfs = new OpfsIndexStorage();
      memoryIndexPersistence = 'OPFS';
      let enabled = true;
      const persist = async <Result>(action: () => Promise<Result>): Promise<Result | undefined> => {
        if (!enabled) return undefined;
        try { return await action(); }
        catch { enabled = false; memoryIndexPersistence = 'memory-only (OPFS unavailable)';
          console.warn('Memory index OPFS unavailable; using a rebuildable in-memory index.'); return undefined; }
      };
      storage = { load: () => persist(() => opfs.load()),
        save: async (database) => { await persist(() => opfs.save(database)); },
        remove: async () => { await persist(() => opfs.remove()); } };
    }
    return new MemorySearchIndex(memoryIndexSource, { storage, idle: waitForIndexIdle,
      activity: (message) => memoryIndexActivity(message) });
  })().catch((error) => { memorySearchIndex = undefined; throw error; });
  return memorySearchIndex;
}

export async function rebuildMemoryIndex() {
  const index = await getMemorySearchIndex();
  await index.rebuild();
  return { ...await index.status(), persistence: memoryIndexPersistence };
}

export async function prepareMemoryIndex() {
  await waitForIndexIdle();
  let needed = (await (await getDatabase()).count('memory')) > 0;
  if (!needed && typeof window !== 'undefined') {
    const { OpfsIndexStorage } = await import('./index-storage');
    needed = Boolean(await new OpfsIndexStorage().load().catch(() => undefined));
  }
  if (!needed) return null;
  const index = await getMemorySearchIndex();
  await index.catchUp();
  return { ...await index.status(), persistence: memoryIndexPersistence };
}

export async function closeMemoryIndex(): Promise<void> {
  const previous = memorySearchIndex;
  memorySearchIndex = undefined;
  if (previous) await (await previous).close();
}

export async function searchMemory(query: string, limit = 5, scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE, sessionId?: string): Promise<EvaMemoryRecord[]> {
  return (await getMemorySearchIndex()).search(query, limit, validateEvaContextScope(scope), sessionId);
}

export async function deleteMemory(memoryId: string, scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE): Promise<void> {
  const database = await getDatabase();
  const transaction = catalogTransaction(database);
  try { await catalogDelete(transaction, 'memory', recordKey(scope, memoryId)); await transaction.done; }
  catch (error) { await abortWrite(transaction, error); }
}

export async function getProfile(scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE): Promise<EvaProfile> {
  const database = await getDatabase();
  return (await database.get('profile', recordKey(scope, 'local'))) ?? defaultEvaProfile(validateEvaContextScope(scope));
}

export async function updateProfile(displayName: string, notes: string, scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE): Promise<EvaProfile> {
  const database = await getDatabase();
  const profile: EvaProfile = {
    ...validateEvaContextScope(scope),
    id: 'local',
    displayName: displayName.trim().slice(0, 80) || 'You',
    notes: notes.trim().slice(0, 2000),
    updatedAt: Date.now(),
  };
  const transaction = catalogTransaction(database);
  await catalogPut(transaction, 'profile', profile);
  await transaction.done;
  return profile;
}

async function readContextSnapshot<Mode extends IDBTransactionMode>(
  transaction: IDBPTransaction<EvaDatabase, typeof CATALOG_STORES, Mode>,
  options: EvaExportOptions = {},
): Promise<EvaDataExport> {
  const [sessions, messages, memory, profiles, recovery] = await Promise.all([
    transaction.objectStore('sessions').getAll(),
    transaction.objectStore('messages').getAll(),
    transaction.objectStore('memory').getAll(),
    transaction.objectStore('profile').getAll(),
    transaction.objectStore('recovery').getAll(),
  ]);
  const data: EvaDataExport = {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    models: Object.create(null),
    contexts: Object.create(null),
  };
  const contextFor = (record: EvaContextScope): EvaContextExport | null => {
    if ((options.model_id !== undefined && record.model_id !== options.model_id)
      || (options.context_partition_id !== undefined && record.context_partition_id !== options.context_partition_id)) return null;
    const key = contextKey(record);
    data.models[record.model_id] = { model_id: record.model_id };
    return data.contexts[key] ??= {
      ...validateEvaContextScope(record), sessions: [], messages: [], memory: [], recovery: [],
      profile: defaultEvaProfile(validateEvaContextScope(record)),
    };
  };
  for (const record of sessions.sort((left, right) => right.updatedAt - left.updatedAt)) contextFor(record)?.sessions.push(record);
  for (const record of messages.sort((left, right) => left.createdAt - right.createdAt)) contextFor(record)?.messages.push(record);
  for (const record of memory.sort((left, right) => right.updatedAt - left.updatedAt)) contextFor(record)?.memory.push(record);
  for (const record of profiles) {
    const context = contextFor(record);
    if (context) context.profile = record;
  }
  for (const record of recovery) contextFor(record)?.recovery.push(record);
  return data;
}

export async function exportEvaLocalData(options: EvaExportOptions = {}): Promise<EvaDataExport> {
  if (options.context_partition_id !== undefined && options.model_id === undefined) {
    throw new TypeError('A context-partition export must specify its model.');
  }
  if (options.model_id !== undefined) validateEvaContextScope({
    model_id: options.model_id, context_partition_id: options.context_partition_id ?? 'default',
  });
  const database = await getDatabase();
  const transaction = database.transaction(CATALOG_STORES, 'readonly');
  const data = await readContextSnapshot(transaction, options);
  await transaction.done;
  return parseEvaDataImport(data);
}

export const exportEvaData = exportEvaLocalData;

export async function listEvaContextScopes(modelId?: string): Promise<EvaContextScope[]> {
  const database = await getDatabase();
  const transaction = database.transaction(CONTEXT_STORES, 'readonly');
  const keys = await Promise.all(CONTEXT_STORES.map((name) => transaction.objectStore(name).getAllKeys()));
  await transaction.done;
  const scopes = new Map<string, EvaContextScope>();
  for (const key of keys.flat()) {
    const scope = { model_id: key[0], context_partition_id: key[1] };
    if (modelId === undefined || modelId === scope.model_id) scopes.set(contextKey(scope), scope);
  }
  return [...scopes.values()].sort((left, right) => contextKey(left).localeCompare(contextKey(right)));
}

export async function importEvaLocalData(input: unknown, mode: 'merge' | 'replace' = 'merge') {
  const { data, counts } = previewEvaDataImport(input);
  if (mode !== 'merge' && mode !== 'replace') throw new TypeError('Invalid Eva import mode.');
  const database = await getDatabase();
  const transaction = catalogTransaction(database);
  let accepted = 0;
  let kept = 0;
  const mergeRecords = <Record extends { id: string; createdAt?: number; updatedAt?: number }>(
    existing: Record[], incoming: Record[],
  ): Record[] => {
    const records = new Map(existing.map((record) => [record.id, record]));
    for (const record of incoming) {
      const previous = records.get(record.id);
      if (!previous || (record.updatedAt ?? record.createdAt ?? 0) > (previous.updatedAt ?? previous.createdAt ?? 0)) {
        records.set(record.id, record);
        accepted += 1;
      } else { kept += 1; }
    }
    return [...records.values()];
  };
  try {
    const combined = await readContextSnapshot(transaction);
    for (const [key, incoming] of Object.entries(data.contexts)) {
      const existing = combined.contexts[key];
      combined.models[incoming.model_id] = data.models[incoming.model_id];
      if (mode === 'replace' || !existing) {
        combined.contexts[key] = incoming;
        accepted += incoming.sessions.length + incoming.messages.length + incoming.memory.length + incoming.recovery.length + 1;
      } else {
        combined.contexts[key] = {
          ...incoming,
          sessions: mergeRecords(existing.sessions, incoming.sessions),
          messages: mergeRecords(existing.messages, incoming.messages),
          memory: mergeRecords(existing.memory, incoming.memory),
          recovery: mergeRecords(existing.recovery, incoming.recovery),
          profile: mergeRecords([existing.profile], [incoming.profile])[0],
        };
      }
    }
    parseEvaDataImport(combined);
    for (const key of Object.keys(data.contexts)) {
      const context = combined.contexts[key];
      for (const name of CONTEXT_STORES) {
        const store = transaction.objectStore(name);
        const keys = await store.index('by-scope').getAllKeys(scopeKey(context));
        for (const recordId of keys) {
          if (name === 'recovery') await store.delete(recordId);
          else await catalogDelete(transaction, name, recordId);
        }
      }
      for (const session of context.sessions) await catalogPut(transaction, 'sessions', session);
      for (const message of context.messages) await catalogPut(transaction, 'messages', message);
      for (const memory of context.memory) await catalogPut(transaction, 'memory', memory);
      await catalogPut(transaction, 'profile', context.profile);
      for (const recovery of context.recovery) await transaction.objectStore('recovery').put(recovery);
    }
    await transaction.done;
    return { counts, accepted, kept };
  } catch (error) { return abortWrite(transaction, error); }
}

export async function loadEvaRecovery(sessionId: string, scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE): Promise<EvaRecoveryRecord | null> {
  const database = await getDatabase();
  return (await database.get('recovery', recordKey(scope, sessionId))) ?? null;
}

export async function saveEvaRecovery(
  sessionId: string,
  value: { draft: string; partialResponse: string },
  scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE,
): Promise<void> {
  const owner = validateEvaContextScope(scope);
  if (typeof value.draft !== 'string' || value.draft.length > EVA_CONTEXT_LIMITS.draftChars
    || typeof value.partialResponse !== 'string' || value.partialResponse.length > EVA_CONTEXT_LIMITS.messageChars) {
    throw new TypeError('Eva recovery exceeds its storage limits.');
  }
  const database = await getDatabase();
  const transaction = database.transaction(['sessions', 'recovery'], 'readwrite');
  try {
    if (!await transaction.objectStore('sessions').get(recordKey(owner, sessionId))) {
      throw new Error('The recovery session is unavailable in this context partition.');
    }
    await transaction.objectStore('recovery').put({ ...owner, ...value, id: sessionId, sessionId, updatedAt: Date.now() });
    await transaction.done;
  } catch (error) { await abortWrite(transaction, error); }
}

export async function clearEvaRecovery(sessionId: string, scope: EvaContextScope = DEFAULT_EVA_CONTEXT_SCOPE): Promise<void> {
  const database = await getDatabase();
  await database.delete('recovery', recordKey(scope, sessionId));
}

export async function clearEvaData(): Promise<void> {
  await closeMemoryIndex();
  const database = await getDatabase();
  database.close();
  databasePromise = null;
  await deleteDB(DATABASE_NAME);
}

export function resetEvaDatabaseConnectionForTests(): void {
  if (databasePromise) {
    void databasePromise.then((database) => database.close());
    databasePromise = null;
  }
}
