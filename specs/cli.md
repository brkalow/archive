# CLI Specification

## Overview

A command-line interface for Claude Session Archive that enables uploading sessions from any project directory and running the archive UI locally.

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

## Future: Daemon Mode

> Not in initial scope, but the CLI architecture should accommodate this.

### `archive daemon`

Start a background daemon that automatically uploads sessions.

```sh
archive daemon start [options]
archive daemon stop
archive daemon status
```

**Options:**
- `--watch <paths>` - Directories to watch for Claude sessions (default: all projects)
- `--auto-upload` - Automatically upload sessions on completion
- `--server <url>` - Archive server URL

**Behavior:**
- Watches `~/.claude/projects/` for session changes
- Detects when a session is "complete" (no writes for N seconds)
- Optionally prompts before uploading or auto-uploads
- Runs as a background process

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

1. **Binary name**: `archive` is generic. Should we use `claude-archive` or similar?

2. **Session selection UI**: Should `archive upload` show a picker if multiple recent sessions exist?

3. **Daemon triggers**: What should trigger an upload in daemon mode?
   - Session file unchanged for N seconds?
   - Git commit detected?
   - Explicit command/hook?

4. **Authentication**: For remote servers with auth (Phase 2), how should credentials be stored?
   - OS keychain?
   - Config file?
   - Environment variables?

5. **Conflict with existing session**: Should uploading the same session ID update or create new?
