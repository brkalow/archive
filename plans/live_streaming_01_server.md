# Server Live Sessions API

> **Spec reference:** [specs/live_streaming.md](../specs/live_streaming.md)

## Overview

This plan covers the server-side infrastructure for live session streaming: schema changes, new API endpoints, WebSocket support, and session lifecycle management.

## Dependencies

None - this is the foundational plan that daemon and browser depend on.

## Tasks

### 1. Schema Migration

Add new columns to the sessions table for live session support.

**File:** `src/db/schema.ts`

```typescript
// Add to safeAddColumn migrations
safeAddColumn(db, "sessions", "status", "TEXT DEFAULT 'archived'");
safeAddColumn(db, "sessions", "last_activity_at", "TEXT");
safeAddColumn(db, "sessions", "stream_token_hash", "TEXT");

// Add index for live sessions
db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);
```

**Update Session type:**
```typescript
export type SessionStatus = "live" | "complete" | "archived";

export type Session = {
  // ... existing fields
  status: SessionStatus;
  last_activity_at: string | null;
  stream_token_hash: string | null;  // SHA-256 hash of stream token
};
```

### 2. Repository Methods

Add repository methods for live session operations.

**File:** `src/db/repository.ts`

```typescript
// New methods needed:

// Create a live session and return stream token
createLiveSession(session: Partial<Session>): { id: string; streamToken: string }

// Validate stream token for a session
validateStreamToken(sessionId: string, token: string): boolean

// Append messages to a session (incremental)
appendMessages(sessionId: string, messages: Omit<Message, 'id'>[]): { appended: number; lastIndex: number }

// Update last_activity_at timestamp
touchSession(sessionId: string): void

// Mark session as complete
completeSession(sessionId: string, summary?: string): void

// Get live sessions
getLiveSessions(): Session[]

// Get messages from a specific index (for WebSocket replay)
getMessagesFromIndex(sessionId: string, fromIndex: number): Message[]

// Auto-complete idle sessions (called by background job)
completeIdleSessions(idleThresholdSeconds: number): number
```

### 3. Stream Token Generation

Implement secure stream token generation and validation.

**File:** `src/routes/api.ts` (or new `src/lib/tokens.ts`)

```typescript
import { createHash, randomBytes } from 'crypto';

function generateStreamToken(): string {
  return randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function verifyStreamToken(token: string, hash: string): boolean {
  return hashToken(token) === hash;
}
```

### 4. API Endpoints

Add new routes for live session management.

**File:** `src/routes/api.ts`

#### POST /api/sessions/live

Create a new live session.

```typescript
async createLiveSession(req: Request): Promise<Response> {
  const body = await req.json();

  // Validate required fields
  if (!body.project_path) {
    return jsonError("project_path is required", 400);
  }

  // Check for existing live session with same harness_session_id
  if (body.harness_session_id) {
    const existing = repo.getLiveSessionByHarnessId(body.harness_session_id);
    if (existing) {
      return jsonError("Session already exists and is live", 409);
    }
  }

  const { id, streamToken } = repo.createLiveSession({
    title: body.title || "Live Session",
    project_path: body.project_path,
    claude_session_id: body.harness_session_id,
    harness: body.harness,
    model: body.model,
    repo_url: body.repo_url,
    status: "live",
  });

  return json({ id, stream_token: streamToken, status: "live" }, 201);
}
```

#### POST /api/sessions/:id/messages

Push messages to a live session.

```typescript
async pushMessages(req: Request, sessionId: string): Promise<Response> {
  // Validate stream token from Authorization header
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonError("Missing stream token", 401);
  }

  const token = authHeader.slice(7);
  if (!repo.validateStreamToken(sessionId, token)) {
    return jsonError("Invalid stream token", 401);
  }

  const session = repo.getSession(sessionId);
  if (!session) {
    return jsonError("Session not found", 404);
  }

  if (session.status !== "live") {
    return jsonError("Session is not live", 409);
  }

  const body = await req.json();
  const { appended, lastIndex } = repo.appendMessages(sessionId, body.messages);

  // Touch session for activity tracking
  repo.touchSession(sessionId);

  // Broadcast to WebSocket subscribers
  wsManager.broadcast(sessionId, {
    type: "message",
    messages: body.messages,
    index: lastIndex,
  });

  return json({
    appended,
    message_count: lastIndex + 1,
    last_index: lastIndex
  });
}
```

