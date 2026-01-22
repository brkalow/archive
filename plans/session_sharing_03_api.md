# Session Sharing Plan 3: API Endpoints

Implementation plan for HTTP API endpoints. Reference: [specs/session_sharing.md](../specs/session_sharing.md)

**Prereqs:** Plan 2 (repository layer)

## Overview

This plan implements the REST API endpoints for managing session visibility and collaborators.

## Tasks

### 3.1 Add route patterns

In `src/routes/api.ts`, add new route patterns:

```typescript
const ROUTES = {
  // ... existing routes ...
  collaborators: /^\/api\/sessions\/([^\/]+)\/collaborators$/,
  collaborator: /^\/api\/sessions\/([^\/]+)\/collaborators\/(\d+)$/,
  collaboratorSelf: /^\/api\/sessions\/([^\/]+)\/collaborators\/me$/,
};
```

### 3.2 Add Clerk user lookup utility

Create `src/lib/clerk.ts`:

```typescript
import { createClerkClient } from '@clerk/backend';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.PUBLIC_CLERK_PUBLISHABLE_KEY,
});

// Simple in-memory cache for user lookups
const userCache = new Map<string, { data: ClerkUserInfo; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export interface ClerkUserInfo {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
}

/**
 * Get user info from Clerk with caching.
 */
export async function getUserInfo(userId: string): Promise<ClerkUserInfo | null> {
  // Check cache
  const cached = userCache.get(userId);
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  try {
    const user = await clerkClient.users.getUser(userId);
    const info: ClerkUserInfo = {
      id: user.id,
      email: user.primaryEmailAddress?.emailAddress ?? null,
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
    };

    userCache.set(userId, { data: info, expires: Date.now() + CACHE_TTL });
    return info;
  } catch {
    return null;
  }
}

/**
 * Get the primary email for a user.
 */
export async function getUserEmail(userId: string): Promise<string | null> {
  const info = await getUserInfo(userId);
  return info?.email ?? null;
}
```

### 3.3 Implement visibility PATCH endpoint

In `src/routes/api.ts`, add visibility update to existing session PATCH:

```typescript
// PATCH /api/sessions/:id
if (method === 'PATCH' && sessionMatch) {
  const sessionId = sessionMatch[1];
  const session = repo.getSession(sessionId);
  if (!session) {
    return jsonResponse({ error: "NotFound", message: "Session not found", code: "NOT_FOUND" }, 404);
  }

  const auth = await extractAuth(req);
  const { allowed, isOwner } = repo.verifyOwnership(sessionId, auth.userId, auth.clientId);

  if (!isOwner) {
    return jsonResponse({ error: "Forbidden", message: "Only owner can modify session", code: "NOT_OWNER" }, 403);
  }

  const body = await req.json();

  // Handle visibility change
  if (body.visibility !== undefined) {
    // Validate visibility value
    if (body.visibility !== 'private' && body.visibility !== 'public') {
      return jsonResponse({
        error: "BadRequest",
        message: "Invalid visibility value",
        code: "INVALID_VISIBILITY"
      }, 400);
    }

    // Remote sessions cannot be made public
    if (body.visibility === 'public' && session.remote) {
      return jsonResponse({
        error: "BadRequest",
        message: "Remote sessions cannot be made public",
        code: "REMOTE_SESSION_PUBLIC"
      }, 400);
    }

    const oldVisibility = session.visibility;
    const updated = repo.updateSessionVisibility(sessionId, body.visibility);

    // Audit log
    if (auth.userId && oldVisibility !== body.visibility) {
      repo.logAuditEvent(sessionId, 'visibility_changed', auth.userId, undefined, oldVisibility, body.visibility);
    }

    return jsonResponse(updated);
  }

  // ... existing update logic ...
}
```

### 3.4 Implement collaborators list endpoint

