# Phase 6: Permission & Question Relay

> **Spec reference:** [specs/browser_initiated_sessions.md](../specs/browser_initiated_sessions.md)

## Overview

This plan completes the permission and question relay functionality. While the basic infrastructure was added in earlier phases, this plan focuses on the daemon-side permission handling using `--permission-prompt-tool stdio` and the browser UI for permission modals.

## Dependencies

- **Phase 2:** Session Spawning Core (spawned session manager)
- **Phase 3:** Server Relay Layer (WebSocket message types)
- **Phase 5:** Browser UI - Session Interaction (modal infrastructure)

## Tasks

### 1. Implement Permission Prompt Detection in Daemon

Parse permission requests from Claude's stdout when using `--permission-prompt-tool stdio`.

**File:** `cli/lib/spawned-session-manager.ts` (enhance)

```typescript
import type {
  PermissionPromptMessage,
} from "../types/daemon-ws";

interface PermissionRequest {
  id: string;
  tool: string;
  description: string;
  command?: string;
  file_path?: string;
  content?: string;
}

// Add to SpawnedSession interface:
interface SpawnedSession {
  // ... existing fields
  pendingPermissionId?: string;
  permissionRequests: Map<string, PermissionRequest>;
}

// Enhance processStreamMessage to detect permission prompts:
private processStreamMessage(session: SpawnedSession, msg: StreamJsonMessage): void {
  // ... existing state tracking code ...

  // Detect permission requests
  // Permission requests come as a special message type when using --permission-prompt-tool stdio
  if (msg.type === "permission_request" ||
      (msg.type === "system" && msg.subtype === "permission_request")) {
    const request: PermissionRequest = {
      id: (msg as any).request_id || crypto.randomUUID(),
      tool: (msg as any).tool,
      description: (msg as any).description || this.formatPermissionDescription(msg),
      command: (msg as any).command,
      file_path: (msg as any).file_path,
      content: (msg as any).content,
    };

    session.permissionRequests.set(request.id, request);
    session.pendingPermissionId = request.id;

    this.sendToServer({
      type: "permission_prompt",
      session_id: session.id,
      request_id: request.id,
      tool: request.tool,
      description: request.description,
      details: {
        command: request.command,
        file_path: request.file_path,
        content: request.content ? request.content.slice(0, 500) : undefined, // Preview only
      },
    });
  }
}

private formatPermissionDescription(msg: any): string {
  const tool = msg.tool || "unknown";

  switch (tool.toLowerCase()) {
    case "bash":
      return `Run bash command: ${msg.command || "unknown"}`;
    case "write":
      return `Write to file: ${msg.file_path || "unknown"}`;
    case "edit":
      return `Edit file: ${msg.file_path || "unknown"}`;
    case "mcp":
      return `Use MCP tool: ${msg.tool_name || "unknown"}`;
    default:
      return `Use ${tool} tool`;
  }
}
```

### 2. Handle Permission Responses in Daemon

Respond to permission requests via stdin.

**File:** `cli/lib/spawned-session-manager.ts` (add method)

```typescript
async respondToPermission(
  sessionId: string,
  requestId: string,
  allow: boolean
): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session || !session.stdinWriter) {
    console.error(`[spawner] Session not found for permission response: ${sessionId}`);
    return;
  }

  const request = session.permissionRequests.get(requestId);
  if (!request) {
    console.error(`[spawner] Permission request not found: ${requestId}`);
    return;
  }

  // Format the permission response for Claude's stdin
  // The format depends on how Claude's --permission-prompt-tool stdio expects responses
  const response = JSON.stringify({
    type: "permission_response",
    request_id: requestId,
    allow,
  }) + "\n";

  try {
    await session.stdinWriter.write(new TextEncoder().encode(response));
    session.permissionRequests.delete(requestId);
    session.pendingPermissionId = undefined;
    console.log(`[spawner] Sent permission response for ${requestId}: ${allow ? "allow" : "deny"}`);
  } catch (error) {
    console.error(`[spawner] Failed to send permission response:`, error);
  }
}
```

### 3. Update Daemon Message Handler

Add permission_response handling.

**File:** `cli/daemon.ts` (modify handleServerMessage)

