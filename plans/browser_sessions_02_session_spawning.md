# Phase 2: Session Spawning Core

> **Spec reference:** [specs/browser_initiated_sessions.md](../specs/browser_initiated_sessions.md)

## Overview

This plan implements the core session spawning functionality: the daemon's `SpawnedSessionManager` that starts Claude Code processes in headless (stream-json) mode, manages their lifecycle, and streams output to the server.

## Dependencies

- **Phase 1:** Daemon WebSocket Infrastructure (daemon↔server communication)

## Tasks

### 1. Create SpawnedSessionManager

Implement the core manager for spawned Claude Code sessions.

**File:** `cli/lib/spawned-session-manager.ts`

```typescript
import type {
  StartSessionMessage,
  StreamJsonMessage,
  DaemonToServerMessage,
} from "../types/daemon-ws";

interface SpawnedSession {
  id: string;                      // Server-assigned session ID
  claudeSessionId?: string;        // Claude's internal session ID (from init message)
  proc: ReturnType<typeof Bun.spawn>;
  cwd: string;
  startedAt: Date;
  state: "starting" | "running" | "waiting" | "ending" | "ended";
  stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  pendingToolUseId?: string;       // For AskUserQuestion relay
  pendingPermissionId?: string;    // For permission relay
  outputBuffer: string;            // Buffer for incomplete NDJSON lines
}

type SendToServer = (message: DaemonToServerMessage) => void;

export class SpawnedSessionManager {
  private sessions = new Map<string, SpawnedSession>();
  private sendToServer: SendToServer;

  constructor(sendToServer: SendToServer) {
    this.sendToServer = sendToServer;
  }

  async startSession(request: StartSessionMessage): Promise<void> {
    // Validate working directory
    if (!this.validateWorkingDirectory(request.cwd)) {
      this.sendToServer({
        type: "session_ended",
        session_id: request.session_id,
        exit_code: 1,
        error: `Invalid working directory: ${request.cwd}`,
        reason: "error",
      });
      return;
    }

    // Build command arguments
    const args = this.buildClaudeArgs(request);

    console.log(`[spawner] Starting session ${request.session_id} in ${request.cwd}`);
    console.log(`[spawner] Command: claude ${args.join(" ")}`);

    try {
      const proc = Bun.spawn(["claude", ...args], {
        cwd: request.cwd,
        env: { ...process.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      const session: SpawnedSession = {
        id: request.session_id,
        proc,
        cwd: request.cwd,
        startedAt: new Date(),
        state: "starting",
        stdinWriter: null,
        outputBuffer: "",
      };

      this.sessions.set(request.session_id, session);

      // Get stdin writer
      session.stdinWriter = proc.stdin.getWriter();

      // Stream stdout
      this.streamOutput(session, proc.stdout);

      // Log stderr (for debugging)
      this.streamStderr(session, proc.stderr);

      // Handle process exit
      proc.exited.then((exitCode) => {
        this.onSessionEnded(session, exitCode);
      });
    } catch (error) {
      console.error(`[spawner] Failed to start session:`, error);
      this.sendToServer({
        type: "session_ended",
        session_id: request.session_id,
        exit_code: 1,
        error: error instanceof Error ? error.message : String(error),
        reason: "error",
      });
    }
  }

  private buildClaudeArgs(request: StartSessionMessage): string[] {
    const args = [
      "-p", request.prompt,
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
    ];

    if (request.model) {
      args.push("--model", request.model);
    }

    if (request.resume_session_id) {
      args.push("--resume", request.resume_session_id);
    }

    // Permission handling
    if (request.permission_mode === "relay") {
      args.push("--permission-prompt-tool", "stdio");
    } else if (request.permission_mode === "auto") {
      args.push("--dangerously-skip-permissions");
    }
    // "deny" mode: no flag, Claude will use default (deny)

    return args;
  }

  private validateWorkingDirectory(cwd: string): boolean {
    try {
      // Use Bun's native file system APIs
      const file = Bun.file(cwd);
      // Bun.file doesn't directly check directories, use Node fs module
      const { existsSync, statSync } = await import("fs");
      return existsSync(cwd) && statSync(cwd).isDirectory();
    } catch {
      return false;
    }
  }

  private async streamOutput(session: SpawnedSession, stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        session.outputBuffer += decoder.decode(value, { stream: true });
        const lines = session.outputBuffer.split("\n");
        session.outputBuffer = lines.pop() || "";

        const messages: StreamJsonMessage[] = [];

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const msg = JSON.parse(line) as StreamJsonMessage;
            messages.push(msg);

            // Process special messages
            this.processStreamMessage(session, msg);
          } catch (parseError) {
            console.error(`[spawner] Failed to parse line:`, line, parseError);
          }
        }

        if (messages.length > 0) {
          this.sendToServer({
            type: "session_output",
            session_id: session.id,
            messages,
          });
        }
      }
    } catch (error) {
      console.error(`[spawner] Error reading stdout:`, error);
    }
  }

  private async streamStderr(session: SpawnedSession, stderr: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        // Log stderr for debugging, but don't send to server
        console.error(`[spawner ${session.id}] stderr:`, text);
      }
    } catch (error) {
      // Ignore stderr read errors
    }
  }

  private processStreamMessage(session: SpawnedSession, msg: StreamJsonMessage): void {
    // Update session state based on message type
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      session.claudeSessionId = msg.session_id;
      session.state = "running";
      console.log(`[spawner] Session ${session.id} initialized, Claude session: ${msg.session_id}`);
    }

    // Detect result message (session completing turn)
    if (msg.type === "result") {
      session.state = "waiting";
    }

    // Detect when Claude starts generating (assistant message)
    if (msg.type === "assistant") {
      session.state = "running";

      // Check for AskUserQuestion tool use
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use" && block.name === "AskUserQuestion") {
            session.pendingToolUseId = block.id;
            this.sendToServer({
              type: "question_prompt",
              session_id: session.id,
              tool_use_id: block.id!,
              question: (block.input as any)?.question || "",
              options: (block.input as any)?.options,
            });
          }
        }
      }
    }
  }

  async sendInput(sessionId: string, content: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[spawner] Session not found: ${sessionId}`);
      return;
    }

    if (!session.stdinWriter) {
      console.error(`[spawner] No stdin writer for session: ${sessionId}`);
      return;
    }

    const message = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    }) + "\n";

    try {
      await session.stdinWriter.write(new TextEncoder().encode(message));
      session.state = "running";
      console.log(`[spawner] Sent input to session ${sessionId}`);
    } catch (error) {
      console.error(`[spawner] Failed to send input:`, error);
    }
  }

  async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.state = "ending";

    try {
      // Close stdin to signal EOF
      session.stdinWriter?.close();

      // Give Claude a moment to finish, then force kill
      setTimeout(() => {
        if (session.proc.exitCode === null) {
          console.log(`[spawner] Force killing session ${sessionId}`);
          session.proc.kill();
        }
      }, 5000);
    } catch (error) {
      console.error(`[spawner] Error ending session:`, error);
      session.proc.kill();
    }
  }

  async interruptSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    console.log(`[spawner] Interrupting session ${sessionId}`);

    try {
      session.proc.kill("SIGINT");
    } catch (error) {
      console.error(`[spawner] Error interrupting session:`, error);
    }
  }

  private onSessionEnded(session: SpawnedSession, exitCode: number): void {
    session.state = "ended";

    console.log(`[spawner] Session ${session.id} ended with code ${exitCode}`);

    this.sendToServer({
      type: "session_ended",
      session_id: session.id,
      exit_code: exitCode,
      reason: exitCode === 0 ? "completed" : "error",
    });

    // Clean up
    this.sessions.delete(session.id);
  }

  getSession(sessionId: string): SpawnedSession | undefined {
    return this.sessions.get(sessionId);
  }

  getActiveSessions(): SpawnedSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.state !== "ended"
    );
  }

  // For tool result injection (AskUserQuestion responses)
  async injectToolResult(
    sessionId: string,
    toolUseId: string,
    result: string
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.stdinWriter) return;

    const message = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: result,
        }],
      },
    }) + "\n";

    try {
      await session.stdinWriter.write(new TextEncoder().encode(message));
      session.pendingToolUseId = undefined;
      console.log(`[spawner] Injected tool result for ${toolUseId}`);
    } catch (error) {
      console.error(`[spawner] Failed to inject tool result:`, error);
    }
  }
}
```

### 2. Integrate SpawnedSessionManager with Daemon WebSocket

Connect the session manager to handle incoming server messages.

**File:** `cli/daemon.ts` (modify existing)

```typescript
import { SpawnedSessionManager } from "./lib/spawned-session-manager";
import { DaemonWebSocket } from "./lib/daemon-ws";
import type { ServerToDaemonMessage } from "./types/daemon-ws";

