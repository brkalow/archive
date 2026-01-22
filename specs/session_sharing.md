# Session Sharing Specification

## Overview

This spec defines the session sharing model, including visibility controls and collaborator permissions. It supersedes the "User-to-User Sharing (Phase 1.5)" section in `auth.md`.

## Goals

1. **Visibility control**: Sessions can be private (default) or public
2. **Granular collaboration**: Share with specific users as viewers or contributors
3. **Owner control**: Only owners can manage visibility and collaborators
4. **Remote session protection**: Remote sessions cannot be made public

## Non-Goals (This Phase)

- Team/organization-based access
- GitHub repo-based permissions
- Transferring ownership
- "Request access" workflow

---

## Visibility Model

### Session Visibility States

| Visibility | Description | Who Can View |
|------------|-------------|--------------|
| `private` | Default. Only owner and explicit collaborators | Owner + collaborators |
| `public` | Anyone with the link can view | Anyone |

### Visibility Rules

1. **Default**: All sessions are `private`
2. **Remote sessions**: Cannot be made `public` (they contain live terminal access)
3. **Changing visibility**: Only the session owner can change visibility
4. **Public access**: Public sessions are read-only to non-collaborators
5. **Visibility changes preserve collaborators**: Switching to public keeps collaborator list intact; switching back to private restores their access

### Data Model

Add `visibility` column to sessions table:

```sql
ALTER TABLE sessions ADD COLUMN visibility TEXT DEFAULT 'private';
CREATE INDEX idx_sessions_visibility ON sessions(visibility);
```

---

## Collaborator Model

### Roles

| Role | Can View | Can Comment | Can Send Prompts |
|------|----------|-------------|------------------|
| `viewer` | Yes | No | No |
| `contributor` | Yes | Yes | Yes* |

*Contributors can send prompts to remote/interactive sessions. Prompts go through the approval flow (see `interactive_sessions.md`).

### Collaborator Permissions by Session Type

| Action | Owner | Contributor (Remote) | Contributor (Non-Remote) | Viewer | Public |
|--------|-------|---------------------|-------------------------|--------|--------|
| View session | Yes | Yes | Yes | Yes | Yes |
| View diffs | Yes | Yes | Yes | Yes | Yes |
| Add annotations | Yes | Yes | Yes | No | No |
| Send prompts | Yes | Yes | No | No | No |
| Manage collaborators | Yes | No | No | No | No |
| Change visibility | Yes | No | No | No | No |
| Delete session | Yes | No | No | No | No |

**Note**: "Send prompts" only applies to live remote/interactive sessions. Archived sessions are read-only for all non-owners.

### Invitation States

Collaborators exist in one of two states:

| State | `user_id` | Description |
|-------|-----------|-------------|
| `invited` | NULL | Email sent but user hasn't accessed yet |
| `active` | Set | User has accessed the session at least once |

On first access with matching email, the system sets `user_id` automatically.

### Data Model

Create `session_collaborators` table:

```sql
CREATE TABLE session_collaborators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  email TEXT NOT NULL,                    -- Normalized (see Email Normalization)
  user_id TEXT,                           -- Clerk user ID (set on first access)
  role TEXT NOT NULL DEFAULT 'viewer',    -- 'viewer' or 'contributor'
  invited_by_user_id TEXT NOT NULL,       -- Who added them
  created_at TEXT DEFAULT (datetime('now', 'utc')),
  accepted_at TEXT,                       -- When user first accessed
  UNIQUE(session_id, email),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_collaborators_session ON session_collaborators(session_id);
CREATE INDEX idx_collaborators_email ON session_collaborators(email);
CREATE INDEX idx_collaborators_user ON session_collaborators(user_id);
```

### Collaborator Limits

- **Per session**: Maximum 50 collaborators
- **Rate limiting**: 50 additions per hour per user (across all sessions)
- **Email throttling**: 10 invitation emails per hour per user

---

## Email Normalization

All emails are normalized before storage and comparison:

1. Convert to lowercase
2. Trim leading/trailing whitespace
3. Validate against RFC 5322 format