```typescript
function handleServerMessage(message: ServerToDaemonMessage): void {
  if (!sessionManager) {
    console.error("[daemon] Session manager not initialized");
    return;
  }

  switch (message.type) {
    // ... existing cases ...

    case "permission_response":
      sessionManager.respondToPermission(
        message.session_id,
        message.request_id,
        message.allow
      );
      break;

    // ... rest of switch
  }
}
```

### 4. Create PermissionModal Component

Enhanced permission modal with tool-specific UI.

**File:** `src/client/components/PermissionModal.tsx`

```typescript
import { useState } from "react";

interface PermissionModalProps {
  tool: string;
  description: string;
  details: {
    command?: string;
    file_path?: string;
    content?: string;
  };
  onAllow: () => void;
  onDeny: () => void;
}

export function PermissionModal({
  tool,
  description,
  details,
  onAllow,
  onDeny,
}: PermissionModalProps) {
  const [rememberChoice, setRememberChoice] = useState(false);

  const getToolIcon = () => {
    switch (tool.toLowerCase()) {
      case "bash":
        return (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        );
      case "write":
      case "edit":
        return (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        );
      default:
        return (
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        );
    }
  };

  const getRememberLabel = () => {
    switch (tool.toLowerCase()) {
      case "bash":
        return "Allow all bash commands this session";
      case "write":
      case "edit":
        return "Allow writes to this directory";
      default:
        return "Remember this choice";
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-800">
          <div className="p-2 bg-yellow-900/50 rounded-lg text-yellow-500">
            {getToolIcon()}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">
              Permission Required
            </h2>
            <p className="text-sm text-gray-400">{description}</p>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          {/* Bash command display */}
          {tool.toLowerCase() === "bash" && details.command && (
            <div className="mb-4">
              <p className="text-sm text-gray-400 mb-2">
                Claude wants to run a bash command:
              </p>
              <pre className="p-3 bg-gray-800 rounded-md text-sm text-gray-200 overflow-x-auto font-mono">
                {details.command}
              </pre>
            </div>
          )}

          {/* File operation display */}
          {(tool.toLowerCase() === "write" || tool.toLowerCase() === "edit") && details.file_path && (
            <div className="mb-4">
              <p className="text-sm text-gray-400 mb-2">
                Claude wants to {tool.toLowerCase() === "write" ? "write to" : "edit"} a file:
              </p>
              <code className="block p-3 bg-gray-800 rounded-md text-sm text-cyan-400 font-mono">
                {details.file_path}
              </code>
              {details.content && (
                <div className="mt-2">
                  <p className="text-sm text-gray-400 mb-1">Preview:</p>
                  <pre className="p-3 bg-gray-800 rounded-md text-xs text-gray-300 overflow-x-auto max-h-32 font-mono">
                    {details.content}
                    {details.content.length >= 500 && "..."}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Remember checkbox */}
          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={rememberChoice}
              onChange={(e) => setRememberChoice(e.target.checked)}
              className="rounded border-gray-600 bg-gray-800 text-cyan-500"
            />
            {getRememberLabel()}
          </label>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex justify-end gap-3">
          <button
            onClick={onDeny}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-md"
          >
            Deny
          </button>
          <button
            onClick={onAllow}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-md"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 5. Add Permission Auto-Approve Settings

Configuration for auto-approving certain permissions.

**Note:** This section adds a new `auto-safe` permission mode. You must also update the `permissionMode` type in Phase 4's NewSessionModal.tsx from `"relay" | "auto" | "deny"` to `"relay" | "auto-safe" | "auto"` for consistency.

**File:** `src/client/components/NewSessionModal.tsx` (enhance permission options)

```typescript
// In the permission mode radio options:

