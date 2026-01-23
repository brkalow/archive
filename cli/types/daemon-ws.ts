/**
 * Daemon WebSocket Message Types
 *
 * Defines the message protocol for bidirectional communication between
 * the daemon and server over WebSocket.
 *
 * Keep in sync with src/types/daemon-ws.ts
 */

// ============================================
// Daemon -> Server Messages
// ============================================

export interface DaemonConnectedMessage {
  type: "daemon_connected";
  client_id: string;
  capabilities: {
    can_spawn_sessions: boolean;
    spawnable_harnesses: SpawnableHarnessInfo[];
  };
}

export interface SpawnableHarnessInfo {
  id: string; // "claude-code", "aider", etc.
  name: string; // Human-readable name
  available: boolean; // Is the CLI installed?
  supports_permission_relay: boolean;
  supports_streaming: boolean;
  default_model?: string;
}

export interface SessionOutputMessage {
  type: "session_output";
  session_id: string;
  messages: StreamJsonMessage[];
}

export interface SessionEndedMessage {
  type: "session_ended";
  session_id: string;
  exit_code: number;
  error?: string;
  reason?: "completed" | "user_terminated" | "error" | "timeout";
}

export interface PermissionPromptMessage {
  type: "permission_prompt";
  session_id: string;
  request_id: string;
  tool: string;
  description: string;
  details: Record<string, unknown>;
}

export interface QuestionPromptMessage {
  type: "question_prompt";
  session_id: string;
  tool_use_id: string;
  question: string;
  options?: string[];
}

// ============================================
// Control Request/Response Types (SDK format)
// Using types from @anthropic-ai/claude-agent-sdk
// ============================================

// Import and re-export PermissionResult from the SDK
import type { PermissionResult as SDKPermissionResult } from "@anthropic-ai/claude-agent-sdk";
export type PermissionResult = SDKPermissionResult;

/** Control request from Claude Code (matches SDKControlRequest format) */
export interface ControlRequestMessage {
  type: "control_request";
  session_id: string; // Added by daemon when relaying
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    tool_use_id: string;
    permission_suggestions?: unknown[];
    blocked_path?: string;
    decision_reason?: string;
    agent_id?: string;
  };
}

/** Control response to send back to Claude (matches SDKControlResponse format) */
export interface ControlResponseMessage {
  type: "control_response";
  session_id: string;
  request_id: string;
  response:
    | {
        subtype: "success";
        request_id: string;
        response: PermissionResult;
      }
    | {
        subtype: "error";
        request_id: string;
        error: string;
      };
}

export interface SessionDiffMessage {
  type: "session_diff";
  session_id: string;
  diff: string;
  /** Files modified by the session (for relevance filtering) */
  modified_files: string[];
}

/**
 * Session metadata message sent by daemon after session initialization.
 * Contains metadata extracted from the working directory and Claude's init response.
 *
 * NOTE: This type is duplicated in src/types/daemon-ws.ts - keep them in sync.
 */
export interface SessionMetadataMessage {
  type: "session_metadata";
  session_id: string;
  /** Claude's internal session ID (from init message) */
  agent_session_id?: string;
  /** Git repository HTTPS URL */
  repo_url?: string;
  /** Current git branch name */
  branch?: string;
}

export type DaemonToServerMessage =
  | DaemonConnectedMessage
  | SessionOutputMessage
  | SessionEndedMessage
  | PermissionPromptMessage
  | QuestionPromptMessage
  | SessionDiffMessage
  | SessionMetadataMessage
  | ControlRequestMessage;

// ============================================
// Server -> Daemon Messages
// ============================================

export interface StartSessionMessage {
  type: "start_session";
  session_id: string; // Server-assigned ID
  prompt: string; // Initial prompt
  cwd: string; // Working directory
  harness?: string; // "claude-code" (default), "aider", etc.
  model?: string; // Model to use
  permission_mode?: "relay" | "auto-safe" | "auto";
  resume_session_id?: string; // Harness session ID to resume
}

export interface SendInputMessage {
  type: "send_input";
  session_id: string;
  content: string;
  user_id?: string; // ID of the user who sent this message (for multi-user remote sessions)
}

export interface EndSessionMessage {
  type: "end_session";
  session_id: string;
}

export interface InterruptSessionMessage {
  type: "interrupt_session";
  session_id: string;
}

export interface PermissionResponseMessage {
  type: "permission_response";
  session_id: string;
  request_id: string;
  allow: boolean;
}

export interface QuestionResponseMessage {
  type: "question_response";
  session_id: string;
  tool_use_id: string;
  answer: string;
}

export type ServerToDaemonMessage =
  | StartSessionMessage
  | SendInputMessage
  | EndSessionMessage
  | InterruptSessionMessage
  | PermissionResponseMessage
  | QuestionResponseMessage
  | ControlResponseMessage;

// ============================================
// Stream JSON types (from Claude Code output)
// ============================================

export interface StreamJsonMessage {
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  message?: {
    id?: string;
    role: string;
    content: ContentBlock[];
    model?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  session_id?: string;
  cwd?: string;
  duration_ms?: number;
  is_error?: boolean;
  user_id?: string; // ID of the user who sent this message (for multi-user remote sessions)
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}
