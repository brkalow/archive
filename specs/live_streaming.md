# Live Session Streaming

This document specifies the API and architecture for streaming live AI coding sessions to the archive, enabling real-time viewing of active sessions in the browser.

## Overview

Live streaming allows users to share and view active coding sessions as they happen. The daemon watches local session files using **harness-specific adapters**, pushes incremental updates to the server, and the browser renders updates in real-time via WebSockets.

The architecture is **harness-agnostic**: Claude Code, Cursor, Windsurf, and other AI coding tools can be supported by implementing a harness adapter.

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  AI Harness     │      │     Daemon      │      │     Server      │
│  (Claude Code,  │      │                 │      │                 │
│   Cursor, etc)  │─────▶│  Harness        │─────▶│  REST API for   │
│                 │ tail │  Adapters       │ HTTP │  session mgmt   │
│  session files  │      │                 │      │                 │
└─────────────────┘      └─────────────────┘      └─────────────────┘
                                                          │
                                                          │ WebSocket
                                                          ▼
                                                  ┌─────────────────┐
                                                  │     Browser     │
                                                  │                 │
                                                  │  Subscribes to  │
                                                  │  live updates   │
                                                  └─────────────────┘
```

## Session Status Model

### Status Enum

Sessions gain a `status` field indicating their lifecycle state:

```typescript
type SessionStatus = "live" | "complete" | "archived";
```

| Status | Description |
|--------|-------------|
| `live` | Session is actively being updated by a daemon |
| `complete` | Session has ended (no updates for N seconds) |
| `archived` | Session was uploaded as a finished artifact (current behavior) |

### Schema Change

```sql
ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'archived';
ALTER TABLE sessions ADD COLUMN last_activity_at TEXT;
```

```typescript
interface Session {
  // ... existing fields
  status: SessionStatus;
  last_activity_at: string | null;  // ISO timestamp of last message
}
```

### Status Transitions

```
                      ┌──────────┐
            create    │          │  timeout (60s idle)
  ─────────────────▶  │   live   │ ─────────────────────▶ complete
                      │          │
                      └──────────┘
                           │
                           │ explicit end
                           ▼
                      ┌──────────┐
                      │ complete │
                      └──────────┘
```

**Timeout behavior:**
- Server marks session `complete` if no updates received for 60 seconds
- Daemon can explicitly mark session complete when Claude Code exits
- Complete sessions cannot return to live status

---

## API Endpoints

### Create Live Session

Creates a new live session and returns an ID for pushing updates.

```
POST /api/sessions/live
Content-Type: application/json

{
  "title": "Implementing auth feature",
  "project_path": "/Users/me/myproject",
  "claude_session_id": "abc123",
  "harness": "claude-code",
  "model": "claude-sonnet-4-20250514",
  "repo_url": "https://github.com/org/repo"
}
```

**Response:**
```json
{
  "id": "sess_abc123_xyz",
  "stream_token": "stk_randomsecuretoken",
  "status": "live"
}
```

The `stream_token` authenticates subsequent push requests. It's single-use per session and not stored in the database (only its hash).

---

### Push Messages

Appends new messages to a live session. Called incrementally as new lines appear in the JSONL.

```
POST /api/sessions/:id/messages
Authorization: Bearer <stream_token>
Content-Type: application/json

{
  "messages": [
    {
      "type": "assistant",
      "message": {
        "role": "assistant",
        "content": [
          {"type": "text", "text": "Let me read that file."},
          {"type": "tool_use", "id": "xyz", "name": "Read", "input": {"file_path": "src/index.ts"}}
        ]
      },
      "timestamp": "2025-01-11T10:30:00Z"
    }
  ]
}
```

**Response:**
```json
{
  "appended": 1,
  "message_count": 15,
  "last_index": 14
}
```

**Behavior:**
- Messages are parsed and stored with incrementing `message_index`
- Tool results are matched to their tool_use blocks (same as batch upload)
- Updates `last_activity_at` timestamp
- Broadcasts to WebSocket subscribers

**Error cases:**
- `401` - Invalid or missing stream token
- `404` - Session not found
- `409` - Session is not live (already complete)
- `400` - Invalid message format

---

### Push Tool Results

Pushes tool results separately (for cases where result arrives after the tool_use).

```
POST /api/sessions/:id/tool-results
Authorization: Bearer <stream_token>
Content-Type: application/json

