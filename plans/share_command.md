# Implementation Plan: Share Command Feature

## Spec Reference
[specs/share_command.md](../specs/share_command.md)

## Overview

This plan implements the `/share` command for explicit opt-in session sharing, replacing the current auto-upload behavior where the daemon uploads all sessions from allowed repos. Key changes:

1. **CLI**: Add `openctl session share` and `openctl session unshare` commands
2. **Shared Sessions Allowlist**: New file at `~/.openctl/shared-sessions.json` tracking explicitly shared sessions
3. **Daemon**: Watch the allowlist file and only track sessions that appear in it
4. **Plugin**: Add `/share` slash command that invokes the CLI
5. **Server**: Support deduplication by Claude session UUID and return session URL in response

## Dependencies

This feature builds on existing infrastructure:
- Daemon infrastructure (`cli/daemon/`) - already watches session files
- Repo allowlist (`cli/lib/config.ts`) - already manages per-server repo permissions
- Server live session API (`src/routes/api.ts`) - already creates sessions by `harness_session_id`

## Implementation Phases

### Phase 1: Shared Sessions Allowlist Module

**File:** `cli/lib/shared-sessions.ts` (new)

Create a new module to manage the shared sessions allowlist file.

```typescript
// Interfaces
interface SharedSession {
  filePath: string;
  servers: string[];
  sharedAt: string;  // ISO timestamp
}

interface SharedSessionsConfig {
  version: 1;
  sessions: Record<string, SharedSession>;  // keyed by session UUID
}

// Constants
const SHARED_SESSIONS_PATH = join(Bun.env.HOME || "~", ".openctl", "shared-sessions.json");

// Functions to implement:
// - loadSharedSessions(): SharedSessionsConfig
// - loadSharedSessionsSync(): SharedSessionsConfig
// - saveSharedSessions(config: SharedSessionsConfig): Promise<void>
// - addSharedSession(sessionUuid: string, filePath: string, serverUrl: string): Promise<void>
// - removeSharedSession(sessionUuid: string, serverUrl?: string): Promise<void>
// - isSessionShared(sessionUuid: string, serverUrl: string): boolean
// - getSharedSessions(): SharedSessionsConfig
// - getSharedSessionsForServer(serverUrl: string): Array<{uuid: string, session: SharedSession}>
```

Implementation notes:
- File permissions should be `0600` (user read/write only)
- Use atomic writes (write to temp file, then rename)
- Handle missing file gracefully (return empty config)
- Follow patterns from existing `cli/lib/config.ts`

### Phase 2: CLI Share Command

**File:** `cli/commands/session.ts` (modify)

Add `share` and `unshare` subcommands to the existing session command.

#### 2.1 Update session command router

Add new cases to the switch statement:
```typescript
case "share":
  return sessionShare(args.slice(1));
case "unshare":
  return sessionUnshare(args.slice(1));
```

Update help text to include:
```
  share <id>        Share a session with the server
  unshare <id>      Stop sharing a session
```

#### 2.2 Implement `sessionShare` function

