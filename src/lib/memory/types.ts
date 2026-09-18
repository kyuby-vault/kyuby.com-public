import type { EvaChatRole } from '../eva/worker-protocol';

export const DEFAULT_EVA_CONTEXT_SCOPE: Readonly<EvaContextScope> = Object.freeze({
  model_id: 'qwen3-4b-element4-eva-holy-grail-browser-q4f16-sharded',
  context_partition_id: 'default',
});

export const EVA_CONTEXT_LIMITS = Object.freeze({
  sessions: 12,
  messagesPerSession: 80,
  memory: 100,
  models: 16,
  contexts: 64,
  importBytes: 16 * 1024 * 1024,
  messageChars: 32_000,
  draftChars: 8_000,
});

export interface EvaContextScope {
  model_id: string;
  context_partition_id: string;
}

export function validateEvaContextScope(scope: EvaContextScope): EvaContextScope {
  for (const value of [scope.model_id, scope.context_partition_id]) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
      || ['__proto__', 'constructor', 'prototype'].includes(value)) {
      throw new TypeError('Invalid Eva model or context partition ID.');
    }
  }
  return { model_id: scope.model_id, context_partition_id: scope.context_partition_id };
}

// The qualified key prevents equal partition names belonging to different models from colliding.
export function contextKey(scope: EvaContextScope): string {
  const value = validateEvaContextScope(scope);
  return JSON.stringify([value.model_id, value.context_partition_id]);
}

export interface EvaSession extends EvaContextScope {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface EvaMessage extends EvaContextScope {
  id: string;
  sessionId: string;
  role: EvaChatRole;
  content: string;
  name?: string;
  createdAt: number;
  turn?: number;
}

export interface EvaMemoryRecord extends EvaContextScope {
  id: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  provenance?: 'user' | 'auto' | 'synopsis' | 'synthesized';
  sourceMessageIds?: string[];
  pagingTurnId?: string;
  synopsis?: {
    chapter: number;
    raw: string;
    tail: string;
    modelVersion: string;
    compressed: boolean;
  };
  recallArtifact?: {
    artifactId: string;
    query: string;
    sourceRefs: SourceRef[];
    modelVersion: string | null;
    text: string;
    charBudget: number;
    schemaVersion: number;
  };
}

export type SourceRef =
  | { kind: 'message'; messageId: string; sessionId: string }
  | { kind: 'block'; blockId: string };

export interface RecallSynthesisRequest {
  query: string;
  candidates: EvaMemoryRecord[];
  budget: { maxCalls: 1; maxRetries: 2; maxOutputChars: 1500 };
}

export type RecallSynthesisResult =
  | { ok: true; artifact: RecallArtifact }
  | { ok: false; reason: 'invalid-output' | 'cancelled' | 'budget-exceeded' | 'model-unavailable' };

export interface RecallArtifact {
  artifactId: string;
  kind: 'recall-artifact';
  provenance: 'synthesized';
  query: string;
  sourceRefs: SourceRef[];
  modelVersion: string | null;
  text: string;
  charBudget: number;
  createdAt: number;
  schemaVersion: 1;
}

export interface EvaProfile extends EvaContextScope {
  id: 'local';
  displayName: string;
  notes: string;
  updatedAt: number;
}

export interface EvaRecoveryRecord extends EvaContextScope {
  id: string;
  sessionId: string;
  draft: string;
  partialResponse: string;
  updatedAt: number;
}

export interface EvaContextExport extends EvaContextScope {
  sessions: EvaSession[];
  messages: EvaMessage[];
  memory: EvaMemoryRecord[];
  profile: EvaProfile;
  recovery: EvaRecoveryRecord[];
}

export interface EvaDataExport {
  schemaVersion: 2;
  exportedAt: string;
  models: Record<string, { model_id: string }>;
  contexts: Record<string, EvaContextExport>;
}

export interface EvaExportOptions {
  model_id?: string;
  context_partition_id?: string;
}

export interface EvaImportCounts {
  models: number;
  contexts: number;
  sessions: number;
  messages: number;
  memory: number;
  profiles: number;
  recovery: number;
}

export function defaultEvaProfile(scope: EvaContextScope): EvaProfile {
  return { ...scope, id: 'local', displayName: 'You', notes: '', updatedAt: 0 };
}