{
  "results": [
    {
      "tool_use_id": "xyz",
      "content": "file contents here...",
      "is_error": false
    }
  ]
}
```

**Response:**
```json
{
  "matched": 1,
  "pending": 0
}
```

**Behavior:**
- Matches results to pending tool_use blocks by ID
- Updates the message containing the tool_use
- Broadcasts update to WebSocket subscribers

---

### Update Diff

Pushes or updates the session's diff data. Can be called multiple times as the diff changes.

```
PUT /api/sessions/:id/diff
Authorization: Bearer <stream_token>
Content-Type: text/plain

diff --git a/src/index.ts b/src/index.ts
index abc123..def456 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,5 @@
+import { auth } from './auth';
...
```

**Response:**
```json
{
  "files_changed": 3,
  "additions": 45,
  "deletions": 12
}
```

**Behavior:**
- Replaces existing diff data for the session
- Parses diff into per-file records
- Computes relevance based on tool calls in messages
- Broadcasts diff update to WebSocket subscribers

---

### Complete Session

Explicitly marks a session as complete. Called when Claude Code exits.

```
POST /api/sessions/:id/complete
Authorization: Bearer <stream_token>
Content-Type: application/json

{
  "final_diff": "diff --git a/...",  // Optional final diff
  "summary": "Added user authentication with JWT"  // Optional
}
```

**Response:**
```json
{
  "status": "complete",
  "message_count": 42,
  "duration_seconds": 1847
}
```

**Behavior:**
- Sets `status = 'complete'`
- Optionally updates description from summary
- Optionally updates diff with final state
- Broadcasts completion event to WebSocket subscribers
- Invalidates stream token

---

### Subscribe to Live Updates (WebSocket)

Browser connects via WebSocket to receive real-time updates for a session. WebSockets enable bidirectional communication, which will be used for Phase 3 interactive feedback.

```
WebSocket /api/sessions/:id/ws
```

**Connection flow:**

1. Client connects to `ws://server/api/sessions/:id/ws`
2. Server sends `connected` message with current state
3. Server pushes updates as they arrive
4. Client can send messages (for future feedback features)
5. Connection closes when session completes or client disconnects

**Server → Client messages:**

```typescript
// All messages have a "type" field
type ServerMessage =
  | { type: "connected"; session_id: string; status: string; message_count: number; last_index: number }
  | { type: "message"; messages: NormalizedMessage[]; index: number }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; message_index: number }
  | { type: "diff"; files: Array<{ filename: string; additions: number; deletions: number }> }
  | { type: "complete"; final_message_count: number }
  | { type: "heartbeat"; timestamp: string }
  | { type: "error"; code: string; message: string };
```

**Example message flow:**

```json
← {"type":"connected","session_id":"sess_abc123","status":"live","message_count":10,"last_index":9}
← {"type":"message","messages":[{"role":"assistant","content_blocks":[...]}],"index":10}
← {"type":"message","messages":[{"role":"user","content_blocks":[...]}],"index":11}
← {"type":"tool_result","tool_use_id":"xyz","content":"...","message_index":10}
← {"type":"diff","files":[{"filename":"src/index.ts","additions":5,"deletions":2}]}
← {"type":"heartbeat","timestamp":"2025-01-11T10:35:00Z"}
← {"type":"complete","final_message_count":42}
```

**Client → Server messages (future):**

```typescript
// Reserved for Phase 3 interactive feedback
type ClientMessage =
  | { type: "subscribe"; from_index?: number }  // Resume from specific index
  | { type: "feedback"; message_index: number; content: string }  // Comment on message
  | { type: "ping" };  // Keep-alive
```

**Message types:**

