/**
 * WebSocket message types for interactive sessions.
 *
 * These types define the protocol for:
 * - Browser <-> Server communication
 */

// ============================================================================
// Browser <-> Server Messages
// ============================================================================

/**
 * Messages sent from the browser to the server.
 */
export type BrowserToServerMessage =
  // Existing messages for live session subscriptions
  | { type: "subscribe"; from_index?: number }
  | { type: "ping" }
  // New interactive session messages
  | { type: "user_message"; content: string }
  | { type: "diff_comment"; file: string; line: number; content: string }
  | { type: "suggested_edit"; file: string; old_content: string; new_content: string };

/**
 * Collaboration event types for session sharing.
 */
export type CollaboratorEvent =
  | { type: "collaborator_added"; id: number; email: string; role: string }
  | { type: "collaborator_removed"; id: number; email: string }
  | { type: "collaborator_role_changed"; id: number; email: string; oldRole: string; newRole: string }
  | { type: "visibility_changed"; visibility: "public" | "private" };

/**
 * Messages sent from the server to the browser.
 */
export type ServerToBrowserMessage =
  // Existing live session messages
  | {
      type: "connected";
      session_id: string;
      status: string;
      message_count: number;
      last_index: number;
      interactive: boolean;
      claude_state: "running" | "waiting" | "unknown";
    }
  | { type: "message"; messages: unknown[]; index: number }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
      message_index: number;
    }
  | { type: "diff"; files: Array<{ filename: string; additions: number; deletions: number }> }
  | { type: "complete"; final_message_count: number }
  | { type: "heartbeat"; timestamp: string }
  | { type: "pong"; timestamp: string }
  | { type: "error"; code: string; message: string }
  // Interactive session messages
  | { type: "feedback_queued"; message_id: string; position: number }
  | { type: "feedback_status"; message_id: string; status: "approved" | "rejected" | "expired" }
  | { type: "state"; state: "running" | "waiting" }
  | { type: "output"; data: string }
  // Collaboration events
  | CollaboratorEvent;