<div>
  <label className="block text-sm font-medium text-gray-300 mb-2">
    Permission mode
  </label>
  <div className="space-y-2">
    <label className="flex items-start gap-2 text-sm text-gray-300">
      <input
        type="radio"
        name="permissionMode"
        value="relay"
        checked={formData.permissionMode === "relay"}
        onChange={() => setFormData({ ...formData, permissionMode: "relay" })}
        className="mt-1 text-cyan-500"
      />
      <div>
        <span className="font-medium">Ask for each permission</span>
        <p className="text-gray-500 text-xs mt-0.5">
          Most secure. You'll approve each file write and bash command.
        </p>
      </div>
    </label>

    <label className="flex items-start gap-2 text-sm text-gray-300">
      <input
        type="radio"
        name="permissionMode"
        value="auto-safe"
        checked={formData.permissionMode === "auto-safe"}
        onChange={() => setFormData({ ...formData, permissionMode: "auto-safe" })}
        className="mt-1 text-cyan-500"
      />
      <div>
        <span className="font-medium">Auto-approve safe operations</span>
        <p className="text-gray-500 text-xs mt-0.5">
          Auto-approve file reads. Ask for writes and bash commands.
        </p>
      </div>
    </label>

    <label className="flex items-start gap-2 text-sm text-gray-300">
      <input
        type="radio"
        name="permissionMode"
        value="auto"
        checked={formData.permissionMode === "auto"}
        onChange={() => setFormData({ ...formData, permissionMode: "auto" })}
        className="mt-1 text-cyan-500"
      />
      <div>
        <span className="font-medium">Auto-approve all</span>
        <p className="text-gray-500 text-xs mt-0.5">
          Trust this session fully. No permission prompts.
        </p>
        <p className="text-yellow-500 text-xs">
          ⚠ Not recommended for untrusted prompts
        </p>
      </div>
    </label>
  </div>
</div>
```

### 6. Enhance Question Modal with Timeout

Add timeout handling for unanswered questions.

**File:** `src/client/components/QuestionModal.tsx` (enhance)

```typescript
import { useState, useCallback, useEffect } from "react";

interface QuestionModalProps {
  question: string;
  options?: string[];
  onAnswer: (answer: string) => void;
  onClose: () => void;
  timeoutSeconds?: number; // Default 300 (5 min)
}

export function QuestionModal({
  question,
  options,
  onAnswer,
  onClose,
  timeoutSeconds = 300,
}: QuestionModalProps) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [customAnswer, setCustomAnswer] = useState("");
  const [secondsRemaining, setSecondsRemaining] = useState(timeoutSeconds);
  const [showTimeoutWarning, setShowTimeoutWarning] = useState(false);

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          onClose(); // Auto-dismiss on timeout
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [onClose]);

  // Show warning at 1 minute remaining
  useEffect(() => {
    if (secondsRemaining <= 60 && !showTimeoutWarning) {
      setShowTimeoutWarning(true);
    }
  }, [secondsRemaining, showTimeoutWarning]);

  const handleSubmit = useCallback(() => {
    const answer = selectedOption || customAnswer.trim();
    if (answer) {
      onAnswer(answer);
    }
  }, [selectedOption, customAnswer, onAnswer]);

  const isSubmitDisabled = !selectedOption && !customAnswer.trim();

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-white">
            Claude is asking
          </h2>
          <div className="flex items-center gap-3">
            {/* Timeout indicator */}
            <span className={`text-sm ${showTimeoutWarning ? "text-yellow-400" : "text-gray-500"}`}>
              {formatTime(secondsRemaining)}
            </span>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Timeout warning */}
        {showTimeoutWarning && (
          <div className="px-6 py-2 bg-yellow-900/30 border-b border-yellow-800/50 text-yellow-300 text-sm">
            This question will auto-dismiss in {formatTime(secondsRemaining)}
          </div>
        )}

        {/* Content - same as before */}
        <div className="px-6 py-4">
          <p className="text-gray-200 mb-4">"{question}"</p>

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

### 7. Add Permission History Tracking

Track permission decisions for session review.

**File:** `src/lib/spawned-session-registry.ts` (enhance)

```typescript
interface PermissionDecision {
  id: string;
  tool: string;
  description: string;
  decision: "allowed" | "denied";
  timestamp: Date;
}

export interface SpawnedSessionRecord {
  // ... existing fields
  permissionHistory: PermissionDecision[];
}

// In createSession:
createSession(record: SpawnedSessionRecord): void {
  this.sessions.set(record.id, {
    ...record,
    permissionHistory: [],
  });
}

// Add method to record permission decision:
recordPermissionDecision(
  sessionId: string,
  decision: Omit<PermissionDecision, "timestamp">
): void {
  const session = this.sessions.get(sessionId);
  if (session) {
    session.permissionHistory.push({
      ...decision,
      timestamp: new Date(),
    });
  }
}
```

### 8. Update Server Relay for Permission Tracking

Record permission decisions when relayed.

