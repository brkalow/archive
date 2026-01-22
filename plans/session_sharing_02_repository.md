# Session Sharing Plan 2: Collaborator Repository & Access Control

Implementation plan for repository layer and access control. Reference: [specs/session_sharing.md](../specs/session_sharing.md)

**Prereqs:** Plan 1 (database schema)

## Overview

This plan implements the collaborator repository methods and updates access control logic to check visibility and collaborator permissions.

## Tasks

### 2.1 Create email normalization utility

Create `src/lib/email.ts`:

```typescript
/**
 * Normalize an email address for storage and comparison.
 * - Converts to lowercase
 * - Trims whitespace
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Validate email format using basic RFC 5322 regex.
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
```

### 2.2 Add collaborator repository methods

Add to `src/db/repository.ts`:

```typescript
// Add prepared statements in constructor
private readonly collabStmts: {
  getCollaborators: Statement;
  getCollaborator: Statement;
  getCollaboratorByEmail: Statement;
  addCollaborator: Statement;
  updateCollaboratorRole: Statement;
  updateCollaboratorUserId: Statement;
  removeCollaborator: Statement;
  removeCollaboratorByEmail: Statement;
  getSessionsSharedWithUser: Statement;
  getSessionsSharedWithEmail: Statement;
};

// Initialize in constructor
this.collabStmts = {
  getCollaborators: db.prepare(`
    SELECT * FROM session_collaborators
    WHERE session_id = ?
    ORDER BY created_at ASC
  `),
  getCollaborator: db.prepare(`
    SELECT * FROM session_collaborators
    WHERE session_id = ? AND id = ?
  `),
  getCollaboratorByEmail: db.prepare(`
    SELECT * FROM session_collaborators
    WHERE session_id = ? AND email = ?
  `),
  addCollaborator: db.prepare(`
    INSERT INTO session_collaborators (session_id, email, role, invited_by_user_id)
    VALUES (?, ?, ?, ?)
    RETURNING *
  `),
  updateCollaboratorRole: db.prepare(`
    UPDATE session_collaborators
    SET role = ?
    WHERE id = ?
    RETURNING *
  `),
  updateCollaboratorUserId: db.prepare(`
    UPDATE session_collaborators
    SET user_id = ?, accepted_at = datetime('now', 'utc')
    WHERE session_id = ? AND email = ? AND user_id IS NULL
  `),
  removeCollaborator: db.prepare(`
    DELETE FROM session_collaborators WHERE id = ?
  `),
  removeCollaboratorByEmail: db.prepare(`
    DELETE FROM session_collaborators WHERE session_id = ? AND email = ?
  `),
  getSessionsSharedWithUser: db.prepare(`
    SELECT s.*, sc.role as collaborator_role
    FROM sessions s
    INNER JOIN session_collaborators sc ON s.id = sc.session_id
    WHERE sc.user_id = ?
    ORDER BY s.updated_at DESC
  `),
  getSessionsSharedWithEmail: db.prepare(`
    SELECT s.*, sc.role as collaborator_role
    FROM sessions s
    INNER JOIN session_collaborators sc ON s.id = sc.session_id
    WHERE sc.email = ?
    ORDER BY s.updated_at DESC
  `),
};
```

### 2.3 Add collaborator CRUD methods