#### POST /api/sessions/:id/tool-results

Push tool results.

```typescript
async pushToolResults(req: Request, sessionId: string): Promise<Response> {
  // Auth validation (same as pushMessages)
  // ...

  const body = await req.json();
  const { matched, pending } = repo.attachToolResults(sessionId, body.results);

  // Broadcast each result to WebSocket subscribers
  for (const result of body.results) {
    wsManager.broadcast(sessionId, {
      type: "tool_result",
      tool_use_id: result.tool_use_id,
      content: result.content,
      is_error: result.is_error,
    });
  }

  return json({ matched, pending });
}
```

#### POST /api/sessions/:id/complete

Mark session as complete.

```typescript
async completeSession(req: Request, sessionId: string): Promise<Response> {
  // Auth validation
  // ...

  const body = await req.json();

  // Update diff if provided
  if (body.final_diff) {
    const touchedFiles = extractTouchedFilesFromSession(sessionId);
    const diffs = parseDiffData(body.final_diff, sessionId, touchedFiles);
    repo.clearDiffs(sessionId);
    repo.addDiffs(diffs);
  }

  // Complete the session
  repo.completeSession(sessionId, body.summary);

  // Broadcast completion
  const messageCount = repo.getMessageCount(sessionId);
  wsManager.broadcast(sessionId, {
    type: "complete",
    final_message_count: messageCount,
  });

  // Invalidate stream token
  repo.invalidateStreamToken(sessionId);

  return json({
    status: "complete",
    message_count: messageCount,
    duration_seconds: calculateDuration(sessionId),
  });
}
```

#### GET /api/sessions/live

List live sessions.

```typescript
getLiveSessions(): Response {
  const sessions = repo.getLiveSessions();
  return json({
    sessions: sessions.map(s => ({
      id: s.id,
      title: s.title,
      project_path: s.project_path,
      message_count: repo.getMessageCount(s.id),
      last_activity_at: s.last_activity_at,
      duration_seconds: calculateDuration(s.id),
    })),
  });
}
```

### 5. Server Route Registration

Register new routes in server.ts.

**File:** `src/server.ts`

```typescript
routes: {
  // ... existing routes

  "/api/sessions/live": {
    GET: () => api.getLiveSessions(),
    POST: (req) => api.createLiveSession(req),
  },

  "/api/sessions/:id/messages": {
    POST: (req) => api.pushMessages(req, req.params.id),
  },

  "/api/sessions/:id/tool-results": {
    POST: (req) => api.pushToolResults(req, req.params.id),
  },

  "/api/sessions/:id/complete": {
    POST: (req) => api.completeSession(req, req.params.id),
  },

  // WebSocket upgrade handled separately
}
```

### 6. WebSocket Manager

Implement WebSocket connection management.

**File:** `src/lib/websocket.ts`

```typescript
type WebSocketMessage =
  | { type: "connected"; session_id: string; status: string; message_count: number; last_index: number }
  | { type: "message"; messages: unknown[]; index: number }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "diff"; files: Array<{ filename: string; additions: number; deletions: number }> }
  | { type: "complete"; final_message_count: number }
  | { type: "heartbeat"; timestamp: string }
  | { type: "error"; code: string; message: string };

class WebSocketManager {
  private connections = new Map<string, Set<ServerWebSocket>>();

  addConnection(sessionId: string, ws: ServerWebSocket): void {
    if (!this.connections.has(sessionId)) {
      this.connections.set(sessionId, new Set());
    }
    this.connections.get(sessionId)!.add(ws);
  }

  removeConnection(sessionId: string, ws: ServerWebSocket): void {
    this.connections.get(sessionId)?.delete(ws);
    if (this.connections.get(sessionId)?.size === 0) {
      this.connections.delete(sessionId);
    }
  }

  broadcast(sessionId: string, message: WebSocketMessage): void {
    const sockets = this.connections.get(sessionId);
    if (!sockets) return;

    const data = JSON.stringify(message);
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        this.removeConnection(sessionId, ws);
      }
    }
  }

  getConnectionCount(sessionId: string): number {
    return this.connections.get(sessionId)?.size ?? 0;
  }
}

export const wsManager = new WebSocketManager();
```

