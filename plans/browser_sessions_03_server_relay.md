# Phase 3: Server Relay Layer

> **Spec reference:** [specs/browser_initiated_sessions.md](../specs/browser_initiated_sessions.md)

## Overview

This plan implements the server-side relay layer that connects browser WebSockets to daemon WebSockets. The server acts as a message broker: receiving spawn requests from browsers, forwarding them to daemons, and relaying output back to browsers.

## Dependencies

- **Phase 1:** Daemon WebSocket Infrastructure
- **Phase 2:** Session Spawning Core

## Tasks

### 1. Create Spawn Session API Endpoint

Add the REST endpoint for browsers to request new sessions.

**File:** `src/routes/api.ts` (add to existing)

```typescript
import { daemonConnections } from "../lib/daemon-connections";
import { spawnedSessionRegistry } from "../lib/spawned-session-registry";

interface SpawnSessionRequest {
  prompt: string;
  cwd: string;
  harness?: string;
  model?: string;
  permission_mode?: "relay" | "auto" | "deny";
}

async spawnSession(req: Request): Promise<Response> {
  // Check daemon is connected
  const daemon = daemonConnections.getAnyConnectedDaemon();
  if (!daemon) {
    return jsonError("No daemon connected", 503);
  }

  // Parse request
  const body = await req.json() as SpawnSessionRequest;

  // Validate required fields
  if (!body.prompt?.trim()) {
    return jsonError("prompt is required", 400);
  }
  if (!body.cwd?.trim()) {
    return jsonError("cwd is required", 400);
  }

  // Validate harness is supported
  const harness = body.harness || "claude-code";
  const supportedHarness = daemon.capabilities.spawnable_harnesses.find(
    (h) => h.id === harness && h.available
  );
  if (!supportedHarness) {
    return jsonError(`Harness '${harness}' is not available`, 400);
  }

  // Generate session ID
  const sessionId = generateSessionId();

  // Create session record in registry (tracks spawned sessions)
  spawnedSessionRegistry.createSession({
    id: sessionId,
    daemonClientId: daemon.clientId,
    cwd: body.cwd,
    harness,
    model: body.model,
    status: "starting",
    createdAt: new Date(),
  });

  // Register session with daemon connection
  daemonConnections.registerSpawnedSession(daemon.clientId, sessionId);

  // Send start_session to daemon
  const sent = daemonConnections.sendToDaemon(daemon.clientId, {
    type: "start_session",
    session_id: sessionId,
    prompt: body.prompt,
    cwd: body.cwd,
    harness,
    model: body.model,
    permission_mode: body.permission_mode || "relay",
  });

  if (!sent) {
    spawnedSessionRegistry.deleteSession(sessionId);
    return jsonError("Failed to send to daemon", 500);
  }

  return json({
    session_id: sessionId,
    status: "starting",
    harness,
  }, 201);
}

function generateSessionId(): string {
  return `spawn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
```

### 2. Create Spawned Session Registry

Track spawned sessions on the server (separate from archived sessions in DB).

**File:** `src/lib/spawned-session-registry.ts`

```typescript
export type SpawnedSessionStatus =
  | "starting"
  | "running"
  | "waiting"
  | "ending"
  | "ended"
  | "failed";

export interface SpawnedSessionRecord {
  id: string;
  daemonClientId: string;
  cwd: string;
  harness: string;
  model?: string;
  status: SpawnedSessionStatus;
  createdAt: Date;
  claudeSessionId?: string;
  lastActivityAt?: Date;
  endedAt?: Date;
  exitCode?: number;
  error?: string;
}

class SpawnedSessionRegistry {
  private sessions = new Map<string, SpawnedSessionRecord>();

  createSession(record: SpawnedSessionRecord): void {
    this.sessions.set(record.id, record);
  }

  getSession(sessionId: string): SpawnedSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  updateSession(
    sessionId: string,
    updates: Partial<SpawnedSessionRecord>
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      Object.assign(session, updates, { lastActivityAt: new Date() });
    }
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getSessionsByDaemon(clientId: string): SpawnedSessionRecord[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.daemonClientId === clientId
    );
  }

  getActiveSessions(): SpawnedSessionRecord[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status !== "ended" && s.status !== "failed"
    );
  }

  // Check if session is a spawned session (vs. daemon-streamed)
  isSpawnedSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
}

export const spawnedSessionRegistry = new SpawnedSessionRegistry();
```

### 3. Handle Daemon Messages for Session Output

Relay session output from daemon to browser WebSockets.

**File:** `src/server.ts` (modify handleDaemonMessage)

```typescript
import { spawnedSessionRegistry } from "./lib/spawned-session-registry";
import { wsManager } from "./lib/websocket";

