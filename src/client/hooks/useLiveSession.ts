import { useRef, useState, useEffect, useCallback } from "react";
import type { Message } from "../../db/schema";
import { LiveSessionManager } from "../liveSession";

export interface UseLiveSessionOptions {
  sessionId: string;
  enabled: boolean;
  initialMessages: Message[];
  onComplete?: () => void;
  onConnectionChange?: (connected: boolean) => void;
  onDiffUpdate?: () => void;
  onInteractiveInfo?: (interactive: boolean, claudeState: string) => void;
  onClaudeState?: (state: "running" | "waiting") => void;
  onFeedbackQueued?: (messageId: string, position: number) => void;
  onFeedbackStatus?: (messageId: string, status: string) => void;
}

export interface UseLiveSessionResult {
  messages: Message[];
  isConnected: boolean;
  pendingToolCalls: Set<string>;
  isInteractive: boolean;
  claudeState: "running" | "waiting" | "unknown";
  sendFeedback: (content: string) => void;
}

/**
 * React hook that wraps LiveSessionManager for WebSocket support.
 * Manages connection lifecycle, message state, and pending tool calls.
 */
export function useLiveSession(options: UseLiveSessionOptions): UseLiveSessionResult {
  const {
    sessionId,
    enabled,
    initialMessages,
    onComplete,
    onConnectionChange,
    onDiffUpdate,
    onInteractiveInfo,
    onClaudeState,
    onFeedbackQueued,
    onFeedbackStatus,
  } = options;

  // Use ref for manager to avoid re-creating on re-render
  const managerRef = useRef<LiveSessionManager | null>(null);

  // Store callbacks in refs to avoid reconnecting WebSocket when callbacks change
  const onCompleteRef = useRef(onComplete);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const onDiffUpdateRef = useRef(onDiffUpdate);
  const onInteractiveInfoRef = useRef(onInteractiveInfo);
  const onClaudeStateRef = useRef(onClaudeState);
  const onFeedbackQueuedRef = useRef(onFeedbackQueued);
  const onFeedbackStatusRef = useRef(onFeedbackStatus);

  // Keep refs up to date with latest callback values
  useEffect(() => {
    onCompleteRef.current = onComplete;
    onConnectionChangeRef.current = onConnectionChange;
    onDiffUpdateRef.current = onDiffUpdate;
    onInteractiveInfoRef.current = onInteractiveInfo;
    onClaudeStateRef.current = onClaudeState;
    onFeedbackQueuedRef.current = onFeedbackQueued;
    onFeedbackStatusRef.current = onFeedbackStatus;
  });

  // Reactive state
  const [messages, setMessages] = useState<Message[]>(() => initialMessages);
  const [isConnected, setIsConnected] = useState(false);
  const [pendingToolCalls, setPendingToolCalls] = useState<Set<string>>(() => new Set());
  const [isInteractive, setIsInteractive] = useState(false);
  const [claudeState, setClaudeState] = useState<"running" | "waiting" | "unknown">("unknown");

  // Stable sendFeedback reference
  const sendFeedback = useCallback((content: string) => {
    managerRef.current?.sendFeedback(content);
  }, []);

  // Connection lifecycle
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const manager = new LiveSessionManager(sessionId, {
      onMessage: (newMessages: Message[], _index: number) => {
        // Append new messages using functional setState
        setMessages((prev) => [...prev, ...newMessages]);

        // Track pending tool calls - add tool_use ids
        for (const message of newMessages) {
          if (message.role === "assistant" && message.content_blocks) {
            for (const block of message.content_blocks) {
              if (block.type === "tool_use") {
                setPendingToolCalls((prev) => {
                  const next = new Set(prev);
                  next.add(block.id);
                  return next;
                });
              }
            }
          }
        }
      },

      onToolResult: (result) => {
        // Remove tool_use_id from pending set
        setPendingToolCalls((prev) => {
          if (!prev.has(result.tool_use_id)) {
            return prev; // No change needed
          }
          const next = new Set(prev);
          next.delete(result.tool_use_id);
          return next;
        });
      },

      onDiff: (_files) => {
        onDiffUpdateRef.current?.();
      },

      onComplete: () => {
        onCompleteRef.current?.();
      },

      onConnectionChange: (connected: boolean) => {
        setIsConnected(connected);
        onConnectionChangeRef.current?.(connected);
      },

      onInteractiveInfo: (interactive: boolean, state: "running" | "waiting" | "unknown") => {
        setIsInteractive(interactive);
        setClaudeState(state);
        onInteractiveInfoRef.current?.(interactive, state);
      },

      onClaudeState: (state: "running" | "waiting") => {
        setClaudeState(state);
        onClaudeStateRef.current?.(state);
      },

      onFeedbackQueued: (messageId: string, position: number) => {
        onFeedbackQueuedRef.current?.(messageId, position);
      },

      onFeedbackStatus: (messageId: string, status: "approved" | "rejected" | "expired") => {
        onFeedbackStatusRef.current?.(messageId, status);
      },
    });

    managerRef.current = manager;
    manager.connect();

    // Cleanup on unmount or when disabled
    return () => {
      manager.destroy();
      managerRef.current = null;
    };
  }, [sessionId, enabled]);

  return {
    messages,
    isConnected,
    pendingToolCalls,
    isInteractive,
    claudeState,
    sendFeedback,
  };
}
