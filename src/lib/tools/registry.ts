import { getProfile, searchMemory, storeMemory, type EvaContextScope } from '../memory/db';
import type { EvaFunctionToolDefinition, EvaModelMessage } from '../eva/worker-protocol';

export const MAX_TOOL_ITERATIONS = 3;
const MAX_TOOL_CALLS_PER_TURN = 3;
const MAX_TOOL_OUTPUT_CHARS = 4000;

export type EvaToolName = 'memory.store' | 'memory.search' | 'profile.get';

export interface EvaToolCall {
  name: EvaToolName;
  arguments: Record<string, unknown>;
}

export interface EvaToolResult {
  name: EvaToolName;
  ok: boolean;
  content: string;
}

export interface EvaToolCallExtraction {
  calls: EvaToolCall[];
  droppedMalformedToolCall: boolean;
  recoveredMalformedXml: boolean;
}

export const MALFORMED_TOOL_CALL_RETRY_MESSAGE =
  '[System: Tool call failed due to malformed XML or invalid JSON. Please retry with strict <tool_call>...</tool_call> tags containing a valid JSON tool envelope.]';

export const EVA_TOOL_DEFINITIONS: EvaFunctionToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'memory.store',
      description: 'Store one durable user fact or preference when the user asks you to remember it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 2000 },
          tags: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 32 },
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory.search',
      description: 'Search durable local memory for facts relevant to the current request.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 8 },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'profile.get',
      description: 'Read the local user profile supplied in this browser.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeToolName(value: unknown): EvaToolName | null {
  return value === 'memory.store' || value === 'memory.search' || value === 'profile.get'
    ? value
    : null;
}

function normalizeToolCall(value: unknown): EvaToolCall[] {
  if (Array.isArray(value)) {
    return value.flatMap(normalizeToolCall);
  }
  if (!isRecord(value)) {
    return [];
  }
  if (Array.isArray(value.tool_calls)) {
    return value.tool_calls.flatMap(normalizeToolCall);
  }

  const functionValue = isRecord(value.function) ? value.function : value;
  const name = normalizeToolName(functionValue.name);
  const args = parseArguments(functionValue.arguments ?? value.arguments ?? {});
  return name && args ? [{ name, arguments: args }] : [];
}

function hasDroppedJsonToolCall(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasDroppedJsonToolCall);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (Array.isArray(value.tool_calls)) {
    return value.tool_calls.some(hasDroppedJsonToolCall);
  }

  const functionValue = isRecord(value.function) ? value.function : value;
  const resemblesToolCall = 'function' in value
    || 'name' in functionValue
    || 'arguments' in functionValue
    || 'arguments' in value;
  return resemblesToolCall && normalizeToolCall(value).length === 0;
}

interface JsonValueExtraction {
  values: unknown[];
  parseErrors: number;
}

function extractJsonValues(text: string): JsonValueExtraction {
  const values: unknown[] = [];
  let parseErrors = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start === -1) {
      if (character === '{' || character === '[') {
        start = index;
        stack.push(character);
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      stack.push(character);
    } else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.pop() !== expected) {
        parseErrors += 1;
        start = -1;
        stack.length = 0;
        continue;
      }
      if (stack.length === 0) {
        try {
          values.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          parseErrors += 1;
        }
        start = -1;
      }
    }
  }

  if (start !== -1) {
    parseErrors += 1;
  }

  return { values, parseErrors };
}

interface FunctionXmlExtraction {
  calls: EvaToolCall[];
  droppedMalformedCall: boolean;
}

function parseFunctionXmlArguments(text: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const parameterPattern = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let parameterMatch: RegExpExecArray | null;

  while ((parameterMatch = parameterPattern.exec(text)) !== null) {
    const parameterName = parameterMatch[1].trim();
    const parameterValue = parameterMatch[2].trim();
    if (parameterName === 'tags') {
      try {
        const parsedTags = JSON.parse(parameterValue);
        args[parameterName] = Array.isArray(parsedTags) ? parsedTags : parameterValue;
      } catch {
        args[parameterName] = parameterValue;
      }
    } else {
      args[parameterName] = parameterValue;
    }
  }

  return args;
}

