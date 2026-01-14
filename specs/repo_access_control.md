# Repository Access Control

## Problem

When using the daemon to automatically push coding sessions, users may work on repositories containing sensitive code they don't want uploaded to the archive server. Without explicit controls, sessions from private/proprietary codebases could be unintentionally shared.

## Goals

1. Give users explicit control over which repositories are eligible for automatic session uploads
2. Default to safe behavior that prevents accidental exposure of sensitive code
3. Provide clear feedback when sessions are skipped due to access control

## Non-Goals

- Viewer-side access control (who can see uploaded sessions) - that's a separate feature
- Per-session manual overrides during upload - users can always use `archive upload` explicitly
- Organization-wide policies - this is user-local configuration

## Design

### Opt-In by Default

The daemon should **not** automatically upload sessions unless the repository is explicitly allowed. This "default deny" approach prevents accidental sharing of sensitive code.

When the daemon encounters a session for an unallowed repository, it should:
1. Log that the session was skipped and why
2. Optionally notify the user (first time per repo)
3. Provide a one-liner command to allow the repo

### Repository Identification

Repositories are identified by their **git remote URL** (normalized). This is more reliable than paths because:
- The same repo can be cloned to different paths
- Remote URLs are stable identifiers
- Users often have multiple checkouts of the same repo

Normalization rules:
- Strip `.git` suffix
- Normalize SSH vs HTTPS: `git@github.com:org/repo` → `github.com/org/repo`
- Lowercase hostname

For repositories without remotes (local-only), use the **absolute repository root path** as the identifier.

When multiple remotes exist, use the `origin` remote by default.

### Configuration

Stored in `~/.archive/config.json`. Allowlists are **per-server** since users may want different repos allowed for different archive servers (e.g., personal vs work):

```json
{
  "server": "https://archive.example.com",
  "servers": {
    "https://archive.example.com": {
      "allowedRepos": [
        "github.com/myorg/public-project",
        "github.com/myorg/another-project"
      ]
    },
    "http://localhost:3000": {
      "allowedRepos": [
        "github.com/myorg/public-project",
        "/Users/me/local-only-project"
      ]
    }
  }
}
```

### CLI Commands

Repository access control commands are scoped under `archive repo`.

#### `archive repo allow`

Add a repository to the allowlist for the current server.

```sh
archive repo allow [path] [options]
```

**Options:**
- `--server <url>` - Target server (default: current configured server)

**Behavior:**
- If `path` is omitted, uses current directory
- Resolves the git remote URL (or root path for local repos)
- Adds to the server's `allowedRepos` in config
- Confirms with the normalized identifier

**Examples:**
```sh
# Allow current repo for default server
archive repo allow

# Allow a specific repo
archive repo allow ~/projects/my-app

# Allow for a specific server
archive repo allow --server https://work-archive.example.com

# Output:
# Allowed: github.com/myorg/my-app
# Server: https://archive.example.com
# Sessions from this repository will now be uploaded automatically.
```

#### `archive repo deny`

Remove a repository from the allowlist.

```sh
archive repo deny [path] [options]
```

**Options:**
- `--server <url>` - Target server (default: current configured server)
- `--all` - Remove from all servers

#### `archive repo list`

List allowed repositories.

```sh
archive repo list [options]
```

**Options:**
- `--server <url>` - Show allowlist for specific server
- `--all` - Show allowlists for all configured servers

**Output:**
```
Allowed repositories (https://archive.example.com):
  github.com/myorg/public-project
  github.com/myorg/another-project
```

With `--all`:
```
https://archive.example.com:
  github.com/myorg/public-project
  github.com/myorg/another-project

http://localhost:3000:
  github.com/myorg/public-project
  /Users/me/local-only-project
```

### Daemon Behavior

The daemon uploads to a single server (the default configured server, or the one specified via `--server` flag at daemon start).

When a new session is detected:

1. Determine the repository from the session's project path
2. Resolve the git remote URL (using `origin` remote, or absolute root path for local repos)
3. Check against `allowedRepos` for the daemon's target server
4. If allowed: proceed with upload
5. If not allowed: skip entirely (log only, no tracking)

**Log output for skipped sessions:**
```
Session skipped: Repository not in allowlist
  Path: /Users/me/work/secret-project
  Repo: github.com/acme-corp/secret-project

To allow this repository, run:
  archive repo allow /Users/me/work/secret-project
```

### Manual Upload Bypass

The `archive upload` command (manual upload) **bypasses** the allowlist. This is intentional:
- Manual upload is an explicit action by the user
- Users may want to upload a one-off session without permanently allowing the repo
- The allowlist is specifically for controlling *automatic* daemon behavior

### First-Run Experience

When the daemon first starts with an empty allowlist, it should explain the opt-in model:

```
No repositories allowed for automatic upload.

The daemon only uploads sessions from explicitly allowed repositories.
To allow the current repository:
  archive repo allow

To allow a specific repository:
  archive repo allow /path/to/repo
```

## User Flows

### New User Setup

1. User installs archive CLI
2. User runs `archive daemon start`
3. Daemon explains opt-in model, user sees no sessions uploaded
4. User runs `archive repo allow` in their work directory
5. Future sessions from that repo are uploaded

### Working on Sensitive Code

1. User clones a sensitive client project
2. User works in the project, daemon is running
3. Sessions are automatically skipped (not in allowlist)
4. User never has to think about it - safe by default

### Allowing a New Repository

