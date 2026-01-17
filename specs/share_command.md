# Share Command

This document specifies the `/share` command for the openctl Claude Code plugin, enabling explicit opt-in session sharing.

## Overview

The share command allows users to explicitly share their current Claude Code session with an openctl server. This replaces the current behavior where the daemon auto-uploads all sessions from allowed repos.

**Key changes:**
- Daemon no longer auto-uploads every session from allowed repos
- Sessions must be explicitly shared via `/share` command
- A session allowlist controls which sessions the daemon tracks
- Daemon watches the allowlist and reacts to changes

```
┌─────────────────┐    /share     ┌─────────────────┐
│   Claude Code   │──────────────▶│   openctl CLI   │
│   (plugin)      │               │                 │
└─────────────────┘               └────────┬────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    │                      │                      │
                    ▼                      ▼                      ▼
            ┌──────────────┐      ┌──────────────┐       ┌──────────────┐
            │   Update     │      │  Start       │       │   Output     │
            │   session    │      │  daemon      │       │   session    │
            │   allowlist  │      │  (if needed) │       │   URL        │
            └──────────────┘      └──────────────┘       └──────────────┘
                    │
                    │ fs.watch()
                    ▼
            ┌──────────────┐
            │   Daemon     │
            │   starts     │
            │   tracking   │
            └──────────────┘
```

## User Experience

### From Claude Code

```
user> /share

Sharing this session with https://openctl.example.com...
✓ Session shared: https://openctl.example.com/sessions/abc123
```

With custom server:
```
user> /share --server https://team.openctl.dev

Sharing this session with https://team.openctl.dev...
✓ Session shared: https://team.openctl.dev/sessions/abc123
```

If repo not allowed:
```
user> /share

This repository (github.com/org/private-repo) hasn't been
allowed for sharing with https://openctl.example.com.

Allow this repository? [y/N]
> y

✓ Repository allowed
Sharing this session with https://openctl.example.com...
✓ Session shared: https://openctl.example.com/sessions/abc123
```

For completed sessions (via CLI):
```
$ openctl session share abc123

✓ Session uploaded: https://openctl.example.com/sessions/xyz789
```

## CLI Interface

### `openctl session share`

Share a session with an openctl server.

```sh
openctl session share [session-id] [options]
```

**Arguments:**
- `session-id` - Session UUID (optional if run from Claude Code context)

**Options:**
- `--server, -s <url>` - Server URL (default: configured default server)

**Behavior:**

1. **Resolve session** - Get session file path from UUID or current context
2. **Check repo allowlist** - Verify the repo is allowed for the target server
   - If not allowed, prompt to add (interactive) or error (non-interactive)
3. **Update session allowlist** - Add session to `~/.openctl/shared-sessions.json`
4. **Start daemon** - If not running, start it
5. **Wait for URL** - Poll until daemon creates session on server
6. **Output URL** - Print session URL

**Exit codes:**
- `0` - Success
- `1` - Session not found
- `2` - Repo not allowed (non-interactive, user declined)
- `3` - Daemon failed to start
- `4` - Timeout waiting for session URL

**Examples:**

```sh
# Share current session (when run from Claude Code hook)
openctl session share

# Share specific session
openctl session share abc123-def456

# Share to specific server
openctl session share --server https://team.openctl.dev

# Share completed session (uploads immediately)
openctl session share abc123 --server https://archive.example.com
```

### `openctl session unshare`

Stop sharing a session.

```sh
openctl session unshare [session-id] [options]
```

**Options:**
- `--server, -s <url>` - Server to unshare from (default: all servers)
- `--delete` - Also delete the session from the server(s)

**Behavior:**
- Removes session from the allowlist
- Daemon stops tracking the session
- Optionally deletes from server

## Plugin Integration

### Slash Command

The Claude Code plugin exposes a `/share` slash command as a markdown prompt:

```
plugins/claude-code/
├── commands/
│   └── share.md          # /share slash command prompt
└── ...
```

