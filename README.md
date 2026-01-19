# openctl

A platform for storing, viewing, and sharing Claude Code sessions. Includes a web viewer with live streaming support and a CLI for uploading sessions.

## CLI Installation

Install the `openctl` CLI with the install script:

```bash
curl -fsSL https://openctl.dev/setup/install.sh | bash
```

This downloads the latest release for your platform and installs it to `/usr/local/bin`.

### Options

```bash
# Install to a custom directory
curl -fsSL https://openctl.dev/setup/install.sh | INSTALL_DIR=~/.local/bin bash
```

### From Source

If you prefer to build from source:

```bash
# Clone and install dependencies
git clone https://github.com/brkalow/openctl.git
cd openctl
bun install

# Build the CLI
bun run build:cli

# Install from local build
LOCAL_DIST=./dist ./install.sh
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

The `openctl` CLI provides commands for managing sessions and configuring the server.

```
openctl <command> [options]

Commands:
  upload    Upload a completed session to the server
  share     Share a live session for real-time viewing
  daemon    Manage the background daemon (start/stop/status)
  config    Manage CLI configuration
  repo      Manage repository access control
  session   Manage sessions (list/delete/unshare)
  list      Alias for 'session list'
```

### Upload a Completed Session

```bash
# Upload the current session (auto-detects from working directory)
openctl upload

# Pick from recent sessions interactively
openctl upload --list

# Upload a specific session by UUID
openctl upload --session c28995d0-7cba-4974-8268-32b94ac183a4

# Upload with a custom title
openctl upload --title "Fixed authentication bug"

# Generate a code review alongside the upload
openctl upload --review
```

### Share a Live Session

```bash
# Share the current session for real-time viewing
openctl share

# Pick from recent sessions interactively
openctl share --list

# Share a specific session by UUID
openctl share abc-123-def
```

### Background Daemon

The daemon watches for shared sessions and streams them to the server in real-time.

```bash
# Start the daemon
openctl daemon start

# Check status
openctl daemon status

# Stop the daemon
openctl daemon stop
```

### Repository Access Control

Control which repositories are allowed for automatic uploads.

```bash
# Allow the current repository
openctl repo allow

# List allowed repositories
openctl repo list

# Remove a repository from the allowlist
openctl repo deny
```

### Configuration

```bash
# Set the server URL
openctl config set server https://openctl.example.com

# View all configuration
openctl config list
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
# Install dependencies
bun install

# Run tests
bun test

# Start dev server (uses $PORT env var to avoid conflicts)
PORT=3001 bun run dev

# Link CLI for local development
bun link
```
