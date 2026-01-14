# Interactive Sessions Architecture

Reference: [interactive_sessions.md](./interactive_sessions.md)

## Design Decisions (from clarifications)

1. **Platform**: POSIX-only initially (Bun/node-pty), Windows support deferred
2. **State Detection**: Pattern matching + inactivity timeout (Claude accepts input anytime, state is informational)
3. **Approval UX**: Notification first, full prompt on user interaction (Option C)
4. **MVP Scope**: Follow-up prompts only (diff comments/suggested edits deferred)
5. **Hot-Upgrade**: Wrapper can attach to existing daemon session via `--resume`
6. **Authentication**: Wrapper uses same stream_token as daemon

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Browser                                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Session Viewer                                                   │   │
│  │  - Conversation display (existing)                                │   │
│  │  - Diff panel (existing)                                          │   │
│  │  - FeedbackInput component (new)                                  │   │
│  │  - Claude state indicator (new)                                   │   │
│  │  - Wrapper connection status (new)                                │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │ WebSocket                                 │
└──────────────────────────────┼──────────────────────────────────────────┘
                               │
┌──────────────────────────────┼──────────────────────────────────────────┐
│                           Server                                         │
│  ┌───────────────────────────┴─────────────────────────────────────┐   │
│  │  /ws/:sessionId (viewer)          /api/sessions/:id/wrapper     │   │
│  │  - Message streaming              - Wrapper WebSocket            │   │
│  │  - Diff updates                   - Feedback relay               │   │
│  │  - State broadcasts               - State updates                │   │
│  └───────────────────────────┬─────────────────────────────────────┘   │
│                              │                                           │
│  ┌───────────────────────────┴─────────────────────────────────────┐   │
│  │  Database                                                         │   │
│  │  - sessions (+ interactive, wrapper_connected columns)           │   │
│  │  - feedback_messages (new table)                                 │   │
│  │  - messages, diffs (existing)                                    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ Wrapper WebSocket
┌──────────────────────────────┼──────────────────────────────────────────┐
│                         Local Machine                                    │
│  ┌───────────────────────────┴─────────────────────────────────────┐   │
│  │  PTY Wrapper (archive wrap)                                       │   │
│  │  - Spawns Claude in PTY                                          │   │
│  │  - Local stdin → PTY                                             │   │
│  │  - PTY → local stdout + server                                   │   │
│  │  - Server feedback → approval prompt → PTY                       │   │
│  └───────────────────────────┬─────────────────────────────────────┘   │
│                              │ PTY                                       │
│  ┌───────────────────────────┴─────────────────────────────────────┐   │
│  │  Claude Code                                                      │   │
│  │  - TUI preserved                                                  │   │
│  │  - Receives injected input                                        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Daemon (optional, can coexist)                                   │   │
│  │  - Watches JSONL                                                  │   │
│  │  - Streams messages (backup/redundancy)                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Component Design

### 1. PTY Wrapper (`cli/start.ts`)

**Responsibilities:**
- Spawn Claude Code in a pseudo-terminal
- Passthrough local stdin/stdout (preserve TUI)
- Stream output to server (message extraction)
- Connect to wrapper WebSocket for feedback
- Show approval prompts for remote feedback
- Detect and broadcast Claude state (idle/running)

**Usage:**
```bash
# Start fresh
archive start claude "implement feature X"

# Resume existing Claude session (hot-upgrade)
archive start claude --resume abc123

# Attach to existing archive session
archive start --session <archive-session-id> claude --resume abc123
```

**State Detection Algorithm:**
```
STATE = "running"
LAST_OUTPUT_TIME = now()
PROMPT_DETECTED = false

on_pty_output(data):
  LAST_OUTPUT_TIME = now()
  STATE = "running"

  if matches_prompt_pattern(data):
    PROMPT_DETECTED = true

every 500ms:
  if PROMPT_DETECTED and (now() - LAST_OUTPUT_TIME) > 2 seconds:
    STATE = "idle"
    broadcast_state("idle")
  else if STATE == "idle" and (now() - LAST_OUTPUT_TIME) < 500ms:
    STATE = "running"
    PROMPT_DETECTED = false
    broadcast_state("running")
```

Prompt patterns to detect:
- `╰─❯` (Claude Code default)
- `❯` (alternative)
- `> ` (generic)
- End of thinking block without new output

**Approval Flow:**

1. Remote feedback arrives via WebSocket
2. Store in pending queue, show notification:
   ```
   📩 Remote feedback pending (1) - press Ctrl+F to review
   ```
3. When user presses Ctrl+F (or Claude is idle for 5s), show full prompt:
   ```
   ┌─ Remote Feedback ────────────────────────────────────┐
   │ From: Browser User                                    │
   │                                                       │
   │ Can you also add error handling for the edge case    │
   │ where the file doesn't exist?                        │
   └──────────────────────────────────────────────────────┘

   [a]pprove  [r]eject  [v]iew full  [e]dit  [s]kip for now
   ```
4. On approve: inject into PTY, mark as sent
5. On reject: mark as rejected, notify browser

**Dependencies:**
- `node-pty` for PTY management (cross-platform foundation)
- Existing `cli/daemon.ts` patterns for server communication

### 2. Server Relay

**New WebSocket Endpoint: `/api/sessions/:id/wrapper`**

Authentication: Same stream_token as daemon (Bearer token)