**Command prompt (`commands/share.md`):**

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
- If the openctl CLI is not installed, instruct the user to install it first
- If the command fails, show the error output to the user
```

**How it works:**

1. User types `/share` or `/share --server https://example.com`
2. Claude Code loads the `share.md` prompt
3. Claude reads the instructions and executes the appropriate CLI command
4. Claude handles any interactive prompts (repo allowlist) and reports results

### Session ID Access

The share command needs the current session UUID. Claude Code should provide this via:

1. **Environment variable** (preferred): `CLAUDE_SESSION_ID`
2. **Stdin** (for hooks): JSON input with session ID
3. **File detection**: Derive from current working directory + session file

## Session Allowlist

### File Location

```
~/.openctl/shared-sessions.json
```

### Schema

```typescript
interface SharedSessionsConfig {
  version: 1;
  sessions: {
    [sessionUuid: string]: SharedSession;
  };
}

interface SharedSession {
  // Session file path (for daemon to locate)
  filePath: string;

  // Servers this session is shared with
  servers: string[];

  // When the session was shared
  sharedAt: string;  // ISO timestamp
}
```

**Example:**

```json
{
  "version": 1,
  "sessions": {
    "abc123-def456-789": {
      "filePath": "/Users/me/.claude/projects/-Users-me-myproject/abc123.jsonl",
      "servers": [
        "https://openctl.example.com",
        "https://team.openctl.dev"
      ],
      "sharedAt": "2025-01-16T10:30:00Z"
    }
  }
}
```

### Operations

**Add session to allowlist:**

```typescript
async function addSharedSession(
  sessionUuid: string,
  filePath: string,
  serverUrl: string
): Promise<void> {
  const config = await loadSharedSessions();

  if (!config.sessions[sessionUuid]) {
    config.sessions[sessionUuid] = {
      filePath,
      servers: [],
      sharedAt: new Date().toISOString(),
    };
  }

  if (!config.sessions[sessionUuid].servers.includes(serverUrl)) {
    config.sessions[sessionUuid].servers.push(serverUrl);
  }

  await saveSharedSessions(config);
}
```

**Remove session from allowlist:**

```typescript
async function removeSharedSession(
  sessionUuid: string,
  serverUrl?: string
): Promise<void> {
  const config = await loadSharedSessions();
  const session = config.sessions[sessionUuid];

  if (!session) return;

  if (serverUrl) {
    // Remove from specific server
    session.servers = session.servers.filter(s => s !== serverUrl);
    if (session.servers.length === 0) {
      delete config.sessions[sessionUuid];
    }
  } else {
    // Remove from all servers
    delete config.sessions[sessionUuid];
  }

  await saveSharedSessions(config);
}
```

**Check if session is shared:**

```typescript
function isSessionShared(
  sessionUuid: string,
  serverUrl: string
): boolean {
  const config = loadSharedSessionsSync();
  const session = config.sessions[sessionUuid];
  return session?.servers.includes(serverUrl) ?? false;
}
```

## Daemon Changes

### Allowlist Watching

The daemon watches `~/.openctl/shared-sessions.json` for changes:

```typescript
// daemon/index.ts
import { watch } from "fs";

class Daemon {
  private sharedSessionsPath = path.join(
    os.homedir(),
    ".openctl",
    "shared-sessions.json"
  );

  async start() {
    // ... existing startup

    // Watch shared sessions file
    this.watchSharedSessions();
  }

  private watchSharedSessions() {
    let debounceTimer: Timer | null = null;

    watch(this.sharedSessionsPath, (eventType) => {
      if (eventType === "change") {
        // Debounce rapid changes
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.handleSharedSessionsChange();
        }, 100);
      }
    });
  }

  private async handleSharedSessionsChange() {
    const config = await loadSharedSessions();

    for (const [uuid, session] of Object.entries(config.sessions)) {
      // Start tracking new shared sessions
      if (!this.isTracking(uuid) && session.servers.length > 0) {
        await this.startTrackingSession(uuid, session);
      }

      // Stop tracking unshared sessions
      if (this.isTracking(uuid) && session.servers.length === 0) {
        await this.stopTrackingSession(uuid);
      }
    }

    // Stop tracking sessions removed from config
    for (const uuid of this.getTrackedSessions()) {
      if (!config.sessions[uuid]) {
        await this.stopTrackingSession(uuid);
      }
    }
  }
}
```