| Type | Direction | Description |
|------|-----------|-------------|
| `connected` | Server→Client | Initial connection with session state |
| `message` | Server→Client | New message(s) appended |
| `tool_result` | Server→Client | Tool result matched to pending tool_use |
| `diff` | Server→Client | Diff was created or updated |
| `complete` | Server→Client | Session ended |
| `heartbeat` | Server→Client | Keep-alive every 30s |
| `error` | Server→Client | Error occurred |
| `subscribe` | Client→Server | Request to resume from index |
| `feedback` | Client→Server | (Phase 3) Send feedback |
| `ping` | Client→Server | Keep-alive from client |

**Reconnection:**
- Client should reconnect on disconnect
- Send `subscribe` message with `from_index` to resume from last received
- Server replays missed messages from that index
- If `from_index` is omitted, sends full current state

**Error handling:**
- `4404` - Session not found (WebSocket close code)
- `4410` - Session is archived (not streamable, use regular API)
- `4401` - Unauthorized (for future auth)

---

### Get Live Sessions

List all currently live sessions.

```
GET /api/sessions/live
```

**Response:**
```json
{
  "sessions": [
    {
      "id": "sess_abc123",
      "title": "Implementing auth",
      "project_path": "/Users/me/myproject",
      "message_count": 15,
      "last_activity_at": "2025-01-11T10:30:00Z",
      "duration_seconds": 340
    }
  ]
}
```

---

## Daemon Architecture

### Overview

The daemon runs as a background process, watching session files from various AI coding harnesses and pushing updates to the archive server. It uses a **pluggable adapter system** to support different harnesses.

```
archive daemon start [options]
archive daemon stop
archive daemon status
```

### Harness Adapter Interface

Each AI coding harness has different session storage formats and locations. Adapters abstract these differences behind a common interface.

```typescript
// daemon/adapters/types.ts

/**
 * Normalized message format that all adapters produce.
 * This is the common format pushed to the server.
 */
interface NormalizedMessage {
  role: "user" | "assistant";
  content_blocks: ContentBlock[];
  timestamp?: string;
  // Tool results are attached to their tool_use blocks
}

/**
 * Metadata about a detected session.
 */
interface SessionInfo {
  localPath: string;           // Path to the session file
  projectPath: string;         // Working directory / project root
  harnessSessionId?: string;   // Harness-specific session ID
  model?: string;              // Model used (if detectable)
  repoUrl?: string;            // Git remote URL (if detectable)
}

/**
 * Harness adapter interface. Implement this to support a new AI coding tool.
 */
interface HarnessAdapter {
  /** Unique identifier for this harness (e.g., "claude-code", "cursor") */
  id: string;

  /** Human-readable name */
  name: string;

  /** Directories to watch for session files */
  getWatchPaths(): string[];

  /**
   * Given a file path, determine if this adapter handles it.
   * Used when multiple adapters are active.
   */
  canHandle(filePath: string): boolean;

  /**
   * Extract session metadata from a file path.
   */
  getSessionInfo(filePath: string): SessionInfo;

  /**
   * Parse a line from the session file into normalized messages.
   * May return multiple messages (e.g., tool_result gets merged).
   * Returns null if line should be skipped.
   */
  parseLine(line: string, context: ParseContext): NormalizedMessage[] | null;

  /**
   * Detect if a session has ended based on file state or external signals.
   * Some harnesses may have explicit end markers.
   */
  detectSessionEnd?(filePath: string): Promise<boolean>;

  /**
   * Derive a title from the session content.
   * Called after first few messages are parsed.
   */
  deriveTitle?(messages: NormalizedMessage[]): string;
}

interface ParseContext {
  /** Previously parsed messages, for matching tool_results to tool_use */
  messages: NormalizedMessage[];
  /** Pending tool_use IDs awaiting results */
  pendingToolUses: Map<string, { messageIndex: number; blockIndex: number }>;
}
```

### Built-in Adapters

#### Claude Code Adapter