let daemonWs: DaemonWebSocket | null = null;
let sessionManager: SpawnedSessionManager | null = null;

function initWebSocket(serverUrl: string, clientId: string): void {
  // Create session manager with send function
  sessionManager = new SpawnedSessionManager((message) => {
    daemonWs?.send(message);
  });

  daemonWs = new DaemonWebSocket({
    serverUrl,
    clientId,
    onMessage: handleServerMessage,
    onConnect: () => {
      console.log("[daemon] WebSocket connected to server");
    },
    onDisconnect: () => {
      console.log("[daemon] WebSocket disconnected from server");
    },
  });

  daemonWs.connect();
}

function handleServerMessage(message: ServerToDaemonMessage): void {
  if (!sessionManager) {
    console.error("[daemon] Session manager not initialized");
    return;
  }

  switch (message.type) {
    case "start_session":
      sessionManager.startSession(message);
      break;

    case "send_input":
      sessionManager.sendInput(message.session_id, message.content);
      break;

    case "end_session":
      sessionManager.endSession(message.session_id);
      break;

    case "interrupt_session":
      sessionManager.interruptSession(message.session_id);
      break;

    case "question_response":
      sessionManager.injectToolResult(
        message.session_id,
        message.tool_use_id,
        message.answer
      );
      break;

    case "permission_response":
      // Will be implemented in Phase 6
      console.log("[daemon] Permission response:", message);
      break;

    default:
      console.warn("[daemon] Unknown message type:", (message as any).type);
  }
}
```

### 3. Add Desktop Notification on Session Start

Show a desktop notification when a remote session starts (security baseline).

**File:** `cli/lib/notifications.ts`

```typescript
import { basename } from "path";