Gmail-specific normalization (optional, Phase 2):
- Remove dots: `a.b@gmail.com` → `ab@gmail.com`
- Remove plus aliases: `ab+tag@gmail.com` → `ab@gmail.com`

---

## Access Control Logic

Access checks are evaluated in order. First match wins:

```
1. User is owner (user_id matches OR client_id matches) → Full access
2. User email/user_id in session_collaborators → Role-based access
3. Session is public AND NOT remote → Read-only access
4. Share token matches (legacy /s/:token route) → Read-only access
5. Otherwise → No access (403)
```

**Order matters**: Collaborator check before public check ensures contributors retain their permissions even on public sessions.

### Share Token vs Collaborator Access

Share tokens provide **public read-only access** equivalent to `public` visibility:
- Can view session, messages, and diffs
- **Cannot** see collaborator list (owner-only)
- **Cannot** add annotations or send prompts
- **Cannot** manage collaborators or visibility

Think of share tokens as "secret public links" - they grant the same permissions as public visibility but without changing the session's visibility setting.

### Integration with Existing Auth

Update `canAccessSession()` in `src/middleware/auth.ts`:

```typescript
async function canAccessSession(
  session: Session,
  req: Request,
  options: { requireOwner?: boolean; action?: 'view' | 'annotate' | 'prompt' } = {}
): Promise<{ allowed: boolean; userId?: string; isOwner: boolean; role?: string }> {
  // 1. Check ownership first
  const isOwner = checkOwnership(session, userId, clientId);
  if (isOwner) return { allowed: true, userId, isOwner: true };

  if (options.requireOwner) return { allowed: false, userId, isOwner: false };

  // 2. Check collaborator access
  const collaborator = await getCollaborator(session.id, userId, userEmail);
  if (collaborator) {
    const allowed = checkPermission(collaborator.role, options.action, session);
    return { allowed, userId, isOwner: false, role: collaborator.role };
  }

  // 3. Check public access (non-remote only)
  if (session.visibility === 'public' && !session.remote) {
    const allowed = options.action === 'view'; // Public only allows viewing
    return { allowed, userId, isOwner: false };
  }

  // 4. Check share token
  const shareToken = extractShareToken(req);
  if (shareToken && session.share_token === shareToken) {
    const allowed = options.action === 'view';
    return { allowed, userId, isOwner: false };
  }

  return { allowed: false, userId, isOwner: false };
}
```

---

## API Endpoints

### Visibility

```
PATCH /api/sessions/:id
{
  "visibility": "public" | "private"
}

Response: 200 OK with updated session
Errors:
  - 403 if not owner
  - 400 if remote session and trying to set public
```

### Collaborators

**List collaborators** (owner or collaborator can view):
```
GET /api/sessions/:id/collaborators
Authorization: Required

Response:
{
  "collaborators": [
    {
      "id": 123,
      "email": "teammate@example.com",
      "user_id": "user_xxx",        // null if invited but not yet accessed
      "role": "contributor",
      "status": "active",           // "invited" or "active"
      "created_at": "2024-01-15T10:00:00Z",
      "accepted_at": "2024-01-15T11:00:00Z"
    }
  ],
  "total": 1
}
```

**Add collaborator** (owner only):
```
POST /api/sessions/:id/collaborators
Authorization: Required (owner only)

Request:
{
  "email": "teammate@example.com",
  "role": "viewer" | "contributor"   // defaults to "viewer"
}

Response: 201 Created
{
  "id": 123,
  "email": "teammate@example.com",
  "role": "viewer",
  "status": "invited",
  "created_at": "2024-01-15T10:00:00Z"
}
```

**Security**: Always returns 201 for valid email format to prevent email enumeration. If email is already a collaborator, silently updates role (idempotent). If email is owner, returns 201 but no-ops.

**Update collaborator role** (owner only):
```
PATCH /api/sessions/:id/collaborators/:collaborator_id
Authorization: Required (owner only)

Request:
{
  "role": "contributor"
}

Response: 200 OK
```

**Remove collaborator** (owner only):
```
DELETE /api/sessions/:id/collaborators/:collaborator_id
Authorization: Required (owner only)

Response: 204 No Content
```

