# Claude Session Archive

A read-only web application for storing and viewing Claude Code sessions.

## Quick Start

```sh
bun run start  # Start server on http://localhost:3000
bun run dev    # Start with hot reload
```

## API

### Create Session
```
POST /api/sessions (multipart/form-data)
- title (required), description, claude_session_id, project_path, pr_url
- session_data: JSON/JSONL of messages (or session_file)
- diff_data: Diff content (or diff_file)
```

### Other Endpoints
- `GET /api/sessions/:id/export` - Export session as JSON
- `POST /api/sessions/:id/share` - Generate share link
- `DELETE /api/sessions/:id` - Delete session

## Planning and Documentation

When creating an implementation plan, write it to `specs/` as a markdown file.

When you learn something new about the architecture or high-level product vision, write it to `specs/north_star.md`.

**IMPORTANT:** Always consult `specs/north_star.md` when making decisions. If you encounter a contradiction, ask if the north star should be adjusted.

## Tech Stack

Use Bun, not Node.js. Use `Bun.serve()` for routing (not express). Use `bun:sqlite` for the database. Use `bun test` for tests.
