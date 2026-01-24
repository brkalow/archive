import type { Message, ToolUseBlock } from '../../db/schema';

/**
 * Group messages into turns: each user message starts a new turn,
 * followed by consecutive assistant messages.
 */
export interface Turn {
  type: 'user' | 'agent';
  messages: Message[];
}

/**
 * Check if a user message is a subagent prompt (sent to a Task subagent).
 * These are user messages that immediately follow a Task tool_use.
 * The subagent echoes the Task prompt as a user message.
 */
export function isSubagentPrompt(message: Message, prevMessage: Message | null): boolean {
  if (message.role !== 'user' || !prevMessage) return false;

  // Check if previous message is an assistant message with a Task tool_use
  if (prevMessage.role !== 'assistant') return false;

  const hasTaskToolUse = prevMessage.content_blocks?.some(
    (block) => block.type === 'tool_use' && (block as ToolUseBlock).name === 'Task'
  );

  return hasTaskToolUse ?? false;
}

/**
 * Group messages into turns for display.
 * Filters out tool_result-only messages and subagent prompts.
 */
export function groupMessagesIntoTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let currentAgentMessages: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const prevMessage = i > 0 ? messages[i - 1]! : null;

    // Skip user messages that only contain tool_result blocks
    if (message.role === 'user') {
      const hasNonToolResult = message.content_blocks?.some(
        (block) => block.type !== 'tool_result'
      );
      if (!hasNonToolResult) {
        continue;
      }

      // Skip subagent prompts (they are shown nested under the Task tool)
      if (isSubagentPrompt(message, prevMessage)) {
        continue;
      }

      // Flush any pending agent messages
      if (currentAgentMessages.length > 0) {
        turns.push({ type: 'agent', messages: currentAgentMessages });
        currentAgentMessages = [];
      }

      // Add user turn
      turns.push({ type: 'user', messages: [message] });
    } else if (message.role === 'assistant') {
      // Accumulate assistant messages
      currentAgentMessages.push(message);
    }
    // Skip system messages
  }

  // Flush remaining agent messages
  if (currentAgentMessages.length > 0) {
    turns.push({ type: 'agent', messages: currentAgentMessages });
  }

  return turns;
}