```typescript
// daemon/adapters/claude-code.ts
const claudeCodeAdapter: HarnessAdapter = {
  id: "claude-code",
  name: "Claude Code",

  getWatchPaths() {
    return [path.join(os.homedir(), ".claude", "projects")];
  },

  canHandle(filePath: string) {
    // Claude Code stores sessions as JSONL in ~/.claude/projects/<slug>/<id>.jsonl
    return filePath.includes("/.claude/projects/") && filePath.endsWith(".jsonl");
  },

  getSessionInfo(filePath: string) {
    // Path format: ~/.claude/projects/-Users-me-myproject/abc123.jsonl
    const parts = filePath.split("/");
    const projectSlug = parts[parts.length - 2];
    const sessionFile = parts[parts.length - 1];

    return {
      localPath: filePath,
      projectPath: projectSlug.replace(/-/g, "/"),  // Decode slug
      harnessSessionId: sessionFile.replace(".jsonl", ""),
    };
  },

  parseLine(line: string, context: ParseContext) {
    const item = JSON.parse(line);

    // Handle tool_result - attach to pending tool_use
    if (item.type === "tool_result") {
      const pending = context.pendingToolUses.get(item.tool_use_id);
      if (pending) {
        // Attach result to existing message
        const msg = context.messages[pending.messageIndex];
        msg.content_blocks.push({
          type: "tool_result",
          tool_use_id: item.tool_use_id,
          content: item.content,
          is_error: item.is_error,
        });
        context.pendingToolUses.delete(item.tool_use_id);
      }
      return null; // Don't emit as separate message
    }

    // Handle user/assistant messages
    const msgData = item.message || item;
    const role = normalizeRole(msgData.role || item.type);
    if (!role) return null;

    const contentBlocks = parseContentBlocks(msgData.content);

    // Track pending tool_uses
    const messageIndex = context.messages.length;
    contentBlocks.forEach((block, blockIndex) => {
      if (block.type === "tool_use") {
        context.pendingToolUses.set(block.id, { messageIndex, blockIndex });
      }
    });

    return [{
      role,
      content_blocks: contentBlocks,
      timestamp: item.timestamp,
    }];
  },

  deriveTitle(messages: NormalizedMessage[]) {
    // Use first user message as title
    const firstUser = messages.find(m => m.role === "user");
    if (firstUser) {
      const text = firstUser.content_blocks
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join(" ");
      return text.slice(0, 80) + (text.length > 80 ? "..." : "");
    }
    return "Untitled Session";
  },
};
```

#### Cursor Adapter (Example)

```typescript
// daemon/adapters/cursor.ts
const cursorAdapter: HarnessAdapter = {
  id: "cursor",
  name: "Cursor",

  getWatchPaths() {
    // Cursor stores conversation history differently
    return [path.join(os.homedir(), ".cursor", "conversations")];
  },

  canHandle(filePath: string) {
    return filePath.includes("/.cursor/conversations/") && filePath.endsWith(".json");
  },

  getSessionInfo(filePath: string) {
    // Extract project path from Cursor's format
    // ... implementation specific to Cursor's storage
  },

  parseLine(line: string, context: ParseContext) {
    // Cursor may use different message formats
    // Normalize to common NormalizedMessage format
    // ... implementation specific to Cursor's format
  },
};
```

#### Adding a New Adapter

To support a new harness:

1. Create `daemon/adapters/<harness-name>.ts`
2. Implement the `HarnessAdapter` interface
3. Register in `daemon/adapters/index.ts`
4. Document the harness's session storage format

```typescript
// daemon/adapters/index.ts
import { claudeCodeAdapter } from "./claude-code";
import { cursorAdapter } from "./cursor";

export const adapters: HarnessAdapter[] = [
  claudeCodeAdapter,
  cursorAdapter,
  // Add new adapters here
];

export function getAdapterForPath(filePath: string): HarnessAdapter | null {
  return adapters.find(a => a.canHandle(filePath)) || null;
}
```

### Daemon Configuration

```typescript
// daemon/config.ts
interface DaemonConfig {
  server: string;              // Archive server URL
  harnesses: string[];         // Which harnesses to watch (default: all)
  idleTimeout: number;         // Seconds before marking complete (default: 60)
  customWatchPaths?: string[]; // Additional paths to watch
}

// Example configuration
const config: DaemonConfig = {
  server: "http://localhost:3000",
  harnesses: ["claude-code"],  // Only watch Claude Code
  idleTimeout: 60,
};
```

