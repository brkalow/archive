# Phase 5: Browser UI - Session Interaction

> **Spec reference:** [specs/browser_initiated_sessions.md](../specs/browser_initiated_sessions.md)

## Overview

This plan implements the browser UI for interacting with active spawned sessions: the enhanced session view with state-aware input, interrupt/end buttons, and real-time message display.

## Dependencies

- **Phase 3:** Server Relay Layer (WebSocket protocol)
- **Phase 4:** Browser UI - Session Initiation

## Tasks

### 1. Create useSpawnedSession Hook

React hook for managing WebSocket connection to spawned session.

**File:** `src/client/hooks/useSpawnedSession.ts`

```typescript
import { useState, useEffect, useCallback, useRef } from "react";

export type SessionState =
  | "connecting"
  | "starting"
  | "running"
  | "waiting"
  | "ending"
  | "ended"
  | "failed"
  | "disconnected";

export interface StreamMessage {
  type: string;
  message?: {
    role: string;
    content: ContentBlock[];
  };
  [key: string]: unknown;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface UseSpawnedSessionOptions {
  sessionId: string;
  onMessage?: (messages: StreamMessage[]) => void;
  onStateChange?: (state: SessionState) => void;
  onQuestionPrompt?: (prompt: QuestionPrompt) => void;
  onPermissionPrompt?: (prompt: PermissionPrompt) => void;
}

interface QuestionPrompt {
  toolUseId: string;
  question: string;
  options?: string[];
}

interface PermissionPrompt {
  requestId: string;
  tool: string;
  description: string;
  details: Record<string, unknown>;
}

export function useSpawnedSession({
  sessionId,
  onMessage,
  onStateChange,
  onQuestionPrompt,
  onPermissionPrompt,
}: UseSpawnedSessionOptions) {
  const [state, setState] = useState<SessionState>("connecting");
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Update state and notify
  const updateState = useCallback((newState: SessionState) => {
    setState(newState);
    onStateChange?.(newState);
  }, [onStateChange]);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/sessions/${sessionId}/ws`);

    ws.onopen = () => {
      console.log("[ws] Connected to session", sessionId);
      updateState("starting");

      // Subscribe from beginning
      ws.send(JSON.stringify({ type: "subscribe", from_index: 0 }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (err) {
        console.error("[ws] Failed to parse message:", err);
      }
    };

    ws.onclose = () => {
      console.log("[ws] Disconnected from session", sessionId);
      if (state !== "ended" && state !== "failed") {
        updateState("disconnected");
        scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      console.error("[ws] WebSocket error:", err);
    };

    wsRef.current = ws;
  }, [sessionId, state, updateState]);

  // Handle incoming messages
  const handleMessage = useCallback((data: any) => {
    switch (data.type) {
      case "connected":
        // Initial connection info
        break;

      case "message":
        // Stream messages from Claude
        if (data.messages) {
          setMessages((prev) => [...prev, ...data.messages]);
          onMessage?.(data.messages);

          // Update state based on message content
          for (const msg of data.messages) {
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
        if (data.error) {
          setError(data.error);
        }
        break;

      case "question_prompt":
        onQuestionPrompt?.({
          toolUseId: data.tool_use_id,
          question: data.question,
          options: data.options,
        });
        break;

      case "permission_prompt":
        onPermissionPrompt?.({
          requestId: data.request_id,
          tool: data.tool,
          description: data.description,
          details: data.details,
        });
        break;

      case "daemon_disconnected":
        updateState("disconnected");
        setError(data.message);
        break;

      case "heartbeat":
        // Ignore heartbeats
        break;

      default:
        console.log("[ws] Unknown message type:", data.type);
    }
  }, [onMessage, onQuestionPrompt, onPermissionPrompt, updateState]);

  // Schedule reconnection
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    reconnectTimeoutRef.current = setTimeout(() => {
      console.log("[ws] Attempting reconnect...");
      connect();
    }, 2000);
  }, [connect]);

  // Send user message
  const sendMessage = useCallback((content: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      console.error("[ws] Cannot send, WebSocket not open");
      return false;
    }

    wsRef.current.send(JSON.stringify({
      type: "user_message",
      content,
    }));

    updateState("running");
    return true;
  }, [updateState]);

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

    wsRef.current.send(JSON.stringify({
      type: "question_response",
      tool_use_id: toolUseId,
      answer,
    }));
  }, []);

  // Respond to permission
  const respondToPermission = useCallback((requestId: string, allow: boolean) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(JSON.stringify({
      type: "permission_response",
      request_id: requestId,
      allow,
    }));
  }, []);

  // Connect on mount
  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  return {
    state,
    messages,
    error,
    sendMessage,
    interrupt,
    endSession,
    answerQuestion,
    respondToPermission,
  };
}
```

### 2. Create SessionInput Component

State-aware input field with message queueing.

**File:** `src/client/components/SessionInput.tsx`

```typescript
import { useState, useCallback, useRef, useEffect } from "react";
import type { SessionState } from "../hooks/useSpawnedSession";

