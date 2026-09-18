import type { ModelCacheManifestInventory } from './model-cache/types';
import { isEvaBudgets, type EvaBudgets, type EvaKvAllowance } from './generation-budget';
import type { EvaTextWindow } from './continuation';

export const EVA_WORKER_PROTOCOL_VERSION = 2 as const;

export type EvaWorkerState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'generating'
  | 'error'
  | 'disposed';

export type EvaChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface EvaModelMessage {
  role: EvaChatRole;
  content: string;
  name?: string;
}

export interface EvaModelConfig {
  modelHost: string;
  modelId: string;
  manifestUrl: string;
  manifestVersion: string;
  manifestEtag: string | null;
  manifestRawSha256: string;
  manifestFetchedAt: number;
  cacheLeaseNonce: string | null;
  pageHeapHeadroom?: number | null;
  kvAllowance?: EvaKvAllowance;
  testFixture?: 'model-cache';
  manifest: EvaArtifactManifest;
}

export interface EvaArtifactManifest {
  schemaVersion: string | number | null;
  prepareMode: string | null;
  cacheInventory: ModelCacheManifestInventory | null;
  onnx: {
    entryFile: string;
    runtimeDtype: 'q4f16';
    quantizationBackend: string | null;
    dataFiles: string[];
  };
}

export interface EvaGenerationOptions {
  maxNewTokens: number;
  contextLimit: number;
  temperature: number;
}

export interface EvaFunctionToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type EvaWorkerRequest =
  | { protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION; type: 'set-budget'; requestId: string; allowance: EvaKvAllowance }
  | { protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION; type: 'measure'; requestId: string; messages: EvaModelMessage[]; tools: EvaFunctionToolDefinition[] }
  | { protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION; type: 'tail'; requestId: string; text: string }
  | {
      protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION;
      type: 'load';
      requestId: string;
      config: EvaModelConfig;
    }
  | {
      protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION;
      type: 'generate';
      requestId: string;
      messages: EvaModelMessage[];
      options: EvaGenerationOptions;
      tools: EvaFunctionToolDefinition[];
    }
  | {
      protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION;
      type: 'cancel';
      requestId: string;
    }
  | {
      protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION;
      type: 'dispose';
      requestId: string;
    };

export type EvaWorkerResponse =
  | { protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION; type: 'measured'; requestId: string; inputTokens: number }
  | { protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION; type: 'text-window'; requestId: string; window: EvaTextWindow }
  | {
      protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION;
      type: 'budgets';
      requestId: string;
      budgets: EvaBudgets;
    }
  | {
      protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION;
      type: 'state';
      requestId: string;
      state: EvaWorkerState;
    }
  | {
      protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION;
      type: 'progress';
      requestId: string;
      file: string | null;
      loaded: number | null;
      total: number | null;
      progress: number | null;
      status: string;
    }
  | {
      protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION;
      type: 'token';
      requestId: string;
      text: string;
    }
  | {
      protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION;
      type: 'done';
      requestId: string;
      text: string;
      inputTokens: number | null;
      generatedTokens: number | null;
      elapsedMs: number;
      finishReason: 'length' | 'stop';
      cancelled: boolean;
      tokenLimit: number;
    }
  | {
      protocolVersion: typeof EVA_WORKER_PROTOCOL_VERSION;
      type: 'error';
      requestId: string;
      code: 'BAD_REQUEST' | 'LOAD_FAILED' | 'GENERATION_FAILED' | 'NOT_READY';
      message: string;
      recoverable: boolean;
      finishReason?: 'error';
    };

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isWorkerState(value: unknown): value is EvaWorkerState {
  return value === 'idle'
    || value === 'loading'
    || value === 'ready'
    || value === 'generating'
    || value === 'error'
    || value === 'disposed';
}

export function isEvaWorkerResponse(value: unknown): value is EvaWorkerResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.protocolVersion !== EVA_WORKER_PROTOCOL_VERSION
    || typeof candidate.requestId !== 'string'
    || candidate.requestId.length === 0) {
    return false;
  }

  if (candidate.type === 'state') {
    return isWorkerState(candidate.state);
  }
  if (candidate.type === 'budgets') return isEvaBudgets(candidate.budgets);
  if (candidate.type === 'measured') return Number.isSafeInteger(candidate.inputTokens) && (candidate.inputTokens as number) >= 0;
  if (candidate.type === 'text-window') {
    const window = candidate.window as EvaTextWindow | null;
    return !!window && typeof window.text === 'string' && window.text.length <= 32000
      && Number.isSafeInteger(window.inputTokens) && window.inputTokens >= 0
      && Number.isSafeInteger(window.tailTokens) && window.tailTokens >= 0 && window.tailTokens <= 600;
  }
  if (candidate.type === 'progress') {
    return isNullableString(candidate.file)
      && isNullableFiniteNumber(candidate.loaded)
      && isNullableFiniteNumber(candidate.total)
      && isNullableFiniteNumber(candidate.progress)
      && typeof candidate.status === 'string';
  }
  if (candidate.type === 'token') {
    return typeof candidate.text === 'string';
  }
  if (candidate.type === 'done') {
    return typeof candidate.text === 'string'
      && isNullableFiniteNumber(candidate.inputTokens)
      && isNullableFiniteNumber(candidate.generatedTokens)
      && typeof candidate.elapsedMs === 'number'
      && Number.isFinite(candidate.elapsedMs)
      && (candidate.finishReason === 'length' || candidate.finishReason === 'stop')
      && typeof candidate.cancelled === 'boolean'
      && typeof candidate.tokenLimit === 'number' && Number.isSafeInteger(candidate.tokenLimit)
      && candidate.tokenLimit > 0 && candidate.tokenLimit <= 4096;
  }
  if (candidate.type === 'error') {
    return (candidate.code === 'BAD_REQUEST'
        || candidate.code === 'LOAD_FAILED'
        || candidate.code === 'GENERATION_FAILED'
        || candidate.code === 'NOT_READY')
      && typeof candidate.message === 'string'
      && typeof candidate.recoverable === 'boolean';
  }
  return false;
}
