import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { MODEL_CACHE_MAX_FILE_BYTES } from './types';
import { ModelDigestScheduler } from './digest-scheduler';

const digestScheduler = new ModelDigestScheduler();

// Legacy streaming helper budgets. hashBlob uses bounded-per-file native
// WebCrypto after queue admission; these are NOT its peak memory bound.
export const MODEL_CACHE_HASH_CHUNK_BYTES = 4 * 1024 * 1024;
export const MODEL_CACHE_MAX_HASH_CHUNK_BYTES = 8 * 1024 * 1024;

export async function yieldModelDigest(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) await scheduler.yield();
  else await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type ModelIntegrityErrorCode =
  | 'INVALID_EXPECTATION'
  | 'INVALID_CHUNK'
  | 'LIMIT_EXCEEDED'
  | 'LENGTH_MISMATCH'
  | 'HASH_MISMATCH'
  | 'ALREADY_FINALIZED';

export class ModelIntegrityError extends Error {
  readonly code: ModelIntegrityErrorCode;

  constructor(code: ModelIntegrityErrorCode, message: string) {
    super(message);
    this.name = 'ModelIntegrityError';
    this.code = code;
  }
}

export interface ModelIntegrityExpectation {
  bytes: number;
  sha256: string;
}

export interface ModelIntegrityResult {
  bytes: number;
  sha256: string;
}

export interface ModelBlobHashOptions {
  chunkBytes?: number;
  maxBytes?: number;
  onProgress?: (hashedBytes: number, totalBytes: number) => void | Promise<void>;
}

export interface ModelIntegrityTransform {
  stream: TransformStream<Uint8Array, Uint8Array>;
  result: Promise<ModelIntegrityResult>;
}

function assertByteLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MODEL_CACHE_MAX_FILE_BYTES) {
    throw new ModelIntegrityError(
      'INVALID_EXPECTATION',
      `${label} must be a non-negative safe integer no greater than 512 MiB.`,
    );
  }
}

function assertExpectation(expectation: ModelIntegrityExpectation): void {
  assertByteLimit(expectation.bytes, 'Expected model byte length');
  if (!SHA256_PATTERN.test(expectation.sha256)) {
    throw new ModelIntegrityError(
      'INVALID_EXPECTATION',
      'Expected model SHA-256 must be 64 lowercase hexadecimal characters.',
    );
  }
}

function normalizeHashOptions(options: ModelBlobHashOptions): {
  chunkBytes: number;
  maxBytes: number;
} {
  const chunkBytes = options.chunkBytes ?? MODEL_CACHE_HASH_CHUNK_BYTES;
  const maxBytes = options.maxBytes ?? MODEL_CACHE_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(chunkBytes)
    || chunkBytes <= 0
    || chunkBytes > MODEL_CACHE_MAX_HASH_CHUNK_BYTES) {
    throw new ModelIntegrityError(
      'INVALID_CHUNK',
      'SHA-256 chunks must be between 1 byte and 8 MiB.',
    );
  }
  assertByteLimit(maxBytes, 'SHA-256 byte limit');
  return { chunkBytes, maxBytes };
}

export class ModelSha256Accumulator {
  readonly #maximumBytes: number;
  readonly #hash = sha256.create();
  #bytes = 0;
  #finalized = false;

  constructor(maximumBytes = MODEL_CACHE_MAX_FILE_BYTES) {
    assertByteLimit(maximumBytes, 'SHA-256 byte limit');
    this.#maximumBytes = maximumBytes;
  }

  get bytes(): number {
    return this.#bytes;
  }

  update(chunk: Uint8Array): void {
    if (this.#finalized) {
      throw new ModelIntegrityError('ALREADY_FINALIZED', 'SHA-256 has already been finalized.');
    }
    if (!(chunk instanceof Uint8Array)) {
      throw new ModelIntegrityError('INVALID_CHUNK', 'SHA-256 input must be a Uint8Array.');
    }
    if (this.#bytes + chunk.byteLength > this.#maximumBytes) {
      this.#hash.destroy();
      this.#finalized = true;
      throw new ModelIntegrityError(
        'LIMIT_EXCEEDED',
        'Model body exceeds its bounded SHA-256 byte limit.',
      );
    }
    this.#hash.update(chunk);
    this.#bytes += chunk.byteLength;
  }