interface SessionInputProps {
  state: SessionState;
  onSend: (content: string) => boolean;
  className?: string;
}

export function SessionInput({ state, onSend, className }: SessionInputProps) {
  const [value, setValue] = useState("");
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Determine input state
  const isDisabled = state === "starting" || state === "ending" || state === "ended";
  const isQueued = state === "running" && queuedMessage !== null;

  const placeholder = (() => {
    switch (state) {
      case "starting":
        return "Starting session...";
      case "running":
        return queuedMessage ? "Message queued..." : "Type your message... (queued until Claude finishes)";
      case "waiting":
        return "Type your message...";
      case "ending":
        return "Session ending...";
      case "ended":
        return "Session ended";
      case "disconnected":
        return "Reconnecting...";
      default:
        return "Type your message...";
    }
  })();

  // Handle submit
  const handleSubmit = useCallback(() => {
    const content = value.trim();
    if (!content) return;

    if (state === "waiting") {
      // Send immediately
      const sent = onSend(content);
      if (sent) {
        setValue("");
      }
    } else if (state === "running") {
      // Queue the message
      if (queuedMessage) {
        // Already have a queued message - warn or concat
        // For now, just replace
        setQueuedMessage(content);
      } else {
        setQueuedMessage(content);
      }
      setValue("");
    }
  }, [value, state, onSend, queuedMessage]);

  // Send queued message when state changes to waiting
  useEffect(() => {
    if (state === "waiting" && queuedMessage) {
      const sent = onSend(queuedMessage);
      if (sent) {
        setQueuedMessage(null);
      }
    }
  }, [state, queuedMessage, onSend]);

  // Keyboard shortcut to focus input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "i") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  if (state === "ended") {
    return null;
  }

  return (
    <div className={`border-t border-gray-800 p-4 ${className || ""}`}>
      <div className="flex gap-2">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          placeholder={placeholder}
          rows={1}
          className="flex-1 px-4 py-2 bg-gray-800 border border-gray-700 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <button
          onClick={handleSubmit}
          disabled={isDisabled || !value.trim()}
          className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-md"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </button>
      </div>

      {/* Queued message indicator */}
      {queuedMessage && (
        <div className="mt-2 text-sm text-gray-500 flex items-center gap-2">
          <svg className="w-4 h-4 animate-pulse" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
          </svg>
          1 message queued - Will send when Claude finishes
          <button
            onClick={() => setQueuedMessage(null)}
            className="text-gray-400 hover:text-white"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
```

### 3. Create SessionHeader Component

Header with state indicator and control buttons.

**File:** `src/client/components/SessionHeader.tsx`

```typescript
import { useState } from "react";
import type { SessionState } from "../hooks/useSpawnedSession";

interface SessionHeaderProps {
  title: string;
  state: SessionState;
  harness: string;
  model?: string;
  cwd: string;
  duration: string;
  onInterrupt: () => void;
  onEndSession: () => void;
}

export function SessionHeader({
  title,
  state,
  harness,
  model,
  cwd,
  duration,
  onInterrupt,
  onEndSession,
}: SessionHeaderProps) {
  const [showEndConfirm, setShowEndConfirm] = useState(false);

  // State indicator styling
  const getStateIndicator = () => {
    switch (state) {
      case "starting":
        return { color: "bg-orange-500", pulse: true, label: "Starting" };
      case "running":
        return { color: "bg-cyan-500", pulse: true, label: "Running" };
      case "waiting":
        return { color: "bg-green-500", pulse: false, label: "Waiting" };
      case "ending":
        return { color: "bg-gray-500", pulse: false, label: "Ending" };
      case "ended":
        return { color: "bg-gray-600", pulse: false, label: "Ended" };
      case "disconnected":
        return { color: "bg-yellow-500", pulse: true, label: "Reconnecting" };
      default:
        return { color: "bg-gray-500", pulse: false, label: "" };
    }
  };

  const indicator = getStateIndicator();
  const isActive = state !== "ended" && state !== "ending";
  const canInterrupt = state === "running";

  const handleEndClick = () => {
    if (state === "running") {
      setShowEndConfirm(true);
    } else {
      onEndSession();
    }
  };

  return (
    <div className="border-b border-gray-800 bg-gray-900">
      <div className="px-4 py-3">
        {/* Top row: Title and actions */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            {/* State indicator */}
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${indicator.color} ${indicator.pulse ? "animate-pulse" : ""}`}
              />
              <span className="text-xs font-medium text-gray-400 uppercase">
                {state === "ended" ? "Ended" : "Live"}
              </span>
              {state === "running" && (
                <span className="text-xs text-cyan-400">
                  {indicator.label}
                </span>
              )}
            </div>

            {/* Title */}
            <h1 className="text-lg font-semibold text-white">
              {title}
            </h1>

            {/* Remote badge */}
            <span className="px-2 py-0.5 bg-purple-900/50 text-purple-300 text-xs rounded">
              Remote
            </span>
          </div>

          {/* Action buttons */}
          {isActive && (
            <div className="flex items-center gap-2">
              {canInterrupt && (
                <button
                  onClick={onInterrupt}
                  className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 text-white text-sm rounded-md"
                >
                  Interrupt
                </button>
              )}
              <button
                onClick={handleEndClick}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-sm rounded-md"
              >
                End
              </button>
            </div>
          )}
        </div>

        {/* Bottom row: Metadata */}
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <span>{harness}</span>
          <span>.</span>
          {model && (
            <>
              <span>{model}</span>
              <span>.</span>
            </>
          )}
          <span className="font-mono">{cwd}</span>
          <span>.</span>
          <span>{duration}</span>
        </div>
      </div>

      {/* End confirmation dialog */}
      {showEndConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-md mx-4">
            <h3 className="text-lg font-semibold text-white mb-2">
              End Session?
            </h3>
            <p className="text-gray-400 mb-4">
              Claude is still working on your request. Are you sure you want to
              end this session?
            </p>
            <p className="text-gray-500 text-sm mb-4">
              The session will be saved and you can review it later.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowEndConfirm(false)}
                className="px-4 py-2 text-gray-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowEndConfirm(false);
                  onEndSession();
                }}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-md"
              >
                End Session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

### 4. Create SpawnedSessionView Component

Main view component for spawned sessions.

**File:** `src/client/components/SpawnedSessionView.tsx`

```typescript
import { useState, useCallback } from "react";
import { useSpawnedSession } from "../hooks/useSpawnedSession";
import { SessionHeader } from "./SessionHeader";
import { SessionInput } from "./SessionInput";
import { MessageList } from "./MessageList"; // Existing component
import { QuestionModal } from "./QuestionModal";
import { PermissionModal } from "./PermissionModal";
import { ConnectionLostBanner } from "./ConnectionLostBanner";

interface SpawnedSessionViewProps {
  sessionId: string;
  cwd: string;
  harness: string;
  model?: string;
}

export function SpawnedSessionView({
  sessionId,
  cwd,
  harness,
  model,
}: SpawnedSessionViewProps) {
  const [title, setTitle] = useState("New Session");
  const [startTime] = useState(new Date());
  const [questionPrompt, setQuestionPrompt] = useState<{
    toolUseId: string;
    question: string;
    options?: string[];
  } | null>(null);
  const [permissionPrompt, setPermissionPrompt] = useState<{
    requestId: string;
    tool: string;
    description: string;
    details: Record<string, unknown>;
  } | null>(null);

  const {
    state,
    messages,
    error,
    sendMessage,
    interrupt,
    endSession,
    answerQuestion,
    respondToPermission,
  } = useSpawnedSession({
    sessionId,
    onQuestionPrompt: setQuestionPrompt,
    onPermissionPrompt: setPermissionPrompt,
  });

  // Calculate duration
  const duration = formatDuration(Date.now() - startTime.getTime());

  // Derive title from first user message
  const firstUserMessage = messages.find(
    (m) => m.type === "user" || (m.message?.role === "user")
  );
  if (firstUserMessage && title === "New Session") {
    const content = firstUserMessage.message?.content;
    if (Array.isArray(content)) {
      const textBlock = content.find((b: any) => b.type === "text");
      if (textBlock?.text) {
        setTitle(textBlock.text.slice(0, 50) + (textBlock.text.length > 50 ? "..." : ""));
      }
    }
  }

  // Handle question answer
  const handleQuestionAnswer = useCallback((answer: string) => {
    if (questionPrompt) {
      answerQuestion(questionPrompt.toolUseId, answer);
      setQuestionPrompt(null);
    }
  }, [questionPrompt, answerQuestion]);

  // Handle permission response
  const handlePermissionResponse = useCallback((allow: boolean) => {
    if (permissionPrompt) {
      respondToPermission(permissionPrompt.requestId, allow);
      setPermissionPrompt(null);
    }
  }, [permissionPrompt, respondToPermission]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <SessionHeader
        title={title}
        state={state}
        harness={harness}
        model={model}
        cwd={cwd}
        duration={duration}
        onInterrupt={interrupt}
        onEndSession={endSession}
      />

      {/* Connection lost banner */}
      {state === "disconnected" && (
        <ConnectionLostBanner
          sessionId={sessionId}
          onEndSession={endSession}
        />
      )}

      {/* Main content area */}
      <div className="flex-1 overflow-hidden flex">
        {/* Message list */}
        <div className="flex-1 overflow-y-auto">
          <MessageList messages={messages} isLive={state !== "ended"} />

          {/* Working indicator */}
          {state === "running" && (
            <div className="px-4 py-2 text-gray-500 flex items-center gap-2">
              <span className="w-2 h-2 bg-cyan-500 rounded-full animate-pulse" />
              Claude is working...
            </div>
          )}
        </div>

        {/* Diff panel - would be integrated from existing component */}
        {/* <DiffPanel sessionId={sessionId} /> */}
      </div>

      {/* Input area */}
      <SessionInput
        state={state}
        onSend={sendMessage}
      />

      {/* Question modal */}
      {questionPrompt && (
        <QuestionModal
          question={questionPrompt.question}
          options={questionPrompt.options}
          onAnswer={handleQuestionAnswer}
          onClose={() => setQuestionPrompt(null)}
        />
      )}

      {/* Permission modal */}
      {permissionPrompt && (
        <PermissionModal
          tool={permissionPrompt.tool}
          description={permissionPrompt.description}
          details={permissionPrompt.details}
          onAllow={() => handlePermissionResponse(true)}
          onDeny={() => handlePermissionResponse(false)}
        />
      )}

      {/* Error state */}
      {state === "ended" && error && (
        <div className="p-4 bg-red-900/30 border-t border-red-800">
          <p className="text-red-400">Session ended with error: {error}</p>
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}
```

### 5. Create QuestionModal Component

Modal for answering Claude's questions.

**File:** `src/client/components/QuestionModal.tsx`

```typescript
import { useState, useCallback } from "react";

interface QuestionModalProps {
  question: string;
  options?: string[];
  onAnswer: (answer: string) => void;
  onClose: () => void;
}

export function QuestionModal({
  question,
  options,
  onAnswer,
  onClose,
}: QuestionModalProps) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [customAnswer, setCustomAnswer] = useState("");

  const handleSubmit = useCallback(() => {
    const answer = selectedOption || customAnswer.trim();
    if (answer) {
      onAnswer(answer);
    }
  }, [selectedOption, customAnswer, onAnswer]);

  const isSubmitDisabled = !selectedOption && !customAnswer.trim();

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-white">
            Claude is asking
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          {/* Question text */}
          <p className="text-gray-200 mb-4">"{question}"</p>

          {/* Options if provided */}
          {options && options.length > 0 && (
            <div className="space-y-2 mb-4">
              {options.map((option, index) => (
                <label
                  key={index}
                  className="flex items-center gap-3 p-3 bg-gray-800 rounded-md cursor-pointer hover:bg-gray-750 border border-transparent has-[:checked]:border-cyan-500"
                >
                  <input
                    type="radio"
                    name="question-option"
                    value={option}
                    checked={selectedOption === option}
                    onChange={() => {
                      setSelectedOption(option);
                      setCustomAnswer("");
                    }}
                    className="text-cyan-500"
                  />
                  <span className="text-gray-200">{option}</span>
                </label>
              ))}
            </div>
          )}

          {/* Custom answer */}
          <div>
            {options && options.length > 0 && (
              <p className="text-gray-400 text-sm mb-2">Or type a custom response:</p>
            )}
            <textarea
              value={customAnswer}
              onChange={(e) => {
                setCustomAnswer(e.target.value);
                setSelectedOption(null);
              }}
              placeholder="Type your response..."
              rows={3}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex justify-end">
          <button
            onClick={handleSubmit}
            disabled={isSubmitDisabled}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded-md font-medium"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 6. Create ConnectionLostBanner Component

Banner shown when daemon connection is lost.

**File:** `src/client/components/ConnectionLostBanner.tsx`

```typescript
import { useState, useEffect } from "react";

interface ConnectionLostBannerProps {
  sessionId: string;
  onEndSession: () => void;
}

export function ConnectionLostBanner({
  sessionId,
  onEndSession,
}: ConnectionLostBannerProps) {
  const [secondsDisconnected, setSecondsDisconnected] = useState(0);
  const [showExtendedHelp, setShowExtendedHelp] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsDisconnected((s) => s + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Show extended help after 2 minutes
  useEffect(() => {
    if (secondsDisconnected >= 120) {
      setShowExtendedHelp(true);
    }
  }, [secondsDisconnected]);

  if (showExtendedHelp) {
    return (
      <div className="bg-yellow-900/30 border-b border-yellow-800 p-4">
        <div className="flex items-start gap-3">
          <svg className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <div className="flex-1">
            <h3 className="font-medium text-yellow-200">
              Connection lost. Unable to reconnect.
            </h3>
            <p className="text-yellow-300/70 text-sm mt-1 mb-3">
              Your session may still be running on your machine. You can:
            </p>
            <ul className="text-yellow-300/70 text-sm space-y-1 mb-3">
              <li>
                Check daemon status:{" "}
                <code className="bg-yellow-900/50 px-1 rounded">openctl daemon status</code>
              </li>
              <li>
                Resume locally:{" "}
                <code className="bg-yellow-900/50 px-1 rounded">claude --resume {sessionId}</code>
              </li>
            </ul>
            <div className="flex gap-3">
              <button
                onClick={() => window.location.reload()}
                className="px-3 py-1.5 bg-yellow-700 hover:bg-yellow-600 text-white text-sm rounded"
              >
                Retry Connection
              </button>
              <button
                onClick={onEndSession}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded"
              >
                End Session
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-yellow-900/30 border-b border-yellow-800 px-4 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-yellow-200">
          <svg className="w-5 h-5 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <span>Connection to daemon lost</span>
          <span className="text-yellow-300/50">.</span>
          <span className="text-yellow-300/70">Reconnecting...</span>
          <span className="text-yellow-300/50 text-sm">
            ({secondsDisconnected}s)
          </span>
        </div>
        <button
          onClick={onEndSession}
          className="text-sm text-yellow-300 hover:text-white"
        >
          End Session
        </button>
      </div>
    </div>
  );
}
```

### 7. Update Session Detail Page

Integrate spawned session view into the session detail page.

**Note:** The existing codebase has `src/client/components/SessionDetailPage.tsx`, not `src/client/pages/SessionDetailPage.tsx`. Also, there is no `ArchivedSessionView` component - the existing `SessionDetailPage.tsx` handles both live and archived sessions. This task should modify the existing component to also handle spawned sessions.

**File:** `src/client/components/SessionDetailPage.tsx` (modify existing)

```typescript
import { useState, useEffect } from "react";
import { SpawnedSessionView } from "./SpawnedSessionView";
// The existing SessionDetailPage already handles archived/live sessions
// Add logic to detect spawned sessions and render SpawnedSessionView instead

interface SessionInfo {
  id: string;
  type: "spawned" | "archived";
  status?: string;
  cwd?: string;
  harness?: string;
  model?: string;
  // ... other fields
}

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchSessionInfo() {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/info`);
        if (!res.ok) {
          throw new Error("Session not found");
        }
        const data = await res.json();
        setSessionInfo(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    fetchSessionInfo();
  }, [sessionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !sessionInfo) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-white mb-2">
            Session not found
          </h2>
          <p className="text-gray-400">{error}</p>
          <a href="/sessions" className="text-cyan-400 hover:text-cyan-300 mt-4 inline-block">
            Back to sessions
          </a>
        </div>
      </div>
    );
  }

  // Render appropriate view based on session type
  if (sessionInfo.type === "spawned") {
    return (
      <SpawnedSessionView
        sessionId={sessionId}
        cwd={sessionInfo.cwd || ""}
        harness={sessionInfo.harness || "claude-code"}
        model={sessionInfo.model}
      />
    );
  }

  // Existing archived session view
  return <ArchivedSessionView sessionId={sessionId} />;
}
```

## Testing

### Hook Tests

**File:** `tests/client/hooks/useSpawnedSession.test.ts`

```typescript
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSpawnedSession } from "../../../src/client/hooks/useSpawnedSession";

// Mock WebSocket
class MockWebSocket {
  onopen: () => void = () => {};
  onmessage: (event: { data: string }) => void = () => {};
  onclose: () => void = () => {};
  onerror: () => void = () => {};
  send = jest.fn();
  close = jest.fn();
  readyState = WebSocket.OPEN;
}

describe("useSpawnedSession", () => {
  beforeEach(() => {
    (global as any).WebSocket = MockWebSocket;
  });

  test("connects to WebSocket on mount", async () => {
    const { result } = renderHook(() =>
      useSpawnedSession({ sessionId: "test-123" })
    );

    expect(result.current.state).toBe("connecting");
  });

  test("updates state on message", async () => {
    const { result } = renderHook(() =>
      useSpawnedSession({ sessionId: "test-123" })
    );

    // Simulate WebSocket messages
    // ...
  });
});
```

### Component Tests

**File:** `tests/client/components/SessionInput.test.tsx`

```typescript
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionInput } from "../../../src/client/components/SessionInput";

describe("SessionInput", () => {
  test("is disabled when state is starting", () => {
    render(<SessionInput state="starting" onSend={() => true} />);

    const input = screen.getByPlaceholderText(/starting session/i);
    expect(input).toBeDisabled();
  });

  test("shows queued indicator when running", () => {
    const onSend = jest.fn().mockReturnValue(true);
    render(<SessionInput state="running" onSend={onSend} />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Test message" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText(/message queued/i)).toBeInTheDocument();
  });

  test("sends immediately when waiting", () => {
    const onSend = jest.fn().mockReturnValue(true);
    render(<SessionInput state="waiting" onSend={onSend} />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Test message" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("Test message");
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/client/hooks/useSpawnedSession.ts` | Create | WebSocket session hook |
| `src/client/components/SessionInput.tsx` | Create | State-aware input component |
| `src/client/components/SessionHeader.tsx` | Create | Session header with controls |
| `src/client/components/SpawnedSessionView.tsx` | Create | Main spawned session view |
| `src/client/components/QuestionModal.tsx` | Create | AskUserQuestion modal |
| `src/client/components/ConnectionLostBanner.tsx` | Create | Reconnection banner |
| `src/client/pages/SessionDetailPage.tsx` | Modify | Integrate spawned session view |
| `tests/client/hooks/useSpawnedSession.test.ts` | Create | Hook tests |
| `tests/client/components/SessionInput.test.tsx` | Create | Component tests |

## Acceptance Criteria

- [ ] WebSocket connection established to session on mount
- [ ] Messages displayed in real-time as they arrive
- [ ] Session state tracked and displayed correctly
- [ ] Input field disabled during starting/ending states
- [ ] Input queued when Claude is running
- [ ] Queued messages sent when Claude finishes
- [ ] Interrupt button visible during running state
- [ ] Interrupt button sends SIGINT signal
- [ ] End session button with confirmation when running
- [ ] Question modal appears for AskUserQuestion
- [ ] Question can be answered via options or custom text
- [ ] Connection lost banner appears on disconnect
- [ ] Extended help shown after 2 minutes disconnected
- [ ] Session view updates to "ended" state appropriately
- [ ] All tests pass