**File:** `src/server.ts` (modify handleBrowserSessionMessage)

```typescript
case "permission_response": {
  const session = spawnedSessionRegistry.getSession(sessionId);
  if (!session) return;

  // Record the decision
  spawnedSessionRegistry.recordPermissionDecision(sessionId, {
    id: message.request_id,
    tool: "unknown", // Would need to store tool from original prompt
    description: "Permission decision",
    decision: message.allow ? "allowed" : "denied",
  });

  daemonConnections.sendToDaemon(session.daemonClientId, {
    type: "permission_response",
    session_id: sessionId,
    request_id: message.request_id,
    allow: message.allow,
  });
  break;
}
```

## Testing

### Unit Tests

**File:** `tests/cli/permission-handling.test.ts`

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { SpawnedSessionManager } from "../../cli/lib/spawned-session-manager";

describe("Permission Handling", () => {
  let manager: SpawnedSessionManager;
  let sentMessages: any[];

  beforeEach(() => {
    sentMessages = [];
    manager = new SpawnedSessionManager((msg) => {
      sentMessages.push(msg);
    });
  });

  test("detects permission request messages", async () => {
    // Simulate permission request from Claude stdout
    const permissionMsg = {
      type: "permission_request",
      request_id: "perm-123",
      tool: "Bash",
      command: "rm -rf node_modules",
    };

    // Would need to inject this into the stream processor
    // This is a placeholder for the test structure
  });

  test("sends permission response to stdin", async () => {
    // Test that respondToPermission writes correct format to stdin
  });
});
```

### Component Tests

**File:** `tests/client/components/PermissionModal.test.tsx`

```typescript
import { render, screen, fireEvent } from "@testing-library/react";
import { PermissionModal } from "../../../src/client/components/PermissionModal";

describe("PermissionModal", () => {
  const defaultProps = {
    tool: "Bash",
    description: "Run bash command",
    details: { command: "npm install" },
    onAllow: jest.fn(),
    onDeny: jest.fn(),
  };

  test("renders bash command in code block", () => {
    render(<PermissionModal {...defaultProps} />);

    expect(screen.getByText("npm install")).toBeInTheDocument();
    expect(screen.getByText(/wants to run a bash command/i)).toBeInTheDocument();
  });

  test("calls onAllow when Allow button clicked", () => {
    render(<PermissionModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Allow"));
    expect(defaultProps.onAllow).toHaveBeenCalled();
  });

  test("calls onDeny when Deny button clicked", () => {
    render(<PermissionModal {...defaultProps} />);

    fireEvent.click(screen.getByText("Deny"));
    expect(defaultProps.onDeny).toHaveBeenCalled();
  });

  test("shows file path for write operations", () => {
    render(
      <PermissionModal
        {...defaultProps}
        tool="Write"
        description="Write to file"
        details={{ file_path: "/src/index.ts" }}
      />
    );

    expect(screen.getByText("/src/index.ts")).toBeInTheDocument();
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `cli/lib/spawned-session-manager.ts` | Modify | Add permission detection and response |
| `cli/daemon.ts` | Modify | Handle permission_response messages |
| `src/client/components/PermissionModal.tsx` | Create | Full permission modal component |
| `src/client/components/QuestionModal.tsx` | Modify | Add timeout handling |
| `src/client/components/NewSessionModal.tsx` | Modify | Enhanced permission mode options |
| `src/lib/spawned-session-registry.ts` | Modify | Track permission history |
| `src/server.ts` | Modify | Record permission decisions |
| `tests/cli/permission-handling.test.ts` | Create | Daemon-side tests |
| `tests/client/components/PermissionModal.test.tsx` | Create | Component tests |

## Acceptance Criteria

- [ ] Daemon detects permission requests from Claude's stdout
- [ ] Permission prompts are relayed to browser via server
- [ ] Browser shows permission modal with tool-specific UI
- [ ] Bash commands show in code block
- [ ] File operations show file path and content preview
- [ ] Allow/Deny buttons send response through relay chain
- [ ] Permission responses written to Claude's stdin correctly
- [ ] "Remember" checkbox tracks preference (session-scoped)
- [ ] Question modal has timeout countdown
- [ ] Question auto-dismisses after timeout
- [ ] Permission history tracked in session registry
- [ ] Permission mode options in new session modal
- [ ] All tests pass