Protocol:
```typescript
// Server → Wrapper
type WrapperServerMessage =
  | { type: "connected"; session_id: string; pending_feedback: FeedbackMessage[] }
  | { type: "feedback"; id: number; content: string; sender_name: string | null }
  | { type: "feedback_cancelled"; id: number };

// Wrapper → Server
type WrapperClientMessage =
  | { type: "state"; state: "idle" | "running" }
  | { type: "feedback_approved"; id: number }
  | { type: "feedback_rejected"; id: number; reason?: string }
  | { type: "feedback_sent"; id: number };
```

**New API Endpoints:**
```
POST   /api/sessions/:id/feedback     - Submit feedback (browser)
GET    /api/sessions/:id/feedback     - Get feedback status (browser)
DELETE /api/sessions/:id/feedback/:fid - Cancel pending feedback (browser)
```

**Broadcast Enhancements:**

Extend existing viewer WebSocket messages:
```typescript
type ViewerServerMessage =
  | { type: "connected"; ...; wrapper_connected: boolean; claude_state: string }
  | { type: "wrapper_status"; connected: boolean }
  | { type: "claude_state"; state: "idle" | "running" }
  | { type: "feedback_status"; id: number; status: string }
  // ... existing message types
```

### 3. Database Schema

**New columns on `sessions`:**
```sql
ALTER TABLE sessions ADD COLUMN interactive INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN wrapper_connected INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN claude_state TEXT DEFAULT 'unknown';
```

**New table `feedback_messages`:**
```sql
CREATE TABLE feedback_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  sender_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  -- pending: awaiting local approval
  -- approved: local user approved
  -- rejected: local user rejected
  -- sent: injected into Claude
  -- cancelled: browser user cancelled
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  rejection_reason TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_feedback_session ON feedback_messages(session_id);
CREATE INDEX idx_feedback_status ON feedback_messages(status);
```

### 4. Browser UI (MVP)

**FeedbackInput Component:**
```
┌─────────────────────────────────────────────────────────────────┐
│ 💬 Send follow-up to Claude                                      │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Can you also add tests for this feature?                    │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                               [Send to Claude]   │
│                                                                  │
│ ℹ️ Requires approval from the session owner                      │
└─────────────────────────────────────────────────────────────────┘
```

Disabled states:
- Wrapper not connected: "Wrapper not connected - follow-ups unavailable"
- Session complete: Hidden entirely

**State Indicators:**
```
┌─ Header ─────────────────────────────────────────────────────────┐
│ 🟢 LIVE  │  claude-code  │  opus-4  │  my-project  │  2m ago    │
│          │               │          │              │             │
│ 🔌 Wrapper connected  •  Claude is idle                          │
└─────────────────────────────────────────────────────────────────┘
```

States:
- `🔌 Wrapper connected • Claude is idle` (green)
- `🔌 Wrapper connected • Claude is working...` (yellow/animated)
- `📴 Wrapper not connected` (gray)

**Feedback Status in Conversation:**

Pending feedback appears at the end of conversation:
```
┌─ Your Follow-up (pending approval) ──────────────────────────────┐
│ Can you also add tests for this feature?                         │
│                                                      [Cancel]    │
└─────────────────────────────────────────────────────────────────┘
```

After approval/rejection:
```
┌─ Your Follow-up (sent ✓) ────────────────────────────────────────┐
│ Can you also add tests for this feature?                         │
└─────────────────────────────────────────────────────────────────┘

┌─ Your Follow-up (rejected) ──────────────────────────────────────┐
│ Can you also add tests for this feature?                         │
│ Reason: "Not relevant to current task"                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Hot-Upgrade Flow

**Scenario: Daemon session → Wrapper interactive**

1. User is running Claude normally, daemon is streaming session S
2. User decides they want interactive features
3. User interrupts Claude (Ctrl+C) or waits for idle
4. User runs: `archive start --session S claude --resume <claude-session-id>`
5. Wrapper:
   - Connects to server's wrapper WebSocket with session S
   - Server validates stream_token, marks `wrapper_connected = true`
   - Spawns Claude with `--resume`
   - Begins PTY I/O and feedback handling
6. Daemon (if still running):
   - Continues watching JSONL as backup
   - Server deduplicates message pushes
   - Both can coexist safely

**Deduplication Strategy:**

Messages are deduplicated by content hash + timestamp:
```typescript
function messageKey(msg: Message): string {
  return `${msg.role}:${msg.timestamp}:${hash(msg.content.slice(0, 100))}`;
}
```

---

## Implementation Phases

### Phase A: PTY Wrapper Core
1. Add `start` command to CLI
2. Implement PTY spawning with node-pty
3. Implement stdin/stdout passthrough
4. Implement basic server connection (reuse daemon patterns)
5. Implement output streaming

### Phase B: Wrapper WebSocket & State
1. Add wrapper WebSocket endpoint to server
2. Implement state detection in wrapper
3. Broadcast state to viewers
4. Add database columns

### Phase C: Feedback Flow
1. Add feedback_messages table
2. Add feedback API endpoints
3. Implement approval flow in wrapper
4. Implement input injection

### Phase D: Browser UI
1. Add FeedbackInput component
2. Add state/connection indicators
3. Handle feedback lifecycle display
4. Update LiveSessionManager for new message types

---

## Security Considerations

1. **Same stream_token**: Wrapper uses daemon's token, ensuring only authorized CLI can connect
2. **Local approval required**: All remote input must be approved by local user
3. **No auto-injection**: Even "safe" messages require explicit approval
4. **Feedback audit trail**: All feedback stored with status history

---

## Testing Strategy

1. **Unit tests**: State detection, message deduplication, approval flow logic
2. **Integration tests**: Wrapper ↔ Server communication
3. **E2E tests**: Browser → Server → Wrapper → Claude flow
4. **Manual testing**: TUI preservation, multi-viewer scenarios
