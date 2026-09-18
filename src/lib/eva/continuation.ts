import type { EvaModelMessage } from './worker-protocol';

export const MAX_UNFINISHED_CHARACTERS = 32_000;
export const CONTINUATION_TAIL_TOKENS = 600;
export interface EvaTextWindow { text: string; inputTokens: number; tailTokens: number }

export function tokenTail(text: string, encode: (text: string) => number[], decode: (tokens: number[]) => string,
  limit = CONTINUATION_TAIL_TOKENS): EvaTextWindow {
  if (!text || text.length > MAX_UNFINISHED_CHARACTERS) throw new Error('Unfinished text exceeds the recovery boundary.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONTINUATION_TAIL_TOKENS) throw new Error('Invalid tail token limit.');
  const tokens = encode(text);
  let selected = tokens.slice(-limit);
  let tail = decode(selected);
  // Decoding a suffix may start inside a multibyte character; trim that boundary only.
  tail = tail.replace(/^\uFFFD+/, '');
  while (encode(tail).length > limit && selected.length) {
    selected = selected.slice(1);
    tail = decode(selected).replace(/^\uFFFD+/, '');
  }
  return { text: tail, inputTokens: tokens.length, tailTokens: encode(tail).length };
}

export class ContinuationNoProgressError extends Error {}

export function continuationRemainder(prefix: string, generated: string): string {
  if (!generated.trim()) throw new ContinuationNoProgressError('Continue produced no new text (immediate stop token). Try a specific instruction or a larger output ceiling.');
  if (prefix.endsWith(generated.trim()) || generated.trim() === prefix.trim()) {
    throw new ContinuationNoProgressError('Continue repeated the existing ending; no new text was saved. Try a specific next-scene instruction.');
  }
  // Strip only an exact, substantial echoed suffix; do not remove legitimate short repeated words.
  for (let length = Math.min(4000, prefix.length, generated.length); length >= 40; length -= 1) {
    if (prefix.endsWith(generated.slice(0, length))) return continuationRemainder(prefix, generated.slice(length));
  }
  return generated;
}

/** Recovery is only sent after explicit Continue (or an opted-in bounded continuation). */
export function continuationMessages(messages: EvaModelMessage[], partial: string): EvaModelMessage[] {
  if (!partial || partial.length >= MAX_UNFINISHED_CHARACTERS) {
    throw new Error('The unfinished response has reached its recovery limit. Export or dismiss it before starting a new turn.');
  }
  return [...messages, { role: 'assistant', content: partial }, {
    role: 'system',
    content: '[CONTINUATION: only the bounded ending of the unfinished response is shown above; earlier text stays on this device.] Continue from exactly where this tail stopped. Output only new text, without repeating the tail or restarting the chapter. Do not call tools. Keep the exact same language as the last user message.',
  }];
}

export class UnfinishedGeneration extends Error {
  constructor(readonly reason: 'length' | 'stop', readonly tokens: number | null) {
    super(reason === 'length' ? `⚠ Truncated at ${tokens ?? 'unknown'} tokens — unfinished`
      : 'Generation stopped. The partial response was kept as unfinished.');
  }
}
