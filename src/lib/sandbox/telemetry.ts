import { sandboxObservabilityTransaction } from '../memory/db';
import { sandboxId, SandboxFault, type SandboxErrorCode } from './capabilities';

export const SANDBOX_MAX_OBSERVABILITY_RECORDS = 500;
export interface WorkerProbeRecord {
  probeId: string; workerId: string; role: 'sandbox'; sessionId: string;
  spawnedAt: number; bootMs: number | null; heapEstimateBytes: number | null; restartCount: number;
  lastReason: 'first-start' | 'clean-exit' | 'crash' | 'oom' | 'lease-expired' | 'user-terminated' | 'unknown';
  mountsGranted: string[]; recordedAt: number;
}
export interface PlacementRecord {
  blockId: string; envelope: { kind: 'tab' } | { kind: 'worker'; workerId: string };
  decidedAt: number; policyId: string; probeId: string;
}
interface Row { probeId: string; recordedAt: number; sessionId: string; storageClass: 'agent-temp' }
export type SandboxObservabilityRecord =
  | (WorkerProbeRecord & { kind: 'probe'; storageClass: 'agent-temp' })
  | (Row & { kind: 'placement'; placement: PlacementRecord })
  | (Row & { kind: 'command-failure'; workerId: string; code: SandboxErrorCode; reason: 'command-timeout' })
  | SandboxPromotion;
export interface SandboxPromotion extends Row { kind: 'promotion'; workerId: string; name: string; bytes: Uint8Array }

export function createWorkerProbe(input: Omit<WorkerProbeRecord, 'probeId' | 'recordedAt' | 'role'>): Extract<SandboxObservabilityRecord, { kind: 'probe' }> {
  return { ...input, mountsGranted: [...input.mountsGranted], probeId: sandboxId(), recordedAt: Date.now(), role: 'sandbox', kind: 'probe', storageClass: 'agent-temp' };
}
export function createPlacementRecord(sessionId: string, placement: PlacementRecord): Extract<SandboxObservabilityRecord, { kind: 'placement' }> {
  // The physical row key differs from placement.probeId (the lineage reference), preventing probe overwrites.
  return { probeId: sandboxId(), recordedAt: Date.now(), sessionId, kind: 'placement', storageClass: 'agent-temp', placement: structuredClone(placement) };
}

async function pruneObservability(transaction: Awaited<ReturnType<typeof sandboxObservabilityTransaction<'readwrite'>>>) {
  let excess = await transaction.store.count() - SANDBOX_MAX_OBSERVABILITY_RECORDS;
  let cursor = await transaction.store.index('by-recorded-at').openCursor();
  while (cursor && excess-- > 0) { await cursor.delete(); cursor = await cursor.continue(); }
}
export async function writeSandboxTelemetry(records: SandboxObservabilityRecord[]): Promise<void> {
  const transaction = await sandboxObservabilityTransaction('readwrite');
  try {
    for (const record of records) await transaction.store.put(record);
    await pruneObservability(transaction);
    await transaction.done;
  } catch (error) { try { transaction.abort(); } catch {} await transaction.done.catch(() => undefined); throw error; }
}
export async function listSandboxObservability(): Promise<SandboxObservabilityRecord[]> {
  const transaction = await sandboxObservabilityTransaction('readonly');
  const rows = await transaction.store.index('by-recorded-at').getAll(); await transaction.done;
  return rows;
}

/** Promotions are fail-closed, unlike optional telemetry. Cancellation aborts a still-pending IDB transaction. */
export async function storeSandboxPromotion(record: SandboxPromotion, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new SandboxFault('EBOUND');
  const transaction = await sandboxObservabilityTransaction('readwrite');
  const abort = () => { try { transaction.abort(); } catch {} };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new SandboxFault('EBOUND');
    await transaction.store.add(record);
    await pruneObservability(transaction);
    await transaction.done;
  } catch (error) { abort(); await transaction.done.catch(() => undefined); throw error; }
  finally { signal.removeEventListener('abort', abort); }
}
export async function removeSandboxPromotions(sessionId: string): Promise<void> {
  const transaction = await sandboxObservabilityTransaction('readwrite');
  try {
    for (const row of await transaction.store.getAll()) {
      if (row.kind === 'promotion' && row.sessionId === sessionId) await transaction.store.delete(row.probeId);
    }
    await transaction.done;
  } catch (error) { try { transaction.abort(); } catch {} await transaction.done.catch(() => undefined); throw error; }
}

function scheduleIdle(action: () => void): () => void {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    const id = window.requestIdleCallback(action, { timeout: 250 }); return () => window.cancelIdleCallback(id);
  }
  const id = setTimeout(action, 0); return () => clearTimeout(id);
}
export class SandboxTelemetry {
  #batch: SandboxObservabilityRecord[] = [];
  #cancelIdle?: () => void;
  #flushing?: Promise<void>;
  constructor(private write = writeSandboxTelemetry, private idle = scheduleIdle) {}
  append(record: SandboxObservabilityRecord): void {
    this.#batch.push(record);
    if (this.#batch.length > SANDBOX_MAX_OBSERVABILITY_RECORDS) this.#batch.shift();
    this.#cancelIdle ??= this.idle(() => { this.#cancelIdle = undefined; void this.flush(); });
  }
  flush(): Promise<void> {
    this.#cancelIdle?.(); this.#cancelIdle = undefined;
    // One in-flight transaction plus one bounded batch, not an unbounded promise chain behind a slow writer.
    this.#flushing ??= this.#drain().finally(() => { this.#flushing = undefined; });
    return this.#flushing;
  }
  async #drain(): Promise<void> {
    while (this.#batch.length) {
      const batch = this.#batch.splice(0);
      try { await this.write(batch); } catch { console.warn('Sandbox telemetry unavailable; batch dropped.'); }
    }
  }
}
