# openctl

A web application for storing and viewing Claude Code sessions.

## Contributing Learnings

When you discover something critical for effective development in this project, add it to the appropriate section below. This helps future agents work more effectively.

**What to capture:**
- Gotchas or non-obvious behaviors
- Patterns that work well (or don't)
- Architectural decisions and their rationale
- Commands or workflows that are frequently needed

## Quick Start

When running the dev server, use a different PORT than the default to avoid overlap with parallel agents:

```sh
PORT=3001 bun run dev
```

## Architecture Notes

- **Server**: Uses `Bun.serve()` with WebSocket support for live streaming
- **Database**: SQLite via `bun:sqlite` (file: `sessions.db`)
- **Frontend**: Server-rendered HTML with client-side hydration, Tailwind CSS v4
- **CLI**: Located in `cli/`, entry point is `cli/index.ts`
- **Component Library**: Visit `/_components` to browse all design tokens, typography, and UI primitives

## Planning and Documentation

- **Feature specs**: Write to `specs/` as markdown
- **Implementation plans**: Write to `plans/`, reference their spec file
- **North star**: Consult `specs/north_star.md` for architectural decisions

## Development Patterns

### Testing
```sh
bun test
```

### Creating commits
Prefer smaller implementation chunks broken into commits. When asked to implement a plan, create a new branch.

## Learned Patterns

<!-- Add learnings here as you discover them -->

### Session JSONL Format
- Session files are JSONL with one message per line
- Each line has a `message` object with `role` ("human", "user", or "assistant") and `content`
- Metadata like `gitBranch` and `model` may appear at the message level
- Files touched can be extracted from `tool_use` blocks with names `Write`, `Edit`, or `NotebookEdit`

### Git Diff Extraction
- The upload command extracts touched files from the session and filters the diff to only those files
- If a branch from session metadata no longer exists (merged/deleted), diff extraction gracefully returns null