### Daemon State Machine

```
                          ┌───────────────────┐
                          │                   │
       file created       │    WATCHING       │◀─────────────────┐
  ────────────────────▶   │  (all adapters)   │                  │
                          │                   │                  │
                          └───────────────────┘                  │
                                   │                             │
                                   │ adapter.canHandle()         │
                                   │ returns true                │
                                   ▼                             │
                          ┌───────────────────┐                  │
                          │                   │                  │
                          │    STREAMING      │                  │
                          │   via adapter     │                  │ session
                          │                   │                  │ ended
                          └───────────────────┘                  │
                                   │                             │
                                   │ 60s idle / exit signal      │
                                   ▼                             │
                          ┌───────────────────┐                  │
                          │                   │                  │
                          │    FINALIZING     │──────────────────┘
                          │  capture diff     │
                          │                   │
                          └───────────────────┘
```

### Active Session Tracking

```typescript
interface ActiveSession {
  adapter: HarnessAdapter;     // Which adapter is handling this session
  localPath: string;           // Path to session file
  sessionId: string;           // Server-assigned session ID
  streamToken: string;         // Auth token for pushes
  lastLineRead: number;        // Line offset for tailing
  lastActivity: Date;          // For idle detection
  parseContext: ParseContext;  // Accumulated parsing state
}
```

### File Watching Strategy

Use `fs.watch` or `chokidar` to detect changes across all adapter watch paths:

1. **New session file created** → Find matching adapter, create live session
2. **File modified** → Parse new lines via adapter, push normalized messages
3. **File deleted / renamed** → Mark session complete

```typescript
// Pseudocode
async function watchSession(filePath: string) {
  const adapter = getAdapterForPath(filePath);
  if (!adapter) return; // No adapter for this file

  const sessionInfo = adapter.getSessionInfo(filePath);

  // Create session on server
  const { id, streamToken } = await createLiveSession({
    title: "Live Session",  // Will be updated after parsing
    project_path: sessionInfo.projectPath,
    harness_session_id: sessionInfo.harnessSessionId,
    harness: adapter.id,
    model: sessionInfo.model,
    repo_url: sessionInfo.repoUrl,
  });

  const parseContext: ParseContext = {
    messages: [],
    pendingToolUses: new Map(),
  };

  // Tail the file
  const watcher = new Tail(filePath);

  watcher.on('line', async (line: string) => {
    const normalized = adapter.parseLine(line, parseContext);
    if (normalized) {
      parseContext.messages.push(...normalized);
      await pushMessages(id, streamToken, normalized);

      // Update title after first few messages
      if (parseContext.messages.length === 3 && adapter.deriveTitle) {
        const title = adapter.deriveTitle(parseContext.messages);
        await updateSessionTitle(id, streamToken, title);
      }
    }
    updateLastActivity();
  });

  // Idle timeout
  setInterval(async () => {
    const ended = adapter.detectSessionEnd
      ? await adapter.detectSessionEnd(filePath)
      : false;

    if (ended || Date.now() - lastActivity > IDLE_TIMEOUT) {
      await finishSession(id, streamToken);
      watcher.stop();
    }
  }, 10000);
}
```

### Diff Capture

The daemon captures and pushes the git diff after each file-modifying tool call (Write, Edit, NotebookEdit). This provides real-time diff updates as the session progresses.

```typescript
async function captureAndPushDiff(sessionId: string, streamToken: string, projectPath: string) {
  // Get diff: staged + unstaged changes
  const diff = await exec(`git diff HEAD`, { cwd: projectPath });

  // Also include untracked files in session scope
  const untrackedDiff = await captureUntrackedDiff(projectPath);

  await pushDiff(sessionId, streamToken, diff + untrackedDiff);
}

// Called when adapter detects a file-modifying tool call
function onFileModifyingToolResult(toolName: string, filePath: string) {
  if (["Write", "Edit", "NotebookEdit"].includes(toolName)) {
    // Debounce to avoid rapid successive calls
    debouncedCaptureAndPushDiff();
  }
}
```