**Self-removal** (collaborator removing themselves):
```
DELETE /api/sessions/:id/collaborators/me
Authorization: Required (must be a collaborator)

Response: 204 No Content
```

### Shared With Me

```
GET /api/sessions?filter=shared
Authorization: Required

Response: Sessions where user is a collaborator (not owner)

GET /api/sessions?filter=owned
Authorization: Required

Response: Sessions where user is owner

GET /api/sessions
Authorization: Required

Response: Both owned and shared sessions, with `access_type` field:
{
  "sessions": [
    {
      "id": "...",
      "title": "...",
      "access_type": "owned" | "shared",
      "collaborator_role": "contributor"  // only if shared
    }
  ]
}
```

### Error Response Format

All errors follow consistent structure:

```json
{
  "error": "BadRequest",
  "message": "Remote sessions cannot be made public",
  "code": "REMOTE_SESSION_PUBLIC"
}
```

Error codes:
- `REMOTE_SESSION_PUBLIC` - Tried to make remote session public
- `NOT_OWNER` - Action requires ownership
- `NOT_FOUND` - Session or collaborator not found
- `COLLABORATOR_LIMIT` - Max 50 collaborators reached
- `RATE_LIMITED` - Too many additions, try again later
- `INVALID_EMAIL` - Email format invalid

---

## Live Session Integration

### Adding Collaborators to Live Sessions

- Owner can add/remove collaborators while session is live
- New collaborators immediately receive live updates via WebSocket
- Removing a collaborator closes their WebSocket connection

### Contributor Prompts

When a contributor sends a prompt to a live remote session:
1. Prompt enters pending state
2. Owner sees approval request (via PTY wrapper or browser UI)
3. Owner approves or rejects
4. Contributor sees status update in real-time

See `interactive_sessions.md` for full approval flow.

### Status Transitions

- Collaborator permissions persist across status changes (live → complete → archived)
- Prompt-sending permission only active during `live` status
- Archived sessions are read-only for all users

### WebSocket Events

Broadcast to connected clients when collaborators change:

```typescript
type CollaboratorEvent =
  | { type: "collaborator_added"; id: number; email: string; role: string }
  | { type: "collaborator_removed"; id: number; email: string }
  | { type: "collaborator_updated"; id: number; role: string }
  | { type: "visibility_changed"; visibility: "public" | "private" }
```

---

## UI Design

### Share Button

Located in the session header. Shows indicator when session has collaborators:
- No collaborators: "Share" button
- Has collaborators: "Share" button with avatar stack + count

### Share Modal

Inspired by Notion's share menu.

**Structure:**
```
┌─────────────────────────────────────────────────────┐
│  Share                                    [Publish] │
├─────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐  ┌────────┐│
│ │ Email address                       │  │ Invite ││
│ └─────────────────────────────────────┘  └────────┘│
│                                                     │
│  People with access                                 │
│  ┌─────────────────────────────────────────────────┐│
│  │ 👤 Owner Name (you)           Owner             ││
│  │    owner@example.com                            ││
│  ├─────────────────────────────────────────────────┤│
│  │ 👤 Collaborator Name         [Contributor ▼]   ││
│  │    collab@example.com        [Remove]          ││
│  ├─────────────────────────────────────────────────┤│
│  │ ✉️  invited@example.com       [Viewer ▼]       ││
│  │    Invited · Pending          [Remove]          ││
│  └─────────────────────────────────────────────────┘│
│                                                     │
│  ─────────────────────────────────────────────────  │
│                                                     │
│  General access                                     │
│  ┌─────────────────────────────────────────────────┐│
│  │ 🔒 Private                   [Change ▼]        ││
│  │    Only people with access can view            ││
│  └─────────────────────────────────────────────────┘│
│                                                     │
│                                      [🔗 Copy link] │
└─────────────────────────────────────────────────────┘
```

**Tabs:**
- **Share** (default): Manage collaborators
- **Publish**: Legacy share token flow (generates /s/:token URL)

**Email Input:**
- Autocomplete from previous collaborators (future)
- Role selector dropdown next to Invite button
- Validation: must be valid email format