  digest(): ModelIntegrityResult {
    if (this.#finalized) {
      throw new ModelIntegrityError('ALREADY_FINALIZED', 'SHA-256 has already been finalized.');
    }
    this.#finalized = true;
    return { bytes: this.#bytes, sha256: bytesToHex(this.#hash.digest()) };
  }
}

export function createModelSha256Accumulator(
  maximumBytes = MODEL_CACHE_MAX_FILE_BYTES,
): ModelSha256Accumulator {
  return new ModelSha256Accumulator(maximumBytes);
}

export function sha256Bytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new ModelIntegrityError('INVALID_CHUNK', 'SHA-256 input must be a Uint8Array.');
  }
  return bytesToHex(sha256(bytes));
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  return sha256Bytes(bytes);
}

export async function hashBlob(
  blob: Blob,
  options: ModelBlobHashOptions = {},
): Promise<ModelIntegrityResult> {
  if (!(blob instanceof Blob)) {
    throw new ModelIntegrityError('INVALID_CHUNK', 'Model content must be a Blob.');
  }
  const { maxBytes } = normalizeHashOptions(options);
  if (blob.size > maxBytes) {
    throw new ModelIntegrityError(
      'LIMIT_EXCEEDED',
      'Model Blob exceeds its bounded SHA-256 byte limit.',
    );
  }

  // Queue the Blob reference, not a preallocated shard-sized ArrayBuffer.
  return digestScheduler.digestBuffer(blob, undefined, options.onProgress);
}

export function assertModelIntegrity(
  result: ModelIntegrityResult,
  expectation: ModelIntegrityExpectation,
): ModelIntegrityResult {
  assertExpectation(expectation);
  if (result.bytes !== expectation.bytes) {
    throw new ModelIntegrityError(
      'LENGTH_MISMATCH',
      `Expected ${expectation.bytes} model bytes, received ${result.bytes}.`,
    );
  }
  if (result.sha256 !== expectation.sha256) {
    throw new ModelIntegrityError('HASH_MISMATCH', 'Model SHA-256 did not match its manifest.');
  }
  return result;
}

export async function verifyBlobIntegrity(
  blob: Blob,
  expectation: ModelIntegrityExpectation,
  options: Omit<ModelBlobHashOptions, 'maxBytes'> = {},
): Promise<ModelIntegrityResult> {
  assertExpectation(expectation);
  if (blob.size !== expectation.bytes) {
    throw new ModelIntegrityError(
      'LENGTH_MISMATCH',
      `Expected ${expectation.bytes} model bytes, received ${blob.size}.`,
    );
  }
  const result = await hashBlob(blob, {
    chunkBytes: options.chunkBytes,
    maxBytes: expectation.bytes,
    onProgress: options.onProgress,
  });
  return assertModelIntegrity(result, expectation);
}

export interface ShardPrecheckResult {
  valid: boolean;
  reason?: 'empty-file' | 'size-mismatch' | 'read-failed';
  actualBytes?: number;
}

export async function verifyShardPrecheck(
  source: Blob | { getFile: () => Promise<Blob> },
  expectedBytes: number,
): Promise<ShardPrecheckResult> {
  try {
    const file = typeof (source as { getFile?: unknown }).getFile === 'function'
      ? await (source as { getFile: () => Promise<Blob> }).getFile()
      : (source as Blob);
    if (file.size === 0 && expectedBytes > 0) {
      return { valid: false, reason: 'empty-file', actualBytes: 0 };
    }
    if (file.size !== expectedBytes) {
      return { valid: false, reason: 'size-mismatch', actualBytes: file.size };
    }
    return { valid: true, actualBytes: file.size };
  } catch {
    return { valid: false, reason: 'read-failed' };
  }
}

export function createModelIntegrityTransform(
  expectation: ModelIntegrityExpectation,
): ModelIntegrityTransform {
  assertExpectation(expectation);
  const accumulator = createModelSha256Accumulator(expectation.bytes);
  let resolveResult!: (result: ModelIntegrityResult) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<ModelIntegrityResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(
      chunk: Uint8Array,
      controller: TransformStreamDefaultController<Uint8Array>,
    ) {
      try {
        accumulator.update(chunk);
        controller.enqueue(chunk);
      } catch (error) {
        rejectResult(error);
        throw error;
      }
    },
    flush() {
      try {
        const verified = assertModelIntegrity(accumulator.digest(), expectation);
        resolveResult(verified);
      } catch (error) {
        rejectResult(error);
        throw error;
      }
    },
  });
  return { stream, result };
}
