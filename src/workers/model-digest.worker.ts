/**
 * src/workers/model-digest.worker.ts
 * Dedicated Worker for computing SHA-256 digests via crypto.subtle.digest.
 * Receives transferable ArrayBuffer, posts heartbeats every 250ms,
 * and posts back the verified SHA-256 hex digest.
 */

export interface DigestWorkerRequest {
  id: string;
  buffer: ArrayBuffer;
}

export type DigestWorkerMessage =
  | { type: 'heartbeat'; id: string; bytesProcessed: number }
  | { type: 'result'; id: string; bytes: number; sha256: string }
  | { type: 'error'; id: string; error: string };

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

self.onmessage = async (event: MessageEvent<DigestWorkerRequest>) => {
  const { id, buffer } = event.data;
  if (!buffer) return;

  const timer = setInterval(() => {
    self.postMessage({ type: 'heartbeat', id, bytesProcessed: buffer.byteLength } satisfies DigestWorkerMessage);
  }, 250);

  try {
    const digestBuffer = await crypto.subtle.digest('SHA-256', buffer);
    clearInterval(timer);
    const sha256 = bufferToHex(digestBuffer);
    self.postMessage({
      type: 'result',
      id,
      bytes: buffer.byteLength,
      sha256,
    } satisfies DigestWorkerMessage);
  } catch (err) {
    clearInterval(timer);
    self.postMessage({
      type: 'error',
      id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies DigestWorkerMessage);
  }
};
