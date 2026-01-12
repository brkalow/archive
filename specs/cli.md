# CLI Specification

## Overview

A command-line interface for uploading AI coding sessions and running the archive UI locally. While initially built for Claude Code, the design should be **harness-agnostic** to support other AI coding tools in the future.

## Commands

### `archive upload`

Upload a Claude Code session from the current project directory.

```sh
archive upload [options]
```

**Options:**
- `--session, -s <path>` - Path to session JSONL file (default: auto-detect most recent session for current directory)
- `--title, -t <title>` - Session title (default: derived from first user message)
- `--description <text>` - Session description
- `--no-diff` - Exclude git diff from upload
- `--pr <url>` - Associate a PR URL with the session
- `--server <url>` - Archive server URL (default: `http://localhost:3000` or `$ARCHIVE_SERVER`)
- `--open` - Open the session in browser after upload

**Behavior:**
- Auto-detects the current Claude Code session from `~/.claude/projects/<project-slug>/`
- Captures git diff (staged + unstaged changes vs main/master, or uncommitted changes)
- Derives title from first user message if not provided
- Prints session URL on success

**Examples:**
```sh
# Upload current session with auto-detected title
archive upload

# Upload with custom title and open in browser
archive upload -t "Implement user auth" --open

# Upload specific session file
archive upload -s ~/.claude/projects/-Users-me-myproject/abc123.jsonl

# Upload to remote server
archive upload --server https://archive.example.com
```

### `archive serve`

Start the archive server locally. Useful for personal/offline use.

```sh
archive serve [options]
```

**Options:**
- `--port, -p <port>` - Port to listen on (default: 3000)
- `--host <host>` - Host to bind to (default: localhost)
- `--db <path>` - Database file path (default: `~/.archive/sessions.db`)
- `--open` - Open browser after starting

**Behavior:**
- Starts the full archive web UI locally
- Uses a local SQLite database (created if not exists)
- Serves on localhost by default (not exposed to network)

**Examples:**
```sh
# Start on default port
archive serve

# Start on custom port and open browser
archive serve -p 8080 --open

# Use custom database location
archive serve --db ./my-sessions.db
```

### `archive list`

List uploaded sessions.

```sh
archive list [options]
```

**Options:**
- `--server <url>` - Archive server URL
- `--project <path>` - Filter by project path
- `--limit <n>` - Number of sessions to show (default: 10)
- `--json` - Output as JSON

**Examples:**
```sh
# List recent sessions
archive list

# List sessions for current project
archive list --project .

# Output as JSON
archive list --json
```

### `archive open`

Open a session in the browser.

```sh
archive open [session-id]
```

**Behavior:**
- If no session ID provided, opens most recent session for current project
- Opens the session URL in the default browser

### `archive config`

Manage CLI configuration.

```sh
archive config [key] [value]
archive config --list
```

**Configuration keys:**
- `server` - Default server URL
- `db` - Default database path for local mode

**Examples:**
```sh
# Set default server
archive config server https://archive.example.com

# View all config
archive config --list
```

## Daemon Mode

> See [live_streaming.md](./live_streaming.md) for the full streaming specification.

### `archive daemon`

Start a background daemon that watches for AI coding sessions and streams live updates. The daemon is **harness-agnostic** and uses pluggable adapters to support different tools.

```sh
archive daemon start [options]
archive daemon stop
archive daemon status
```

**Options:**
- `--harness <name>` - Which harness adapter(s) to enable (default: all). Can specify multiple: `--harness claude-code --harness cursor`
- `--watch <paths>` - Additional directories to watch (supplements harness defaults)
- `--server <url>` - Archive server URL
- `--idle-timeout <seconds>` - Seconds of inactivity before marking session complete (default: 60)

**Supported Harnesses:**
| Harness | ID | Watch Path |
|---------|-----|------------|
| Claude Code | `claude-code` | `~/.claude/projects/` |
| Cursor | `cursor` | `~/.cursor/conversations/` |
| (more to come) | | |

**Behavior:**
- Watches session directories for all enabled harness adapters
- Uses harness-specific parsers to normalize session data
- **Live streaming**: Pushes incremental updates to the server as sessions progress
  - New messages appear in the UI in real-time
  - Enables "watching" an active coding session from the web UI
- Detects session start (new session file created)
- Detects session end (no writes for N seconds, or harness-specific signals)

**Live Session Flow:**
1. Daemon detects new session file in a watched directory
2. Matches file to a harness adapter via `adapter.canHandle()`
3. Creates session record on server, gets session ID and stream token
4. Tails the session file, parsing via adapter and pushing normalized messages
5. Captures git diff on session end
6. Marks session as "complete" when idle or harness signals completion

**Use Cases:**
- Team members can watch an active coding session in real-time
- Enables Phase 3 "in-the-loop review" - give feedback while Claude is working
- Debugging/monitoring long-running sessions
- Works with any supported AI coding tool

**Privacy:**
- Live sessions are visible by default (no explicit share step needed)
- Phase 2 access control (GitHub-based permissions) will scope visibility to repo collaborators

## Installation & Distribution

### npm/bun global install

```sh
bun install -g claude-session-archive
# or
npm install -g claude-session-archive
```

This installs the `archive` binary globally.

### Local development

```sh
# From the archive repo
bun link
# Now `archive` command is available
```

### Binary name

The CLI command is `archive`. Consider alternatives if there are conflicts:
- `claude-archive`
- `session-archive`
- `csa` (short form)

## Configuration

Configuration stored in `~/.archive/config.json`:

```json
{
  "server": "http://localhost:3000",
  "db": "~/.archive/sessions.db",
  "autoOpen": false
}
```

Environment variables override config file:
- `ARCHIVE_SERVER` - Server URL
- `ARCHIVE_DB` - Database path

## Architecture

```
cli/
  index.ts        # Entry point, command router
  commands/
    upload.ts     # Upload command (refactor from bin/upload-session.ts)
    serve.ts      # Start local server
    list.ts       # List sessions
    open.ts       # Open in browser
    config.ts     # Config management
    daemon.ts     # (future) Daemon management
  lib/
    config.ts     # Config loading/saving
    session.ts    # Session detection utilities
    api.ts        # API client for remote server
```

The `serve` command reuses the existing server code but configures it for local-only operation with a user-specific database.

## Open Questions

1. **Binary name**: `archive` is generic but we want harness-agnostic naming. TBD.

2. **Session selection UI**: Should `archive upload` show a picker if multiple recent sessions exist?

3. **Daemon triggers**: What should trigger an upload in daemon mode?
   - Likely via harness-specific plugins (e.g., Claude Code hook, Cursor extension, etc.)
   - Could also support file watching as fallback

4. **Authentication**: For remote servers with auth (Phase 2), how should credentials be stored?
   - Likely OS-specific keychain (macOS Keychain, Windows Credential Manager, etc.)

5. **Session updates & streaming**: API needs work to support:
   - Updating an existing session (re-upload same session ID)
   - Appending messages to a live session (for daemon streaming)
   - Distinguishing "in-progress" vs "complete" sessions