### 7. WebSocket Endpoint

Handle WebSocket upgrade and messages.

**File:** `src/server.ts`

Bun's serve() supports WebSocket via the `websocket` option:

```typescript
const server = Bun.serve({
  port: PORT,
  hostname: HOST,

  routes: { /* ... */ },

  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for /api/sessions/:id/ws
    const wsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/ws$/);
    if (wsMatch && req.headers.get("upgrade") === "websocket") {
      const sessionId = wsMatch[1];
      const session = repo.getSession(sessionId);

      if (!session) {
        return new Response("Session not found", { status: 404 });
      }

      if (session.status === "archived") {
        return new Response("Session is archived", { status: 410 });
      }

      const success = server.upgrade(req, { data: { sessionId } });
      if (success) {
        return undefined; // Bun handles the response
      }
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      const { sessionId } = ws.data as { sessionId: string };
      wsManager.addConnection(sessionId, ws);

      // Send initial state
      const session = repo.getSession(sessionId);
      const messageCount = repo.getMessageCount(sessionId);

      ws.send(JSON.stringify({
        type: "connected",
        session_id: sessionId,
        status: session?.status,
        message_count: messageCount,
        last_index: messageCount - 1,
      }));
    },

    message(ws, message) {
      const { sessionId } = ws.data as { sessionId: string };

      try {
        const data = JSON.parse(message as string);

        if (data.type === "subscribe" && data.from_index !== undefined) {
          // Replay messages from index
          const messages = repo.getMessagesFromIndex(sessionId, data.from_index);
          for (const msg of messages) {
            ws.send(JSON.stringify({
              type: "message",
              messages: [msg],
              index: msg.message_index,
            }));
          }
        }

        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "heartbeat", timestamp: new Date().toISOString() }));
        }
      } catch {
        // Invalid message, ignore
      }
    },

    close(ws) {
      const { sessionId } = ws.data as { sessionId: string };
      wsManager.removeConnection(sessionId, ws);
    },
  },
});
```

### 8. Session Timeout Background Job

Implement automatic session completion for idle sessions.

**File:** `src/lib/session-timeout.ts`

```typescript
const IDLE_TIMEOUT_SECONDS = 60;
const CHECK_INTERVAL_MS = 10_000;

export function startSessionTimeoutChecker(repo: SessionRepository) {
  setInterval(() => {
    const completed = repo.completeIdleSessions(IDLE_TIMEOUT_SECONDS);
    if (completed > 0) {
      console.log(`Auto-completed ${completed} idle session(s)`);

      // Broadcast completion to any connected clients
      // (Would need to track which sessions were completed)
    }
  }, CHECK_INTERVAL_MS);
}
```

### 9. Heartbeat Broadcasting

Send periodic heartbeats to connected WebSocket clients.

**File:** `src/lib/websocket.ts`

```typescript
// Add to WebSocketManager
startHeartbeat() {
  setInterval(() => {
    const timestamp = new Date().toISOString();
    for (const [sessionId, sockets] of this.connections) {
      const data = JSON.stringify({ type: "heartbeat", timestamp });
      for (const ws of sockets) {
        try {
          ws.send(data);
        } catch {
          this.removeConnection(sessionId, ws);
        }
      }
    }
  }, 30_000); // Every 30 seconds
}
```

## Testing

### Unit Tests

