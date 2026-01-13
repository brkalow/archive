# Plan: Incremental Diff Uploads During Live Sessions

## Summary

Implement diff capture and upload in the daemon so that during a live session, the current git diff is pushed to the server after file-modifying tool calls. This enables real-time diff viewing in the browser as the session progresses.

## Current State

- `ApiClient.pushDiff()` exists but is never called (cli/daemon/api-client.ts:199)
- Server endpoint `PUT /api/sessions/:id/diff` is implemented and working (src/routes/api.ts:696)
- `SessionTracker` tracks active sessions but doesn't capture or push diffs
- The adapter provides `projectPath` via `getSessionInfo()` but it's not stored in `ActiveSession`

## Implementation

### 1. Store project path in ActiveSession

**File:** `cli/daemon/session-tracker.ts`

Add `projectPath` to the `ActiveSession` interface and populate it during `startSession()`:

```typescript
interface ActiveSession {
  // ... existing fields
  projectPath: string;  // Add this
}
```

In `startSession()`, store it:
```typescript
const session: ActiveSession = {
  // ... existing
  projectPath: sessionInfo.projectPath,
};
```

### 2. Create git diff capture utility

**File:** `cli/lib/git.ts` (new file)

Create a utility to capture the current diff:

```typescript
export async function captureGitDiff(projectPath: string): Promise<string | null> {
  // Check if directory is a git repo
  // Run: git diff HEAD
  // Optionally capture untracked files in session scope
  // Return combined diff or null if not a git repo / error
}
```

### 3. Add debounced diff capture to SessionTracker

**File:** `cli/daemon/session-tracker.ts`

Add:
- A `diffDebounceTimer` field to `ActiveSession`
- A constant for debounce delay (e.g., 2000ms)
- Method `scheduleDiffCapture(session)` - debounces and triggers diff capture
- Method `captureAndPushDiff(session)` - captures diff and calls `api.pushDiff()`

### 4. Detect file-modifying tool calls

**File:** `cli/daemon/session-tracker.ts`

In `handleLine()`, after successfully pushing messages, check if any of the parsed messages contain `tool_use` blocks with names in `["Write", "Edit", "NotebookEdit"]`. If so, schedule a diff capture.

```typescript
const FILE_MODIFYING_TOOLS = ["Write", "Edit", "NotebookEdit"];

// After pushing messages
for (const msg of messages) {
  for (const block of msg.content_blocks) {
    if (block.type === "tool_use" && FILE_MODIFYING_TOOLS.includes(block.name)) {
      this.scheduleDiffCapture(session);
      break;
    }
  }
}
```

### 5. Capture final diff on session end

**File:** `cli/daemon/session-tracker.ts`

In `endSession()`, before calling `api.completeSession()`:
1. Cancel any pending debounce timer
2. Capture one final diff
3. Pass the final diff to `completeSession()` (which accepts `final_diff` parameter)

## Files to Modify

| File | Change |
|------|--------|
| `cli/daemon/session-tracker.ts` | Add projectPath storage, diff detection, debouncing, and capture |
| `cli/lib/git.ts` | New file - git diff capture utility |

## Verification

1. Start the dev server: `PORT=$PORT bun run dev`
2. Start the daemon: `bun run cli/index.ts daemon start --server http://localhost:$PORT`
3. Start a Claude Code session in a git repo
4. Make file changes via Claude's Write/Edit tools
5. Verify in browser that diff appears and updates as files change
6. Let session idle-complete or stop daemon
7. Verify final diff is captured
