// Live session WebSocket manager
import type { Message } from "../db/schema";

// WebSocket message types from server
type ServerMessage =
  | { type: "connected"; session_id: string; status: string; message_count: number; last_index: number; interactive: boolean; wrapper_connected: boolean; claude_state: "running" | "waiting" | "unknown" }
  | { type: "message"; messages: Message[]; index: number }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; message_index: number }
  | { type: "diff"; files: Array<{ filename: string; additions: number; deletions: number }> }
  | { type: "complete"; final_message_count: number }
  | { type: "heartbeat"; timestamp: string }
  | { type: "pong"; timestamp: string }
  | { type: "error"; code: string; message: string }
  // Interactive session messages
  | { type: "feedback_queued"; message_id: string; position: number }
  | { type: "feedback_status"; message_id: string; status: "approved" | "rejected" | "expired" }
  | { type: "wrapper_status"; connected: boolean }
  | { type: "state"; state: "running" | "waiting" }
  | { type: "output"; data: string };

// Client-to-server message types
type ClientMessage =
  | { type: "subscribe"; from_index?: number }
  | { type: "ping" }
  | { type: "user_message"; content: string }
  | { type: "diff_comment"; file: string; line: number; content: string }
  | { type: "suggested_edit"; file: string; old_content: string; new_content: string };

export interface LiveSessionCallbacks {
  onMessage: (messages: Message[], index: number) => void;
  onToolResult: (result: { tool_use_id: string; content: string; is_error?: boolean; message_index: number }) => void;
  onDiff: (files: Array<{ filename: string; additions: number; deletions: number }>) => void;
  onComplete: () => void;
  onConnectionChange: (connected: boolean) => void;
  onReconnectAttempt?: (attempt: number, maxAttempts: number) => void;
  onReconnectFailed?: () => void;
  // Interactive session callbacks
  onFeedbackQueued?: (messageId: string, position: number) => void;
  onFeedbackStatus?: (messageId: string, status: "approved" | "rejected" | "expired") => void;
  onWrapperStatus?: (connected: boolean) => void;
  onClaudeState?: (state: "running" | "waiting") => void;
  onOutput?: (data: string) => void;
  onInteractiveInfo?: (interactive: boolean, wrapperConnected: boolean, claudeState: "running" | "waiting" | "unknown") => void;
}

export class LiveSessionManager {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private callbacks: LiveSessionCallbacks;
  private lastIndex = -1;
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_DELAY_MS = 1000;
  private static readonly MAX_RECONNECT_DELAY_MS = 15000;
  private static readonly PING_INTERVAL_MS = 30000;

  constructor(sessionId: string, callbacks: LiveSessionCallbacks) {
    this.sessionId = sessionId;
    this.callbacks = callbacks;
  }

  connect(): void {
    if (this.destroyed) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/api/sessions/${this.sessionId}/ws`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.callbacks.onConnectionChange(true);

      // Resume from last index if reconnecting
      if (this.lastIndex >= 0) {
        this.send({ type: "subscribe", from_index: this.lastIndex + 1 });
      }

      // Start ping interval
      this.startPingInterval();
    };

    this.ws.onmessage = (event) => {
      try {
        const data: ServerMessage = JSON.parse(event.data);
        this.handleMessage(data);
      } catch {
        // Invalid message, ignore
      }
    };

    this.ws.onclose = (event) => {
      this.stopPingInterval();
      this.callbacks.onConnectionChange(false);

      // Reconnect unless:
      // - Normal close (1000)
      // - Destroyed
      if (!this.destroyed && event.code !== 1000) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.callbacks.onConnectionChange(false);
    };
  }

  private handleMessage(data: ServerMessage): void {
    switch (data.type) {
      case "connected":
        this.lastIndex = data.last_index;
        // Notify about interactive session info including claude state
        this.callbacks.onInteractiveInfo?.(data.interactive, data.wrapper_connected, data.claude_state);
        break;

      case "message":
        this.lastIndex = data.index;
        this.callbacks.onMessage(data.messages, data.index);
        break;

      case "tool_result":
        this.callbacks.onToolResult({
          tool_use_id: data.tool_use_id,
          content: data.content,
          is_error: data.is_error,
          message_index: data.message_index,
        });
        break;

      case "diff":
        this.callbacks.onDiff(data.files);
        break;

      case "complete":
        this.callbacks.onComplete();
        this.disconnect();
        break;

      case "heartbeat":
      case "pong":
        // Keep-alive, no action needed
        break;

      case "error":
        console.error("WebSocket error:", data.message);
        break;

      // Interactive session message handlers
      case "feedback_queued":
        this.callbacks.onFeedbackQueued?.(data.message_id, data.position);
        break;

      case "feedback_status":
        this.callbacks.onFeedbackStatus?.(data.message_id, data.status);
        break;

      case "wrapper_status":
        this.callbacks.onWrapperStatus?.(data.connected);
        break;

      case "state":
        this.callbacks.onClaudeState?.(data.state);
        break;

      case "output":
        this.callbacks.onOutput?.(data.data);
        break;
    }
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  // Send feedback to the session (interactive sessions only)
  sendFeedback(content: string): void {
    this.send({ type: "user_message", content });
  }

  // Send diff comment feedback
  sendDiffComment(file: string, line: number, content: string): void {
    this.send({ type: "diff_comment", file, line, content });
  }

  // Send suggested edit feedback
  sendSuggestedEdit(file: string, oldContent: string, newContent: string): void {
    this.send({ type: "suggested_edit", file, old_content: oldContent, new_content: newContent });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;

    // Notify about reconnection attempt
    this.callbacks.onReconnectAttempt?.(this.reconnectAttempts, LiveSessionManager.MAX_RECONNECT_ATTEMPTS);

    // Check if we've exhausted attempts
    if (this.reconnectAttempts >= LiveSessionManager.MAX_RECONNECT_ATTEMPTS) {
      this.callbacks.onReconnectFailed?.();
      return;
    }

    const delay = LiveSessionManager.RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1);
    const cappedDelay = Math.min(delay, LiveSessionManager.MAX_RECONNECT_DELAY_MS);

    this.reconnectTimeout = setTimeout(() => {
      if (!this.destroyed) {
        this.connect();
      }
    }, cappedDelay);
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      this.send({ type: "ping" });
    }, LiveSessionManager.PING_INTERVAL_MS);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  disconnect(): void {
    this.stopPingInterval();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.disconnect();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// UI state for live sessions
export interface LiveSessionState {
  isLive: boolean;
  isConnected: boolean;
  pendingToolCalls: Set<string>;
  lastMessageIndex: number;
  // Interactive session state
  isInteractive: boolean;
  wrapperConnected: boolean;
  claudeState: "running" | "waiting" | "unknown";
  pendingFeedback: Map<string, { position: number; status: "pending" | "approved" | "rejected" }>;
}

// Helper to check if user is near bottom of scroll container
export function isNearBottom(container: HTMLElement, threshold = 100): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}

// Smooth scroll to bottom
export function scrollToBottom(container: HTMLElement): void {
  container.scrollTo({
    top: container.scrollHeight,
    behavior: "smooth",
  });
}

// Format duration for live sessions
export function formatDuration(createdAt: string): string {
  const started = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - started.getTime();
  const minutes = Math.floor(diffMs / 60000);

  if (minutes < 1) return "started just now";
  if (minutes === 1) return "started 1m ago";
  if (minutes < 60) return `started ${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "started 1h ago";
  return `started ${hours}h ago`;
}