### Session Tracking Changes

Update `SessionTracker` to only track sessions in the allowlist:

```typescript
// daemon/session-tracker.ts

class SessionTracker {
  async startSession(filePath: string): Promise<void> {
    const sessionInfo = this.adapter.getSessionInfo(filePath);
    const uuid = sessionInfo.harnessSessionId;

    // Check if session is in allowlist
    const sharedConfig = await loadSharedSessions();
    const sharedSession = sharedConfig.sessions[uuid];

    if (!sharedSession || sharedSession.servers.length === 0) {
      // Session not shared, skip
      this.log(`Skipping session ${uuid} - not in shared sessions list`);
      return;
    }

    // Check repo allowlist for each server
    for (const serverUrl of sharedSession.servers) {
      const repoId = await getRepoIdentifier(sessionInfo.projectPath);
      if (!isRepoAllowed(serverUrl, repoId)) {
        this.log(`Skipping ${serverUrl} for ${uuid} - repo not allowed`);
        continue;
      }

      // Start streaming to this server
      await this.streamToServer(uuid, filePath, serverUrl);
    }
  }
}
```

### Completed Session Handling

When a session is shared after completion:

```typescript
async function shareCompletedSession(
  uuid: string,
  filePath: string,
  serverUrl: string
): Promise<string> {
  // Use existing upload logic
  const sessionData = await parseSessionFile(filePath);
  const diff = await captureGitDiff(sessionData.projectPath);

  const response = await uploadSession(serverUrl, {
    ...sessionData,
    diff,
  });

  return response.sessionUrl;
}
```

### Session URL

When the daemon creates a session on the server, it passes the Claude session UUID. The server returns the session URL directly in the response:

```typescript
// POST /api/sessions/live request (includes Claude UUID)
interface CreateLiveSessionRequest {
  claude_session_id: string;  // Claude Code session UUID (used for deduplication)
  title?: string;
  project_path: string;
  // ... other fields
}

// POST /api/sessions/live response
interface CreateLiveSessionResponse {
  id: string;           // Server-assigned session ID
  url: string;          // Full session URL (e.g., "https://openctl.example.com/sessions/abc123")
  stream_token: string; // Auth token for pushing updates
  status: "live";
  created: boolean;     // true if new, false if resuming existing
}
```

The server uses `claude_session_id` to deduplicate - if a session with this UUID already exists, it returns the existing session instead of creating a new one. This enables resharing without duplicate sessions.

The CLI can output this URL immediately without needing to store or look up server IDs.

**Note:** Session "liveness" is determined by whether the daemon is actively tracking the session, not by a stored state field. The server tracks `status: "live" | "complete"` based on daemon activity.

## Share Command Flow

```
1. User runs /share in Claude Code
   │
2. Plugin invokes: openctl session share <uuid> --server <url>
   │
3. CLI checks repo allowlist
   │
   ├─ Not allowed → Prompt user → Add to allowlist (or exit)
   │
4. CLI adds session to shared-sessions.json
   │
5. CLI checks if daemon is running
   │
   ├─ Not running → Start daemon in background
   │
6. Daemon detects allowlist change (fs.watch)
   │
7. Daemon starts tracking session, creates on server
   │
8. Server returns session URL in response
   │
9. Daemon outputs URL (or CLI receives it via stdout/file)
   │
10. CLI outputs: ✓ Session shared: <url>
```

### Resharing a Session