function handleDaemonMessage(
  ws: ServerWebSocket<{ type: string; clientId?: string }>,
  message: DaemonToServerMessage
): void {
  switch (message.type) {
    case "daemon_connected": {
      (ws.data as any).clientId = message.client_id;
      daemonConnections.addDaemon(message.client_id, ws as any, message.capabilities);
      break;
    }

    case "session_output": {
      const session = spawnedSessionRegistry.getSession(message.session_id);
      if (!session) {
        console.warn(`[relay] Unknown session: ${message.session_id}`);
        return;
      }

      // Update session status based on messages
      for (const msg of message.messages) {
        if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
          spawnedSessionRegistry.updateSession(message.session_id, {
            claudeSessionId: msg.session_id,
            status: "running",
          });
        }
        if (msg.type === "result") {
          spawnedSessionRegistry.updateSession(message.session_id, {
            status: "waiting",
          });
        }
        if (msg.type === "assistant") {
          spawnedSessionRegistry.updateSession(message.session_id, {
            status: "running",
          });
        }
      }

      // Broadcast to browser WebSocket subscribers
      wsManager.broadcast(message.session_id, {
        type: "message",
        messages: message.messages,
      });
      break;
    }

    case "session_ended": {
      spawnedSessionRegistry.updateSession(message.session_id, {
        status: "ended",
        endedAt: new Date(),
        exitCode: message.exit_code,
        error: message.error,
      });

      // Unregister from daemon
      const clientId = (ws.data as any).clientId;
      if (clientId) {
        daemonConnections.unregisterSpawnedSession(clientId, message.session_id);
      }

      // Broadcast to browsers
      wsManager.broadcast(message.session_id, {
        type: "complete",
        exit_code: message.exit_code,
        reason: message.reason,
        error: message.error,
      });
      break;
    }

    case "question_prompt": {
      // Relay AskUserQuestion to browser
      wsManager.broadcast(message.session_id, {
        type: "question_prompt",
        tool_use_id: message.tool_use_id,
        question: message.question,
        options: message.options,
      });
      break;
    }

    case "permission_prompt": {
      // Relay permission request to browser
      wsManager.broadcast(message.session_id, {
        type: "permission_prompt",
        request_id: message.request_id,
        tool: message.tool,
        description: message.description,
        details: message.details,
      });
      break;
    }

    default:
      console.warn("[daemon-msg] Unknown message type:", (message as any).type);
  }
}
```

### 4. Extend Browser WebSocket Protocol

Handle user input from browsers and relay to daemon.

**File:** `src/server.ts` (modify WebSocket message handler)

```typescript
message(ws, message) {
  const data = ws.data as { type: string; sessionId?: string; clientId?: string };

  try {
    const parsed = JSON.parse(message as string);

    // Handle daemon messages
    if (data.type === "daemon") {
      handleDaemonMessage(ws, parsed as DaemonToServerMessage);
      return;
    }

    // Handle browser session messages
    if (data.type === "session" && data.sessionId) {
      handleBrowserSessionMessage(data.sessionId, parsed);
      return;
    }
  } catch (error) {
    console.error("[ws] Failed to parse message:", error);
  }
}

