const CLIENT_CORRELATION_BYTES = 4;
const CLIENT_CORRELATION_PATTERN = /^[A-F0-9]{8}$/;
const MODEL_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEBUG_SESSION_ID_PATTERN = /^([A-F0-9]{8})-(\d{8}-\d{6})-([a-f0-9]{10}|unknown)$/;

export interface DebugSessionIdOptions {
  correlationToken: string;
  createdAt: number;
  modelSha256: string | null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatDebugSessionTimestamp(createdAt: number): string {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new TypeError('Debug session creation time must be a nonnegative integer timestamp.');
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Debug session creation time is invalid.');
  }
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/**
 * Creates the short client-correlation segment used in Runtime diagnostics.
 * Despite the historical "CF-short" label, this is local random data, not a
 * Cloudflare identifier, credential, or telemetry value.
 */
export function createClientCorrelationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CLIENT_CORRELATION_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function createDebugSessionId(options: DebugSessionIdOptions): string {
  if (!CLIENT_CORRELATION_PATTERN.test(options.correlationToken)) {
    throw new TypeError('Debug session correlation token must be eight uppercase hexadecimal characters.');
  }
  const modelSha = options.modelSha256 && MODEL_SHA256_PATTERN.test(options.modelSha256)
    ? options.modelSha256.slice(0, 10)
    : 'unknown';
  return `${options.correlationToken}-${formatDebugSessionTimestamp(options.createdAt)}-${modelSha}`;
}

export function isDebugSessionId(value: string): boolean {
  return DEBUG_SESSION_ID_PATTERN.test(value);
}

export function correlationTokenFromSessionId(value: string): string | null {
  const debugMatch = DEBUG_SESSION_ID_PATTERN.exec(value);
  if (debugMatch) {
    return debugMatch[1];
  }
  const uuidMatch = /(?:^|_)([a-f0-9]{8})-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.exec(value);
  return uuidMatch?.[1].toUpperCase() ?? null;
}