```typescript
// GET /api/sessions/:id/collaborators
if (method === 'GET' && collaboratorsMatch) {
  const sessionId = collaboratorsMatch[1];
  const session = repo.getSession(sessionId);
  if (!session) {
    return jsonResponse({ error: "NotFound", message: "Session not found", code: "NOT_FOUND" }, 404);
  }

  const auth = await extractAuth(req);
  const userEmail = auth.userId ? await getUserEmail(auth.userId) : null;
  const access = repo.checkAccess(sessionId, auth.userId, auth.clientId, userEmail);

  if (!access.allowed) {
    return jsonResponse({ error: "Forbidden", message: "Access denied", code: "FORBIDDEN" }, 403);
  }

  // Only owner can see collaborator list (spec requirement)
  // Actually, the spec says owner OR collaborator can view - let me check...
  // From spec: "List collaborators (owner or collaborator can view)"
  // So we need to allow collaborators to see the list too

  const collaborators = repo.getCollaborators(sessionId);

  // Enrich with user info where available
  const enriched = await Promise.all(collaborators.map(async (collab) => {
    let userInfo = null;
    if (collab.user_id) {
      userInfo = await getUserInfo(collab.user_id);
    }

    return {
      id: collab.id,
      email: collab.email,
      user_id: collab.user_id,
      role: collab.role,
      status: collab.accepted_at ? 'active' : 'invited',
      created_at: collab.created_at,
      accepted_at: collab.accepted_at,
      // Enriched user info
      name: userInfo ? `${userInfo.firstName ?? ''} ${userInfo.lastName ?? ''}`.trim() || null : null,
      image_url: userInfo?.imageUrl ?? null,
    };
  }));

  return jsonResponse({ collaborators: enriched, total: enriched.length });
}
```

### 3.5 Implement add collaborator endpoint

```typescript
// POST /api/sessions/:id/collaborators
if (method === 'POST' && collaboratorsMatch) {
  const sessionId = collaboratorsMatch[1];
  const session = repo.getSession(sessionId);
  if (!session) {
    return jsonResponse({ error: "NotFound", message: "Session not found", code: "NOT_FOUND" }, 404);
  }

  const auth = await extractAuth(req);
  if (!auth.userId) {
    return jsonResponse({ error: "Unauthorized", message: "Authentication required", code: "UNAUTHORIZED" }, 401);
  }

  const { allowed, isOwner } = repo.verifyOwnership(sessionId, auth.userId, auth.clientId);
  if (!isOwner) {
    return jsonResponse({ error: "Forbidden", message: "Only owner can add collaborators", code: "NOT_OWNER" }, 403);
  }

  const body = await req.json();
  const { email, role = 'viewer' } = body;

  // Validate email
  if (!email || !isValidEmail(email)) {
    return jsonResponse({ error: "BadRequest", message: "Invalid email address", code: "INVALID_EMAIL" }, 400);
  }

  // Validate role
  if (role !== 'viewer' && role !== 'contributor') {
    return jsonResponse({ error: "BadRequest", message: "Invalid role", code: "INVALID_ROLE" }, 400);
  }

  // Check collaborator limit (50 per session)
  const count = repo.getCollaboratorCount(sessionId);
  if (count >= 50) {
    return jsonResponse({
      error: "BadRequest",
      message: "Maximum 50 collaborators per session",
      code: "COLLABORATOR_LIMIT"
    }, 400);
  }

  // Check if email is the owner's email (no-op)
  const ownerEmail = await getUserEmail(auth.userId);
  if (ownerEmail && normalizeEmail(email) === normalizeEmail(ownerEmail)) {
    // Silent no-op for owner adding themselves (security: always return 201)
    return jsonResponse({
      id: 0,
      email: normalizeEmail(email),
      role,
      status: 'active',
      created_at: new Date().toISOString(),
    }, 201);
  }

  const collaborator = repo.addCollaborator(sessionId, email, role, auth.userId);

  // Audit log
  repo.logAuditEvent(sessionId, 'collaborator_added', auth.userId, normalizeEmail(email), undefined, role);

  // TODO: Queue email notification (Plan 6)

  return jsonResponse({
    id: collaborator.id,
    email: collaborator.email,
    role: collaborator.role,
    status: collaborator.accepted_at ? 'active' : 'invited',
    created_at: collaborator.created_at,
  }, 201);
}
```

### 3.6 Implement update collaborator role endpoint