function handleBrowserSessionMessage(sessionId: string, message: any): void {
  switch (message.type) {
    case "subscribe": {
      // Existing subscription logic
      if (message.from_index !== undefined) {
        // Replay messages from index
        // For spawned sessions, we'd need to track message history
      }
      break;
    }

    case "ping": {
      // Existing heartbeat logic
      break;
    }

    case "user_message": {
      // NEW: Handle user input for spawned sessions
      const session = spawnedSessionRegistry.getSession(sessionId);
      if (!session) {
        console.warn(`[ws] user_message for unknown session: ${sessionId}`);
        return;
      }

      // Relay to daemon
      const sent = daemonConnections.sendToDaemon(session.daemonClientId, {
        type: "send_input",
        session_id: sessionId,
        content: message.content,
      });

      if (!sent) {
        console.error(`[ws] Failed to relay user_message to daemon`);
      }
      break;
    }

    case "interrupt": {
      // NEW: Handle interrupt request
      const session = spawnedSessionRegistry.getSession(sessionId);
      if (!session) return;

      daemonConnections.sendToDaemon(session.daemonClientId, {
        type: "interrupt_session",
        session_id: sessionId,
      });
      break;
    }

    case "end_session": {
      // NEW: Handle end session request
      const session = spawnedSessionRegistry.getSession(sessionId);
      if (!session) return;

      daemonConnections.sendToDaemon(session.daemonClientId, {
        type: "end_session",
        session_id: sessionId,
      });
      break;
    }

    case "question_response": {
      // NEW: Handle AskUserQuestion response
      const session = spawnedSessionRegistry.getSession(sessionId);
      if (!session) return;

      daemonConnections.sendToDaemon(session.daemonClientId, {
        type: "question_response",
        session_id: sessionId,
        tool_use_id: message.tool_use_id,
        answer: message.answer,
      });
      break;
    }

    case "permission_response": {
      // NEW: Handle permission response
      const session = spawnedSessionRegistry.getSession(sessionId);
      if (!session) return;

      daemonConnections.sendToDaemon(session.daemonClientId, {
        type: "permission_response",
        session_id: sessionId,
        request_id: message.request_id,
        allow: message.allow,
      });
      break;
    }

    default:
      console.warn(`[ws] Unknown browser message type: ${message.type}`);
  }
}
```

### 5. Add Session Info API Endpoints

REST endpoints for browser to query session state.

**File:** `src/routes/api.ts` (add to existing)

```typescript
// GET /api/sessions/:id/info
// Returns info for both archived DB sessions and active spawned sessions
getSessionInfo(sessionId: string): Response {
  // Check if it's a spawned session
  const spawned = spawnedSessionRegistry.getSession(sessionId);
  if (spawned) {
    return json({
      id: spawned.id,
      type: "spawned",
      status: spawned.status,
      cwd: spawned.cwd,
      harness: spawned.harness,
      model: spawned.model,
      created_at: spawned.createdAt.toISOString(),
      claude_session_id: spawned.claudeSessionId,
      last_activity_at: spawned.lastActivityAt?.toISOString(),
      ended_at: spawned.endedAt?.toISOString(),
      exit_code: spawned.exitCode,
      error: spawned.error,
    });
  }

  // Fall back to DB session
  const dbSession = repo.getSession(sessionId);
  if (dbSession) {
    return json({
      id: dbSession.id,
      type: "archived",
      // ... existing session fields
    });
  }

  return jsonError("Session not found", 404);
}

// GET /api/sessions/spawned
// List active spawned sessions
getSpawnedSessions(): Response {
  const sessions = spawnedSessionRegistry.getActiveSessions();

  return json({
    sessions: sessions.map((s) => ({
      id: s.id,
      status: s.status,
      cwd: s.cwd,
      harness: s.harness,
      created_at: s.createdAt.toISOString(),
      last_activity_at: s.lastActivityAt?.toISOString(),
    })),
  });
}
```

### 6. Register New Routes

Add routes to server.ts.

**File:** `src/server.ts` (add routes)

```typescript
routes: {
  // ... existing routes

  "/api/sessions/spawn": {
    POST: (req) => api.spawnSession(req),
  },

  "/api/sessions/spawned": {
    GET: () => api.getSpawnedSessions(),
  },

  // Note: This route may conflict with existing /api/sessions/:id routes.
  // Consider placing this BEFORE the /api/sessions/:id route in server.ts,
  // or use a different path like /api/sessions/:id/state
  "/api/sessions/:id/info": {
    GET: (req) => api.getSessionInfo(req.params.id),
  },
}
```

### 7. Handle Daemon Disconnect

When daemon disconnects, update all its spawned sessions.

**File:** `src/lib/daemon-connections.ts` (modify removeDaemon)

```typescript
import { spawnedSessionRegistry } from "./spawned-session-registry";
import { wsManager } from "./websocket";

removeDaemon(clientId: string): void {
  const daemon = this.daemons.get(clientId);
  if (daemon) {
    // Mark all active spawned sessions as disconnected
    for (const sessionId of daemon.activeSpawnedSessions) {
      const session = spawnedSessionRegistry.getSession(sessionId);
      if (session && session.status !== "ended") {
        spawnedSessionRegistry.updateSession(sessionId, {
          status: "failed",
          error: "Daemon disconnected",
        });

        // Notify browser subscribers
        wsManager.broadcast(sessionId, {
          type: "daemon_disconnected",
          session_id: sessionId,
          message: "Connection to daemon lost",
        });
      }
    }
  }

  this.daemons.delete(clientId);
  console.log(`[daemon-mgr] Daemon disconnected: ${clientId}`);
}
```

### 8. Add Message Type Definitions

Define browser↔server WebSocket message types.

**File:** `src/types/browser-ws.ts`

```typescript
// Browser → Server messages
export type BrowserToServerMessage =
  | { type: "subscribe"; from_index?: number }
  | { type: "ping" }
  | { type: "user_message"; content: string }
  | { type: "interrupt" }
  | { type: "end_session" }
  | { type: "question_response"; tool_use_id: string; answer: string }
  | { type: "permission_response"; request_id: string; allow: boolean };

