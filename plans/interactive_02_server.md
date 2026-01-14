# Interactive Sessions: Server Relay

> **Spec reference:** [specs/interactive_sessions.md](../specs/interactive_sessions.md)

## Overview

This plan extends the server's WebSocket infrastructure to support bidirectional communication between browsers and PTY wrappers. The server acts as a relay, forwarding feedback from browsers to the appropriate wrapper.

## Dependencies

- [interactive_01_wrapper.md](./interactive_01_wrapper.md) - Wrapper must be ready to receive messages
- Existing live session WebSocket infrastructure (`src/server.ts`, `src/routes/api.ts`)

## Goals

1. New WebSocket endpoint for wrapper connections (`/api/sessions/:id/wrapper`)
2. Relay browser messages to wrapper
3. Relay wrapper output back to browser
4. Track feedback message status (pending/approved/rejected)
5. Handle interactive vs non-interactive sessions

## Architecture

```
Browser                Server                  Wrapper
   │                     │                        │
   │◄───────────────────►│◄──────────────────────►│
   │  /api/sessions/     │  /api/sessions/        │
   │    :id/ws           │    :id/wrapper         │
   │                     │                        │
   │  user_message ─────►│────── inject ─────────►│
   │                     │                        │
   │◄──── feedback_status│◄── feedback_status ────│
   │                     │                        │
   │◄────── output ──────│◄────── output ─────────│
   │                     │                        │
```

## Tasks

### 1. Schema Updates

Add fields to track interactive session state.

**File:** `src/db/schema.ts` (additions)

```typescript
// Add to Session interface
interface Session {
  // ... existing fields
  interactive: boolean;     // Whether this session accepts feedback
  wrapper_connected: boolean; // Whether wrapper is currently connected
}

// New table for feedback messages
interface FeedbackMessage {
  id: string;
  session_id: string;
  content: string;
  source: string | null;    // Who sent it (email or null)
  type: "message" | "diff_comment" | "suggested_edit";
  status: "pending" | "approved" | "rejected" | "expired";
  created_at: string;
  resolved_at: string | null;
  context_json: string | null; // For diff comments: { file, line }
}
```

**Migration:**

```sql
ALTER TABLE sessions ADD COLUMN interactive INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN wrapper_connected INTEGER DEFAULT 0;

CREATE TABLE feedback_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source TEXT,
  type TEXT NOT NULL DEFAULT 'message',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  context_json TEXT
);

CREATE INDEX idx_feedback_session ON feedback_messages(session_id);
CREATE INDEX idx_feedback_status ON feedback_messages(status);
```

### 2. Repository Updates

Add methods for feedback message management.

**File:** `src/db/repository.ts` (additions)

```typescript
interface FeedbackMessage {
  id: string;
  session_id: string;
  content: string;
  source: string | null;
  type: "message" | "diff_comment" | "suggested_edit";
  status: "pending" | "approved" | "rejected" | "expired";
  created_at: string;
  resolved_at: string | null;
  context?: { file: string; line: number };
}

// Add to SessionRepository class

createFeedbackMessage(
  sessionId: string,
  content: string,
  type: FeedbackMessage["type"],
  source?: string,
  context?: { file: string; line: number }
): FeedbackMessage {
  const id = crypto.randomUUID().slice(0, 8);
  const contextJson = context ? JSON.stringify(context) : null;

  this.db.run(`
    INSERT INTO feedback_messages (id, session_id, content, source, type, context_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, sessionId, content, source || null, type, contextJson]);

  return {
    id,
    session_id: sessionId,
    content,
    source: source || null,
    type,
    status: "pending",
    created_at: new Date().toISOString(),
    resolved_at: null,
    context,
  };
}

updateFeedbackStatus(
  messageId: string,
  status: "approved" | "rejected" | "expired"
): void {
  this.db.run(`
    UPDATE feedback_messages
    SET status = ?, resolved_at = datetime('now')
    WHERE id = ?
  `, [status, messageId]);
}

getPendingFeedback(sessionId: string): FeedbackMessage[] {
  const rows = this.db.query(`
    SELECT * FROM feedback_messages
    WHERE session_id = ? AND status = 'pending'
    ORDER BY created_at ASC
  `).all(sessionId) as any[];

  return rows.map(row => ({
    ...row,
    context: row.context_json ? JSON.parse(row.context_json) : undefined,
  }));
}

