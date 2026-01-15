export interface PendingFeedback {
  id: string;
  content: string;
  type: "message" | "diff_comment" | "suggested_edit";
  source?: string;
  created_at: string;
  context?: {
    file: string;
    line: number;
  };
}

export interface PendingFeedbackResponse {
  pending: boolean;
  messages: PendingFeedback[];
  session_id: string; // Archive session ID
}

/**
 * Fetch pending feedback by Claude session ID.
 * The server looks up the Archive session using the claude_session_id field.
 */
export async function fetchPendingFeedbackByClaudeSession(
  serverUrl: string,
  claudeSessionId: string
): Promise<PendingFeedbackResponse> {
  const url = `${serverUrl}/api/sessions/by-claude-session/${encodeURIComponent(claudeSessionId)}/feedback/pending`;

  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`Failed to fetch feedback: ${response.status} - ${text}`);
  }

  return response.json() as Promise<PendingFeedbackResponse>;
}

/**
 * Mark a feedback message as delivered.
 * Uses the Archive session ID returned from fetchPendingFeedbackByClaudeSession.
 */
export async function markFeedbackDelivered(
  serverUrl: string,
  archiveSessionId: string,
  messageId: string
): Promise<void> {
  const url = `${serverUrl}/api/sessions/${archiveSessionId}/feedback/${messageId}/delivered`;

  await fetch(url, { method: "POST" });
}

export interface MarkInteractiveResponse {
  success: boolean;
  session_id: string;
}

/**
 * Mark a session as interactive (collaborative).
 * This enables the session to receive browser feedback.
 */
export async function markSessionInteractive(
  serverUrl: string,
  claudeSessionId: string
): Promise<MarkInteractiveResponse> {
  const url = `${serverUrl}/api/sessions/by-claude-session/${encodeURIComponent(claudeSessionId)}/interactive`;

  const response = await fetch(url, { method: "POST" });

  if (!response.ok) {
    throw new Error(`Failed to mark session interactive: ${response.status}`);
  }

  return response.json() as Promise<MarkInteractiveResponse>;
}

export interface MarkFinishedResponse {
  success: boolean;
  session_id: string;
}

/**
 * Mark a session as finished/closed.
 * Called when Claude Code session ends.
 */
export async function markSessionFinished(
  serverUrl: string,
  claudeSessionId: string
): Promise<MarkFinishedResponse> {
  const url = `${serverUrl}/api/sessions/by-claude-session/${encodeURIComponent(claudeSessionId)}/finished`;

  const response = await fetch(url, { method: "POST" });

  if (!response.ok) {
    throw new Error(`Failed to mark session finished: ${response.status}`);
  }

  return response.json() as Promise<MarkFinishedResponse>;
}
