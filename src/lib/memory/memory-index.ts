import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { IndexEntry, IndexEvent, MemoryIndexSource } from './index-source';
import type { IndexStorage } from './index-storage';
import { EVA_CONTEXT_LIMITS, type EvaContextScope, type EvaMemoryRecord } from './types';

export const MEMORY_INDEX_SCHEMA_VERSION = 1;
export const MEMORY_INDEX_BATCH_SIZE = 100;
export const MEMORY_INDEX_WINDOW = 200;
export const MEMORY_INDEX_CHECKPOINT_INTERVAL_MS = 30_000;
export const MEMORY_INDEX_CHECKPOINT_BATCHES = 10;

export interface MemoryIndexSearchMetadata {
  totalHits: number;
  candidates: number;
  truncated: boolean;
}

type Hit = { record_key: string; record_id: string; model_id: string; context_partition_id: string;
  session_id: string | null; index_seq: number; content: string; tags: string };

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE memory_index (
  record_key TEXT PRIMARY KEY, record_id TEXT NOT NULL, model_id TEXT NOT NULL,
  context_partition_id TEXT NOT NULL, owner TEXT NOT NULL, provenance TEXT NOT NULL,
  session_id TEXT, updated_at BIGINT NOT NULL, index_seq BIGINT NOT NULL,
  content TEXT NOT NULL, tags TEXT NOT NULL, storage_class TEXT NOT NULL,
  haystack TEXT NOT NULL, search TSVECTOR NOT NULL
);
CREATE INDEX memory_scope ON memory_index(model_id, context_partition_id, session_id);
CREATE INDEX memory_search ON memory_index USING GIN(search);
CREATE INDEX memory_trigram ON memory_index USING GIN(haystack gin_trgm_ops);
`;

export function isIndexableMemory(record: EvaMemoryRecord): boolean {
  return !('class' in record && record.class === 'agent-temp');
}

async function putEntry(transaction: Transaction, entry: IndexEntry): Promise<void> {
  const { record, indexSeq, key } = entry;
  if (!isIndexableMemory(record)) return;
  const tags = record.tags.join(' ');
  const haystack = `${record.content} ${tags}`.toLocaleLowerCase();
  await transaction.query(`INSERT INTO memory_index
    (record_key, record_id, model_id, context_partition_id, owner, provenance, session_id,
     updated_at, index_seq, content, tags, storage_class, haystack, search)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,to_tsvector('simple',$13))
    ON CONFLICT (record_key) DO UPDATE SET owner=EXCLUDED.owner, provenance=EXCLUDED.provenance,
    updated_at=EXCLUDED.updated_at, index_seq=EXCLUDED.index_seq, content=EXCLUDED.content,
    tags=EXCLUDED.tags, storage_class=EXCLUDED.storage_class, haystack=EXCLUDED.haystack, search=EXCLUDED.search`,
  [key, record.id, record.model_id, record.context_partition_id,
    record.sessionId ? `session:${record.sessionId}` : `memory:${record.id}`, record.provenance ?? 'user',
    record.sessionId ?? null, record.updatedAt, indexSeq, record.content, tags,
    record.provenance === 'synthesized' ? 'rebuildable-cache' : 'session-data', haystack]);
}

export interface MemoryIndexOptions {
  storage?: IndexStorage;
  idle?: () => Promise<void>;
  open?: (checkpoint?: Blob) => Promise<PGlite>;
  log?: (message: string) => void;
  activity?: (message: string) => void;
}

export class MemorySearchIndex {
  #database: PGlite | undefined;
  #highWaterSeq = 0;
  #epoch = '';
  #pending = new Map<number, IndexEvent>();
  #queue: Promise<unknown> = Promise.resolve();
  #unsubscribe: () => void;
  #closed = false;
  #notified = false;
  #notificationPending = false;
  #dirtyBatches = 0;
  #checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  #closing: Promise<void> | undefined;
  #lastSearchMetadata: MemoryIndexSearchMetadata | undefined;
  readonly #log: (message: string) => void;

  constructor(private source: MemoryIndexSource, private options: MemoryIndexOptions = {}) {
    this.#log = options.log ?? console.warn;
    this.#unsubscribe = source.subscribe((events) => {
      if (!events.length || !this.#database || this.#closed) return;
      this.#notified = true;
      if (this.#notificationPending) return;
      this.#notificationPending = true;
      void this.#serial(async () => {
        while (this.#notified) { this.#notified = false; await this.#catchUp(); }
      }).catch(() => this.#log('Memory index update failed; IDB remains authoritative.'))
        .finally(() => { this.#notificationPending = false; });
    });
  }

  #serial<Result>(action: () => Promise<Result>): Promise<Result> {
    const next = this.#queue.then(() => {
      if (this.#closed) throw new Error('Memory index is closed.');
      return action();
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #idle(): Promise<void> { await this.options.idle?.(); }

  async #open(checkpoint?: Blob): Promise<PGlite> {
    return this.options.open ? this.options.open(checkpoint)
      : PGlite.create({ loadDataDir: checkpoint, extensions: { pg_trgm } });
  }

  async #save(): Promise<void> {
    this.#cancelCheckpoint();
    if (this.#dirtyBatches && this.#database && this.options.storage) {
      await this.options.storage.save(this.#database);
      this.#dirtyBatches = 0;
    }
  }

  #cancelCheckpoint(): void {
    clearTimeout(this.#checkpointTimer);
    this.#checkpointTimer = undefined;
  }

  async #changed(force = false): Promise<void> {
    if (!this.options.storage) return;
    this.#dirtyBatches++;
    if (force || this.#dirtyBatches >= MEMORY_INDEX_CHECKPOINT_BATCHES) return this.#save();
    // Fixed deadline from the first dirty batch: later batches share this window.
    if (this.#checkpointTimer !== undefined || this.#closing) return;
    this.#checkpointTimer = setTimeout(() => {
      this.#checkpointTimer = undefined;
      void this.#serial(async () => { await this.#idle(); await this.#save(); })
        .catch(() => this.#log('Memory index checkpoint failed; IDB replay will recover unsaved batches.'));
    }, MEMORY_INDEX_CHECKPOINT_INTERVAL_MS);
  }

  async #ensure(): Promise<void> {
    const state = await this.source.state();
    if (this.#database && this.#epoch === state.epoch && this.#highWaterSeq <= state.highWaterSeq) return;
    await this.#idle();
    if (this.#database) return this.#rebuild();
    try {
      const checkpoint = await this.options.storage?.load();
      if (!checkpoint) return this.#rebuild();
      this.#database = await this.#open(checkpoint);
      const table = await this.#database.query<{ name: string | null }>("SELECT to_regclass('public.meta')::text AS name");
      if (table.rows[0].name) {
        const rows = await this.#database.query<{ key: string; value: string }>('SELECT key,value FROM meta');
        const meta = new Map(rows.rows.map(({ key, value }) => [key, value]));
        const sequence = Number(meta.get('highWaterSeq'));
        if (meta.get('indexSchemaVersion') === String(MEMORY_INDEX_SCHEMA_VERSION)
          && meta.get('sourceEpoch') === state.epoch && Number.isSafeInteger(sequence)
          && sequence >= 0 && sequence <= state.highWaterSeq) {
          this.#highWaterSeq = sequence;
          this.#epoch = state.epoch;
          return;
        }
      }
    } catch {
      this.#log('Memory index checkpoint unavailable or invalid; rebuilding from IDB.');
    }
    await this.#rebuild();
  }

  async #rebuild(): Promise<void> {
    await this.#idle();
    this.#cancelCheckpoint();
    this.#dirtyBatches = 0;
    this.#epoch = '';
    this.#highWaterSeq = 0;
    await this.#database?.close().catch(() => undefined);
    this.#database = undefined;
    await this.options.storage?.remove();
    this.#pending.clear();
    this.#database = await this.#open();
    await this.#database.exec(SCHEMA);
    const snapshot = await this.source.snapshot();
    for (let offset = 0; offset < snapshot.entries.length; offset += MEMORY_INDEX_BATCH_SIZE) {
      await this.#idle();
      await this.#database.transaction(async (transaction) => {
        for (const entry of snapshot.entries.slice(offset, offset + MEMORY_INDEX_BATCH_SIZE)) await putEntry(transaction, entry);
      });
    }
    await this.#database.transaction(async (transaction) => {
      for (const [key, value] of Object.entries({ indexSchemaVersion: MEMORY_INDEX_SCHEMA_VERSION,
        highWaterSeq: snapshot.highWaterSeq, lastRebuildAt: Date.now(), sourceEpoch: snapshot.epoch })) {
        await transaction.query('INSERT INTO meta VALUES ($1,$2)', [key, String(value)]);
      }
    });
    this.#epoch = snapshot.epoch;
    this.#highWaterSeq = snapshot.highWaterSeq;
    await this.#changed(true);
  }

  async #apply(events: IndexEvent[]): Promise<void> {
    if (events.length > MEMORY_INDEX_BATCH_SIZE) throw new Error('Index event batch exceeds 100.');
    for (const event of events) {
      if (event.indexSeq <= this.#highWaterSeq) continue;
      if (this.#pending.size >= 1000 && !this.#pending.has(event.indexSeq)) throw new Error('Index reorder window exceeded.');
      this.#pending.set(event.indexSeq, event);
    }
    const batch: IndexEvent[] = [];
    for (let sequence = this.#highWaterSeq + 1; batch.length < MEMORY_INDEX_BATCH_SIZE; sequence++) {
      const event = this.#pending.get(sequence);
      if (!event) break;
      batch.push(event);
    }
    if (!batch.length) return;
    await this.#idle();
    const entries = await Promise.all(batch.map((event) => event.op === 'put' ? this.source.read(event) : null));
    await this.#database!.transaction(async (transaction) => {
      for (const [offset, event] of batch.entries()) {
        if (event.table !== 'memory') continue;
        await transaction.query('DELETE FROM memory_index WHERE record_key=$1', [event.key]);
        const entry = entries[offset];
        if (entry && entry.indexSeq === event.indexSeq) await putEntry(transaction, entry);
      }
      await transaction.query("UPDATE meta SET value=$1 WHERE key='highWaterSeq'", [String(batch.at(-1)!.indexSeq)]);
    });
    this.#highWaterSeq = batch.at(-1)!.indexSeq;
    for (const event of batch) this.#pending.delete(event.indexSeq);
    await this.#changed();
  }

  async #catchUp(): Promise<void> {
    await this.#ensure();
    const target = (await this.source.state()).highWaterSeq;
    while (this.#highWaterSeq < target) {
      const events = await this.source.events(this.#highWaterSeq, MEMORY_INDEX_BATCH_SIZE);
      if (!events.length || events[0].indexSeq !== this.#highWaterSeq + 1) {
        await this.#rebuild();
        return;
      }
      await this.#apply(events);
    }
  }

  catchUp(): Promise<void> { return this.#serial(() => this.#catchUp()); }
  // Future Worker-push API. The current live subscriber re-pulls the IDB outbox.
  accept(events: IndexEvent[]): Promise<void> { return this.#serial(async () => { await this.#ensure(); await this.#apply(events); }); }
  rebuild(): Promise<void> { return this.#serial(async () => { await this.#rebuild(); await this.#catchUp(); await this.#save(); }); }
  flush(): Promise<void> { return this.#serial(() => this.#save()); }

  get lastSearchMetadata(): Readonly<MemoryIndexSearchMetadata> | undefined {
    return this.#lastSearchMetadata && { ...this.#lastSearchMetadata };
  }

  status(): Promise<{ highWaterSeq: number; records: number; schemaVersion: number }> {
    return this.#serial(async () => {
      await this.#ensure();
      const count = await this.#database!.query<{ count: number }>('SELECT count(*)::integer AS count FROM memory_index');
      return { highWaterSeq: this.#highWaterSeq, records: count.rows[0].count, schemaVersion: MEMORY_INDEX_SCHEMA_VERSION };
    });
  }

  search(query: string, limit: number, scope: EvaContextScope, sessionId?: string): Promise<EvaMemoryRecord[]> {
    return this.#serial(async () => {
      if (query.length > EVA_CONTEXT_LIMITS.draftChars) throw new Error('Memory search query exceeds its bound.');
      await this.#catchUp();
      const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const patterns = terms.map((term) => `%${term.replace(/[\\%_]/g, '\\$&')}%`);
      const where = `WHERE model_id=$1 AND context_partition_id=$2 AND ($3::text IS NULL OR session_id=$3)
        AND (cardinality($4::text[])=0 OR haystack LIKE ANY($5::text[]))`;
      const parameters = [scope.model_id, scope.context_partition_id, sessionId ?? null, terms, patterns];
      const [count, hits] = await Promise.all([
        this.#database!.query<{ count: number }>(`SELECT count(*)::integer AS count FROM memory_index ${where}`, parameters),
        this.#database!.query<Hit>(`SELECT record_key,record_id,model_id,context_partition_id,
          session_id,index_seq,content,tags FROM memory_index ${where}
          ORDER BY (SELECT count(*) FROM unnest($4::text[]) AS term WHERE strpos(haystack,term)>0) DESC,
          updated_at DESC,record_id ASC LIMIT $6`, [...parameters, MEMORY_INDEX_WINDOW]),
      ]);
      const totalHits = count.rows[0].count;
      this.#lastSearchMetadata = { totalHits, candidates: hits.rows.length, truncated: totalHits > MEMORY_INDEX_WINDOW };
      if (this.#lastSearchMetadata.truncated) {
        const message = `Memory search truncated: ${totalHits} matches; verifying the first ${MEMORY_INDEX_WINDOW} candidates.`;
        this.#log(message);
        this.options.activity?.(message);
      }
      // One bounded concurrent verification batch; preserve SQL order and IDB's drop rules.
      const entries = await Promise.all(hits.rows.map((hit) => this.source.read({ ...scope,
        id: hit.record_id, sessionId: hit.session_id, key: hit.record_key,
        indexSeq: hit.index_seq, table: 'memory', op: 'put' })));
      const records: EvaMemoryRecord[] = [];
      for (const [position, hit] of hits.rows.entries()) {
        const entry = entries[position];
        if (!entry || entry.indexSeq !== hit.index_seq || entry.record.content !== hit.content
          || entry.record.tags.join(' ') !== hit.tags || !isIndexableMemory(entry.record)) {
          this.#log('Dropped missing or stale memory index hit after IDB verification.');
          continue;
        }
        records.push(entry.record);
      }
      return records.slice(0, terms.length ? Math.max(1, Math.min(limit, 8)) : Math.max(0, Math.min(limit, MEMORY_INDEX_WINDOW)));
    });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#unsubscribe();
    this.#cancelCheckpoint();
    this.#closing = this.#serial(async () => {
      this.#closed = true;
      try { await this.#save(); }
      finally {
        await this.#database?.close();
        this.#database = undefined;
      }
    });
    return this.#closing;
  }
}
