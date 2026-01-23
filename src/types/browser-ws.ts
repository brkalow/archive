/**
 * Browser <-> Server WebSocket Message Types
 *
 * Defines the protocol for browser-initiated sessions where the server
 * acts as a relay between browser WebSockets and daemon WebSockets.
 */

import type { StreamJsonMessage } from "./daemon-ws";

// ============================================
// Browser -> Server Messages
// ============================================

export type BrowserToServerMessage =
  // Existing messages for live session subscriptions
  | { type: "subscribe"; from_index?: number }
  | { type: "ping" }
  // Interactive session messages (plugin-based)
  | { type: "user_message"; content: string; user_id?: string }
  | { type: "diff_comment"; file: string; line: number; content: string }
  | { type: "suggested_edit"; file: string; old_content: string; new_content: string }
  // Spawned session messages (browser-initiated)
  | { type: "interrupt" }
  | { type: "end_session" }
  | { type: "question_response"; tool_use_id: string; answer: string }
  | { type: "permission_response"; request_id: string; allow: boolean }
  // Control request response (SDK format)
  | {
      type: "control_response";
      request_id: string;
      allow: boolean;
      message?: string; // Required when deny
      updatedInput?: Record<string, unknown>; // Optional on allow
    };

// ============================================
// Server -> Browser Messages
// ============================================

export type ServerToBrowserMessage =
  // Connection and state messages
  | {
      type: "connected";
      session_id: string;
      status: string;
      message_count: number;
      last_index?: number;
      interactive?: boolean;
      claude_state?: "running" | "waiting" | "unknown";
    }
  // Session output messages
  | { type: "message"; messages: StreamJsonMessage[] }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
      message_index?: number;
    }
  | { type: "diff"; files: Array<{ filename: string; additions: number; deletions: number }> }
  // Session completion
  | { type: "complete"; exit_code?: number; reason?: string; error?: string; final_message_count?: number }
  // Interactive prompts (relayed from daemon)
  | { type: "question_prompt"; tool_use_id: string; question: string; options?: string[] }
  | {
      type: "permission_prompt";
      request_id: string;
      tool: string;
      description: string;
      details: Record<string, unknown>;
    }
  // Control request prompt (SDK format, relayed from daemon)
  | {
      type: "control_request";
      request_id: string;
      tool_name: string;
      tool_use_id: string;
      input: Record<string, unknown>;
      decision_reason?: string;
      blocked_path?: string;
    }
  // Connection status
  | {
      type: "daemon_disconnected";
      session_id: string;
      message: string;
      can_resume?: boolean;
      claude_session_id?: string;
    }
  | { type: "heartbeat"; timestamp: string }
  | { type: "pong"; timestamp: string }
  // Errors
  | { type: "error"; code: string; message: string }
  // Plugin-based interactive session messages
  | { type: "feedback_queued"; message_id: string; position: number }
  | { type: "feedback_status"; message_id: string; status: "approved" | "rejected" | "expired" }
  | { type: "state"; state: "running" | "waiting" }
  | { type: "output"; data: string };