```typescript
// Collaborator methods
getCollaborators(sessionId: string): SessionCollaborator[] {
  return this.collabStmts.getCollaborators.all(sessionId) as SessionCollaborator[];
}

getCollaborator(sessionId: string, collaboratorId: number): SessionCollaborator | null {
  return this.collabStmts.getCollaborator.get(sessionId, collaboratorId) as SessionCollaborator | null;
}

getCollaboratorByEmail(sessionId: string, email: string): SessionCollaborator | null {
  const normalizedEmail = normalizeEmail(email);
  return this.collabStmts.getCollaboratorByEmail.get(sessionId, normalizedEmail) as SessionCollaborator | null;
}

getCollaboratorCount(sessionId: string): number {
  const stmt = this.db.prepare("SELECT COUNT(*) as count FROM session_collaborators WHERE session_id = ?");
  const result = stmt.get(sessionId) as { count: number };
  return result.count;
}

addCollaborator(
  sessionId: string,
  email: string,
  role: CollaboratorRole,
  invitedByUserId: string
): SessionCollaborator | null {
  const normalizedEmail = normalizeEmail(email);

  try {
    return this.collabStmts.addCollaborator.get(
      sessionId,
      normalizedEmail,
      role,
      invitedByUserId
    ) as SessionCollaborator;
  } catch (err) {
    // Unique constraint violation - collaborator already exists
    // Return existing collaborator (idempotent behavior)
    const existing = this.getCollaboratorByEmail(sessionId, normalizedEmail);
    if (existing && existing.role !== role) {
      // Update role if different
      return this.updateCollaboratorRole(existing.id, role);
    }
    return existing;
  }
}

updateCollaboratorRole(collaboratorId: number, role: CollaboratorRole): SessionCollaborator | null {
  return this.collabStmts.updateCollaboratorRole.get(role, collaboratorId) as SessionCollaborator | null;
}

/**
 * Link a collaborator record to a user ID on first access.
 * Only updates if user_id is currently NULL (hasn't been linked yet).
 */
linkCollaboratorToUser(sessionId: string, email: string, userId: string): void {
  const normalizedEmail = normalizeEmail(email);
  this.collabStmts.updateCollaboratorUserId.run(userId, sessionId, normalizedEmail);
}

removeCollaborator(collaboratorId: number): boolean {
  const result = this.collabStmts.removeCollaborator.run(collaboratorId);
  return result.changes > 0;
}

removeCollaboratorByEmail(sessionId: string, email: string): boolean {
  const normalizedEmail = normalizeEmail(email);
  const result = this.collabStmts.removeCollaboratorByEmail.run(sessionId, normalizedEmail);
  return result.changes > 0;
}

/**
 * Get sessions shared with a user (by user_id or email).
 */
getSessionsSharedWith(userId?: string, email?: string): Array<Session & { collaborator_role: CollaboratorRole }> {
  const results: Array<Record<string, unknown>> = [];

  if (userId) {
    results.push(...this.collabStmts.getSessionsSharedWithUser.all(userId) as Record<string, unknown>[]);
  }

  if (email) {
    const normalizedEmail = normalizeEmail(email);
    const byEmail = this.collabStmts.getSessionsSharedWithEmail.all(normalizedEmail) as Record<string, unknown>[];
    // Dedupe by session ID
    const seenIds = new Set(results.map(r => r.id));
    for (const row of byEmail) {
      if (!seenIds.has(row.id)) {
        results.push(row);
      }
    }
  }

  return results.map(r => ({
    ...this.normalizeSession(r),
    collaborator_role: r.collaborator_role as CollaboratorRole,
  }));
}
```

### 2.4 Add visibility update method

```typescript
updateSessionVisibility(sessionId: string, visibility: SessionVisibility): Session | null {
  const stmt = this.db.prepare(`
    UPDATE sessions
    SET visibility = ?, updated_at = datetime('now', 'utc')
    WHERE id = ?
    RETURNING *
  `);
  const result = stmt.get(visibility, sessionId) as Record<string, unknown> | null;
  return result ? this.normalizeSession(result) : null;
}
```

### 2.5 Update verifyOwnership to include collaborator and visibility checks

Replace/update `verifyOwnership` in `src/db/repository.ts`:

