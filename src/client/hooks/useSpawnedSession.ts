import { useState, useEffect, useCallback, useRef } from "react";
import type { ContentBlock, StreamJsonMessage } from "../../types/daemon-ws";

/** Interval in ms for polling daemon status when disconnected */
const DAEMON_POLL_INTERVAL_MS = 3000;

export type SessionState =
  | "connecting"
  | "starting"
  | "running"
  | "waiting"
  | "ending"
  | "ended"
  | "failed"
  | "disconnected";

export interface StreamMessage extends StreamJsonMessage {
  [key: string]: unknown;
}

export interface QuestionPrompt {
  toolUseId: string;
  question: string;
  options?: string[];
}

export interface PermissionPrompt {
  requestId: string;
  tool: string;
  description: string;
  details: Record<string, unknown>;
}

export interface ControlRequestPrompt {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  decisionReason?: string;
  blockedPath?: string;
}

export interface ParsedDiff {
  filename: string;
  diff_content: string;
  additions: number;
  deletions: number;
  is_session_relevant: boolean;
}

interface UseSpawnedSessionOptions {
  sessionId: string;
  onMessage?: (messages: StreamMessage[]) => void;
  onStateChange?: (state: SessionState) => void;
  onQuestionPrompt?: (prompt: QuestionPrompt) => void;
  onPermissionPrompt?: (prompt: PermissionPrompt) => void;
  onControlRequest?: (request: ControlRequestPrompt) => void;
}