1. User starts working on a new open-source project
2. User wants to share sessions from this project
3. User runs `archive repo allow` in the project directory
4. Daemon confirms the repo is now allowed
5. Current and future sessions are uploaded

### One-Off Upload from Sensitive Repo

1. User is working on a sensitive project (not in allowlist)
2. User wants to share one specific session without allowing future auto-uploads
3. User runs `archive upload` manually
4. Session is uploaded (manual upload bypasses allowlist)
5. Future sessions from this repo remain blocked by daemon

### Multiple Servers

1. User has a personal archive server and a work archive server
2. User allows `github.com/personal/project` only on personal server
3. User allows `github.com/work/project` on both servers
4. Daemon respects per-server allowlists when uploading

## Session Deletion

Users should be able to delete sessions they uploaded. Since we don't have user authentication yet, we use a client-based ownership model.

### Client ID

Each CLI installation has a unique **client ID** - a UUID generated on first run and stored locally.

**Storage:** `~/.archive/client-id`

**Generation:**
- On first CLI command that requires a client ID, check if file exists
- If not, generate a UUID v4 and write to file
- File should be readable only by the user (`chmod 600`)

**Lifecycle:**
- Created on first use
- Persists across CLI upgrades
- Lost on reinstall or if file is deleted
- Not synced across machines

### Session Ownership

When a session is uploaded:
1. CLI includes its client ID in the upload request
2. Server stores the client ID with the session record
3. Only requests with a matching client ID can delete the session

**API changes:**

All CLI requests include the client ID header:
```
X-Archive-Client-ID: <uuid>
```

This enables:
- Session ownership tracking on upload
- Delete authorization
- Server-side filtering for `--mine` queries

Session record stores:
```json
{
  "id": "session-123",
  "client_id": "550e8400-e29b-41d4-a716-446655440000",
  ...
}
```

### CLI Commands

#### `archive session delete`

Delete a session from the server.

```sh
archive session delete <session-id> [options]
```

**Options:**
- `--server <url>` - Target server (default: current configured server)
- `--force` - Skip confirmation prompt

**Behavior:**
1. Prompt for confirmation (unless `--force`)
2. Send delete request with client ID
3. Server validates client ID matches session owner
4. If match: delete session and confirm
5. If no match: return 403 Forbidden

**Examples:**
```sh
# Delete a session (with confirmation)
archive session delete abc123
# Delete session abc123? This cannot be undone. [y/N]

# Delete without confirmation
archive session delete abc123 --force
```

**Error cases:**
```
Error: Permission denied
This session was uploaded from a different device.
```

```
Error: Session not found
No session with ID 'abc123' exists on this server.
```

#### `archive session list`

List sessions. Replaces the existing `archive list` command (which becomes an alias).

```sh
archive session list [options]
```

**Options:**
- `--server <url>` - Target server
- `--project <path>` - Filter by project path
- `--mine` - Only show sessions uploaded by this client
- `--limit <n>` - Number of sessions to show (default: 10)
- `--json` - Output as JSON

**Examples:**
```sh
# List recent sessions
archive session list

# List only my sessions
archive session list --mine

# List sessions for current project
archive session list --project .
```

### Limitations

This model has known limitations that are acceptable for now:

1. **Reinstall loses ownership** - If the CLI is reinstalled, the client ID is lost and old sessions cannot be deleted. Users must contact server admin or wait for Phase 2 user auth.

2. **No cross-device deletion** - Sessions can only be deleted from the machine that uploaded them. Phase 2 user auth will address this.

3. **Client ID can be copied** - A user could copy `~/.archive/client-id` to another machine to gain delete capability. This is a feature, not a bug - it's a manual escape hatch.

4. **No revocation** - If a client ID is compromised, there's no way to revoke it without server admin intervention.

5. **Legacy sessions undeletable** - Sessions uploaded before this feature have no `client_id` and cannot be deleted via CLI.

## Design Decisions

Decisions made during spec review:

1. **No pattern matching** - Repos must be explicitly allowed one at a time. This keeps the model simple and avoids accidental over-permissioning.

2. **Per-server allowlists** - Different servers can have different allowed repos. Useful for separating personal vs work contexts.

3. **Console output for notifications** - Skipped sessions are logged to console. No system notifications or web UI indicators for now.

4. **Manual upload bypasses allowlist** - `archive upload` is explicit user intent and doesn't require the repo to be in the allowlist.

5. **Git repository granularity** - Access control is at the git repo level, not workspace or subdirectory level.

6. **Installation-based client ID** - Simple UUID stored locally. Reinstall loses delete capability for old sessions, which is acceptable until Phase 2 user auth.

7. **Scoped CLI commands** - Related commands grouped under namespaces: `archive repo` for repository access control, `archive session` for session operations. `archive list` becomes an alias for `archive session list`. `archive upload` stays at top level for ergonomics.

8. **Daemon skips non-allowed sessions entirely** - Sessions from repos not in the allowlist are completely ignored (just logged). They can be uploaded later via manual `archive upload` if needed.

9. **Single server per daemon** - The daemon uploads only to its configured server (default or `--server` flag at start). It does not fan out to multiple servers.

10. **Client ID sent on all requests** - The `X-Archive-Client-ID` header is included on all API requests, not just delete. This enables server-side filtering for `--mine`.

11. **Legacy sessions undeletable** - Sessions uploaded before client ID was implemented have no `client_id` and cannot be deleted via CLI. Requires admin intervention or Phase 2 user auth.