```typescript
async function sessionShare(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      server: { type: "string", short: "s" },
    },
    allowPositionals: true,
  });

  // 1. Get session UUID - from arg or CLAUDE_SESSION_ID env var
  let sessionUuid = positionals[0];
  if (!sessionUuid) {
    sessionUuid = Bun.env.CLAUDE_SESSION_ID;
    if (!sessionUuid) {
      console.error("Error: Session ID required (or set CLAUDE_SESSION_ID)");
      process.exit(1);
    }
  }

  // 2. Find session file path
  const sessionPath = await findSessionByUuid(sessionUuid);
  if (!sessionPath) {
    console.error(`Error: Session not found: ${sessionUuid}`);
    process.exit(1);
  }

  // 3. Extract project path from session
  const projectPath = extractProjectPathFromSessionPath(sessionPath);

  // 4. Get server URL
  const config = loadConfig();
  const serverUrl = values.server || config.server || "http://localhost:3000";

  // 5. Check repo allowlist
  const repoId = await getRepoIdentifier(projectPath || process.cwd());
  if (!repoId || !isRepoAllowed(serverUrl, repoId)) {
    // Interactive: prompt to allow
    if (process.stdin.isTTY) {
      console.log(`This repository hasn't been allowed for sharing with ${serverUrl}.`);
      process.stdout.write("Allow this repository? [y/N] ");
      const response = await readLine();
      if (response.toLowerCase() === "y") {
        addAllowedRepo(serverUrl, repoId!);
        console.log("Repository allowed.");
      } else {
        console.error("Error: Repository not allowed. Run: openctl repo allow");
        process.exit(2);
      }
    } else {
      console.error("Error: Repository not allowed. Run: openctl repo allow");
      process.exit(2);
    }
  }

  // 6. Add to shared sessions allowlist
  await addSharedSession(sessionUuid, sessionPath, serverUrl);
  console.log(`Sharing session with ${serverUrl}...`);

  // 7. Ensure daemon is running
  const status = await getDaemonStatus();
  if (!status.running) {
    console.log("Starting daemon...");
    await startDaemonBackground(serverUrl);
    await Bun.sleep(1000);
  }

  // 8. Poll for session URL (daemon will create session on server)
  const sessionUrl = await pollForSessionUrl(sessionUuid, serverUrl);
  if (!sessionUrl) {
    console.error("Error: Timed out waiting for session URL");
    process.exit(4);
  }

  console.log(`Session shared: ${sessionUrl}`);
}
```

#### 2.3 Implement `sessionUnshare` function

```typescript
async function sessionUnshare(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      server: { type: "string", short: "s" },
      delete: { type: "boolean" },
    },
    allowPositionals: true,
  });

  const sessionUuid = positionals[0] || Bun.env.CLAUDE_SESSION_ID;
  if (!sessionUuid) {
    console.error("Error: Session ID required");
    process.exit(1);
  }

  const config = loadConfig();
  const serverUrl = values.server;  // undefined means all servers

  await removeSharedSession(sessionUuid, serverUrl);
  console.log(`Session unshared${serverUrl ? ` from ${serverUrl}` : ""}.`);

  if (values.delete && serverUrl) {
    console.log("Note: Server-side deletion not yet implemented.");
  }
}
```

#### 2.4 Helper functions

```typescript
// Poll server for session URL by querying with claude_session_id
async function pollForSessionUrl(sessionUuid: string, serverUrl: string, timeoutMs = 30000): Promise<string | null> {
  const startTime = Date.now();
  const pollInterval = 500;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${serverUrl}/api/sessions?claude_session_id=${sessionUuid}`);
      if (response.ok) {
        const data = await response.json();
        if (data.session?.id) {
          return `${serverUrl}/sessions/${data.session.id}`;
        }
      }
    } catch {
      // Server not reachable, continue polling
    }
    await Bun.sleep(pollInterval);
  }
  return null;
}

// Start daemon in background (detached process)
async function startDaemonBackground(serverUrl: string): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "cli/index.ts", "daemon", "start", "--server", serverUrl], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  proc.unref();
}
```

### Phase 3: Daemon Changes

**File:** `cli/daemon/index.ts` (modify)

#### 3.1 Add allowlist watching

```typescript
import { watch } from "fs";
import { loadSharedSessions, getSharedSessionsForServer } from "../lib/shared-sessions";

const SHARED_SESSIONS_PATH = join(Bun.env.HOME || "~", ".openctl", "shared-sessions.json");

// In startDaemon(), after creating tracker and watcher:
watchSharedSessions(options.server, tracker);

function watchSharedSessions(serverUrl: string, tracker: SessionTracker): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Ensure file exists
  if (!existsSync(SHARED_SESSIONS_PATH)) {
    const dir = dirname(SHARED_SESSIONS_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(SHARED_SESSIONS_PATH, JSON.stringify({ version: 1, sessions: {} }));
  }

  // Initial load
  handleSharedSessionsChange(serverUrl, tracker);

  // Watch for changes
  watch(SHARED_SESSIONS_PATH, (eventType) => {
    if (eventType === "change") {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        handleSharedSessionsChange(serverUrl, tracker);
      }, 100);
    }
  });
}

async function handleSharedSessionsChange(serverUrl: string, tracker: SessionTracker): Promise<void> {
  const sharedSessions = getSharedSessionsForServer(serverUrl);

  for (const { uuid, session } of sharedSessions) {
    if (!tracker.isTracking(session.filePath)) {
      const adapter = getAdapterForPath(session.filePath);
      if (adapter) {
        await tracker.startSession(session.filePath, adapter);
      }
    }
  }

  // Stop tracking sessions no longer in allowlist
  for (const filePath of tracker.getTrackedFilePaths()) {
    const isShared = sharedSessions.some(s => s.session.filePath === filePath);
    if (!isShared) {
      await tracker.endSession(filePath);
    }
  }
}
```

**File:** `cli/daemon/session-tracker.ts` (modify)

#### 3.2 Update session tracking logic

Add helper methods:

```typescript
isTracking(filePath: string): boolean {
  return this.sessions.has(filePath);
}

getTrackedFilePaths(): string[] {
  return Array.from(this.sessions.keys());
}
```

**File:** `cli/daemon/watcher.ts` (modify)

#### 3.3 Disable auto-upload behavior

Remove auto-tracking from the watcher. The allowlist watcher handles all session starts. The file watcher should only detect file changes for sessions already being tracked.

### Phase 4: Server API Changes

**File:** `src/routes/api.ts` (modify)

#### 4.1 Add session lookup by claude_session_id

```typescript
// GET /api/sessions?claude_session_id=<uuid>
getSessions(req: Request): Response {
  const url = new URL(req.url);
  const claudeSessionId = url.searchParams.get("claude_session_id");

  if (claudeSessionId) {
    const session = repo.getSessionByClaudeSessionId(claudeSessionId);
    if (session) {
      return json({ session, url: `/sessions/${session.id}` });
    }
    return json({ session: null });
  }

  // ... existing logic
}
```

#### 4.2 Update createLiveSession response to include URL

```typescript
return json({
  id,
  url: `/sessions/${id}`,  // Add this
  stream_token: streamToken,
  status: "live",
  resumed: false,
  message_count: 0,
  last_index: -1,
});
```

### Phase 5: Plugin Integration

**File:** `plugins/claude-code/openctl/commands/share.md` (new)

```markdown
# Share Session

Share this Claude Code session with an openctl server for live streaming.

## Instructions

1. Get the current session ID from the `CLAUDE_SESSION_ID` environment variable
2. Run the openctl CLI to share the session:

\`\`\`bash
openctl session share $CLAUDE_SESSION_ID
\`\`\`

If the user specified a server URL as an argument to /share, include it:

\`\`\`bash
openctl session share $CLAUDE_SESSION_ID --server <server-url>
\`\`\`

3. If the command prompts about allowing a repository, ask the user if they want to allow it
4. Report the session URL to the user when complete

## Error Handling

- If `CLAUDE_SESSION_ID` is not set, inform the user this command must be run within a Claude Code session
- If the openctl CLI is not installed, instruct the user to install it with: `bun install -g openctl`
- If the command fails, show the error output to the user
```

### Phase 6: Testing

**File:** `tests/shared-sessions.test.ts` (new)

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

describe("Shared Sessions", () => {
  // Tests for:
  // - addSharedSession creates file if missing
  // - addSharedSession adds new session
  // - addSharedSession adds server to existing session
  // - removeSharedSession removes server
  // - removeSharedSession removes session when no servers left
  // - isSessionShared returns correct boolean
});
```

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `cli/lib/shared-sessions.ts` | Create | Shared sessions allowlist management |
| `cli/commands/session.ts` | Modify | Add share/unshare subcommands |
| `cli/daemon/index.ts` | Modify | Watch shared sessions file |
| `cli/daemon/session-tracker.ts` | Modify | Add tracking helpers |
| `cli/daemon/watcher.ts` | Modify | Disable auto-upload, respect allowlist |
| `src/routes/api.ts` | Modify | Add claude_session_id query, include URL in response |
| `plugins/claude-code/openctl/commands/share.md` | Create | /share slash command prompt |
| `tests/shared-sessions.test.ts` | Create | Unit tests |

## Acceptance Criteria

- [ ] `openctl session share <uuid>` adds session to allowlist
- [ ] `openctl session share` works with `CLAUDE_SESSION_ID` env var
- [ ] Share command prompts for repo permission if not allowed
- [ ] Daemon watches `~/.openctl/shared-sessions.json` for changes
- [ ] Daemon starts tracking sessions when added to allowlist
- [ ] Daemon stops tracking sessions when removed from allowlist
- [ ] Daemon no longer auto-uploads sessions from allowed repos
- [ ] `/share` plugin command works in Claude Code
- [ ] Server returns session URL in createLiveSession response
- [ ] Resharing returns existing session URL (no duplicates)
- [ ] `openctl session unshare <uuid>` removes from allowlist

## Migration Notes

The behavior change from auto-upload to explicit share is significant:
1. Existing daemon users will notice sessions no longer auto-upload
2. Document the change prominently in release notes
3. Consider a deprecation warning in daemon startup for one release cycle