setSessionInteractive(sessionId: string, interactive: boolean): void {
  this.db.run(`
    UPDATE sessions SET interactive = ? WHERE id = ?
  `, [interactive ? 1 : 0, sessionId]);
}

setWrapperConnected(sessionId: string, connected: boolean): void {
  this.db.run(`
    UPDATE sessions SET wrapper_connected = ? WHERE id = ?
  `, [connected ? 1 : 0, sessionId]);
}
```

### 3. WebSocket Types

Define message types for wrapper and browser communication.

**File:** `src/routes/websocket-types.ts`

```typescript
// Browser → Server messages (existing + new)
export type BrowserToServerMessage =
  | { type: "subscribe"; from_index?: number }
  | { type: "ping" }
  // New interactive messages:
  | { type: "user_message"; content: string }
  | { type: "diff_comment"; file: string; line: number; content: string }
  | { type: "suggested_edit"; file: string; old_content: string; new_content: string };

// Server → Browser messages (existing + new)
export type ServerToBrowserMessage =
  | { type: "connected"; session_id: string; status: string; message_count: number; last_index: number; interactive: boolean; wrapper_connected: boolean }
  | { type: "message"; messages: any[]; index: number }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; message_index: number }
  | { type: "diff"; files: any[] }
  | { type: "complete"; final_message_count: number }
  | { type: "heartbeat"; timestamp: string }
  | { type: "pong"; timestamp: string }
  | { type: "error"; code: string; message: string }
  // New:
  | { type: "feedback_queued"; message_id: string; position: number }
  | { type: "feedback_status"; message_id: string; status: "approved" | "rejected" | "expired" }
  | { type: "wrapper_status"; connected: boolean }
  | { type: "state"; state: "running" | "waiting" };

// Wrapper → Server messages
export type WrapperToServerMessage =
  | { type: "auth"; token: string }
  | { type: "output"; data: string }
  | { type: "state"; state: "running" | "waiting" }
  | { type: "ended"; exitCode: number }
  | { type: "feedback_status"; message_id: string; status: "approved" | "rejected" };

// Server → Wrapper messages
export type ServerToWrapperMessage =
  | { type: "auth_ok" }
  | { type: "auth_failed" }
  | { type: "inject"; content: string; source?: string; message_id: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "interrupt" }
  | { type: "end" };
```

### 4. Wrapper Connection Manager

Manage WebSocket connections from wrappers.

**File:** `src/routes/wrapper-connections.ts`

```typescript
import type { ServerWebSocket } from "bun";
import type { WrapperToServerMessage, ServerToWrapperMessage, ServerToBrowserMessage } from "./websocket-types";
import { SessionRepository } from "../db/repository";
import { broadcastToSession } from "./api";

interface WrapperConnection {
  ws: ServerWebSocket<{ sessionId: string; isWrapper: true }>;
  sessionId: string;
  authenticated: boolean;
}

const wrapperConnections = new Map<string, WrapperConnection>();

export function addWrapperConnection(
  sessionId: string,
  ws: ServerWebSocket<{ sessionId: string; isWrapper: true }>
): void {
  wrapperConnections.set(sessionId, {
    ws,
    sessionId,
    authenticated: false,
  });
}

export function removeWrapperConnection(sessionId: string): void {
  wrapperConnections.delete(sessionId);
}

export function getWrapperConnection(sessionId: string): WrapperConnection | undefined {
  return wrapperConnections.get(sessionId);
}

export function isWrapperConnected(sessionId: string): boolean {
  const conn = wrapperConnections.get(sessionId);
  return conn?.authenticated ?? false;
}

export function authenticateWrapper(sessionId: string, token: string, repo: SessionRepository): boolean {
  const conn = wrapperConnections.get(sessionId);
  if (!conn) return false;

  const session = repo.getSession(sessionId);
  if (!session || session.stream_token !== token) {
    return false;
  }

  conn.authenticated = true;
  repo.setWrapperConnected(sessionId, true);

  // Notify browsers
  broadcastToSession(sessionId, {
    type: "wrapper_status",
    connected: true,
  });

  return true;
}

export function sendToWrapper(sessionId: string, message: ServerToWrapperMessage): boolean {
  const conn = wrapperConnections.get(sessionId);
  if (!conn?.authenticated) return false;

  conn.ws.send(JSON.stringify(message));
  return true;
}