```typescript
// tests/live-sessions.test.ts

import { describe, test, expect, beforeEach } from "bun:test";

describe("Live Sessions API", () => {
  test("creates live session with stream token", async () => {
    const res = await fetch("/api/sessions/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test Session",
        project_path: "/test/project",
        harness: "claude-code",
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toMatch(/^sess_/);
    expect(data.stream_token).toBeDefined();
    expect(data.status).toBe("live");
  });

  test("rejects duplicate harness_session_id", async () => {
    // Create first session
    await fetch("/api/sessions/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: "/test",
        harness_session_id: "unique-123",
      }),
    });

    // Try to create duplicate
    const res = await fetch("/api/sessions/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: "/test",
        harness_session_id: "unique-123",
      }),
    });

    expect(res.status).toBe(409);
  });

  test("pushes messages with valid stream token", async () => {
    const { id, stream_token } = await createLiveSession();

    const res = await fetch(`/api/sessions/${id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${stream_token}`,
      },
      body: JSON.stringify({
        messages: [{
          role: "user",
          content_blocks: [{ type: "text", text: "Hello" }],
        }],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.appended).toBe(1);
  });

  test("rejects messages with invalid token", async () => {
    const { id } = await createLiveSession();

    const res = await fetch(`/api/sessions/${id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer invalid-token",
      },
      body: JSON.stringify({ messages: [] }),
    });

    expect(res.status).toBe(401);
  });

  test("completes session", async () => {
    const { id, stream_token } = await createLiveSession();

    const res = await fetch(`/api/sessions/${id}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${stream_token}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("complete");
  });
});
```

### WebSocket Tests

```typescript
describe("WebSocket Subscription", () => {
  test("connects and receives initial state", async () => {
    const { id } = await createLiveSession();

    const ws = new WebSocket(`ws://localhost:3000/api/sessions/${id}/ws`);

    const message = await new Promise((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data));
    });

    expect(message.type).toBe("connected");
    expect(message.session_id).toBe(id);
    expect(message.status).toBe("live");

    ws.close();
  });

  test("receives broadcast when messages are pushed", async () => {
    const { id, stream_token } = await createLiveSession();

    const ws = new WebSocket(`ws://localhost:3000/api/sessions/${id}/ws`);
    await waitForOpen(ws);

    // Skip connected message
    await waitForMessage(ws);

    // Push a message via API
    await fetch(`/api/sessions/${id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${stream_token}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content_blocks: [{ type: "text", text: "Test" }] }],
      }),
    });

    const broadcast = await waitForMessage(ws);
    expect(broadcast.type).toBe("message");
    expect(broadcast.messages[0].role).toBe("user");

    ws.close();
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/db/schema.ts` | Modify | Add status, last_activity_at, stream_token_hash columns |
| `src/db/repository.ts` | Modify | Add live session repository methods |
| `src/routes/api.ts` | Modify | Add live session API endpoints |
| `src/server.ts` | Modify | Add route registration and WebSocket handling |
| `src/lib/websocket.ts` | Create | WebSocket connection manager |
| `src/lib/tokens.ts` | Create | Stream token generation/validation |
| `src/lib/session-timeout.ts` | Create | Idle session timeout checker |
| `tests/live-sessions.test.ts` | Create | Unit and integration tests |

## Acceptance Criteria

- [ ] Live sessions can be created via `POST /api/sessions/live`
- [ ] Stream token is returned and used to authenticate subsequent requests
- [ ] Messages can be pushed to live sessions via `POST /api/sessions/:id/messages`
- [ ] Tool results can be pushed via `POST /api/sessions/:id/tool-results`
- [ ] Sessions can be completed via `POST /api/sessions/:id/complete`
- [ ] WebSocket connections can be established at `/api/sessions/:id/ws`
- [ ] WebSocket clients receive real-time message broadcasts
- [ ] Idle sessions are automatically marked complete after 60 seconds
- [ ] Duplicate harness_session_id for live sessions is rejected with 409
- [ ] All tests pass
