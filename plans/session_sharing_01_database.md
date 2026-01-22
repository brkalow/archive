# Session Sharing Plan 1: Database Schema & Types

Implementation plan for database layer of session sharing. Reference: [specs/session_sharing.md](../specs/session_sharing.md)

**Prereqs:** None

## Overview

This plan adds the foundational database schema for session visibility and collaborators. All changes are backwards compatible - existing sessions continue to work with default `private` visibility.

## Tasks

### 1.1 Add visibility column to sessions

Add `visibility` column to sessions table in `src/db/schema.ts`:

```typescript
// Add after existing session columns
safeAddColumn(db, "sessions", "visibility", "TEXT DEFAULT 'private'");
db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_visibility ON sessions(visibility)`);
```

**Visibility values:**
- `private` (default) - Only owner and explicit collaborators
- `public` - Anyone with the link can view (except remote sessions)

### 1.2 Create session_collaborators table

Add in `src/db/schema.ts`:

```typescript
db.run(`
  CREATE TABLE IF NOT EXISTS session_collaborators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    email TEXT NOT NULL,
    user_id TEXT,
    role TEXT NOT NULL DEFAULT 'viewer',
    invited_by_user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'utc')),
    accepted_at TEXT,
    UNIQUE(session_id, email),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_collaborators_session ON session_collaborators(session_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_collaborators_email ON session_collaborators(email)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_collaborators_user ON session_collaborators(user_id)`);
```

### 1.3 Create session_audit_log table

Add in `src/db/schema.ts`:

```typescript
db.run(`
  CREATE TABLE IF NOT EXISTS session_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    target_email TEXT,
    old_value TEXT,
    new_value TEXT,
    created_at TEXT DEFAULT (datetime('now', 'utc')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_audit_session ON session_audit_log(session_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_audit_actor ON session_audit_log(actor_user_id)`);
```

### 1.4 Add TypeScript types

Add to `src/db/schema.ts`:

```typescript
// Session visibility
export type SessionVisibility = "private" | "public";

// Collaborator roles
export type CollaboratorRole = "viewer" | "contributor";

// Collaborator record
export type SessionCollaborator = {
  id: number;
  session_id: string;
  email: string;
  user_id: string | null;
  role: CollaboratorRole;
  invited_by_user_id: string;
  created_at: string;
  accepted_at: string | null;
};

// Collaborator status (derived from data)
export type CollaboratorStatus = "invited" | "active";

// Audit log actions
export type AuditAction =
  | "collaborator_added"
  | "collaborator_removed"
  | "collaborator_role_changed"
  | "visibility_changed";

// Audit log record
export type SessionAuditLog = {
  id: number;
  session_id: string;
  action: AuditAction;
  actor_user_id: string;
  target_email: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
};
```

### 1.5 Update Session type

Update the `Session` type to include visibility:

```typescript
export type Session = {
  // ... existing fields ...
  visibility: SessionVisibility;
};
```

### 1.6 Update normalizeSession helper

In `src/db/repository.ts`, update `normalizeSession` to handle the new field:

```typescript
private normalizeSession(result: Record<string, unknown>): Session {
  return {
    ...result,
    interactive: Boolean(result.interactive),
    remote: Boolean(result.remote),
    visibility: (result.visibility as SessionVisibility) || "private",
  } as Session;
}
```

## Testing Checklist

- [ ] New sessions created with default `private` visibility
- [ ] Existing sessions return `private` visibility (default)
- [ ] `session_collaborators` table created with proper indexes
- [ ] `session_audit_log` table created with proper indexes
- [ ] Session type includes `visibility` field
- [ ] Foreign key cascade works (deleting session removes collaborators and audit logs)

## Rollout

This migration is backwards compatible:
1. Deploy schema changes
2. Verify existing sessions work
3. New features can be deployed after
