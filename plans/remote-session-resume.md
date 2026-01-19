# Remote Session Resumption

> **Status:** Future feature (deferred)
> **Spec reference:** [specs/browser_initiated_sessions.md](../specs/browser_initiated_sessions.md)

## Overview

When a daemon disconnects while a remote (browser-initiated) session is in progress, the session shows as "disconnected" in the browser. This plan enables users to resume such sessions from the browser when the daemon reconnects.

The resume flow:
1. User views a disconnected session in the browser
2. Daemon reconnects to the server
3. Browser detects daemon is available and shows "Resume" button
4. User clicks "Resume"
5. Server sends `start_session` with `resume_session_id` to daemon
6. Daemon spawns `claude --resume <claude_session_id>`
7. Session continues in the browser with message history preserved

## Dependencies

- **Remote session flag:** `remote` field on sessions (see `plans/remote-session-flag.md`)
- Claude Code's `--resume` flag (already supported)

## Key Changes

### 1. Preserve Recovery Info on Disconnect

**File:** `src/lib/daemon-connections.ts`

When daemon disconnects, preserve `claudeSessionId` for resumption instead of just marking as failed.

### 2. Add "disconnected" Status

**File:** `src/lib/spawned-session-registry.ts`

Add `"disconnected"` to `SpawnedSessionStatus` type.

### 3. Resume Session API Endpoint

**File:** `src/routes/api.ts`

```typescript
POST /api/sessions/:id/resume
```

- Validates session is in "disconnected" state
- Validates daemon is connected
- Validates recovery info exists
- Sends `start_session` with `resume_session_id` to daemon

### 4. UI Changes

**File:** `src/client/components/ConnectionLostBanner.tsx`

- Add "Resume Session" button
- Show when `canResume && daemonConnected`
- Disable while resuming

**File:** `src/client/hooks/useSpawnedSession.ts`

- Poll daemon status when disconnected
- Track `canResume` from `daemon_disconnected` message
- Add `resumeSession()` function

### 5. Daemon Changes

**File:** `cli/lib/spawned-session-manager.ts`

- Skip sending initial prompt when `resume_session_id` is present (already has flag support)

## State Transitions

```
[running] --(daemon disconnect)--> [disconnected]
[disconnected] --(user clicks Resume)--> [starting]
[starting] --(claude init)--> [running]
[starting] --(resume fails)--> [failed]
[disconnected] --(user ends session)--> [ended]
```

## Edge Cases

1. **Invalid claude_session_id:** Claude Code's `--resume` fails → show error
2. **Session cwd no longer exists:** Daemon validation fails → show error
3. **Daemon disconnects during resume:** Back to "disconnected" state
4. **Session expired in Claude Code:** Resume fails → offer to start new session

## Files to Modify

| File | Description |
|------|-------------|
| `src/lib/spawned-session-registry.ts` | Add "disconnected" status |
| `src/lib/daemon-connections.ts` | Preserve recovery info on disconnect |
| `src/routes/api.ts` | Add `resumeSession` endpoint |
| `src/server.ts` | Register resume route |
| `src/types/daemon-ws.ts` | Add resume-related message types |
| `src/client/hooks/useSpawnedSession.ts` | Add resume logic and daemon polling |
| `src/client/components/ConnectionLostBanner.tsx` | Add Resume button |
| `src/client/components/SpawnedSessionView.tsx` | Wire up resume props |

## Acceptance Criteria

- [ ] Disconnected sessions preserve `claudeSessionId` in recovery info
- [ ] Resume button appears when daemon connected and session resumable
- [ ] `POST /api/sessions/:id/resume` works correctly
- [ ] Daemon spawns claude with `--resume` flag
- [ ] Session continues with existing message history
- [ ] Edge cases handled gracefully
