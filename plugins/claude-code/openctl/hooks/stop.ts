#!/usr/bin/env bun
import { loadConfig, readStdinInput } from "../lib/config";
import {
  fetchPendingFeedbackByClaudeSession,
  markFeedbackDelivered,
  type PendingFeedback,
} from "../lib/api";

interface StopHookResponse {
  decision: "block";
  reason: string;
}

const TIMEOUT_MS = 3000; // 3 second timeout

async function main(): Promise<void> {
  // Read stdin first (before checking config) to get Claude session ID
  const stdinInput = await readStdinInput();
  if (!stdinInput?.session_id) {
    // No session ID from Claude Code - allow Claude to stop
    process.exit(0);
  }

  const config = loadConfig();

  // Not an Archive session (no env vars set) - allow Claude to stop
  if (!config) {
    process.exit(0);
  }

  try {
    // Fetch with timeout using the Claude session ID from stdin
    const response = await Promise.race([
      fetchPendingFeedbackByClaudeSession(config.serverUrl, stdinInput.session_id),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), TIMEOUT_MS)
      ),
    ]);

    if (!response.pending || response.messages.length === 0) {
      // No pending feedback - allow Claude to stop
      process.exit(0);
    }

    // Batch all pending messages into a single injection
    const reason = formatBatchedFeedback(response.messages);

    // Mark all as delivered using the Archive session ID from the response
    await Promise.all(
      response.messages.map((m) =>
        markFeedbackDelivered(config.serverUrl, response.session_id, m.id)
      )
    );

    // Block Claude from stopping and inject the feedback
    const output: StopHookResponse = {
      decision: "block",
      reason,
    };

    // Output to stderr for Claude to receive
    console.error(JSON.stringify(output));
    process.exit(2); // Exit code 2 = block
  } catch {
    // Network error, timeout, or server unavailable
    // Allow Claude to stop rather than blocking indefinitely
    process.exit(0);
  }
}

/**
 * Format multiple feedback messages into a single batched message.
 */
function formatBatchedFeedback(messages: PendingFeedback[]): string {
  if (messages.length === 1) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return formatSingleFeedback(messages[0]!);
  }

  const header = `[${messages.length} remote feedback messages]`;
  const formatted = messages.map((m, i) => {
    const num = i + 1;
    return `--- Feedback ${num} ---\n${formatSingleFeedback(m)}`;
  });

  return `${header}\n\n${formatted.join("\n\n")}\n\nPlease address all feedback above.`;
}

/**
 * Format a single feedback message.
 */
function formatSingleFeedback(feedback: PendingFeedback): string {
  if (feedback.type === "diff_comment" && feedback.context) {
    return `[Feedback on ${feedback.context.file}:${feedback.context.line}]

${feedback.content}`;
  }

  if (feedback.type === "suggested_edit" && feedback.context) {
    return `[Suggested edit for ${feedback.context.file}]

${feedback.content}`;
  }

  const source = feedback.source ? ` from ${feedback.source}` : "";
  return `[Remote feedback${source}]

${feedback.content}`;
}

main();