export function handleWrapperMessage(
  sessionId: string,
  message: WrapperToServerMessage,
  repo: SessionRepository
): void {
  const conn = wrapperConnections.get(sessionId);
  if (!conn) return;

  switch (message.type) {
    case "auth":
      const success = authenticateWrapper(sessionId, message.token, repo);
      conn.ws.send(JSON.stringify({
        type: success ? "auth_ok" : "auth_failed",
      }));
      if (!success) {
        conn.ws.close(4001, "Authentication failed");
      }
      break;

    case "output":
      // Broadcast raw output to browsers (for live indicator)
      broadcastToSession(sessionId, {
        type: "output",
        data: message.data,
      } as any);
      break;

    case "state":
      // Broadcast state change to browsers
      broadcastToSession(sessionId, {
        type: "state",
        state: message.state,
      });
      break;

    case "ended":
      // Mark session complete
      repo.updateSessionStatus(sessionId, "complete");
      repo.setWrapperConnected(sessionId, false);

      broadcastToSession(sessionId, {
        type: "complete",
        final_message_count: repo.getMessageCount(sessionId),
      });
      break;

    case "feedback_status":
      // Update feedback message status
      repo.updateFeedbackStatus(message.message_id, message.status);

      // Notify browsers
      broadcastToSession(sessionId, {
        type: "feedback_status",
        message_id: message.message_id,
        status: message.status,
      });
      break;
  }
}

export function handleWrapperClose(sessionId: string, repo: SessionRepository): void {
  const conn = wrapperConnections.get(sessionId);
  if (conn?.authenticated) {
    repo.setWrapperConnected(sessionId, false);

    // Notify browsers
    broadcastToSession(sessionId, {
      type: "wrapper_status",
      connected: false,
    });
  }

  wrapperConnections.delete(sessionId);
}
```

### 5. Update Server WebSocket Handler

Add wrapper WebSocket endpoint and handle browser feedback messages.

**File:** `src/server.ts` (updates)

```typescript
import {
  addWrapperConnection,
  removeWrapperConnection,
  handleWrapperMessage,
  handleWrapperClose,
  sendToWrapper,
  isWrapperConnected,
} from "./routes/wrapper-connections";

// WebSocket data types
interface BrowserWebSocketData {
  sessionId: string;
  isWrapper: false;
}

interface WrapperWebSocketData {
  sessionId: string;
  isWrapper: true;
}

type WebSocketData = BrowserWebSocketData | WrapperWebSocketData;

// In fetch handler, add wrapper endpoint:
fetch(req, server) {
  const url = new URL(req.url);

  // Existing browser WebSocket: /api/sessions/:id/ws
  const wsMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/ws$/);
  if (wsMatch) {
    // ... existing browser WebSocket handling
    const upgraded = server.upgrade<BrowserWebSocketData>(req, {
      data: { sessionId, isWrapper: false },
    });
    // ...
  }

  // New wrapper WebSocket: /api/sessions/:id/wrapper
  const wrapperMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/wrapper$/);
  if (wrapperMatch) {
    const sessionId = wrapperMatch[1];
    const session = repo.getSession(sessionId);

    if (!session) {
      return new Response("Session not found", { status: 404 });
    }

    if (!session.interactive) {
      return new Response("Session is not interactive", { status: 400 });
    }

    const upgraded = server.upgrade<WrapperWebSocketData>(req, {
      data: { sessionId, isWrapper: true },
    });

    if (upgraded) {
      return undefined;
    }

    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  return new Response("Not Found", { status: 404 });
},

// Update websocket handlers:
websocket: {
  open(ws) {
    const data = ws.data as WebSocketData;

    if (data.isWrapper) {
      // Wrapper connection
      addWrapperConnection(data.sessionId, ws as any);
    } else {
      // Browser connection (existing logic)
      addSessionSubscriber(data.sessionId, ws as unknown as WebSocket);

      const session = repo.getSession(data.sessionId);
      const messageCount = repo.getMessageCount(data.sessionId);
      const lastIndex = repo.getLastMessageIndex(data.sessionId);

      ws.send(JSON.stringify({
        type: "connected",
        session_id: data.sessionId,
        status: session?.status || "unknown",
        message_count: messageCount,
        last_index: lastIndex,
        interactive: session?.interactive ?? false,
        wrapper_connected: isWrapperConnected(data.sessionId),
      }));
    }
  },

  message(ws, message) {
    const data = ws.data as WebSocketData;

    try {
      const msg = JSON.parse(message.toString());

      if (data.isWrapper) {
        // Handle wrapper messages
        handleWrapperMessage(data.sessionId, msg, repo);
      } else {
        // Handle browser messages
        handleBrowserMessage(data.sessionId, msg, repo);
      }
    } catch {
      // Invalid message
    }
  },

  close(ws) {
    const data = ws.data as WebSocketData;

    if (data.isWrapper) {
      handleWrapperClose(data.sessionId, repo);
    } else {
      removeSessionSubscriber(data.sessionId, ws as unknown as WebSocket);
    }
  },
},
```

### 6. Browser Message Handler

Handle feedback messages from browsers.

**File:** `src/routes/browser-messages.ts`

```typescript
import type { BrowserToServerMessage, ServerToBrowserMessage } from "./websocket-types";
import { SessionRepository } from "../db/repository";
import { sendToWrapper, isWrapperConnected } from "./wrapper-connections";

