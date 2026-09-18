import type { EvaMessage } from '../memory/db';
import type { EvaModelMessage } from './worker-protocol';

export const MAX_EVA_CONTEXT_MESSAGES = 24;
export const MAX_EVA_CONTEXT_CHARACTERS = 28_000;
export const EVA_LOCAL_TOOL_REQUEST_PLACEHOLDER = 'Local tool request omitted.';

const EVA_ASSISTANT_TOOL_MARKUP_PATTERN = /(?:<|&lt;)\s*\/?\s*(?:tool_call|tool|function|parameter)\b/i;

/**
 * Keeps local tool protocol markup out of assistant bubbles without mutating
 * persisted history or user-authored text.
 */
export function getEvaMessageDisplayContent(
  message: Pick<EvaMessage, 'role' | 'content'>,
): string {
  return message.role === 'assistant' && EVA_ASSISTANT_TOOL_MARKUP_PATTERN.test(message.content)
    ? EVA_LOCAL_TOOL_REQUEST_PLACEHOLDER
    : message.content;
}

/** Maps persisted UI records to the model's deliberately narrow message shape. */
export function createRecentEvaModelMessages(messages: EvaMessage[]): EvaModelMessage[] {
  const selected: EvaMessage[] = [];
  let characters = 0;
  for (const message of messages.slice(-MAX_EVA_CONTEXT_MESSAGES).reverse()) {
    if (selected.length > 0 && characters + message.content.length > MAX_EVA_CONTEXT_CHARACTERS) {
      break;
    }
    selected.push(message);
    characters += message.content.length;
  }
  return selected.reverse().map(({ role, content, name }) => ({
    role,
    content,
    ...(name ? { name } : {}),
  }));
}