function extractFunctionXmlCalls(text: string): FunctionXmlExtraction {
  const calls: EvaToolCall[] = [];
  let completedFunctions = 0;
  const assignedFunctionPattern = /<function=([^>]+)>([\s\S]*?)<\/function>/gi;
  let match: RegExpExecArray | null;

  while ((match = assignedFunctionPattern.exec(text)) !== null) {
    completedFunctions += 1;
    const name = normalizeToolName(match[1].trim());
    if (!name) {
      continue;
    }
    calls.push({ name, arguments: parseFunctionXmlArguments(match[2]) });
  }

  const namedFunctionPattern = /<function>\s*([^<]+?)\s*<\/function>/gi;
  while ((match = namedFunctionPattern.exec(text)) !== null) {
    completedFunctions += 1;
    const name = normalizeToolName(match[1].trim());
    if (!name) {
      continue;
    }
    calls.push({ name, arguments: parseFunctionXmlArguments(text) });
  }

  const functionOpenings = text.match(/<function(?:=[^>]+)?>/gi)?.length ?? 0;
  return {
    calls,
    droppedMalformedCall: functionOpenings > completedFunctions,
  };
}

interface TaggedToolPayload {
  content: string;
  malformedClosingTag: boolean;
}

function findTag(pattern: RegExp, text: string, fromIndex: number): RegExpExecArray | null {
  pattern.lastIndex = fromIndex;
  return pattern.exec(text);
}

function extractTaggedToolPayloads(text: string): TaggedToolPayload[] {
  const payloads: TaggedToolPayload[] = [];
  const openingPattern = /<(tool_call|tool)\b[^>]*>/gi;
  const malformedClosingIndexes = new Set<number>();
  let searchIndex = 0;

  while (searchIndex < text.length) {
    const opening = findTag(openingPattern, text, searchIndex);
    if (!opening) {
      break;
    }

    const contentStart = opening.index + opening[0].length;
    const openedAtMalformedBoundary = malformedClosingIndexes.has(opening.index);
    const closingPattern = new RegExp(`<\\/${opening[1]}\\s*>`, 'gi');
    const closing = findTag(closingPattern, text, contentStart);
    const nextOpening = findTag(/<(tool_call|tool)\b[^>]*>/gi, text, contentStart);

    if (closing && (!nextOpening || closing.index < nextOpening.index)) {
      payloads.push({
        content: text.slice(contentStart, closing.index),
        malformedClosingTag: false,
      });
      searchIndex = closing.index + closing[0].length;
      continue;
    }

    if (nextOpening) {
      payloads.push({
        content: text.slice(contentStart, nextOpening.index),
        malformedClosingTag: true,
      });
      malformedClosingIndexes.add(nextOpening.index);
      searchIndex = nextOpening.index;
      continue;
    }

    // Salvage a complete JSON or function payload that reaches end-of-message
    // without a closing tool tag. Validation still happens after extraction.
    const endOfMessageContent = text.slice(contentStart);
    if (openedAtMalformedBoundary && endOfMessageContent.trim().length === 0) {
      searchIndex = text.length;
      continue;
    }
    payloads.push({
      content: endOfMessageContent,
      malformedClosingTag: true,
    });
    searchIndex = text.length;
  }

  return payloads;
}

export function inspectEvaToolCalls(text: string): EvaToolCallExtraction {
  const calls: EvaToolCall[] = [];
  let droppedMalformedToolCall = false;
  let recoveredMalformedXml = false;

  for (const payload of extractTaggedToolPayloads(text)) {
    const functionExtraction = extractFunctionXmlCalls(payload.content);
    const jsonExtraction = extractJsonValues(payload.content);
    const jsonCalls = jsonExtraction.values.flatMap(normalizeToolCall);
    const droppedJsonToolCall = jsonExtraction.values.some(hasDroppedJsonToolCall);
    const payloadCalls = [
      ...functionExtraction.calls,
      ...jsonCalls,
    ];
    calls.push(...payloadCalls);

    if (payload.malformedClosingTag && payloadCalls.length > 0) {
      recoveredMalformedXml = true;
    }
    if (functionExtraction.droppedMalformedCall
      || jsonExtraction.parseErrors > 0
      || droppedJsonToolCall
      || payloadCalls.length === 0) {
      droppedMalformedToolCall = true;
    }
  }

  calls.push(...extractJsonValues(text).values.flatMap(normalizeToolCall));

  const uniqueCalls = new Map<string, EvaToolCall>();
  for (const call of calls) {
    uniqueCalls.set(`${call.name}:${JSON.stringify(call.arguments)}`, call);
  }
  return {
    calls: [...uniqueCalls.values()].slice(0, MAX_TOOL_CALLS_PER_TURN),
    droppedMalformedToolCall,
    recoveredMalformedXml,
  };
}

