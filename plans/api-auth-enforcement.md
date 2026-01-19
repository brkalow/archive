# API Auth Enforcement

Implementation plan for adding authentication enforcement to API routes. This implements **Phase 1, Section C1** from [auth-phase1.md](./auth-phase1.md).

Reference: [specs/auth.md](../specs/auth.md), [Clerk authenticateRequest docs](https://clerk.com/docs/reference/backend/authenticate-request)

## Current State

The auth infrastructure exists but is not enforced:

- `extractAuth()` in `src/middleware/auth.ts` uses `clerkClient.authenticateRequest()`
- Only 3 API routes call `extractAuth()`:
  - `GET /api/sessions` with `mine=true` - extracts auth but doesn't require it
  - `GET /api/sessions/unclaimed` - properly requires auth
  - `POST /api/sessions/claim` - properly requires auth
- **All other endpoints are unprotected** - anyone can view, modify, or delete any session

## Goal

Enforce authentication on all protected endpoints per the spec.

---

## Implementation Tasks

### 1. Enhance Auth Middleware

**File:** `src/middleware/auth.ts`

Add `authorizedParties` for CSRF protection per Clerk docs:

```typescript
const authState = await clerkClient.authenticateRequest(req, {
  acceptsToken: ['session_token', 'oauth_token'],
  authorizedParties: [
    'https://openctl.dev',
    'http://localhost:3000', // dev
  ],
});
```

Add helper to extract just the request URL origin for `authorizedParties`:

```typescript
function getAuthorizedParties(): string[] {
  const parties = ['https://openctl.dev'];
  if (process.env.NODE_ENV === 'development') {
    parties.push('http://localhost:3000');
  }
  return parties;
}
```

---

### 2. Add Auth to Protected Endpoints

Update `src/routes/api.ts` to call `extractAuth()` and enforce access control.

#### Endpoint Protection Matrix (from spec)

| Endpoint | Auth Required | Owner Required | Notes |
|----------|--------------|----------------|-------|
| `POST /api/sessions` | Optional | - | If authed: owned by user. If not: owned by client_id |
| `GET /api/sessions` | Required | - | Returns user's sessions (+ client_id sessions) |
| `GET /api/sessions/:id` | Required* | No | User/client owns OR share token access |
| `PATCH /api/sessions/:id` | Required* | Yes | User/client owns |
| `DELETE /api/sessions/:id` | Required* | Yes | User/client owns |
| `POST /api/sessions/:id/share` | Required* | Yes | User/client owns |
| `POST /api/sessions/live` | Optional | - | Same as POST /api/sessions |
| `POST /api/sessions/:id/messages` | Required* | Yes | Live streaming |
| `POST /api/sessions/:id/tool-results` | Required* | Yes | Live streaming |
| `PUT /api/sessions/:id/diff` | Required* | Yes | Live streaming |
| `POST /api/sessions/:id/complete` | Required* | Yes | Live streaming |
| `GET /api/sessions/:id/ws` | Required* | No | WebSocket - user/client owns |
| `GET /api/s/:shareToken` | None | - | Public via share token |
| `GET /api/stats/*` | Required | - | User's own stats only |

*These endpoints support dual ownership: user_id OR client_id grants access.

---

### 3. Implementation by Endpoint

#### 3.1 `GET /api/sessions` - Require Auth

Currently: Returns all sessions when `mine` is not set.
Change: Always require auth, always filter by owner.

```typescript
async getSessions(req: Request): Promise<Response> {
  const auth = await extractAuth(req);

  // Require at least user_id or client_id
  const authError = requireAuth(auth);
  if (authError) return authError;

  // Always filter by owner (no more "all sessions" mode)
  const sessions = repo.getSessionsByOwner(
    auth.userId ?? undefined,
    auth.clientId ?? undefined
  );
  return json({ sessions });
}
```

#### 3.2 `GET /api/sessions/:id` - Verify Access

Currently: Returns any session by ID (no auth check).
Change: Require auth and verify ownership.

**Note:** Public sessions (with share_token) and user-to-user sharing will be handled in a followup. For now, only owners can access via this endpoint. Public access remains available via `/api/s/:shareToken`.

```typescript
async getSessionDetail(req: Request, sessionId: string, baseUrl?: string): Promise<Response> {
  const session = repo.getSession(sessionId);
  if (!session) return jsonError("Session not found", 404);

  const auth = await extractAuth(req);

  // Check ownership via repository (handles user_id OR client_id)
  const { allowed } = repo.verifyOwnership(sessionId, auth.userId, auth.clientId);

  if (!allowed) {
    // TODO (followup): Also allow if session.share_token exists (public)
    // TODO (followup): Also allow if session shared with authenticated user
    return jsonError("Forbidden", 403);
  }

  // ... rest of handler
}
```

#### 3.3 `DELETE /api/sessions/:id` - Owner Only

Currently: Deletes any session (no auth check).
Change: Require owner access.

```typescript
async deleteSession(req: Request, sessionId: string): Promise<Response> {
  const session = repo.getSession(sessionId);
  if (!session) return jsonError("Session not found", 404);

  const auth = await extractAuth(req);
  const authError = requireAuth(auth);
  if (authError) return authError;

  // Verify client ownership (for live sessions) or user ownership
  const { allowed, isOwner } = repo.verifyOwnership(sessionId, auth.userId, auth.clientId);

  if (!allowed || !isOwner) {
    return jsonError("Forbidden", 403);
  }

  repo.deleteSession(sessionId);
  return json({ success: true });
}
```

#### 3.4 `PATCH /api/sessions/:id` - Owner Only

Add auth check before allowing updates.

```typescript
async patchSession(req: Request, sessionId: string): Promise<Response> {
  const session = repo.getSession(sessionId);
  if (!session) return jsonError("Session not found", 404);

  const auth = await extractAuth(req);
  const authError = requireAuth(auth);
  if (authError) return authError;

  const { allowed, isOwner } = repo.verifyOwnership(sessionId, auth.userId, auth.clientId);
  if (!allowed || !isOwner) {
    return jsonError("Forbidden", 403);
  }

  // ... rest of handler
}
```

#### 3.5 Stats Endpoints - User Only

```typescript
async getStats(req: Request): Promise<Response> {
  const auth = await extractAuth(req);

  if (!auth.isAuthenticated) {
    return jsonError("Unauthorized", 401);
  }

  // Filter stats by user_id
  const stats = repo.getStatsByUser(auth.userId!);
  return json(stats);
}
```

#### 3.6 Live Session Endpoints - Owner Only

All live session mutation endpoints (`messages`, `tool-results`, `diff`, `complete`) need owner verification:

```typescript
async pushMessages(req: Request, sessionId: string): Promise<Response> {
  const session = repo.getSession(sessionId);
  if (!session) return jsonError("Session not found", 404);

  const auth = await extractAuth(req);
  const authError = requireAuth(auth);
  if (authError) return authError;

  // For live sessions, also check stream token or ownership
  if (session.status === 'live') {
    const streamToken = req.headers.get('X-Stream-Token');
    if (streamToken) {
      const valid = repo.verifyStreamToken(sessionId, streamToken);
      if (!valid) return jsonError("Invalid stream token", 403);
    } else {
      const { allowed, isOwner } = repo.verifyOwnership(sessionId, auth.userId, auth.clientId);
      if (!allowed || !isOwner) return jsonError("Forbidden", 403);
    }
  }

  // ... rest of handler
}
```

---

### 4. Error Responses

Standardize auth error responses:

```typescript
// 401 Unauthorized - No valid credentials
function unauthorized(message = "Unauthorized"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer"
    },
  });
}

// 403 Forbidden - Valid credentials but no access
function forbidden(message = "Forbidden"): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}
```

---

## Files to Modify

1. **`src/middleware/auth.ts`**
   - Add `authorizedParties` to `authenticateRequest()`
   - Update helpers as needed

2. **`src/routes/api.ts`**
   - Add `extractAuth()` call to all protected endpoints
   - Add ownership verification via `repo.verifyOwnership()`
   - Return proper 401/403 responses

3. **`src/db/repository.ts`** (if needed)
   - Ensure `verifyOwnership()` handles all cases correctly
   - Add `getStatsByUser()` if not exists

---

## Testing Checklist

### Authentication
- [ ] Request without token returns 401 for protected endpoints
- [ ] Request with invalid token returns 401
- [ ] Request with valid token returns data

### Authorization
- [ ] Owner can access their sessions (by user_id)
- [ ] Owner can access their sessions (by client_id)
- [ ] Non-owner gets 403 on protected session endpoints
- [ ] Share token grants read-only access via `/api/s/:shareToken`

### Stats
- [ ] Stats endpoints require authentication
- [ ] Stats are filtered to authenticated user only