```typescript
// PATCH /api/sessions/:id/collaborators/:collaboratorId
if (method === 'PATCH' && collaboratorMatch) {
  const sessionId = collaboratorMatch[1];
  const collaboratorId = parseInt(collaboratorMatch[2], 10);

  const session = repo.getSession(sessionId);
  if (!session) {
    return jsonResponse({ error: "NotFound", message: "Session not found", code: "NOT_FOUND" }, 404);
  }

  const auth = await extractAuth(req);
  if (!auth.userId) {
    return jsonResponse({ error: "Unauthorized", message: "Authentication required", code: "UNAUTHORIZED" }, 401);
  }

  const { allowed, isOwner } = repo.verifyOwnership(sessionId, auth.userId, auth.clientId);
  if (!isOwner) {
    return jsonResponse({ error: "Forbidden", message: "Only owner can update collaborators", code: "NOT_OWNER" }, 403);
  }

  const collaborator = repo.getCollaborator(sessionId, collaboratorId);
  if (!collaborator) {
    return jsonResponse({ error: "NotFound", message: "Collaborator not found", code: "NOT_FOUND" }, 404);
  }

  const body = await req.json();
  const { role } = body;

  if (role !== 'viewer' && role !== 'contributor') {
    return jsonResponse({ error: "BadRequest", message: "Invalid role", code: "INVALID_ROLE" }, 400);
  }

  const oldRole = collaborator.role;
  const updated = repo.updateCollaboratorRole(collaboratorId, role);

  // Audit log
  if (oldRole !== role) {
    repo.logAuditEvent(sessionId, 'collaborator_role_changed', auth.userId, collaborator.email, oldRole, role);
  }

  return jsonResponse({
    id: updated.id,
    email: updated.email,
    role: updated.role,
    status: updated.accepted_at ? 'active' : 'invited',
    created_at: updated.created_at,
    accepted_at: updated.accepted_at,
  });
}
```

### 3.7 Implement remove collaborator endpoint

```typescript
// DELETE /api/sessions/:id/collaborators/:collaboratorId
if (method === 'DELETE' && collaboratorMatch) {
  const sessionId = collaboratorMatch[1];
  const collaboratorId = parseInt(collaboratorMatch[2], 10);

  const session = repo.getSession(sessionId);
  if (!session) {
    return jsonResponse({ error: "NotFound", message: "Session not found", code: "NOT_FOUND" }, 404);
  }

  const auth = await extractAuth(req);
  if (!auth.userId) {
    return jsonResponse({ error: "Unauthorized", message: "Authentication required", code: "UNAUTHORIZED" }, 401);
  }

  const { allowed, isOwner } = repo.verifyOwnership(sessionId, auth.userId, auth.clientId);
  if (!isOwner) {
    return jsonResponse({ error: "Forbidden", message: "Only owner can remove collaborators", code: "NOT_OWNER" }, 403);
  }

  const collaborator = repo.getCollaborator(sessionId, collaboratorId);
  if (!collaborator) {
    return jsonResponse({ error: "NotFound", message: "Collaborator not found", code: "NOT_FOUND" }, 404);
  }

  repo.removeCollaborator(collaboratorId);

  // Audit log
  repo.logAuditEvent(sessionId, 'collaborator_removed', auth.userId, collaborator.email);

  return new Response(null, { status: 204 });
}
```

### 3.8 Implement self-removal endpoint

```typescript
// DELETE /api/sessions/:id/collaborators/me
if (method === 'DELETE' && collaboratorSelfMatch) {
  const sessionId = collaboratorSelfMatch[1];

  const session = repo.getSession(sessionId);
  if (!session) {
    return jsonResponse({ error: "NotFound", message: "Session not found", code: "NOT_FOUND" }, 404);
  }

  const auth = await extractAuth(req);
  if (!auth.userId) {
    return jsonResponse({ error: "Unauthorized", message: "Authentication required", code: "UNAUTHORIZED" }, 401);
  }

  const userEmail = await getUserEmail(auth.userId);
  if (!userEmail) {
    return jsonResponse({ error: "BadRequest", message: "User has no email", code: "NO_EMAIL" }, 400);
  }

  // Check if user is a collaborator
  const collaborator = repo.getCollaboratorByEmail(sessionId, userEmail);
  if (!collaborator) {
    return jsonResponse({ error: "NotFound", message: "You are not a collaborator on this session", code: "NOT_COLLABORATOR" }, 404);
  }

  repo.removeCollaborator(collaborator.id);

  // Audit log (self-removal)
  repo.logAuditEvent(sessionId, 'collaborator_removed', auth.userId, collaborator.email);

  return new Response(null, { status: 204 });
}
```

### 3.9 Implement sessions list with filter