export function handleBrowserMessage(
  sessionId: string,
  msg: BrowserToServerMessage,
  repo: SessionRepository,
  sendToBrowser: (msg: ServerToBrowserMessage) => void
): void {
  switch (msg.type) {
    case "subscribe":
      // Existing: resume from index
      if (typeof msg.from_index === "number") {
        const messages = repo.getMessagesFromIndex(sessionId, msg.from_index);
        if (messages.length > 0) {
          sendToBrowser({
            type: "message",
            messages,
            index: messages[messages.length - 1].message_index,
          });
        }
      }
      break;

    case "ping":
      sendToBrowser({ type: "pong", timestamp: new Date().toISOString() });
      break;

    case "user_message":
      handleUserMessage(sessionId, msg.content, repo, sendToBrowser);
      break;

    case "diff_comment":
      handleDiffComment(sessionId, msg.file, msg.line, msg.content, repo, sendToBrowser);
      break;

    case "suggested_edit":
      handleSuggestedEdit(sessionId, msg.file, msg.old_content, msg.new_content, repo, sendToBrowser);
      break;
  }
}

function handleUserMessage(
  sessionId: string,
  content: string,
  repo: SessionRepository,
  sendToBrowser: (msg: ServerToBrowserMessage) => void
): void {
  const session = repo.getSession(sessionId);

  if (!session?.interactive) {
    sendToBrowser({
      type: "error",
      code: "NOT_INTERACTIVE",
      message: "This session does not accept feedback",
    });
    return;
  }

  if (!isWrapperConnected(sessionId)) {
    sendToBrowser({
      type: "error",
      code: "WRAPPER_DISCONNECTED",
      message: "Session wrapper is not connected",
    });
    return;
  }

  // Create feedback message record
  const feedback = repo.createFeedbackMessage(sessionId, content, "message");

  // Get queue position
  const pending = repo.getPendingFeedback(sessionId);
  const position = pending.findIndex(m => m.id === feedback.id) + 1;

  // Notify browser of queue position
  sendToBrowser({
    type: "feedback_queued",
    message_id: feedback.id,
    position,
  });

  // Send to wrapper
  sendToWrapper(sessionId, {
    type: "inject",
    content,
    message_id: feedback.id,
  });
}

function handleDiffComment(
  sessionId: string,
  file: string,
  line: number,
  content: string,
  repo: SessionRepository,
  sendToBrowser: (msg: ServerToBrowserMessage) => void
): void {
  const session = repo.getSession(sessionId);

  if (!session?.interactive || !isWrapperConnected(sessionId)) {
    sendToBrowser({
      type: "error",
      code: "UNAVAILABLE",
      message: "Cannot send feedback to this session",
    });
    return;
  }

  // Format diff comment with context
  const formattedContent = `Feedback on ${file} line ${line}:\n\nComment: ${content}\n\nPlease address this feedback.`;

  const feedback = repo.createFeedbackMessage(
    sessionId,
    formattedContent,
    "diff_comment",
    undefined,
    { file, line }
  );

  const pending = repo.getPendingFeedback(sessionId);
  const position = pending.findIndex(m => m.id === feedback.id) + 1;

  sendToBrowser({
    type: "feedback_queued",
    message_id: feedback.id,
    position,
  });

  sendToWrapper(sessionId, {
    type: "inject",
    content: formattedContent,
    message_id: feedback.id,
  });
}

