/**
 * API endpoints for the openctl plugin to retrieve pending feedback.
 *
 * Unlike the WebSocket-based PTY wrapper approach, the plugin polls this
 * endpoint when Claude's Stop hook fires.
 */

import type { SessionRepository } from "../db/repository";

// Generate SQLite-compatible UTC timestamp (YYYY-MM-DD HH:MM:SS)
function sqliteDatetimeNow(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export interface PendingFeedbackResponse {
  pending: boolean;
  messages: Array<{
    id: string;
    content: string;
    type: string;
    source?: string;
    created_at: string;
    context?: {
      file: string;
      line: number;
    };
  }>;
  session_id: string;
}

/**
 * GET /api/sessions/:id/feedback/pending
 *
 * Returns pending feedback messages for a session.
 * Used by the Stop hook to check if there's feedback to inject.
 */
export function handleGetPendingFeedback(
  sessionId: string,
  repo: SessionRepository
): Response {
  const session = repo.getSession(sessionId);

  if (!session) {
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get pending (undelivered) feedback messages
  const pending = repo.getPendingFeedback(sessionId);

  const response: PendingFeedbackResponse = {
    pending: pending.length > 0,
    messages: pending.map((m) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      source: m.source ?? undefined,
      created_at: m.created_at,
      context: m.context,
    })),
    session_id: sessionId,
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * POST /api/sessions/:id/feedback/:messageId/delivered
 *
 * Mark a feedback message as delivered.
 * Called by the Stop hook after successfully injecting feedback.
 */
export function handleMarkFeedbackDelivered(
  sessionId: string,
  messageId: string,
  repo: SessionRepository
): Response {
  const session = repo.getSession(sessionId);

  if (!session) {
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Update feedback status to delivered
  repo.updateFeedbackStatus(messageId, "delivered");

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /api/sessions/by-claude-session/:claudeSessionId/feedback/pending
 *
 * Returns pending feedback messages for a session, looking up by Claude session ID.
 * This allows the plugin to find the openctl session without needing the openctl
 * session ID to be set as an environment variable.
 */
export function handleGetPendingFeedbackByClaudeSession(
  claudeSessionId: string,
  repo: SessionRepository
): Response {
  console.log(`[feedback] Looking up session by claude_session_id=${claudeSessionId}`);

  // Look up session by Claude session ID
  const session = repo.getSessionByClaudeSessionId(claudeSessionId);

  if (!session) {
    console.log(`[feedback] Session not found for claude_session_id=${claudeSessionId}`);
    return new Response(
      JSON.stringify({ error: "Session not found for claude_session_id" }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  console.log(`[feedback] Found session: id=${session.id}, interactive=${session.interactive}`);

  // Get pending (undelivered) feedback messages
  const pending = repo.getPendingFeedback(session.id);
  console.log(`[feedback] Found ${pending.length} pending feedback messages`);

  const response: PendingFeedbackResponse = {
    pending: pending.length > 0,
    messages: pending.map((m) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      source: m.source ?? undefined,
      created_at: m.created_at,
      context: m.context,
    })),
    session_id: session.id, // Return openctl session ID for marking delivered
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * POST /api/sessions/by-claude-session/:claudeSessionId/interactive
 *
 * Mark a session as interactive (accepts browser feedback).
 * If no session exists with this claude_session_id, creates one.
 * Called by the UserPromptSubmit hook when /collaborate is run.
 */
export function handleMarkSessionInteractive(
  claudeSessionId: string,
  repo: SessionRepository
): Response {
  console.log(`[interactive] Marking session interactive: claude_session_id=${claudeSessionId}`);

  // Look up session by Claude session ID
  let session = repo.getSessionByClaudeSessionId(claudeSessionId);

  if (!session) {
    // No session exists - create one on-demand
    console.log(`[interactive] Session not found, creating new session for claude_session_id=${claudeSessionId}`);

    const id = generateSessionId();

    session = repo.createSession({
      id,
      title: "Interactive Session",
      description: null,
      claude_session_id: claudeSessionId,
      agent_session_id: claudeSessionId,
      pr_url: null,
      share_token: null,
      project_path: null,
      model: null,
      harness: "claude-code",
      repo_url: null,
      branch: null,
      status: "live",
      last_activity_at: sqliteDatetimeNow(),
      interactive: true,
      remote: false,
    });

    console.log(`[interactive] Created new session: id=${session.id}`);
  } else {
    console.log(`[interactive] Found session: id=${session.id}, current interactive=${session.interactive}`);

    // Mark session as interactive
    repo.setSessionInteractive(session.id, true);

    console.log(`[interactive] Session marked interactive: id=${session.id}`);
  }

  return new Response(
    JSON.stringify({ success: true, session_id: session.id }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Generate a unique session ID.
 */
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = crypto.randomUUID().replace(/-/g, "").substring(0, 8);
  return `sess_${timestamp}_${randomPart}`;
}

/**
 * POST /api/sessions/by-claude-session/:claudeSessionId/finished
 *
 * Mark a session as finished/closed.
 * Called by the SessionEnd hook when Claude Code exits.
 */
export function handleMarkSessionFinished(
  claudeSessionId: string,
  repo: SessionRepository
): Response {
  console.log(`[session-end] Marking session finished: claude_session_id=${claudeSessionId}`);

  // Look up session by Claude session ID
  const session = repo.getSessionByClaudeSessionId(claudeSessionId);

  if (!session) {
    console.log(`[session-end] Session not found for claude_session_id=${claudeSessionId}`);
    return new Response(
      JSON.stringify({ error: "Session not found for claude_session_id" }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  console.log(`[session-end] Found session: id=${session.id}, status=${session.status}`);

  // Mark session as complete and disable interactive mode
  repo.updateSession(session.id, { status: "complete" });
  repo.setSessionInteractive(session.id, false);

  console.log(`[session-end] Session marked finished: id=${session.id}`);

  return new Response(
    JSON.stringify({ success: true, session_id: session.id }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