// Server → Browser messages
export type ServerToBrowserMessage =
  | { type: "connected"; session_id: string; status: string; message_count: number }
  | { type: "message"; messages: StreamJsonMessage[] }
  | { type: "complete"; exit_code?: number; reason?: string; error?: string }
  | { type: "question_prompt"; tool_use_id: string; question: string; options?: string[] }
  | { type: "permission_prompt"; request_id: string; tool: string; description: string; details: Record<string, unknown> }
  | { type: "daemon_disconnected"; session_id: string; message: string }
  | { type: "heartbeat"; timestamp: string }
  | { type: "error"; code: string; message: string };
```

## Testing

### Unit Tests

**File:** `tests/server-relay.test.ts`

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { spawnedSessionRegistry } from "../src/lib/spawned-session-registry";

describe("SpawnedSessionRegistry", () => {
  beforeEach(() => {
    // Clear registry between tests
  });

  test("creates and retrieves session", () => {
    spawnedSessionRegistry.createSession({
      id: "test-123",
      daemonClientId: "daemon-1",
      cwd: "/test/path",
      harness: "claude-code",
      status: "starting",
      createdAt: new Date(),
    });

    const session = spawnedSessionRegistry.getSession("test-123");
    expect(session).toBeDefined();
    expect(session?.status).toBe("starting");
  });

  test("updates session status", () => {
    spawnedSessionRegistry.createSession({
      id: "test-456",
      daemonClientId: "daemon-1",
      cwd: "/test",
      harness: "claude-code",
      status: "starting",
      createdAt: new Date(),
    });

    spawnedSessionRegistry.updateSession("test-456", { status: "running" });

    const session = spawnedSessionRegistry.getSession("test-456");
    expect(session?.status).toBe("running");
  });

  test("filters active sessions", () => {
    spawnedSessionRegistry.createSession({
      id: "active-1",
      daemonClientId: "daemon-1",
      cwd: "/test",
      harness: "claude-code",
      status: "running",
      createdAt: new Date(),
    });

    spawnedSessionRegistry.createSession({
      id: "ended-1",
      daemonClientId: "daemon-1",
      cwd: "/test",
      harness: "claude-code",
      status: "ended",
      createdAt: new Date(),
    });

    const active = spawnedSessionRegistry.getActiveSessions();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe("active-1");
  });
});
```

### Integration Tests

**File:** `tests/server-relay-integration.test.ts`

```typescript
import { describe, test, expect } from "bun:test";

describe("Server Relay Integration", () => {
  test("spawns session via REST and receives output via WebSocket", async () => {
    // 1. Ensure daemon is connected (mock or real)
    // 2. POST /api/sessions/spawn
    // 3. Connect browser WebSocket to session
    // 4. Verify session_output messages are relayed
  });

  test("relays user input from browser to daemon", async () => {
    // 1. Start spawned session
    // 2. Send user_message via WebSocket
    // 3. Verify daemon receives send_input
  });

  test("handles daemon disconnect gracefully", async () => {
    // 1. Start spawned session
    // 2. Disconnect daemon
    // 3. Verify browser receives daemon_disconnected message
    // 4. Verify session status is updated to failed
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/lib/spawned-session-registry.ts` | Create | Track active spawned sessions |
| `src/types/browser-ws.ts` | Create | Browser↔Server WebSocket message types |
| `src/routes/api.ts` | Modify | Add spawn endpoint and session info endpoints |
| `src/server.ts` | Modify | Add route registration and WebSocket message handling |
| `src/lib/daemon-connections.ts` | Modify | Handle session cleanup on daemon disconnect |
| `tests/server-relay.test.ts` | Create | Unit tests |
| `tests/server-relay-integration.test.ts` | Create | Integration tests |

## Acceptance Criteria

- [ ] `POST /api/sessions/spawn` creates spawned session and sends to daemon
- [ ] Session output is relayed from daemon to browser WebSocket
- [ ] Browser can send user input via WebSocket `user_message`
- [ ] Browser can interrupt session via WebSocket `interrupt`
- [ ] Browser can end session via WebSocket `end_session`
- [ ] Question prompts are relayed to browser
- [ ] Question responses are relayed to daemon
- [ ] Permission prompts are relayed to browser (setup for Phase 6)
- [ ] `GET /api/sessions/:id/info` returns spawned session info
- [ ] `GET /api/sessions/spawned` lists active spawned sessions
- [ ] Daemon disconnect triggers session failure and browser notification
- [ ] All tests pass
