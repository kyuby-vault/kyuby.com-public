import type { ModelCacheFileProgressMessage } from './protocol';
import type { ModelCacheManifestInventory } from './types';

export interface CacheFileProgress {
  file: string;
  total: number;
  received: number;
  verified: number;
  percent: number;
  phase: string;
  source: 'disk' | 'network';
}

/** One explicit load, weighted by manifest bytes; retries never move the bar backwards. */
export class ModelCacheProgress {
  readonly files = new Map<string, CacheFileProgress>();
  #percent = 0;

  constructor(inventory: ModelCacheManifestInventory | null) {
    for (const file of inventory?.files ?? []) {
      if (file.present) this.files.set(file.path, {
        file: file.path, total: file.bytes, received: 0, verified: 0, percent: 0, phase: 'queued', source: 'network',
      });
    }
  }

  update(message: ModelCacheFileProgressMessage): boolean {
    const file = this.files.get(message.file);
    if (!file || message.totalBytes !== file.total) return false;
    file.received = Math.max(file.received, message.receivedBytes);
    file.verified = Math.max(file.verified, message.verifiedBytes);
    const hashing = message.phase === 'verifying' || message.phase === 'committing';
    const work = hashing ? file.total + message.loadedBytes
      : message.phase === 'serving' ? file.total * 2 : message.loadedBytes;
    const percent = file.total ? work / (2 * file.total) * 100 : 0;
    file.percent = Math.max(file.percent, message.phase === 'serving' ? 100 : Math.min(99, percent));
    file.phase = message.phase;
    file.source = message.source;
    const total = [...this.files.values()].reduce((sum, entry) => sum + entry.total, 0);
    const weighted = [...this.files.values()].reduce((sum, entry) => sum + entry.total * entry.percent, 0);
    this.#percent = Math.max(this.#percent, total ? Math.floor(weighted / total) : 0);
    return true;
  }

  get percent(): number { return this.#percent; }
  get received(): number { return [...this.files.values()].reduce((sum, file) => sum + file.received, 0); }
  get verified(): number { return [...this.files.values()].reduce((sum, file) => sum + file.verified, 0); }
  get total(): number { return [...this.files.values()].reduce((sum, file) => sum + file.total, 0); }
}
