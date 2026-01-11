# North Star

## Vision

A platform for sharing, reviewing, and eventually interacting with Claude Code sessions.

## Current Focus

**Session sharing and diff review** - Make it easy to share Claude Code sessions with others and review the changes made.

## Roadmap

### Phase 1: Sharing & Review (now)
- Read-only session viewer
- Shareable links
- Diff visualization

### Phase 2: Access Control
- GitHub-based permissions: only show sessions for repos a user has access to
- Private sessions shareable with teammates
- Org/team scoping

### Phase 3: Interactive Feedback
- In-the-loop review: provide feedback on diffs within the UI
- Feedback triggers new Claude Code sessions
- Could be live interaction with running instances or sandboxed agents

## Design Principles

- **Read-only first**: The archive is for viewing and sharing, not editing sessions directly
- **Git-centric permissions**: GitHub repo access is the natural permission boundary
- **Sessions are artifacts**: Treat sessions as reviewable artifacts, like PRs
