/**
 * Handles feedback messages from browsers in interactive sessions.
 *
 * When a browser sends feedback (user message, diff comment, or suggested edit),
 * this module:
 * 1. Validates the session is interactive and wrapper is connected
 * 2. Creates a feedback message record in the database
 * 3. Sends the feedback to the wrapper for injection into the PTY
 * 4. Notifies the browser of the queue position
 */

import type { BrowserToServerMessage, ServerToBrowserMessage } from "./websocket-types";
import type { SessionRepository } from "../db/repository";
import { sendToWrapper, isWrapperConnected } from "./wrapper-connections";
import { checkRateLimit } from "./rate-limit";

/**
 * Handle a message from a browser WebSocket connection.
 */
export function handleBrowserMessage(
  sessionId: string,
  msg: BrowserToServerMessage,
  repo: SessionRepository,
  sendToBrowser: (msg: ServerToBrowserMessage) => void
): void {
  switch (msg.type) {
    case "subscribe":
      // Existing: resume from index
      if (typeof msg.from_index === "number") {
        const messages = repo.getMessagesFromIndex(sessionId, msg.from_index);
        if (messages.length > 0) {
          sendToBrowser({
            type: "message",
            messages,
            index: messages[messages.length - 1].message_index,
          });
        }
      }
      break;

    case "ping":
      sendToBrowser({ type: "pong", timestamp: new Date().toISOString() });
      break;

    case "user_message":
      handleUserMessage(sessionId, msg.content, repo, sendToBrowser);
      break;

    case "diff_comment":
      handleDiffComment(sessionId, msg.file, msg.line, msg.content, repo, sendToBrowser);
      break;

    case "suggested_edit":
      handleSuggestedEdit(sessionId, msg.file, msg.old_content, msg.new_content, repo, sendToBrowser);
      break;
  }
}

/**
 * Handle a user message (free-form text feedback).
 */
function handleUserMessage(
  sessionId: string,
  content: string,
  repo: SessionRepository,
  sendToBrowser: (msg: ServerToBrowserMessage) => void
): void {
  const session = repo.getSession(sessionId);

  if (!session?.interactive) {
    sendToBrowser({
      type: "error",
      code: "NOT_INTERACTIVE",
      message: "This session does not accept feedback",
    });
    return;
  }

  if (!isWrapperConnected(sessionId)) {
    sendToBrowser({
      type: "error",
      code: "WRAPPER_DISCONNECTED",
      message: "Session wrapper is not connected",
    });
    return;
  }

  // Check rate limit
  const rateCheck = checkRateLimit(sessionId, "message");
  if (!rateCheck.allowed) {
    sendToBrowser({
      type: "error",
      code: "RATE_LIMITED",
      message: `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.`,
    });
    return;
  }

  // Create feedback message record
  const feedback = repo.createFeedbackMessage(sessionId, content, "message");

  // Get queue position
  const pending = repo.getPendingFeedback(sessionId);
  const position = pending.findIndex((m) => m.id === feedback.id) + 1;

  // Notify browser of queue position
  sendToBrowser({
    type: "feedback_queued",
    message_id: feedback.id,
    position,
  });

  // Send to wrapper for injection
  sendToWrapper(sessionId, {
    type: "inject",
    content,
    message_id: feedback.id,
  });
}

/**
 * Handle a diff comment (feedback on a specific file/line).
 */
function handleDiffComment(
  sessionId: string,
  file: string,
  line: number,
  content: string,
  repo: SessionRepository,
  sendToBrowser: (msg: ServerToBrowserMessage) => void
): void {
  const session = repo.getSession(sessionId);

  if (!session?.interactive || !isWrapperConnected(sessionId)) {
    sendToBrowser({
      type: "error",
      code: "UNAVAILABLE",
      message: "Cannot send feedback to this session",
    });
    return;
  }

  // Check rate limit
  const rateCheck = checkRateLimit(sessionId, "diff_comment");
  if (!rateCheck.allowed) {
    sendToBrowser({
      type: "error",
      code: "RATE_LIMITED",
      message: `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.`,
    });
    return;
  }

  // Format diff comment with context
  const formattedContent = `Feedback on ${file} line ${line}:

Comment: ${content}

Please address this feedback.`;

  const feedback = repo.createFeedbackMessage(sessionId, formattedContent, "diff_comment", undefined, {
    file,
    line,
  });

  const pending = repo.getPendingFeedback(sessionId);
  const position = pending.findIndex((m) => m.id === feedback.id) + 1;

  sendToBrowser({
    type: "feedback_queued",
    message_id: feedback.id,
    position,
  });

  sendToWrapper(sessionId, {
    type: "inject",
    content: formattedContent,
    message_id: feedback.id,
  });
}

/**
 * Handle a suggested edit (proposed code change).
 */
function handleSuggestedEdit(
  sessionId: string,
  file: string,
  oldContent: string,
  newContent: string,
  repo: SessionRepository,
  sendToBrowser: (msg: ServerToBrowserMessage) => void
): void {
  const session = repo.getSession(sessionId);

  if (!session?.interactive || !isWrapperConnected(sessionId)) {
    sendToBrowser({
      type: "error",
      code: "UNAVAILABLE",
      message: "Cannot send feedback to this session",
    });
    return;
  }

  // Check rate limit
  const rateCheck = checkRateLimit(sessionId, "suggested_edit");
  if (!rateCheck.allowed) {
    sendToBrowser({
      type: "error",
      code: "RATE_LIMITED",
      message: `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.`,
    });
    return;
  }

  const formattedContent = `I have a suggested edit for ${file}:

Current code:
\`\`\`
${oldContent}
\`\`\`

Suggested change:
\`\`\`
${newContent}
\`\`\`

Please review and apply this change if appropriate.`;

  const feedback = repo.createFeedbackMessage(sessionId, formattedContent, "suggested_edit", undefined, {
    file,
    line: 0, // Line not applicable for full edits
  });

  const pending = repo.getPendingFeedback(sessionId);
  const position = pending.findIndex((m) => m.id === feedback.id) + 1;

  sendToBrowser({
    type: "feedback_queued",
    message_id: feedback.id,
    position,
  });

  sendToWrapper(sessionId, {
    type: "inject",
    content: formattedContent,
    message_id: feedback.id,
  });
}
