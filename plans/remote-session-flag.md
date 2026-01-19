# Plan: Fix Spawned Session Identification with Dedicated `remote` Flag

## Problem Statement

When a daemon disconnects, spawned (remote) sessions should retain their behavior. The `interactive` flag cannot be used to identify spawned sessions because TUI sessions can also become interactive via `/collaborate`.

**Key distinction:**
- **Remote sessions**: Headless, spawned by daemon, real-time WebSocket relay
- **Interactive TUI sessions**: Has local terminal, asynchronous feedback polling via Stop hook

**Relationship:**
- Remote sessions are always interactive (when daemon is connected)
- Non-remote sessions can become interactive via `/collaborate`

## Semantics of `remote`

**`remote` is dynamic (execution-mode based):**
- `remote: true` = Session is currently running headless via daemon/browser
- `remote: false` = Session is running in TUI or is an upload

**Transitions:**
- Browser spawns session → `remote: true`
- Remote session opened in TUI → `remote: false` (downgrade)
- TUI session stays TUI → `remote: false` (never changes)

This means `remote` reflects the *current* execution context, not the origin.

## Root Cause

When the daemon disconnects:
1. Session may no longer be in `spawnedSessionRegistry`
2. `getSessionInfo()` at line 1368 returns `type: "archived"` unconditionally for DB sessions
3. Client sees `type: "archived"` and uses `SessionDetailPage` instead of `SpawnedSessionView`
4. Remote badge is not shown, wrong view is rendered

## Solution

Add a dedicated `remote` boolean field to the sessions table and use it to determine session type.

---

## Implementation Plan

### 1. Database Schema Changes

**File**: `src/db/schema.ts`

1. Add migration in `initializeDatabase()`:
```typescript
safeAddColumn(db, "sessions", "remote", "INTEGER DEFAULT 0");
```

2. Add to `Session` type:
```typescript
export type Session = {
  // ... existing fields
  remote: boolean;  // true when session is running headless via daemon/browser
};
```

### 2. Repository Updates

**File**: `src/db/repository.ts`

Update all session creation methods to include `remote`:

1. **Prepared statement** (line ~55):
   - Add `remote` to INSERT column list

2. **`createSession()`** (line ~185):
   - Add `remote` parameter (default `false`)
   - Include in INSERT values

3. **`createSessionWithData()`** (line ~213):
   - Add `remote` to INSERT values

4. **`createSessionWithDataAndReview()`** (line ~653):
   - Add `remote` to INSERT values

5. **`upsertSessionWithDataAndReview()`** (line ~842):
   - Add `remote` to INSERT values

6. **`normalizeSession()`** (line ~388):
   - Add boolean conversion: `remote: Boolean(result.remote)`

### 3. Spawned Session Creation

**File**: `src/routes/api.ts`

In `spawnSession()` handler (~line 1265):
```typescript
repo.createSession({
  // ... existing fields
  interactive: true,
  remote: true,  // Headless session via daemon/browser
});
```

**Important**: `createLiveSession()` should leave `remote: false` (default) for TUI sessions.

### 4. Fix getSessionInfo to Use `remote` Flag (CRITICAL)

**File**: `src/routes/api.ts` (lines 1363-1379)

Change:
```typescript
// Fall back to DB session
const dbSession = repo.getSession(sessionId);
if (dbSession) {
  return json({
    id: dbSession.id,
    type: "archived",  // WRONG: Always returns "archived"
    // ...
  });
}
```

To:
```typescript
// Fall back to DB session
const dbSession = repo.getSession(sessionId);
if (dbSession) {
  return json({
    id: dbSession.id,
    type: dbSession.remote ? "spawned" : "archived",  // Use remote flag
    status: dbSession.status,
    cwd: dbSession.project_path,  // Add cwd for SpawnedSessionView
    harness: dbSession.harness,
    model: dbSession.model,
    // ...
  });
}
```

This ensures that even when a remote session is not in the registry (daemon disconnected), the client still uses `SpawnedSessionView` with the Remote badge.

### 5. WebSocket Upgrade Path

**File**: `src/server.ts` (lines 751-755)

Change:
```typescript
const upgraded = server.upgrade<BrowserWebSocketData>(req, {
  data: { type: "browser", sessionId, isSpawned: session.interactive },
});
```

To:
```typescript
const upgraded = server.upgrade<BrowserWebSocketData>(req, {
  data: { type: "browser", sessionId, isSpawned: session.remote },
});
```

### 6. WebSocket Connected Message

**File**: `src/server.ts`

Update the `connected` message (lines ~804-814 and ~833-841) to include `remote`:
```typescript
ws.send(JSON.stringify({
  type: "connected",
  // ... existing fields
  interactive: true,
  is_spawned: true,  // Keep for backwards compatibility
  remote: true,      // NEW: Explicit remote flag
}));
```

### 7. Type Definition Updates

**File**: `src/types/browser-ws.ts`

Add `remote?: boolean` to the `connected` message type in `ServerToBrowserMessage`.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/db/schema.ts` | Add migration + `remote` to Session type |
| `src/db/repository.ts` | Add `remote` to all create methods + normalizeSession |
| `src/routes/api.ts` | Set `remote: true` in spawnSession(), fix getSessionInfo() |
| `src/server.ts` | Use `session.remote` for `isSpawned`, include in connected message |
| `src/types/browser-ws.ts` | Add `remote` to connected message type |

---

## Existing Changes to Keep

These changes already made are still correct:
- `src/server.ts`: Status derivation logic for disconnected spawned sessions (lines ~791-802)
- `src/server.ts`: Message replay mapping for `result` type (lines ~859-862)
- `src/client/hooks/useSpawnedSession.ts`: Initial state from server status

---

## UI Behavior

The Remote badge is already implemented in `SessionHeader.tsx` and is unconditionally shown when using `SpawnedSessionView`. This is correct because:
1. `SpawnedSessionView` is only used when `sessionInfo.type === 'spawned'`
2. With the fix to `getSessionInfo()`, remote sessions will return `type: "spawned"` even when daemon is disconnected
3. Therefore the Remote badge will be shown correctly

---

## Future: Remote Session Resume

See `plans/remote-session-resume.md` for the deferred plan to allow resuming disconnected remote sessions from the browser.

---

## Verification

1. **Database migration**: Verify `remote` column is added on server start
2. **New spawned session**: Create from browser, verify `remote: true` in DB
3. **Spawned session after disconnect**:
   - Should return `type: "spawned"` from `/api/sessions/:id/info`
   - Should show `SpawnedSessionView` with Remote badge
   - Should show "Disconnected" or appropriate status
4. **TUI interactive session**: Should have `remote: false`, return `type: "archived"`, not show Remote badge
5. **Existing sessions**: Should have `remote: false` (default)
6. **Run tests**: `bun test tests/integration/browser-sessions.test.ts`