**Diff timing:** On write (after each file-modifying tool call)
- Provides real-time diff updates in the browser
- Debounced to handle rapid successive writes
- Final diff also captured on session complete

### Error Handling

| Error | Recovery |
|-------|----------|
| Server unreachable | Buffer messages locally, retry with backoff |
| Auth token expired | Re-authenticate (shouldn't happen for live sessions) |
| Session already complete | Log warning, stop watching |
| JSONL parse error | Skip malformed line, continue |
| File watch error | Attempt re-watch, give up after N failures |

### Local Buffering

When the server is unreachable, buffer messages locally:

```typescript
interface BufferedMessage {
  sessionId: string;
  message: unknown;
  timestamp: Date;
}

const buffer: BufferedMessage[] = [];

async function pushWithRetry(sessionId: string, messages: unknown[]) {
  try {
    await pushMessages(sessionId, messages);
    // Flush buffer on success
    await flushBuffer();
  } catch (e) {
    if (isNetworkError(e)) {
      buffer.push(...messages.map(m => ({ sessionId, message: m, timestamp: new Date() })));
    } else {
      throw e;
    }
  }
}
```

---

## Browser-Side Changes

### Session Detail View Updates

The session detail view gains live session capabilities:

```typescript
interface SessionDetailData {
  // ... existing fields
  status: SessionStatus;
  last_activity_at: string | null;
}
```

### Live Indicator

Live sessions display a pulsing indicator in the header:

```
┌────────────────────────────────────────────────────────────────────┐
│  ● LIVE  Session Title · project · started 5m ago     [PR] [Share] │
└────────────────────────────────────────────────────────────────────┘
```

**Styling:**
- Indicator: `●` with `animate-pulse` in `text-green-500`
- Label: `LIVE` in `text-xs font-bold uppercase tracking-wide text-green-500`
- Duration: "started Xm ago" instead of fixed date

### Real-Time Message Rendering

```typescript
// Client-side WebSocket subscription
function subscribeToSession(sessionId: string, fromIndex?: number) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/api/sessions/${sessionId}/ws`);

  let lastIndex = fromIndex ?? -1;

  ws.onopen = () => {
    // Optionally resume from a specific index
    if (fromIndex !== undefined) {
      ws.send(JSON.stringify({ type: 'subscribe', from_index: fromIndex }));
    }
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case 'connected':
        lastIndex = data.last_index;
        break;

      case 'message':
        lastIndex = data.index;
        appendMessage(data.messages);
        scrollToBottom();
        break;

      case 'tool_result':
        updateToolResult(data.tool_use_id, data.content);
        break;

      case 'diff':
        updateDiffPanel(data);
        break;

      case 'complete':
        setSessionStatus('complete');
        ws.close();
        break;

      case 'error':
        console.error('WebSocket error:', data.message);
        break;
    }
  };

  ws.onclose = (event) => {
    if (event.code !== 1000) {
      // Unexpected close, attempt reconnect
      setTimeout(() => subscribeToSession(sessionId, lastIndex), 1000);
    }
  };

  return ws;
}
```

### Pending Tool Calls

Live sessions may have tool calls awaiting results:

```
┌─────────────────────────────────────────┐
│ ▶ Read  src/config.ts  ⋯                │  ← spinner or dots
└─────────────────────────────────────────┘
```

When result arrives:
```
┌─────────────────────────────────────────┐
│ ▶ Read  src/config.ts  ✓                │
└─────────────────────────────────────────┘
```

### Auto-Scroll Behavior

- **Auto-scroll enabled** (default): New messages scroll into view
- **User scrolled up**: Pause auto-scroll, show "New messages ↓" button
- **Click button / scroll to bottom**: Resume auto-scroll

```typescript
function handleNewMessage(message: Message) {
  appendToDOM(message);

  if (isNearBottom()) {
    scrollToBottom({ behavior: 'smooth' });
  } else {
    showNewMessagesButton();
  }
}

