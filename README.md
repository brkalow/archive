# Claude Session Archive

A platform for storing, viewing, and sharing Claude Code sessions. Includes a web viewer with live streaming support and a CLI for uploading sessions.

## Installation

```bash
# Install dependencies
bun install

# Link the CLI globally
bun link
```

## Quick Start

```bash
# Start the server
bun run start

# Or with hot reload for development
bun run dev
```

The web UI is available at `http://localhost:3000`.

## CLI

The `archive` CLI provides commands for managing sessions and configuring the archive.

```
archive <command> [options]

Commands:
  daemon    Manage the background daemon (start/stop/status)
  upload    Upload a session to the archive
  config    Manage CLI configuration
  repo      Manage repository access control
  session   Manage sessions (list/delete/start)
  list      Alias for 'session list'
```

### Upload a Session

```bash
# Upload the current session (auto-detects from working directory)
archive upload

# Upload a specific session by UUID
archive upload --session c28995d0-7cba-4974-8268-32b94ac183a4

# Upload with a custom title
archive upload --title "Fixed authentication bug"

# Generate a code review alongside the upload
archive upload --review
```

### Background Daemon

The daemon watches for active Claude Code sessions and streams them to the archive server in real-time.

```bash
# Start the daemon
archive daemon start

# Check status
archive daemon status

# Stop the daemon
archive daemon stop
```

### Repository Access Control

Control which repositories are allowed for automatic uploads.

```bash
# Allow the current repository
archive repo allow

# List allowed repositories
archive repo list

# Remove a repository from the allowlist
archive repo deny
```

### Configuration

```bash
# Set the server URL
archive config set server https://archive.example.com

# View all configuration
archive config list
```

## API

### Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/sessions` | Create a session (multipart/form-data) |
| `GET` | `/api/sessions/:id/export` | Export session as JSON |
| `POST` | `/api/sessions/:id/share` | Generate a share link |
| `DELETE` | `/api/sessions/:id` | Delete a session |

### Creating a Session

```
POST /api/sessions (multipart/form-data)

Fields:
  title (required)     Session title
  description          Optional description
  claude_session_id    Original session ID
  project_path         Path to the project
  repo_url             GitHub repository URL
  harness              Client used (e.g., "Claude Code")
  model                Model used (e.g., "claude-sonnet-4-20250514")
  session_file         JSONL file containing session messages
  diff_file            Git diff content
  review_summary       AI-generated review summary
  annotations          JSON array of review annotations
```

## Tech Stack

- **Runtime**: Bun
- **Server**: `Bun.serve()` with WebSocket support
- **Database**: SQLite via `bun:sqlite`
- **Styling**: Tailwind CSS v4
- **Testing**: `bun test`

## Development

```bash
# Run tests
bun test

# Start dev server (uses $PORT env var to avoid conflicts)
PORT=3001 bun run dev
```