export function useSpawnedSession({
  sessionId,
  onMessage,
  onStateChange,
  onQuestionPrompt,
  onPermissionPrompt,
  onControlRequest,
}: UseSpawnedSessionOptions) {
  const [state, setState] = useState<SessionState>("connecting");
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<ParsedDiff[]>([]);
  const [canResume, setCanResume] = useState(false);
  const [daemonConnected, setDaemonConnected] = useState(true);
  const [isResuming, setIsResuming] = useState(false);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const daemonPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const messageCountRef = useRef(0);

  // Store callbacks in refs to avoid reconnecting when callbacks change
  const onMessageRef = useRef(onMessage);
  const onStateChangeRef = useRef(onStateChange);
  const onQuestionPromptRef = useRef(onQuestionPrompt);
  const onPermissionPromptRef = useRef(onPermissionPrompt);
  const onControlRequestRef = useRef(onControlRequest);

  useEffect(() => {
    onMessageRef.current = onMessage;
    onStateChangeRef.current = onStateChange;
    onQuestionPromptRef.current = onQuestionPrompt;
    onPermissionPromptRef.current = onPermissionPrompt;
    onControlRequestRef.current = onControlRequest;
  });

  // Update state and notify
  const updateState = useCallback((newState: SessionState) => {
    setState(newState);
    onStateChangeRef.current?.(newState);
  }, []);

  // Handle incoming messages
  const handleMessage = useCallback(
    (data: Record<string, unknown>) => {
      switch (data.type) {
        case "connected":
          // Initial connection info
          reconnectAttemptsRef.current = 0;
          // Capture claude session ID if present
          if (data.claude_session_id && typeof data.claude_session_id === "string") {
            setClaudeSessionId(data.claude_session_id);
          }
          // Set initial state from server status
          if (data.status && typeof data.status === "string") {
            const status = data.status as SessionState;
            // Only update if it's a valid state we recognize
            if (["starting", "running", "waiting", "ending", "ended", "failed", "disconnected"].includes(status)) {
              updateState(status);
            }
          }
          break;

        case "session_init":
          // Claude session initialized - capture the session ID
          if (data.claude_session_id && typeof data.claude_session_id === "string") {
            setClaudeSessionId(data.claude_session_id);
          }
          break;

        case "message":
          // Stream messages from Claude
          if (data.messages && Array.isArray(data.messages)) {
            const newMessages = data.messages as StreamMessage[];
            setMessages((prev) => {
              const updated = [...prev, ...newMessages];
              messageCountRef.current = updated.length;
              return updated;
            });
            onMessageRef.current?.(newMessages);

            // Update state based on message content
            for (const msg of newMessages) {
              if (msg.type === "system" && msg.subtype === "init") {
                updateState("running");
              }
              if (msg.type === "result") {
                updateState("waiting");
              }
              if (msg.type === "assistant") {
                updateState("running");
              }
            }
          }
          break;

        case "complete":
          updateState("ended");
          if (data.error && typeof data.error === "string") {
            setError(data.error);
          }
          break;

        case "question_prompt":
          onQuestionPromptRef.current?.({
            toolUseId: data.tool_use_id as string,
            question: data.question as string,
            options: data.options as string[] | undefined,
          });
          break;

        case "permission_prompt":
          onPermissionPromptRef.current?.({
            requestId: data.request_id as string,
            tool: data.tool as string,
            description: data.description as string,
            details: data.details as Record<string, unknown>,
          });
          break;

        case "control_request":
          onControlRequestRef.current?.({
            requestId: data.request_id as string,
            toolName: data.tool_name as string,
            toolUseId: data.tool_use_id as string,
            input: data.input as Record<string, unknown>,
            decisionReason: data.decision_reason as string | undefined,
            blockedPath: data.blocked_path as string | undefined,
          });
          break;

        case "daemon_disconnected":
          updateState("disconnected");
          setDaemonConnected(false);
          if (data.message && typeof data.message === "string") {
            setError(data.message);
          }
          if (data.can_resume === true) {
            setCanResume(true);
            if (data.claude_session_id && typeof data.claude_session_id === "string") {
              setClaudeSessionId(data.claude_session_id);
            }
          }
          break;

        case "diff_update":
          // Update diffs when daemon sends them
          if (data.diffs && Array.isArray(data.diffs)) {
            setDiffs(data.diffs as ParsedDiff[]);
          }
          break;

        case "session_metadata":
          // Update session metadata (repo_url, branch) from daemon
          if (data.repo_url && typeof data.repo_url === "string") {
            setRepoUrl(data.repo_url);
          }
          if (data.branch && typeof data.branch === "string") {
            setBranch(data.branch);
          }
          break;

        case "heartbeat":
        case "pong":
        case "ping":
          // Ignore keepalive messages
          break;

        case "error":
          console.error("[ws] Server error:", data.message);
          break;

        default:
          console.log("[ws] Unknown message type:", data.type);
      }
    },
    [updateState]
  );

  // Poll daemon status when disconnected
  const startDaemonPolling = useCallback(() => {
    if (daemonPollRef.current) return;

    daemonPollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/daemon/status");
        if (res.ok) {
          const data = await res.json();
          if (data.connected) {
            setDaemonConnected(true);
          }
        }
      } catch (err) {
        // Ignore poll errors
      }
    }, DAEMON_POLL_INTERVAL_MS);
  }, []);

  const stopDaemonPolling = useCallback(() => {
    if (daemonPollRef.current) {
      clearInterval(daemonPollRef.current);
      daemonPollRef.current = null;
    }
  }, []);

  // Resume session after daemon reconnects
  const resumeSession = useCallback(async () => {
    if (!canResume || !daemonConnected || isResuming) {
      return { success: false, error: "Cannot resume session" };
    }

    setIsResuming(true);
    setError(null);

    try {
      const res = await fetch(`/api/sessions/${sessionId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to resume session");
        setIsResuming(false);
        return { success: false, error: data.error };
      }

      // Session is resuming - update state
      // Note: polling is automatically stopped by useEffect when canResume becomes false
      updateState("starting");
      setCanResume(false);
      setIsResuming(false);

      return { success: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to resume session";
      setError(errorMsg);
      setIsResuming(false);
      return { success: false, error: errorMsg };
    }
  }, [sessionId, canResume, daemonConnected, isResuming, updateState]);

  // Start polling when disconnected and can resume
  useEffect(() => {
    if (state === "disconnected" && canResume) {
      startDaemonPolling();
    } else {
      stopDaemonPolling();
    }

    return () => stopDaemonPolling();
  }, [state, canResume, startDaemonPolling, stopDaemonPolling]);

  // Schedule reconnection with exponential backoff
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    const attempt = reconnectAttemptsRef.current;
    if (attempt >= 5) {
      console.log("[ws] Max reconnect attempts reached");
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, attempt), 15000);
    reconnectAttemptsRef.current = attempt + 1;

    reconnectTimeoutRef.current = setTimeout(() => {
      console.log(`[ws] Attempting reconnect (attempt ${attempt + 1})...`);
      connectRef.current();
    }, delay);
  }, []);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/sessions/${sessionId}/ws`
    );

    ws.onopen = () => {
      console.log("[ws] Connected to session", sessionId);
      updateState("starting");
      reconnectAttemptsRef.current = 0;

      // Subscribe from current message count (0 on first connect, >0 on reconnect)
      ws.send(JSON.stringify({ type: "subscribe", from_index: messageCountRef.current }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (err) {
        console.error("[ws] Failed to parse message:", err);
      }
    };

    ws.onclose = (event) => {
      console.log("[ws] Disconnected from session", sessionId);
      // Don't update state or reconnect if this was a clean close or we're already ended/failed
      if (event.code === 1000) {
        return;
      }

      setState((currentState) => {
        if (currentState !== "ended" && currentState !== "failed") {
          updateState("disconnected");
          scheduleReconnect();
        }
        return currentState;
      });
    };

    ws.onerror = (err) => {
      console.error("[ws] WebSocket error:", err);
    };

    wsRef.current = ws;
  }, [sessionId, updateState, handleMessage, scheduleReconnect]);

  // Keep connectRef updated for use in scheduleReconnect
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Send user message
  const sendMessage = useCallback(
    (content: string) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        console.error("[ws] Cannot send, WebSocket not open");
        return false;
      }

      wsRef.current.send(
        JSON.stringify({
          type: "user_message",
          content,
        })
      );

      updateState("running");
      return true;
    },
    [updateState]
  );

  // Send interrupt
  const interrupt = useCallback(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(JSON.stringify({ type: "interrupt" }));
  }, []);

  // Send end session
  const endSession = useCallback(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(JSON.stringify({ type: "end_session" }));
    updateState("ending");
  }, [updateState]);

  // Answer question
  const answerQuestion = useCallback((toolUseId: string, answer: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(
      JSON.stringify({
        type: "question_response",
        tool_use_id: toolUseId,
        answer,
      })
    );
  }, []);

  // Respond to permission
  const respondToPermission = useCallback(
    (requestId: string, allow: boolean) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;

      wsRef.current.send(
        JSON.stringify({
          type: "permission_response",
          request_id: requestId,
          allow,
        })
      );
    },
    []
  );

  // Respond to control request (SDK format)
  const sendControlResponse = useCallback(
    (requestId: string, allow: boolean, message?: string, updatedInput?: Record<string, unknown>) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;

      wsRef.current.send(
        JSON.stringify({
          type: "control_response",
          request_id: requestId,
          allow,
          message: allow ? undefined : (message || "User denied the action"),
          updatedInput: allow ? updatedInput : undefined,
        })
      );
    },
    []
  );

  // Connect on mount
  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close(1000);
    };
  }, [connect]);

  return {
    state,
    messages,
    error,
    claudeSessionId,
    diffs,
    canResume,
    daemonConnected,
    isResuming,
    repoUrl,
    branch,
    sendMessage,
    interrupt,
    endSession,
    answerQuestion,
    respondToPermission,
    sendControlResponse,
    resumeSession,
  };
}