Update `GET /api/sessions` to support filtering:

```typescript
// GET /api/sessions
if (method === 'GET' && pathname === '/api/sessions') {
  const auth = await extractAuth(req);
  const url = new URL(req.url);
  const filter = url.searchParams.get('filter'); // 'owned', 'shared', or null (both)

  if (!auth.userId && !auth.clientId) {
    return jsonResponse({ sessions: [] });
  }

  const userEmail = auth.userId ? await getUserEmail(auth.userId) : null;

  let sessions: Array<Session & { access_type: 'owned' | 'shared'; collaborator_role?: string }> = [];

  if (filter !== 'shared') {
    // Get owned sessions
    const owned = repo.getSessionsByOwner(auth.userId, auth.clientId);
    sessions.push(...owned.map(s => ({ ...s, access_type: 'owned' as const })));
  }

  if (filter !== 'owned' && auth.userId) {
    // Get shared sessions
    const shared = repo.getSessionsSharedWith(auth.userId, userEmail);
    sessions.push(...shared.map(s => ({
      ...s,
      access_type: 'shared' as const,
      collaborator_role: s.collaborator_role,
    })));
  }

  // Sort by updated_at descending
  sessions.sort((a, b) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );

  return jsonResponse({ sessions });
}
```

### 3.10 Update session access checks in existing endpoints

Update any endpoint that checks session access to use the new `checkAccess` method with appropriate action:

```typescript
// Example: GET /api/sessions/:id/diffs
const access = repo.checkAccess(sessionId, auth.userId, auth.clientId, userEmail, { action: 'view' });
if (!access.allowed) {
  return jsonResponse({ error: "Forbidden" }, 403);
}

// Example: POST /api/sessions/:id/feedback (annotations)
const access = repo.checkAccess(sessionId, auth.userId, auth.clientId, userEmail, { action: 'annotate' });
if (!access.allowed) {
  return jsonResponse({ error: "Forbidden" }, 403);
}
```

## Error Response Format

All error responses follow consistent structure:

```typescript
interface ErrorResponse {
  error: string;      // Error type (e.g., "BadRequest", "Forbidden")
  message: string;    // Human-readable message
  code: string;       // Machine-readable code
}
```

Error codes:
- `REMOTE_SESSION_PUBLIC` - Tried to make remote session public
- `NOT_OWNER` - Action requires ownership
- `NOT_FOUND` - Session or collaborator not found
- `COLLABORATOR_LIMIT` - Max 50 collaborators reached
- `RATE_LIMITED` - Too many additions, try again later
- `INVALID_EMAIL` - Email format invalid
- `INVALID_ROLE` - Role must be 'viewer' or 'contributor'
- `INVALID_VISIBILITY` - Visibility must be 'private' or 'public'

## Testing Checklist

### Visibility
- [ ] `PATCH /api/sessions/:id` with `visibility: 'public'` updates visibility
- [ ] `PATCH /api/sessions/:id` with `visibility: 'public'` on remote session returns 400
- [ ] Non-owner cannot change visibility (403)

### Collaborators
- [ ] `GET /api/sessions/:id/collaborators` returns collaborator list
- [ ] `POST /api/sessions/:id/collaborators` adds collaborator
- [ ] `POST /api/sessions/:id/collaborators` with duplicate email updates role
- [ ] `POST /api/sessions/:id/collaborators` with owner email is no-op (201)
- [ ] `POST /api/sessions/:id/collaborators` with invalid email returns 400
- [ ] `POST /api/sessions/:id/collaborators` at limit (50) returns 400
- [ ] `PATCH /api/sessions/:id/collaborators/:id` updates role
- [ ] `DELETE /api/sessions/:id/collaborators/:id` removes collaborator
- [ ] `DELETE /api/sessions/:id/collaborators/me` allows self-removal
- [ ] Non-owner cannot manage collaborators (403)

### Sessions List
- [ ] `GET /api/sessions` returns both owned and shared sessions
- [ ] `GET /api/sessions?filter=owned` returns only owned sessions
- [ ] `GET /api/sessions?filter=shared` returns only shared sessions
- [ ] Shared sessions include `collaborator_role`

## Rollout

1. Deploy repository changes (Plan 2)
2. Deploy API endpoints
3. Verify existing endpoints continue to work
4. Test new endpoints with manual requests