```typescript
/**
 * Access control for sessions.
 *
 * Access is granted in this order (first match wins):
 * 1. User is owner (user_id OR client_id matches)
 * 2. User is a collaborator (email or user_id in session_collaborators)
 * 3. Session is public AND NOT remote
 * 4. Share token matches (handled separately in routes)
 * 5. Otherwise, no access
 */
checkAccess(
  sessionId: string,
  userId: string | null,
  clientId: string | null,
  userEmail: string | null,
  options: {
    requireOwner?: boolean;
    action?: 'view' | 'annotate' | 'prompt';
  } = {}
): {
  allowed: boolean;
  isOwner: boolean;
  role?: CollaboratorRole;
} {
  const { requireOwner = false, action = 'view' } = options;

  // Get session with visibility
  const session = this.getSession(sessionId);
  if (!session) {
    return { allowed: false, isOwner: false };
  }

  // 1. Check ownership
  const isOwner =
    (userId && session.user_id === userId) ||
    (clientId && session.client_id === clientId) ||
    false;

  if (isOwner) {
    return { allowed: true, isOwner: true };
  }

  if (requireOwner) {
    return { allowed: false, isOwner: false };
  }

  // 2. Check collaborator access
  let collaborator: SessionCollaborator | null = null;

  if (userId) {
    // Check by user_id first
    const stmt = this.db.prepare(`
      SELECT * FROM session_collaborators
      WHERE session_id = ? AND user_id = ?
    `);
    collaborator = stmt.get(sessionId, userId) as SessionCollaborator | null;
  }

  if (!collaborator && userEmail) {
    // Fall back to email check
    collaborator = this.getCollaboratorByEmail(sessionId, userEmail);

    // Link user_id for future lookups
    if (collaborator && userId && !collaborator.user_id) {
      this.linkCollaboratorToUser(sessionId, userEmail, userId);
    }
  }

  if (collaborator) {
    const allowed = this.checkRolePermission(collaborator.role, action, session);
    return { allowed, isOwner: false, role: collaborator.role };
  }

  // 3. Check public access (non-remote only)
  if (session.visibility === 'public' && !session.remote) {
    const allowed = action === 'view'; // Public only allows viewing
    return { allowed, isOwner: false };
  }

  return { allowed: false, isOwner: false };
}

/**
 * Check if a role has permission for an action.
 */
private checkRolePermission(
  role: CollaboratorRole,
  action: 'view' | 'annotate' | 'prompt',
  session: Session
): boolean {
  switch (action) {
    case 'view':
      // Both viewers and contributors can view
      return true;

    case 'annotate':
      // Only contributors can annotate
      return role === 'contributor';

    case 'prompt':
      // Only contributors on remote/interactive sessions can send prompts
      return role === 'contributor' && (session.remote || session.interactive);

    default:
      return false;
  }
}
```

### 2.6 Add audit logging methods

```typescript
// Add prepared statement
private readonly auditStmts: {
  insertAuditLog: Statement;
  getAuditLogs: Statement;
};

// In constructor
this.auditStmts = {
  insertAuditLog: db.prepare(`
    INSERT INTO session_audit_log (session_id, action, actor_user_id, target_email, old_value, new_value)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getAuditLogs: db.prepare(`
    SELECT * FROM session_audit_log
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `),
};

// Methods
logAuditEvent(
  sessionId: string,
  action: AuditAction,
  actorUserId: string,
  targetEmail?: string,
  oldValue?: string,
  newValue?: string
): void {
  this.auditStmts.insertAuditLog.run(
    sessionId,
    action,
    actorUserId,
    targetEmail ?? null,
    oldValue ?? null,
    newValue ?? null
  );
}

getAuditLogs(sessionId: string, limit: number = 50): SessionAuditLog[] {
  return this.auditStmts.getAuditLogs.all(sessionId, limit) as SessionAuditLog[];
}
```

## Testing Checklist

- [ ] `normalizeEmail` converts to lowercase and trims whitespace
- [ ] `isValidEmail` validates email format correctly
- [ ] `addCollaborator` creates new collaborator record
- [ ] `addCollaborator` is idempotent (updates role on duplicate)
- [ ] `getCollaborators` returns all collaborators for a session
- [ ] `removeCollaborator` deletes collaborator record
- [ ] `getSessionsSharedWith` returns sessions shared with user
- [ ] `checkAccess` returns `allowed: true` for owner
- [ ] `checkAccess` returns `allowed: true` for collaborator (view)
- [ ] `checkAccess` returns `allowed: true` for public session (view)
- [ ] `checkAccess` returns `allowed: false` for public remote session
- [ ] `checkAccess` correctly enforces role permissions for actions
- [ ] `linkCollaboratorToUser` links user_id on first access
- [ ] `logAuditEvent` creates audit log records

## Notes

- The `checkAccess` method replaces the simpler `verifyOwnership` for routes that need full access control
- Existing `verifyOwnership` can remain for backwards compatibility in routes that only need owner checks
- Email normalization happens at the repository layer to ensure consistency
