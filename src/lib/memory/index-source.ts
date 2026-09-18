import type { EvaContextScope, EvaMemoryRecord } from './types';

export type CatalogTable = 'sessions' | 'messages' | 'memory' | 'profile';

export interface IndexEvent extends EvaContextScope {
  indexSeq: number;
  op: 'put' | 'delete';
  table: CatalogTable;
  id: string;
  sessionId: string | null;
  key: string;
}

export interface IndexEntry {
  key: string;
  indexSeq: number;
  record: EvaMemoryRecord;
}

export interface IndexSnapshot {
  epoch: string;
  highWaterSeq: number;
  entries: IndexEntry[];
}

export interface MemoryIndexSource {
  state(): Promise<{ epoch: string; highWaterSeq: number }>;
  events(after: number, limit: number): Promise<IndexEvent[]>;
  snapshot(): Promise<IndexSnapshot>;
  read(event: IndexEvent): Promise<IndexEntry | null>;
  subscribe(listener: (events: IndexEvent[]) => void): () => void;
}

export function indexRecordKey(scope: EvaContextScope, sessionId: string | null, table: CatalogTable, id: string): string {
  return JSON.stringify([scope.model_id, scope.context_partition_id, sessionId, table, id]);
}