function isNearBottom(): boolean {
  const panel = document.querySelector('.conversation-panel');
  const threshold = 100; // px
  return panel.scrollHeight - panel.scrollTop - panel.clientHeight < threshold;
}
```

### Typing Indicator

While Claude is thinking (tool_use in progress but no result yet):

```
┌─────────────────────────────────────────┐
│ CLAUDE                                  │
│                                         │
│ ▶ Read  package.json  ⋯                 │
│                                         │
│ ● Claude is working...                  │  ← typing indicator
└─────────────────────────────────────────┘
```

**Timing:**
- Show after 500ms of pending tool call
- Hide when result arrives or new text content appears

---

## Security Considerations

### Stream Token

- Generated using `crypto.randomBytes(32).toString('hex')`
- Only the hash is stored: `sha256(token)`
- Transmitted over HTTPS only
- Invalid after session completes
- One token per session (not reusable)

### Rate Limiting

Apply rate limits to prevent abuse:

| Endpoint | Limit |
|----------|-------|
| `POST /api/sessions/live` | 10/minute per IP |
| `POST /api/sessions/:id/messages` | 60/minute per session |
| `WebSocket /api/sessions/:id/ws` | 100 concurrent connections total |

### WebSocket Connection Limits

- Max 100 concurrent WebSocket connections per server
- Per-IP limit: 10 concurrent subscriptions
- Connections closed after 1 hour (client should reconnect)
- Idle connections (no messages for 5 minutes) may be closed

### Sensitive Data Scrubbing

> **Important:** Session content may contain sensitive data that should not be stored or transmitted.

Tool results and message content may inadvertently contain:
- API keys and tokens (e.g., from environment variables, config files)
- Passwords and credentials
- Private keys and certificates
- Personal identifiable information (PII)
- Internal URLs and endpoints

**Mitigation strategies:**

1. **Daemon-side scrubbing**: Before pushing messages, the daemon should scan tool results for common secret patterns:
   - Environment variable values matching `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`
   - Base64-encoded strings that look like keys
   - Known secret formats (AWS keys, GitHub tokens, etc.)

2. **Configurable redaction**: Allow users to specify additional patterns to redact via daemon config:
   ```typescript
   interface DaemonConfig {
     // ... existing fields
     redactPatterns?: RegExp[];  // Additional patterns to scrub
     redactEnvVars?: string[];   // Env var names to always redact
   }
   ```

3. **User awareness**: Display a warning when starting the daemon that session content will be transmitted to the server.

4. **Phase 2 consideration**: When access control is implemented, ensure sensitive sessions can be restricted to authorized viewers only.

**Implementation note:** Start with a basic set of well-known secret patterns. This is not foolproof—users should be aware that sessions may contain sensitive data and configure access controls appropriately.

---

## Implementation Phases

### Phase 1: Core Streaming (MVP)

**Server:**
- [ ] Add `status`, `last_activity_at` columns to sessions table
- [ ] `POST /api/sessions/live` - create live session
- [ ] `POST /api/sessions/:id/messages` - push messages
- [ ] `POST /api/sessions/:id/complete` - end session
- [ ] `WebSocket /api/sessions/:id/ws` - WebSocket subscription
- [ ] Session timeout (60s idle → complete)

**Daemon:**
- [ ] Basic file watching with `fs.watch`
- [ ] Session detection (new JSONL file)
- [ ] JSONL tailing and parsing
- [ ] Message push to server
- [ ] Idle detection and completion

**Browser:**
- [ ] WebSocket subscription on session detail page
- [ ] Live indicator in header
- [ ] Real-time message append
- [ ] Auto-scroll behavior

### Phase 2: Robustness

**Server:**
- [ ] Rate limiting
- [ ] WebSocket reconnection with `from_index`
- [ ] Connection limits

**Daemon:**
- [ ] Local message buffering
- [ ] Retry with exponential backoff
- [ ] Graceful shutdown (mark sessions complete)
- [ ] `daemon status` command

**Browser:**
- [ ] Pending tool call indicators
- [ ] Typing indicator
- [ ] Connection status indicator
- [ ] Reconnection handling

### Phase 3: Polish

**Server:**
- [ ] `PUT /api/sessions/:id/diff` - push diff updates
- [ ] `GET /api/sessions/live` - list live sessions
- [ ] Diff relevance detection for live sessions

**Daemon:**
- [ ] Periodic diff capture
- [ ] Final diff on session complete
- [ ] Multi-session support (watch multiple projects)
- [ ] CLI configuration (`daemon config`)

**Browser:**
- [ ] Live diff updates
- [ ] "New messages" button when scrolled up
- [ ] Live session list on homepage

---

## Design Decisions

Resolved questions about the streaming architecture:

1. **Multi-daemon scenario**: First wins. Server rejects `POST /api/sessions/live` if a session with the same `harness_session_id` already exists and is live. Treat it like a lock.

2. **Session ownership**: No user association for now. Will revisit in Phase 2 (access control).

3. **Diff strategy**: On write. Capture and push diff after each file-modifying tool call (Write, Edit, NotebookEdit), debounced. Also capture final diff on session complete.

4. **Title derivation**: Wait for first user message. Use `adapter.deriveTitle()` after parsing the first few messages.

5. **Heartbeat**: Yes. Daemon sends periodic heartbeats to keep session alive. Server uses heartbeats + message activity to detect idle sessions.

6. **Resume interrupted streams**: Messages are stored on server. If daemon loses connection, it can idempotently re-send messages (server deduplicates by message index). Daemon tracks `lastLineRead` locally for file tailing, but doesn't need persistent state for server sync.

7. **Non-appendable file formats**: Leave to adapters. Each adapter is responsible for implementing appropriate file watching strategy for its harness's format.

8. **Content block normalization**: Start with Claude Code as the reference format. Evaluate how much tweaking is needed when adding other harnesses. May introduce `harness_specific` block type if needed.

9. **Model detection**: Infer from session metadata where available. This is harness-specific—adapters should extract model info from their harness's session format.

---

## Open Questions

1. **Harness auto-detection**: How to handle unknown session files in watched directories?
   - Ignore files no adapter claims
   - Log warning for visibility
   - Support a "generic JSONL" fallback adapter
   - *Deferred until we have more harness experience*

2. **Heartbeat interval**: How often should daemon send heartbeats?
   - Every 30s seems reasonable
   - Should match the idle timeout logic on server

3. **Message deduplication**: How to handle idempotent re-sends?
   - Server rejects messages with `message_index` <= last stored index
   - Or: Server accepts and deduplicates by content hash

---

## Appendix: Harness Session Formats

### Claude Code (JSONL)

Reference for parsing session files:

```jsonl
{"type":"user","message":{"role":"user","content":"Please read package.json"},"timestamp":"2025-01-11T10:00:00Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll read that file."},{"type":"tool_use","id":"tu_001","name":"Read","input":{"file_path":"package.json"}}]},"timestamp":"2025-01-11T10:00:01Z"}
{"type":"tool_result","tool_use_id":"tu_001","content":"{\"name\":\"myproject\"...}"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The package.json contains..."}]},"timestamp":"2025-01-11T10:00:02Z"}
```

**Key parsing rules:**
- `type: "user"` → User message
- `type: "assistant"` → Claude message (may contain tool_use blocks)
- `type: "tool_result"` → Matches to preceding tool_use by `tool_use_id`
- `message.content` may be string or array of content blocks

**Location:** `~/.claude/projects/<project-slug>/<session-id>.jsonl`

### Cursor (TBD)

> Format to be documented after research.

**Location:** `~/.cursor/conversations/` (needs verification)

### Windsurf (TBD)

> Format to be documented after research.

### Other Harnesses

When adding support for a new harness:

1. Document the session file location and format here
2. Identify how to detect session boundaries (start/end)
3. Map message types to the normalized `NormalizedMessage` format
4. Note any harness-specific considerations (e.g., non-JSONL format, binary data)