interface NotificationOptions {
  title: string;
  message: string;
  sessionId: string;
  cwd: string;
  prompt: string;
}

export async function notifySessionStarted(options: NotificationOptions): Promise<void> {
  const { title, message, sessionId, cwd, prompt } = options;

  // Use native macOS notifications via osascript
  // For cross-platform, could use node-notifier package
  if (process.platform === "darwin") {
    const truncatedPrompt = prompt.length > 100
      ? prompt.slice(0, 100) + "..."
      : prompt;

    const script = `
      display notification "${truncatedPrompt}" ¬
        with title "${title}" ¬
        subtitle "Directory: ${basename(cwd)}"
    `;

    try {
      Bun.spawn(["osascript", "-e", script], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch (error) {
      console.error("[notification] Failed to show notification:", error);
    }
  } else if (process.platform === "linux") {
    // Use notify-send on Linux
    try {
      Bun.spawn([
        "notify-send",
        title,
        `${message}\nDirectory: ${cwd}`,
        "--app-name=openctl",
      ], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch (error) {
      console.error("[notification] Failed to show notification:", error);
    }
  }
  // Windows: would need different approach (PowerShell or node-notifier)
}
```

**Update SpawnedSessionManager to show notification:**

```typescript
// At the top of spawned-session-manager.ts, add import:
import { notifySessionStarted } from "./notifications";

// In startSession(), after successful spawn:

async startSession(request: StartSessionMessage): Promise<void> {
  // ... existing validation and spawn code ...

  // Show desktop notification
  notifySessionStarted({
    title: "Remote Session Started",
    message: `Claude session started`,
    sessionId: request.session_id,
    cwd: request.cwd,
    prompt: request.prompt,
  });

  // ... rest of method
}
```

### 4. Add Session Listing Capability

Allow querying active spawned sessions.

**File:** `cli/lib/spawned-session-manager.ts` (add methods)

```typescript
interface SessionInfo {
  id: string;
  claudeSessionId?: string;
  cwd: string;
  startedAt: Date;
  state: SpawnedSession["state"];
  durationSeconds: number;
}

// Add to SpawnedSessionManager class:

getSessionInfo(sessionId: string): SessionInfo | undefined {
  const session = this.sessions.get(sessionId);
  if (!session) return undefined;

  return {
    id: session.id,
    claudeSessionId: session.claudeSessionId,
    cwd: session.cwd,
    startedAt: session.startedAt,
    state: session.state,
    durationSeconds: Math.floor((Date.now() - session.startedAt.getTime()) / 1000),
  };
}

getAllSessionInfo(): SessionInfo[] {
  return Array.from(this.sessions.values()).map((session) => ({
    id: session.id,
    claudeSessionId: session.claudeSessionId,
    cwd: session.cwd,
    startedAt: session.startedAt,
    state: session.state,
    durationSeconds: Math.floor((Date.now() - session.startedAt.getTime()) / 1000),
  }));
}
```

### 5. Handle Process Cleanup on Daemon Shutdown

Ensure spawned sessions are cleaned up when daemon stops.

**File:** `cli/daemon.ts` (modify shutdown)

```typescript
export async function stopDaemon(): Promise<void> {
  console.log("[daemon] Shutting down...");

  // End all active spawned sessions
  if (sessionManager) {
    const activeSessions = sessionManager.getActiveSessions();
    console.log(`[daemon] Ending ${activeSessions.length} active session(s)`);

    for (const session of activeSessions) {
      await sessionManager.endSession(session.id);
    }
  }

  // Disconnect WebSocket
  daemonWs?.disconnect();

  // ... existing shutdown logic
}

// Handle process signals
process.on("SIGINT", () => {
  stopDaemon().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  stopDaemon().then(() => process.exit(0));
});
```

### 6. Add Output Buffering for Reconnection

Buffer output during connection loss for replay.

**File:** `cli/lib/spawned-session-manager.ts` (enhance)

```typescript
interface SpawnedSession {
  // ... existing fields
  outputHistory: StreamJsonMessage[];  // All messages for replay
  maxHistorySize: number;
}

// In constructor or when creating session:
const session: SpawnedSession = {
  // ... existing initialization
  outputHistory: [],
  maxHistorySize: 1000,  // Keep last 1000 messages
};

// In processStreamMessage or where messages are sent:
private recordMessage(session: SpawnedSession, msg: StreamJsonMessage): void {
  session.outputHistory.push(msg);

  // Trim history if too large
  if (session.outputHistory.length > session.maxHistorySize) {
    session.outputHistory = session.outputHistory.slice(-session.maxHistorySize);
  }
}

// For replay on reconnection:
getSessionHistory(sessionId: string, fromIndex: number = 0): StreamJsonMessage[] {
  const session = this.sessions.get(sessionId);
  if (!session) return [];

  return session.outputHistory.slice(fromIndex);
}
```

## Testing

### Unit Tests

**File:** `tests/spawned-session-manager.test.ts`

```typescript
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { SpawnedSessionManager } from "../cli/lib/spawned-session-manager";

describe("SpawnedSessionManager", () => {
  let manager: SpawnedSessionManager;
  let sentMessages: any[];

  beforeEach(() => {
    sentMessages = [];
    manager = new SpawnedSessionManager((msg) => {
      sentMessages.push(msg);
    });
  });

  test("validates working directory", async () => {
    await manager.startSession({
      type: "start_session",
      session_id: "test-123",
      prompt: "Test prompt",
      cwd: "/nonexistent/path",
    });

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].type).toBe("session_ended");
    expect(sentMessages[0].error).toContain("Invalid working directory");
  });

  test("builds correct Claude args", () => {
    // Test with internal method or via spawn call
    const args = (manager as any).buildClaudeArgs({
      prompt: "Test prompt",
      model: "claude-sonnet-4-20250514",
      permission_mode: "relay",
    });

    expect(args).toContain("-p");
    expect(args).toContain("Test prompt");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-20250514");
    expect(args).toContain("--permission-prompt-tool");
    expect(args).toContain("stdio");
  });

  test("tracks session state", async () => {
    // Would need to mock Bun.spawn for proper testing
    // This is a placeholder for the test structure
  });
});
```

### Integration Tests

**File:** `tests/spawned-session-integration.test.ts`

```typescript
import { describe, test, expect } from "bun:test";

describe("Session Spawning Integration", () => {
  test("spawns Claude and receives output", async () => {
    // This test requires Claude CLI to be installed
    // Skip in CI if not available

    // Start daemon
    // Send start_session via WebSocket
    // Verify session_output messages received
    // Verify session_ended on completion
  });

  test("sends input to running session", async () => {
    // Start session
    // Wait for initial response
    // Send follow-up input
    // Verify response received
  });

  test("interrupts running session", async () => {
    // Start session with long-running prompt
    // Send interrupt
    // Verify session responds to interrupt
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `cli/lib/spawned-session-manager.ts` | Create | Core session spawning and management |
| `cli/lib/notifications.ts` | Create | Desktop notification utilities |
| `cli/daemon.ts` | Modify | Integrate session manager, handle signals |
| `tests/spawned-session-manager.test.ts` | Create | Unit tests |
| `tests/spawned-session-integration.test.ts` | Create | Integration tests |

## Acceptance Criteria

- [ ] Daemon can spawn Claude Code in stream-json mode
- [ ] Session output is streamed to server via WebSocket
- [ ] User input can be sent to running session via stdin
- [ ] Sessions can be interrupted via SIGINT
- [ ] Sessions can be ended gracefully
- [ ] Desktop notification shown when remote session starts
- [ ] Session state is tracked (starting, running, waiting, ended)
- [ ] AskUserQuestion tool calls are detected and relayed
- [ ] Sessions are cleaned up on daemon shutdown
- [ ] Output is buffered for potential replay
- [ ] All tests pass