**Collaborator List:**
- Shows name (if known from Clerk) and email
- Role dropdown: Viewer, Contributor
- Remove button (trash icon)
- Owner shown at top, non-editable, with distinct background (accent tint)
- Pending invitations show "Invited · Pending" badge in muted yellow
- Section heading: "People with access" in uppercase, muted color, font-medium

**General Access Section:**
- Visually prominent (subtle border) since it's a security-critical setting
- Private (default): Lock icon + "Only people with access can view"
- Public: Globe icon + "Anyone with the link can view"
- Disabled for remote sessions with lock on dropdown + info text explaining why

**Copy Link Button:**
- Copies the session URL to clipboard
- Shows toast confirmation

### Role Selector Dropdown

```
┌──────────────┐
│ ✓ Viewer     │
│   Contributor│
├──────────────┤
│   Remove     │
└──────────────┘
```

### Access Indicators

On session cards/list:
- Private: Lock icon
- Public: Globe icon
- Shared with you: "Shared by [name]" badge

---

## UI States & Interactions

### Loading States

**Initial modal load:**
```
┌─────────────────────────────────────────────────┐
│  People with access                              │
│  ┌─────────────────────────────────────────────┐│
│  │ [████████░░░░░░░░░░]  [███░░] [████░]       ││  ← skeleton shimmer
│  │ [██████████████░░░░]  [███░░] [████░]       ││
│  └─────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
```

**Invite in progress:**
```
[email input disabled]  [🔄 Inviting...]  ← button disabled with spinner
```

**Role change in progress:**
```
│ 👤 Jane Doe              [🔄 Updating...]       │  ← inline spinner on affected row
```

**Visibility change in progress:**
```
│ 🔒 Private → Public      [🔄 Updating...]       │  ← toggle disabled with spinner
```

### Empty State

When no collaborators have been added:
```
┌─────────────────────────────────────────────────┐
│  People with access                              │
│  ┌─────────────────────────────────────────────┐│
│  │         👥 No collaborators yet              ││
│  │    Share this session by inviting people     ││
│  │    via email above.                          ││
│  └─────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
```

### Error States

**Network error loading collaborators:**
```
┌─────────────────────────────────────────────────┐
│  ⚠️ Failed to load collaborators                 │
│     Check your connection and try again.        │
│                    [Retry]                       │
└─────────────────────────────────────────────────┘
```

**Invite failed:**
- Toast: "Failed to invite collaborator. Please try again."
- Input remains populated so user can retry

**Role change failed:**
- Toast: "Failed to update role. Please try again."
- Revert dropdown to previous value

**Concurrent modification detected:**
```
┌─────────────────────────────────────────────────┐
│ ⚠️ This session was updated. [Refresh]          │  ← banner at top of modal
├─────────────────────────────────────────────────┤
```

### Confirmation Flows

**Remove collaborator:**
```
Modal:
┌─────────────────────────────────────────────────┐
│  Remove Jane Doe?                                │
│                                                  │
│  They will immediately lose access to this       │
│  session.                                        │
│                                                  │
│                        [Cancel]  [Remove]        │
└─────────────────────────────────────────────────┘
```

**Change visibility to private:**
```
Modal:
┌─────────────────────────────────────────────────┐
│  Make this session private?                      │
│                                                  │
│  Anyone viewing via public link will lose        │
│  access. Collaborators will keep their access.   │
│                                                  │
│                      [Cancel]  [Make Private]    │
└─────────────────────────────────────────────────┘
```

### Input Validation

**Real-time email validation:**
- Invalid format: Red border + "Enter a valid email address"
- Valid format: Green checkmark appears in input

**After successful invite:**
1. Input clears
2. New collaborator slides into list with animation
3. Toast: "Invitation sent to jane@example.com"

### Copy Link Feedback

**Success sequence:**
1. Click "Copy link"
2. Button text changes: "Copy link" → "✓ Copied!"
3. Button background flashes accent color (150ms)
4. Toast appears: "Link copied to clipboard"
5. After 2s: Button reverts to "Copy link"

**Clipboard failure:**
- Toast: "Failed to copy. Select and copy manually."
- Show readonly input with URL below button