export function extractEvaToolCalls(text: string): EvaToolCall[] {
  return inspectEvaToolCalls(text).calls;
}

function assertOnlyKeys(args: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected argument: ${unexpected[0]}.`);
  }
}

function readBoundedString(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${key} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function serializeToolOutput(value: unknown): string {
  const output = JSON.stringify(value);
  return output.length > MAX_TOOL_OUTPUT_CHARS
    ? `${output.slice(0, MAX_TOOL_OUTPUT_CHARS - 16)}"...truncated"}`
    : output;
}

export async function executeEvaTool(call: EvaToolCall, scope?: EvaContextScope, sessionId?: string): Promise<EvaToolResult> {
  try {
    if (call.name === 'memory.store') {
      assertOnlyKeys(call.arguments, ['content', 'tags']);
      const content = readBoundedString(call.arguments, 'content', 2000);
      const rawTags = call.arguments.tags ?? [];
      if (!Array.isArray(rawTags) || rawTags.length > 8
        || rawTags.some((tag) => typeof tag !== 'string' || tag.length === 0 || tag.length > 32)) {
        throw new Error('tags must contain at most 8 strings of at most 32 characters.');
      }
      const record = await storeMemory(content, rawTags as string[], scope, sessionId ? { sessionId, provenance: 'user' } : {});
      return { name: call.name, ok: true, content: serializeToolOutput({ stored: true, id: record.id }) };
    }

    if (call.name === 'memory.search') {
      assertOnlyKeys(call.arguments, ['query', 'limit']);
      const query = readBoundedString(call.arguments, 'query', 200);
      const rawLimit = call.arguments.limit ?? 5;
      if (!Number.isInteger(rawLimit) || (rawLimit as number) < 1 || (rawLimit as number) > 8) {
        throw new Error('limit must be an integer from 1 to 8.');
      }
      const records = await searchMemory(query, rawLimit as number, scope, sessionId);
      return {
        name: call.name,
        ok: true,
        content: serializeToolOutput(records.map(({ id, content, tags, updatedAt }) => ({
          id,
          content,
          tags: tags.filter((tag) => !tag.startsWith('session:')),
          updatedAt,
        }))),
      };
    }

    assertOnlyKeys(call.arguments, []);
    const profile = await getProfile(scope);
    return { name: call.name, ok: true, content: serializeToolOutput(profile) };
  } catch (error) {
    return {
      name: call.name,
      ok: false,
      content: serializeToolOutput({ error: error instanceof Error ? error.message : String(error) }),
    };
  }
}

export async function runBoundedToolLoop(
  initialMessages: EvaModelMessage[],
  generate: (messages: EvaModelMessage[], tools: EvaFunctionToolDefinition[]) => Promise<string>,
  scope?: EvaContextScope,
  sessionId?: string,
): Promise<{ text: string; messages: EvaModelMessage[]; toolIterations: number }> {
  const messages = [...initialMessages];

  for (let iteration = 0; iteration <= MAX_TOOL_ITERATIONS; iteration += 1) {
    const text = await generate(messages, EVA_TOOL_DEFINITIONS);
    const extraction = inspectEvaToolCalls(text);
    if (extraction.calls.length === 0 && !extraction.droppedMalformedToolCall) {
      return { text, messages, toolIterations: iteration };
    }
    if (iteration === MAX_TOOL_ITERATIONS) {
      throw new Error(`Eva exceeded the ${MAX_TOOL_ITERATIONS}-iteration tool limit.`);
    }

    messages.push({ role: 'assistant', content: text });
    for (const call of extraction.calls) {
      const result = await executeEvaTool(call, scope, sessionId);
      messages.push({ role: 'tool', name: result.name, content: result.content });
    }
    if (extraction.droppedMalformedToolCall) {
      messages.push({ role: 'system', content: MALFORMED_TOOL_CALL_RETRY_MESSAGE });
    }
  }

  throw new Error('Eva tool loop ended unexpectedly.');
}