If a session was previously shared to a server:
- The daemon passes the Claude session UUID when creating/updating
- Server uses UUID to find existing session and resume streaming
- No local ID mapping needed - server handles deduplication

## Configuration

### Default Server

The default server URL comes from (in order):
1. `--server` flag
2. `OPENCTL_SERVER_URL` environment variable
3. `~/.openctl/config.json` → `server` field

### Repo Allowlist

Repo allowlist remains in `~/.openctl/config.json`:

```json
{
  "server": "https://openctl.example.com",
  "servers": {
    "https://openctl.example.com": {
      "allowedRepos": [
        "github.com/org/repo1",
        "github.com/org/repo2"
      ]
    }
  }
}
```

## Error Handling

| Error | Message | Exit Code |
|-------|---------|-----------|
| Not in Claude Code session | "Error: Not running in a Claude Code session" | 1 |
| Session file not found | "Error: Session not found: {uuid}" | 1 |
| Repo not allowed (declined) | "Error: Repository not allowed. Run: openctl repo allow" | 2 |
| Daemon failed to start | "Error: Failed to start daemon: {reason}" | 3 |
| Timeout waiting for URL | "Error: Timed out waiting for session URL" | 4 |
| Server unreachable | "Error: Could not connect to {server}" | 5 |

## Migration

### From Auto-Upload Behavior

The daemon currently auto-uploads all sessions from allowed repos. To migrate:

1. **Add feature flag** (temporary):
   ```json
   {
     "experimentalExplicitShare": true
   }
   ```

2. **Default: explicit share required**
   - Daemon only tracks sessions in allowlist
   - Users must run `/share` to start streaming

3. **Deprecation path**:
   - Warn users about behavior change in daemon output
   - Remove feature flag after one release cycle

### Cleanup

When migrating, the daemon should:
- Stop auto-tracking new sessions
- Continue tracking already-started sessions until complete
- Log guidance: "Run /share to stream sessions"

## Security Considerations

### File Permissions

The shared sessions file contains session paths and server URLs:
- File mode: `0600` (user read/write only)
- Validate paths don't escape expected directories

### Server URL Validation

When adding a session to a server:
- Validate URL format
- Warn on HTTP (non-HTTPS) URLs
- Consider server allowlist for enterprise deployments

### Session Privacy

- Sessions are only shared when explicitly requested
- Users control which repos can share to which servers
- Session content is only transmitted after user action

## Implementation Phases

### Phase 1: Core Share Command

- [ ] Add `openctl session share` command
- [ ] Implement session allowlist (`shared-sessions.json`)
- [ ] Update daemon to watch allowlist
- [ ] Add repo allowlist prompt on share

### Phase 2: Plugin Integration

- [ ] Add `/share` slash command to Claude Code plugin
- [ ] Pass session UUID from Claude Code context
- [ ] Handle interactive prompts in terminal

### Phase 3: Resharing Support

- [ ] Server deduplication by Claude session UUID
- [ ] Resume streaming to existing session
- [ ] Handle session file changes since last stream

### Phase 4: Polish

- [ ] Add `openctl session unshare` command
- [ ] Daemon started in background by share command
- [ ] Migration from auto-upload behavior

## Design Decisions

1. **Session state model**: What matters is `live` (daemon actively streaming) vs not. When the daemon stops tracking a session (unshare, daemon shutdown, session file deleted), it's no longer live. We don't distinguish "in-progress" from "completed" at the share command level.

2. **Daemon locality**: Always local. The share command starts the daemon on the local machine. No cross-machine daemon discovery.

3. **Unshare behavior**: Stop streaming, session is no longer marked as live on the server. Partial content remains on the server (not deleted).

4. **Reshare behavior**: Update the existing server session. The daemon passes the Claude session UUID, and the server uses it to find and resume the existing session.

5. **Session IDs**: The local allowlist tracks Claude session UUIDs only. The server maintains its own IDs internally. When creating a session, the server returns the full URL so the CLI doesn't need to construct or look up IDs.