function handleSuggestedEdit(
  sessionId: string,
  file: string,
  oldContent: string,
  newContent: string,
  repo: SessionRepository,
  sendToBrowser: (msg: ServerToBrowserMessage) => void
): void {
  const session = repo.getSession(sessionId);

  if (!session?.interactive || !isWrapperConnected(sessionId)) {
    sendToBrowser({
      type: "error",
      code: "UNAVAILABLE",
      message: "Cannot send feedback to this session",
    });
    return;
  }

  const formattedContent = `I have a suggested edit for ${file}:

Current code:
\`\`\`
${oldContent}
\`\`\`

Suggested change:
\`\`\`
${newContent}
\`\`\`

Please review and apply this change if appropriate.`;

  const feedback = repo.createFeedbackMessage(
    sessionId,
    formattedContent,
    "suggested_edit",
    undefined,
    { file, line: 0 }
  );

  const pending = repo.getPendingFeedback(sessionId);
  const position = pending.findIndex(m => m.id === feedback.id) + 1;

  sendToBrowser({
    type: "feedback_queued",
    message_id: feedback.id,
    position,
  });

  sendToWrapper(sessionId, {
    type: "inject",
    content: formattedContent,
    message_id: feedback.id,
  });
}
```

### 7. Update Live Session Creation

Mark sessions as interactive when created via wrapper.

**File:** `src/routes/api.ts` (updates)

```typescript
// In createLiveSession handler:

async createLiveSession(req: Request) {
  const body = await req.json();
  const {
    title,
    project_path,
    interactive = false, // New field
    // ... other fields
  } = body;

  // ... create session

  if (interactive) {
    this.repo.setSessionInteractive(sessionId, true);
  }

  return Response.json({
    id: sessionId,
    stream_token: streamToken,
    url: `${baseUrl}/sessions/${sessionId}`,
    interactive,
  });
}
```

### 8. Rate Limiting

Add rate limiting for feedback messages.

**File:** `src/routes/rate-limit.ts`

```typescript
interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateLimitBucket>();

const LIMITS = {
  message: { max: 100, windowMs: 60 * 60 * 1000 },      // 100/hour
  diff_comment: { max: 50, windowMs: 60 * 60 * 1000 }, // 50/hour
  suggested_edit: { max: 20, windowMs: 60 * 60 * 1000 }, // 20/hour
};

export function checkRateLimit(
  sessionId: string,
  type: "message" | "diff_comment" | "suggested_edit"
): { allowed: boolean; retryAfter?: number } {
  const key = `${sessionId}:${type}`;
  const limit = LIMITS[type];
  const now = Date.now();

  let bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + limit.windowMs };
    buckets.set(key, bucket);
  }

  if (bucket.count >= limit.max) {
    return {
      allowed: false,
      retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
    };
  }

  bucket.count++;
  return { allowed: true };
}
```

## Testing

### Manual Testing

```bash
# Terminal 1: Start server
bun run dev

# Terminal 2: Start wrapper
cd /some/project
archive wrap -- claude "hello"

# Terminal 3: Use wscat to test wrapper endpoint
wscat -c "ws://localhost:3000/api/sessions/<id>/wrapper"
> {"type":"auth","token":"<stream_token>"}
# Should receive auth_ok

# Browser: Open session, try sending feedback
```

### Integration Tests

**File:** `tests/integration/interactive.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";

describe("Interactive Sessions", () => {
  let server: any;
  let sessionId: string;
  let streamToken: string;

  beforeAll(async () => {
    // Start test server
    // Create interactive session
  });

  it("creates interactive session", async () => {
    const res = await fetch("http://localhost:3000/api/sessions/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test Interactive",
        project_path: "/tmp",
        interactive: true,
      }),
    });

    const data = await res.json();
    expect(data.interactive).toBe(true);
    sessionId = data.id;
    streamToken = data.stream_token;
  });

  it("wrapper can authenticate", async () => {
    // Test wrapper WebSocket connection
  });

  it("relays messages from browser to wrapper", async () => {
    // Test message relay
  });
});
```

## Checklist

- [x] Add `interactive` and `wrapper_connected` columns to sessions table
- [x] Create `feedback_messages` table
- [x] Add repository methods for feedback management
- [x] Create `src/routes/websocket-types.ts`
- [x] Create `src/routes/wrapper-connections.ts`
- [x] Create `src/routes/browser-messages.ts`
- [x] Create `src/routes/rate-limit.ts`
- [x] Update `src/server.ts` for wrapper WebSocket endpoint
- [x] Update `createLiveSession` to support `interactive` flag
- [x] Update browser WebSocket `connected` message with new fields
- [x] Add integration tests
- [ ] Manual testing with wrapper
