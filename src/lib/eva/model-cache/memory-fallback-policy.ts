/** App policy, NOT a claimed browser/phone memory ceiling. Large artifacts
 * require durable streaming. A successful desktop happy path is unchanged.
 */
export const MAX_AUTOMATIC_MODEL_MEMORY_FALLBACK_BYTES = 16 * 1024 * 1024;
export class ModelMemoryFallbackRefusedError extends Error {
  readonly code = 'MODEL_STREAM_REQUIRED';
  constructor() { super('This model requires durable streaming storage. Saved checkpoints are unchanged; free storage or reconnect, then retry.'); }
}
export function assertModelMemoryFallback(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_AUTOMATIC_MODEL_MEMORY_FALLBACK_BYTES) {
    throw new ModelMemoryFallbackRefusedError();
  }
}
