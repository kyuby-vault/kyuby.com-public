const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const MODEL_CACHE_MAX_RANGE_HEADER_BYTES = 1024;

export type ModelByteRange =
  | { kind: 'none' }
  | { kind: 'multi' }
  | { kind: 'invalid' }
  | { kind: 'unsatisfiable' }
  | { kind: 'range'; start: number; end: number };

export interface ModelBlobResponseOptions {
  method: 'GET' | 'HEAD';
  rangeHeader?: string | null;
  contentType: string;
  sha256: string;
}

function parseDecimal(value: string): bigint | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function hasByteRangeSyntax(value: string): boolean {
  const match = /^(\d*)-(\d*)$/.exec(value);
  return Boolean(match && (match[1] !== '' || match[2] !== ''));
}

export function parseModelByteRange(
  headerValue: string | null | undefined,
  size: number,
): ModelByteRange {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TypeError('Model Blob size must be a non-negative safe integer.');
  }
  if (headerValue === null || headerValue === undefined) {
    return { kind: 'none' };
  }
  if (headerValue.length > MODEL_CACHE_MAX_RANGE_HEADER_BYTES) {
    return { kind: 'invalid' };
  }

  const unit = /^\s*bytes\s*=\s*(.*?)\s*$/i.exec(headerValue);
  if (!unit || unit[1] === '') {
    return { kind: 'invalid' };
  }
  const members = unit[1].split(',').map((member) => member.trim());
  if (members.length > 1) {
    return members.every(hasByteRangeSyntax)
      ? { kind: 'multi' }
      : { kind: 'invalid' };
  }

  const match = /^(\d*)-(\d*)$/.exec(members[0]);
  if (!match || (match[1] === '' && match[2] === '')) {
    return { kind: 'invalid' };
  }
  const objectSize = BigInt(size);

  if (match[1] === '') {
    const suffixLength = parseDecimal(match[2]);
    if (suffixLength === null) {
      return { kind: 'invalid' };
    }
    if (suffixLength === 0n || objectSize === 0n) {
      return { kind: 'unsatisfiable' };
    }
    const length = suffixLength < objectSize ? suffixLength : objectSize;
    return {
      kind: 'range',
      start: Number(objectSize - length),
      end: size - 1,
    };
  }

  const start = parseDecimal(match[1]);
  const requestedEnd = match[2] === '' ? null : parseDecimal(match[2]);
  if (start === null || (match[2] !== '' && requestedEnd === null)) {
    return { kind: 'invalid' };
  }
  if (objectSize === 0n || start >= objectSize) {
    return { kind: 'unsatisfiable' };
  }
  if (requestedEnd !== null && requestedEnd < start) {
    return { kind: 'unsatisfiable' };
  }

  const end = requestedEnd === null || requestedEnd >= objectSize
    ? objectSize - 1n
    : requestedEnd;
  return { kind: 'range', start: Number(start), end: Number(end) };
}

export function createModelFileEtag(sha256: string): string {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new TypeError('Model file SHA-256 must be 64 lowercase hexadecimal characters.');
  }
  return `"sha256-${sha256}"`;
}

function createResponseHeaders(
  contentType: string,
  sha256: string,
): Headers {
  const headers = new Headers();
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set(
    'Access-Control-Expose-Headers',
    'Accept-Ranges, Content-Length, Content-Range, ETag',
  );
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', contentType);
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('ETag', createModelFileEtag(sha256));
  return headers;
}

export function createModelBlobResponse(
  blob: Blob,
  options: ModelBlobResponseOptions,
): Response {
  if (!(blob instanceof Blob)) {
    throw new TypeError('A verified Blob is required for a local model response.');
  }
  if (options.method !== 'GET' && options.method !== 'HEAD') {
    throw new TypeError('Local model responses support only GET and HEAD.');
  }
  if (typeof options.contentType !== 'string' || options.contentType.length === 0) {
    throw new TypeError('A model response content type is required.');
  }

  const headers = createResponseHeaders(options.contentType, options.sha256);
  if (options.method === 'HEAD') {
    headers.set('Content-Length', String(blob.size));
    return new Response(null, { status: 200, headers });
  }

  const range = parseModelByteRange(options.rangeHeader, blob.size);
  if (range.kind === 'invalid' || range.kind === 'unsatisfiable') {
    headers.set('Content-Length', '0');
    headers.set('Content-Range', `bytes */${blob.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range.kind === 'range') {
    const length = range.end - range.start + 1;
    headers.set('Content-Length', String(length));
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${blob.size}`);
    return new Response(blob.slice(range.start, range.end + 1), {
      status: 206,
      headers,
    });
  }

  headers.set('Content-Length', String(blob.size));
  return new Response(blob, { status: 200, headers });
}