**Link context hint:**
```
Private session:
[🔗 Copy link]
"Link works for people with access"

Public session:
[🔗 Copy link]
"Anyone with this link can view"
```

### Remote Session Disabled State

When session is remote, visibility cannot be changed:
```
│ 🔒 Private                    [🔒 Private]      │  ← dropdown shows lock icon
│    Only people with access                      │
│    ⓘ Remote sessions cannot be made public     │  ← info text
```
- Dropdown is visually disabled (greyed out)
- Clicking shows tooltip: "Remote sessions cannot be made public for security"

### Text Truncation

**Long email addresses:**
```
│ ✉️ verylongemail...@example.com  [Viewer ▼]    │
│    Invited · Pending              [Remove]      │
```
- Full email shown in tooltip on hover
- Truncate at ~25 characters with ellipsis

**Long display names:**
```
│ 👤 Maximilian Augustus...        [Viewer ▼]    │
│    max@example.com               [Remove]      │
```
- Full name shown in tooltip on hover

### Animations

**Modal:**
- Enter: fade-in 200ms + scale(0.95 → 1) ease-out
- Exit: fade-out 150ms + scale(1 → 0.95) ease-in
- Backdrop: fade 200ms

**Collaborator row add:**
- Slide in from top: translateY(-10px) → translateY(0)
- Fade in: opacity 0 → 1
- Duration: 250ms ease-out

**Collaborator row remove:**
- Slide out left: translateX(0) → translateX(-20px)
- Fade out: opacity 1 → 0
- Height collapse
- Duration: 200ms ease-in

**Tab switch:**
- Content crossfade: 150ms

### Accessibility

**Keyboard navigation:**
- Tab order: Email input → Role selector → Invite → Collaborator rows (role dropdown → remove) → Visibility dropdown → Copy link
- Enter in email input: Submit invitation
- Escape: Close modal
- Arrow keys: Navigate dropdown options

**Focus management:**
- After adding collaborator: Focus returns to email input
- After removing collaborator: Focus moves to next row, or email input if last
- Modal open: Focus trapped within modal
- Modal close: Focus returns to Share button

**ARIA labels:**
```html
<input aria-label="Email address to invite" />
<button aria-label="Invite collaborator">Invite</button>
<button aria-label="Remove Jane Doe from session">Remove</button>
<select aria-label="Change role for Jane Doe">
```

**Live announcements:**
```html
<div role="status" aria-live="polite" class="sr-only">
  <!-- "Jane Doe added as Viewer" -->
  <!-- "Role changed to Contributor" -->
  <!-- "Jane Doe removed" -->
  <!-- "Link copied to clipboard" -->
</div>
```

**Icon-only buttons:**
- Remove button (trash icon): Must have aria-label
- All icons paired with sr-only text or aria-label

### Mobile Layout

**Breakpoint:** < 640px

**Modal:**
- Full-screen overlay instead of centered dialog
- Header pinned to top with close button

**Email input section:**
```
Mobile:
┌────────────────────────────────┐
│ Email address                  │
└────────────────────────────────┘
┌────────────────────────────────┐
│           Invite               │
└────────────────────────────────┘

Desktop: Side by side
```

**Collaborator rows:**
```
Mobile:
┌────────────────────────────────┐
│ 👤 Jane Doe                     │
│    jane@example.com             │
│    [Contributor ▼]    [Remove]  │
└────────────────────────────────┘

Desktop: Single row
```

**Touch targets:**
- All buttons/dropdowns: Minimum 44x44px touch area
- Remove button: Extra padding around icon (40px minimum)

**Role selector:**
- Opens as bottom sheet instead of dropdown on mobile

---

## Email Notifications

### Invitation Email

**Subject**: `[Name] shared a session with you on openctl`

**Body**:
```
[Name] shared a session with you.

"[Session Title]"

View session: https://openctl.dev/sessions/[id]

---
You're receiving this because [email] was added as a [role] on this session.
```

### Removal Email (optional, Phase 2)

**Subject**: `You've been removed from a session on openctl`

**Body**:
```
You no longer have access to "[Session Title]".

If you believe this was a mistake, contact the session owner.
```

---

## Audit Log

Track all sharing-related changes for security:

