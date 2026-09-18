import {
  contextKey,
  DEFAULT_EVA_CONTEXT_SCOPE,
  EVA_CONTEXT_LIMITS,
  validateEvaContextScope,
  type EvaContextExport,
  type EvaContextScope,
  type EvaDataExport,
  type EvaImportCounts,
  type EvaMemoryRecord,
} from './types';

import { parseChapterSynopsis } from '../eva/story-bible';

type JsonObject = Record<string, unknown>;
const SCOPE_KEYS = ['model_id', 'context_partition_id'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(detail: string): never {
  throw new TypeError(`Invalid Eva context import: ${detail}`);
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be an object.`);
  const result = value as JsonObject;
  if (Object.keys(result).some((key) => FORBIDDEN_KEYS.has(key))) invalid(`${label} contains a forbidden key.`);
  return result;
}

function keys(value: JsonObject, required: string[], optional: string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    invalid('Unexpected or missing fields.');
  }
}

function text(value: unknown, max: number, min = 0): asserts value is string {
  if (typeof value !== 'string' || value.length < min || value.length > max) invalid('Text exceeds its allowed bounds.');
}

function id(value: unknown): asserts value is string {
  text(value, 128, 1);
  if (/[\u0000-\u001f\u007f]/.test(value) || FORBIDDEN_KEYS.has(value)) invalid('Invalid record ID.');
}

function timestamp(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid('Invalid timestamp.');
}

function owned(value: JsonObject, scope: EvaContextScope): void {
  if (value.model_id !== scope.model_id || value.context_partition_id !== scope.context_partition_id) {
    invalid('A record belongs to a different model or context partition.');
  }
}

function records(value: unknown, max: number, validate: (record: JsonObject) => void): JsonObject[] {
  if (!Array.isArray(value) || value.length > max) invalid('Record count exceeds its allowed bounds.');
  const seen = new Set<string>();
  return value.map((entry) => {
    const record = object(entry, 'Record');
    id(record.id);
    if (seen.has(record.id)) invalid('Duplicate record ID within a context partition.');
    seen.add(record.id);
    validate(record);
    return record;
  });
}

export function validateEvaMemoryRecord(value: unknown, scope: EvaContextScope): asserts value is EvaMemoryRecord {
  const record = object(value, 'Memory');
  keys(record, [...SCOPE_KEYS, 'id', 'content', 'tags', 'createdAt', 'updatedAt'],
    ['sessionId', 'provenance', 'sourceMessageIds', 'pagingTurnId', 'synopsis', 'recallArtifact']);
  owned(record, scope);
  id(record.id);
  text(record.content, record.provenance === 'auto' ? 1200 : 2000, 1);
  if (!Array.isArray(record.tags) || record.tags.length > 8) invalid('Invalid memory tags.');
  if (record.provenance !== undefined && !['auto', 'user', 'synopsis', 'synthesized'].includes(record.provenance as string)) invalid('Invalid memory provenance.');
  if (record.sessionId !== undefined) id(record.sessionId);
  if (record.provenance !== undefined && record.sessionId === undefined) invalid('Memory provenance requires session ownership.');
  for (const tag of record.tags) text(tag, ['auto', 'synopsis', 'synthesized'].includes(record.provenance as string) && tag === `session:${record.sessionId}` ? 136 : 32, 1);
  if (new Set(record.tags).size !== record.tags.length) invalid('Duplicate memory tags.');
  if (record.provenance === 'auto') {
    id(record.pagingTurnId);
    if (!Array.isArray(record.sourceMessageIds) || record.sourceMessageIds.length < 2
      || record.sourceMessageIds.length > EVA_CONTEXT_LIMITS.messagesPerSession) invalid('Invalid summary source IDs.');
    for (const source of record.sourceMessageIds) id(source);
    if (new Set(record.sourceMessageIds).size !== record.sourceMessageIds.length) invalid('Duplicate summary source IDs.');
    const range = typeof record.tags[2] === 'string' ? /^turns:([1-9][0-9]*)-([1-9][0-9]*)$/.exec(record.tags[2]) : null;
    const validMethod = record.tags.length === 3 || (record.tags.length === 4 && record.tags[3] === 'summary-method:extractive');
    if (!validMethod || record.tags[0] !== 'context-summary' || record.tags[1] !== `session:${record.sessionId}`
      || !range || !Number.isSafeInteger(Number(range[1])) || range[1] !== range[2]) invalid('Invalid summary ownership or turn range.');
  } else if (record.provenance === 'synopsis') {
    const synopsis = object(record.synopsis, 'Synopsis');
    keys(synopsis, ['chapter', 'raw', 'tail', 'modelVersion', 'compressed']);
    const chapter = parseChapterSynopsis(record.content as string);
    if (synopsis.chapter !== chapter.chapter || typeof synopsis.compressed !== 'boolean') invalid('Invalid synopsis chapter or consent flag.');
    text(synopsis.raw, EVA_CONTEXT_LIMITS.messageChars, 1);
    text(synopsis.tail, EVA_CONTEXT_LIMITS.messageChars, 1);
    text(synopsis.modelVersion, 512, 1);
    if (!Array.isArray(record.sourceMessageIds) || record.sourceMessageIds.length !== 1 || record.pagingTurnId !== undefined) invalid('Invalid synopsis source.');
    id(record.sourceMessageIds[0]);
    if (record.tags.join('|') !== `chapter-synopsis|session:${record.sessionId}|chapter:${chapter.chapter}`) invalid('Invalid synopsis tags.');
  } else if (record.provenance === 'synthesized') {
    // D2 artifacts are standalone; optional recallArtifact metadata only references a standalone artifact.
  } else if (record.sourceMessageIds !== undefined || record.pagingTurnId !== undefined) invalid('Only summaries may reference source messages.');
  if (record.provenance !== 'synopsis' && record.synopsis !== undefined) invalid('Unexpected synopsis metadata.');
  if (Object.hasOwn(record, 'recallArtifact')) {
    const artifact = object(record.recallArtifact, 'Recall artifact');
    keys(artifact, ['artifactId', 'query', 'sourceRefs', 'modelVersion', 'text', 'charBudget', 'schemaVersion']);
    id(artifact.artifactId);
    text(artifact.query, EVA_CONTEXT_LIMITS.draftChars, 1);
    text(artifact.text, 1500);
    if (!Number.isSafeInteger(artifact.charBudget) || (artifact.charBudget as number) < 1
      || (artifact.charBudget as number) > 1500 || artifact.text.length > (artifact.charBudget as number)) invalid('Invalid recall artifact character budget.');
    if (!Number.isSafeInteger(artifact.schemaVersion) || (artifact.schemaVersion as number) < 1) invalid('Invalid recall artifact schema version.');
    if (artifact.modelVersion !== null) text(artifact.modelVersion, 512, 1);
    if (!Array.isArray(artifact.sourceRefs) || artifact.sourceRefs.length > 8) invalid('Invalid recall artifact source references.');
    for (const value of artifact.sourceRefs) {
      const source = object(value, 'Recall artifact source');
      if (source.kind === 'message') {
        keys(source, ['kind', 'messageId', 'sessionId']);
        id(source.messageId);
        id(source.sessionId);
      } else if (source.kind === 'block') {
        keys(source, ['kind', 'blockId']);
        id(source.blockId);
      } else invalid('Invalid recall artifact source kind.');
    }
  }
  timestamp(record.createdAt);
  timestamp(record.updatedAt);
  if ((record.updatedAt as number) < (record.createdAt as number)) invalid('Memory timestamps are reversed.');
}

function validateContext(value: unknown): EvaContextExport {
  const context = object(value, 'Context');
  keys(context, [...SCOPE_KEYS, 'sessions', 'messages', 'memory', 'profile', 'recovery']);
  const scope = validateEvaContextScope(context as unknown as EvaContextScope);
  const sessions = records(context.sessions, EVA_CONTEXT_LIMITS.sessions, (record) => {
    keys(record, [...SCOPE_KEYS, 'id', 'title', 'createdAt', 'updatedAt']);
    owned(record, scope);
    text(record.title, 128, 1);
    timestamp(record.createdAt);
    timestamp(record.updatedAt);
    if ((record.updatedAt as number) < (record.createdAt as number)) invalid('Session timestamps are reversed.');
  });
  const sessionIds = new Set(sessions.map((record) => record.id));
  const messageCounts = new Map<string, number>();
  records(context.messages, EVA_CONTEXT_LIMITS.sessions * EVA_CONTEXT_LIMITS.messagesPerSession, (record) => {
    keys(record, [...SCOPE_KEYS, 'id', 'sessionId', 'role', 'content', 'createdAt'], ['name', 'turn']);
    owned(record, scope);
    id(record.sessionId);
    if (!sessionIds.has(record.sessionId)) invalid('A message references a missing session.');
    if (!['system', 'user', 'assistant', 'tool'].includes(record.role as string)) invalid('Unknown message role.');
    text(record.content, EVA_CONTEXT_LIMITS.messageChars);
    if (record.name !== undefined) text(record.name, 128, 1);
    timestamp(record.createdAt);
    if (record.turn !== undefined && (!Number.isSafeInteger(record.turn) || (record.turn as number) < 1)) invalid('Invalid message turn.');
    const count = (messageCounts.get(record.sessionId) ?? 0) + 1;
    if (count > EVA_CONTEXT_LIMITS.messagesPerSession) invalid('Too many messages in a session.');
    messageCounts.set(record.sessionId, count);
  });
  records(context.memory, EVA_CONTEXT_LIMITS.memory, (record) => {
    validateEvaMemoryRecord(record, scope);
  });
  const profile = object(context.profile, 'Profile');
  keys(profile, [...SCOPE_KEYS, 'id', 'displayName', 'notes', 'updatedAt']);
  owned(profile, scope);
  if (profile.id !== 'local') invalid('Invalid profile ID.');
  text(profile.displayName, 80, 1);
  text(profile.notes, 2000);
  timestamp(profile.updatedAt);
  records(context.recovery, EVA_CONTEXT_LIMITS.sessions, (record) => {
    keys(record, [...SCOPE_KEYS, 'id', 'sessionId', 'draft', 'partialResponse', 'updatedAt']);
    owned(record, scope);
    if (record.id !== record.sessionId || !sessionIds.has(record.sessionId)) invalid('Recovery references a missing session.');
    text(record.draft, EVA_CONTEXT_LIMITS.draftChars);
    text(record.partialResponse, EVA_CONTEXT_LIMITS.messageChars);
    timestamp(record.updatedAt);
  });
  return context as unknown as EvaContextExport;
}

function normalizeLegacy(value: JsonObject): JsonObject {
  keys(value, ['schemaVersion', 'exportedAt', 'sessions', 'messages', 'memory', 'profile']);
  const scope = DEFAULT_EVA_CONTEXT_SCOPE;
  const addScope = (entry: unknown, allowed: string[], optional: string[] = []) => {
    const record = object(entry, 'Legacy record');
    keys(record, allowed, optional);
    return { ...record, ...scope };
  };
  const map = (input: unknown, allowed: string[], optional: string[] = []) => {
    if (!Array.isArray(input)) invalid('Legacy records must be arrays.');
    return input.map((entry) => addScope(entry, allowed, optional));
  };
  return {
    schemaVersion: 2,
    exportedAt: value.exportedAt,
    models: { [scope.model_id]: { model_id: scope.model_id } },
    contexts: {
      [contextKey(scope)]: {
        ...scope,
        sessions: map(value.sessions, ['id', 'title', 'createdAt', 'updatedAt']),
        messages: map(value.messages, ['id', 'sessionId', 'role', 'content', 'createdAt'], ['name']),
        memory: map(value.memory, ['id', 'content', 'tags', 'createdAt', 'updatedAt']),
        profile: addScope(value.profile, ['id', 'displayName', 'notes', 'updatedAt']),
        recovery: [],
      },
    },
  };
}

/** Treats all content as passive records: importing never invokes Eva or the tool registry. */
export function parseEvaDataImport(input: string | unknown): EvaDataExport {
  let serialized: string;
  try {
    serialized = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    return invalid('Unable to read JSON.');
  }
  if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > EVA_CONTEXT_LIMITS.importBytes) {
    invalid('File exceeds the 16 MiB import limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return invalid('Unable to read JSON.');
  }
  let root = object(parsed, 'Export');
  if (root.schemaVersion === 1) root = normalizeLegacy(root);
  keys(root, ['schemaVersion', 'exportedAt', 'models', 'contexts']);
  if (root.schemaVersion !== 2) invalid('Unsupported schema version.');
  text(root.exportedAt, 40, 1);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(root.exportedAt)
    || !Number.isFinite(Date.parse(root.exportedAt))) invalid('Invalid export timestamp.');
  const canonicalTimestamp = root.exportedAt.length === 20
    ? `${root.exportedAt.slice(0, -1)}.000Z` : root.exportedAt;
  if (new Date(root.exportedAt).toISOString() !== canonicalTimestamp) invalid('Invalid export timestamp.');
  const models = object(root.models, 'Models');
  const contexts = object(root.contexts, 'Contexts');
  if (Object.keys(models).length > EVA_CONTEXT_LIMITS.models || Object.keys(contexts).length > EVA_CONTEXT_LIMITS.contexts) {
    invalid('Too many models or context partitions.');
  }
  const usedModels = new Set<string>();
  for (const [key, value] of Object.entries(models)) {
    const model = object(value, 'Model');
    keys(model, ['model_id']);
    if (model.model_id !== key) invalid('Model key does not match model_id.');
    validateEvaContextScope({ model_id: key, context_partition_id: 'default' });
  }
  for (const [key, value] of Object.entries(contexts)) {
    const context = validateContext(value);
    if (key !== contextKey(context)) invalid('Context key does not match its qualified partition identity.');
    if (!Object.hasOwn(models, context.model_id)) invalid('Context references an undeclared model.');
    usedModels.add(context.model_id);
  }
  if (Object.keys(models).some((key) => !usedModels.has(key))) invalid('A model has no exported context partition.');
  return root as unknown as EvaDataExport;
}

export function previewEvaDataImport(input: string | unknown): { data: EvaDataExport; counts: EvaImportCounts } {
  const data = parseEvaDataImport(input);
  const contexts = Object.values(data.contexts);
  return {
    data,
    counts: {
      models: Object.keys(data.models).length,
      contexts: contexts.length,
      sessions: contexts.reduce((sum, context) => sum + context.sessions.length, 0),
      messages: contexts.reduce((sum, context) => sum + context.messages.length, 0),
      memory: contexts.reduce((sum, context) => sum + context.memory.length, 0),
      profiles: contexts.length,
      recovery: contexts.reduce((sum, context) => sum + context.recovery.length, 0),
    },
  };
}
