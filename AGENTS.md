# openctl

A web application for storing and viewing Claude Code sessions.

## Learned Patterns

**After completing a task, add any gotchas or non-obvious discoveries here.** This helps future agents work more effectively. Capture things like:
- Gotchas or non-obvious behaviors you encountered
- Patterns that work well (or don't)
- Architectural decisions and their rationale
- Commands or workflows that are frequently needed

### Session JSONL Format
- Session files are JSONL with one message per line
- Each line has a `message` object with `role` ("human", "user", or "assistant") and `content`
- Metadata like `gitBranch` and `model` may appear at the message level
- Files touched can be extracted from `tool_use` blocks with names `Write`, `Edit`, or `NotebookEdit`

### Git Diff Extraction
- The upload command extracts touched files from the session and filters the diff to only those files
- If a branch from session metadata no longer exists (merged/deleted), diff extraction gracefully returns null

---

## Quick Start

```sh
bun run dev
```

The dev server defaults to port 3000 and automatically selects the next available port if busy.

## Architecture Notes

- **Server**: Uses `Bun.serve()` with WebSocket support for live streaming (`src/server.ts`)
- **Database**: SQLite via `bun:sqlite` (file: `data/sessions.db`)
- **Frontend**: React SPA with client-side routing (`src/client/`), Tailwind CSS v4
- **CLI**: Located in `cli/`, entry point is `cli/index.ts`
- **Component Library**: Visit `/_components` to browse all design tokens, typography, and UI primitives

### Directory Structure (key directories)
```
src/
├── server.ts       # Main server entry point
├── routes/         # API and page route handlers
├── client/         # React frontend (App.tsx, components/, hooks/)
├── db/             # Database schema and repository
├── middleware/     # Auth middleware
├── lib/            # Shared utilities (daemon connections, rate limiting, etc.)
└── views/          # Server-rendered HTML templates

cli/
├── index.ts        # CLI entry point
├── commands/       # CLI command implementations (upload, auth, serve, etc.)
├── adapters/       # AI harness adapters (claude-code, etc.)
├── daemon/         # Background daemon for live streaming
└── lib/            # CLI utilities

tests/              # Organized by domain (db/, cli/, client/, integration/)
```

## Planning and Documentation

- **Feature specs**: Write to `specs/` as markdown
- **Implementation plans**: Write to `plans/`, reference their spec file
- **North star**: Consult `specs/north_star.md` for architectural decisions

## Authentication

The app uses Clerk for authentication with Google sign-in. See `specs/auth.md` for comprehensive documentation.

**Key concepts:**
- **Web auth**: Clerk-managed sessions with Bearer tokens
- **CLI auth**: OAuth 2.0 with PKCE flow via `openctl auth login`
- **Session ownership**: Dual model - sessions owned by `user_id` (authenticated) OR `client_id` (anonymous)
- **Access control**: Owner access via user_id/client_id match, public access via share tokens, remote sessions publicly accessible

**Environment variables** (see `.env.example`):
- `PUBLIC_CLERK_PUBLISHABLE_KEY` - Client-side Clerk key (must have PUBLIC_ prefix)
- `CLERK_SECRET_KEY` - Server-side Clerk key
- `OAUTH_CLIENT_ID` / `OAUTH_DOMAIN` - CLI OAuth configuration

**Auth middleware** (`src/middleware/auth.ts`):
- `extractAuth(req)` - Extracts userId and clientId from request
- `requireAuth(auth)` - Returns error response if not authenticated
- `verifyOwnership(sessionId, userId, clientId)` - Checks session access

## Development Patterns

### Testing
```sh
bun test                    # Run all tests
bun test tests/db/          # Run tests in a specific directory
bun test --watch            # Watch mode
```

Database tests use `:memory:` SQLite for isolation—see `tests/db/` for examples.

### Useful Scripts
```sh
bun run dev                 # Start dev server with hot reload
bun run seed                # Seed database with sample data
bun run build:cli           # Build CLI binary
bun run build:cli:release   # Build CLI with archive for distribution
```

### Verifying UI Changes
Always verify UI changes in the browser. Seed the database first for realistic test data:
```sh
bun run seed && bun run dev
```

### Creating commits
Prefer smaller implementation chunks broken into commits. When asked to implement a plan, create a new branch.