```sql
CREATE TABLE session_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  target_email TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT DEFAULT (datetime('now', 'utc')),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_audit_session ON session_audit_log(session_id);
CREATE INDEX idx_audit_actor ON session_audit_log(actor_user_id);
```

Actions:
- `collaborator_added`
- `collaborator_removed`
- `collaborator_role_changed`
- `visibility_changed`

Display "Share history" link in share modal for owner.

---

## Implementation Order

### Phase 1: Core Sharing

1. **Database migration**
   - Add `visibility` column to sessions
   - Create `session_collaborators` table
   - Create `session_audit_log` table

2. **API endpoints**
   - PATCH /api/sessions/:id (visibility)
   - GET/POST/PATCH/DELETE /api/sessions/:id/collaborators
   - DELETE /api/sessions/:id/collaborators/me
   - GET /api/sessions?filter=shared|owned

3. **Access control update**
   - Update `canAccessSession` to check visibility + collaborators
   - Add role-based permission checks
   - Add action-specific permission checks (view, annotate, prompt)

4. **Share modal UI**
   - Collaborator management (add/remove/change role)
   - Visibility toggle
   - Copy link button
   - Invitation status badges
   - Loading states (skeleton, inline spinners)
   - Empty state
   - Error states with retry
   - Confirmation modals (remove, visibility change)
   - Mobile layout (full-screen, stacked inputs)
   - Accessibility (keyboard nav, ARIA labels, focus management)

5. **Audit logging**
   - Log all collaborator and visibility changes

### Phase 2: Polish

6. **Email notifications**
   - Send email when collaborator added
   - Use transactional email service (Resend, Postmark)

7. **"Shared with me" view**
   - Filter/tab in sessions list
   - Show who shared each session

8. **Access denied page**
   - Clear message when user lacks access
   - "Request access" button (placeholder for future)

9. **WebSocket events**
   - Real-time collaborator updates in share modal

### Future: Team Sharing

- Team/organization model
- "Everyone at [Org]" access like Notion
- GitHub repo-based permissions
- Inherit sharing from parent (if we add folders/workspaces)
- Ownership transfer

---

## Edge Cases

1. **Collaborator doesn't have account**: They sign up with Google, email must match invited email
2. **Collaborator uses different email**: Show message: "This session was shared with [invited_email]. Please sign in with that account."
3. **Owner changes visibility to private**: Existing collaborators keep access
4. **Session deleted**: Collaborators removed via CASCADE, no notification
5. **Remote session**: Visibility dropdown disabled with tooltip
6. **Owner tries to add themselves**: Silent no-op (returns 201 but doesn't create record)
7. **Duplicate invite**: Silent update to new role (idempotent)
8. **Collaborator limit reached**: Return 400 with `COLLABORATOR_LIMIT` code
9. **Email changes in Clerk**: Access checked by both `user_id` and `email` - if user_id is set, that takes precedence

---

## Migration from Share Tokens

Existing share tokens (`/s/:shareToken` route) continue to work:
- They provide public, read-only access regardless of visibility setting
- Think of them as "secret links" that bypass visibility
- This maintains backwards compatibility

### Future Deprecation Path (Phase 3+)

1. Add banner: "Share tokens will be deprecated. Use public visibility instead."
2. Add "Convert to public" button on Publish tab
3. Disable new share token generation
4. Auto-convert sessions with share tokens to public (with owner notification)

---

## Security Considerations

1. **Email enumeration prevention**: POST collaborators always returns 201 for valid email format
2. **Rate limiting**: 50 collaborator additions per hour per user
3. **Collaborator limits**: Max 50 per session
4. **Email throttling**: Max 10 invitation emails per hour per user
5. **Audit logging**: All changes tracked with actor and timestamp
6. **Notification opt-out**: Allow users to unsubscribe from share emails (future)

---

## References

- [auth.md](./auth.md) - Authentication and ownership model
- [interactive_sessions.md](./interactive_sessions.md) - Feedback and prompt approval flow
- [live_streaming.md](./live_streaming.md) - WebSocket streaming
- [north_star.md](./north_star.md) - Product roadmap
- Notion share menu - UI inspiration
