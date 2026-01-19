# Authentication Specification

## Overview

This spec covers the authentication system for openctl, enabling user identity, session ownership, and access control. Auth is implemented using **Clerk** with **Google sign-in** as the initial (and only) provider.

## Goals

1. **User identity**: Know who uploaded/owns each session
2. **CLI authentication**: Seamless auth flow for the command-line interface
3. **Access control**: Users can only see and manage their own sessions
4. **Session ownership migration**: Transition from client_id-based ownership to user-based
5. **Shared session support**: Maintain public sharing via share tokens

## Non-Goals (Phase 1)

- GitHub-based repo permissions (Phase 2)
- Org/team scoping (Phase 2)
- Multiple identity providers beyond Google (later)
- Fine-grained sharing with specific users (later)

---

## Authentication Surfaces

### 1. Web UI

**Sign In Flow:**
- Clerk-hosted sign-in modal or redirect
- Google OAuth only
- After sign-in, redirect back to original page
- Store Clerk session token in cookie (handled by Clerk SDK)

**Protected Routes:**
| Route | Auth Required | Notes |
|-------|--------------|-------|
| `/` | No | Landing page, shows public info |
| `/sessions` | Yes | User's session list |
| `/sessions/:id` | Yes* | User's own sessions only |
| `/s/:shareToken` | No | Shared sessions are public |
| `/stats` | Yes | User's own stats only |
| `/_components` | No | Dev tool |

*Sessions accessed without auth return 401 unless accessed via share token.

**Unauthenticated Experience:**
- Landing page explains the product
- "Sign in with Google" button prominent
- Shared session links (`/s/:token`) work without auth
- Attempting to access `/sessions` redirects to sign-in

### 2. CLI

CLI authentication is critical as it's a primary product surface.

**Auth Flow: OAuth 2.0 with PKCE**

The CLI uses OAuth 2.0 Authorization Code flow with PKCE (similar to `gh auth login`):

```
1. User runs: openctl auth login
2. CLI starts local HTTP server on random port (e.g., 54321)
3. CLI generates PKCE code_verifier/challenge and signed state (contains port)
4. CLI opens browser to Clerk OAuth authorize endpoint
5. User signs in with Google (via Clerk)
6. Clerk redirects to https://openctl.dev/auth/cli/callback
7. Server validates state, redirects to localhost with auth code
8. CLI exchanges code for tokens with Clerk (using PKCE)
9. CLI stores tokens in OS keychain
10. Done - CLI is authenticated
```

**Why OAuth with server redirect:**
- Standard protocol with refresh tokens built-in
- Single pre-registered redirect URI (Clerk requirement)
- PKCE provides security for public clients
- Familiar pattern (GitHub CLI, Vercel CLI, etc.)

See [CLI Auth (OAuth with Clerk)](#cli-auth-oauth-with-clerk) in Appendix for full details.

**CLI Auth Commands:**

```sh
# Authenticate with the server
openctl auth login [--server <url>]

# Check current auth status
openctl auth status

# Log out (remove stored credentials)
openctl auth logout [--server <url>]

# Show current user info
openctl auth whoami
```

**Token Storage:**

Tokens stored securely using OS-native credential storage:

| Platform | Storage |
|----------|---------|
| macOS | Keychain Services (`security` CLI or Security.framework) |
| Linux | Secret Service API (libsecret) or encrypted file fallback |
| Windows | Credential Manager |

**Keychain Entry Format:**
- Service: `openctl-cli`
- Account: `<server_url>` (e.g., `https://openctl.dev`)
- Password: JSON blob with tokens

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "userId": "user_xxx",
  "email": "user@example.com",
  "expiresAt": "2024-12-01T00:00:00Z"
}
```

**Fallback (Linux without Secret Service):**
- Encrypted file at `~/.openctl/auth.enc`
- Key derived from machine ID + user ID
- File permissions: `600`
- Warn user about reduced security

**Why OS keychain over plaintext:**
- Protected by OS-level access controls
- Not exposed in backups/Time Machine by default
- Consistent with `gh`, `vercel`, and other CLIs
- Tokens refreshed automatically when expired

**CLI Request Authentication:**

All authenticated CLI requests include:
```
Authorization: Bearer <access_token>
X-Openctl-Client-ID: <client_uuid>  # Keep for backwards compat
```

The server validates the Bearer token via Clerk and extracts user identity.

### 3. API

**Auth Header:**
```
Authorization: Bearer <clerk_session_token>
```

**Endpoint Protection:**

| Endpoint | Auth | Notes |
|----------|------|-------|
| `POST /api/sessions` | Optional | If authed: owned by user. If not: owned by client_id |
| `GET /api/sessions` | Required | Returns user's sessions (+ client_id sessions if header present) |
| `GET /api/sessions/:id` | Required* | User owns session OR client_id matches |
| `PATCH /api/sessions/:id` | Required* | User owns session OR client_id matches |
| `DELETE /api/sessions/:id` | Required* | User owns session OR client_id matches |
| `POST /api/sessions/:id/share` | Required* | User owns session OR client_id matches |
| `POST /api/sessions/:id/messages` | Required* | User owns session OR client_id matches (live) |
| `POST /api/sessions/:id/complete` | Required* | User owns session OR client_id matches (live) |
| `POST /api/sessions/live` | Optional | If authed: owned by user. If not: owned by client_id |
| `PUT /api/sessions/:id/diff` | Required* | User owns session OR client_id matches |
| `GET /api/s/:shareToken` | None | Public access via share token |
| `GET /api/stats/*` | Required | Returns user's stats only |
| `GET /auth/cli/callback` | None | OAuth callback, validates state, redirects to localhost |

*These endpoints work with either user auth OR client_id ownership (backwards compatible).

**WebSocket Auth:**

WebSocket connections at `/api/sessions/:id/ws` require auth:
- Token passed via `Sec-WebSocket-Protocol` header (NOT query params)
- Server validates token before accepting upgrade
- On validation failure: reject upgrade with 401

**Why not query params:**
- Query params logged in server access logs
- Leaked via Referer headers
- Visible in browser history
- Cannot use HttpOnly/Secure flags

**Implementation:**
```javascript
// Client
const ws = new WebSocket(url, ['openctl-auth', accessToken]);

// Server
const protocols = req.headers['sec-websocket-protocol']?.split(', ');
const token = protocols?.find(p => p !== 'openctl-auth');
const userId = await verifyToken(token);
if (!userId) return new Response(null, { status: 401 });
```

---

## Data Model Changes

### Sessions Table

Add `user_id` column:

```sql
ALTER TABLE sessions ADD COLUMN user_id TEXT;
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
```

- `user_id`: Clerk user ID (e.g., `user_2abc123xyz`)
- Keep `client_id` for backwards compatibility during migration
- New sessions: `user_id` required, `client_id` optional
- Legacy sessions: `client_id` only, `user_id` null

### Users Table (Optional)

Clerk handles user data, but we may want local cache:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,           -- Clerk user ID
  email TEXT,
  name TEXT,
  avatar_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Benefits:
- Avoid repeated Clerk API calls
- Enable user search/autocomplete for future sharing features
- Store app-specific user preferences

### CSRF State Validation (Stateless HMAC)

CLI auth uses HMAC-signed state tokens for CSRF protection. No database table needed.

**State Token Format:**
```
state = base64url(payload + "." + signature)

payload = {
  "r": <16 random bytes, base64>,
  "p": <callback port>,
  "c": <client_id>,
  "t": <timestamp, unix seconds>
}

signature = HMAC-SHA256(SERVER_SECRET, payload)
```

**Validation Rules:**
1. Verify HMAC signature matches
2. Reject if timestamp > 5 minutes old
3. Reject if already used (optional: track in memory/Redis for replay protection)

**Example State Token:**
```
eyJyIjoiYWJjMTIzIiwicCI6NTQzMjEsImMiOiJ1dWlkIiwidCI6MTcwNTAwMDAwMH0.abc123signature
```

**Why HMAC over database:**
- No database writes during auth flow
- No cleanup of expired states needed
- Simpler implementation
- Replay protection optional (5-minute window is short)

---

## Session Ownership Migration

### Strategy: Gradual Migration

1. **New sessions**: Always have `user_id`, may have `client_id`
2. **Existing sessions**: Have `client_id` only, `user_id` null
3. **Claiming legacy sessions**: When authenticated user makes request with matching `client_id`, offer to claim their sessions

### Claiming Flow

```
User authenticates for first time
↓
Server sees X-Openctl-Client-ID header
↓
Query: SELECT COUNT(*) FROM sessions WHERE client_id = ? AND user_id IS NULL
↓
If > 0, prompt: "Found 15 sessions from this device. Claim them?"
↓
If yes: UPDATE sessions SET user_id = ? WHERE client_id = ?
↓
Sessions now accessible cross-device
```

**CLI Experience:**

```
$ openctl auth login
...authentication completes...

Found 15 sessions uploaded from this device that aren't linked to your account.
Claim these sessions? They'll be accessible from any device you sign into. [Y/n]

Claimed 15 sessions.
```

### Access Control Logic

```
Can request access session?

1. Session has share_token AND accessed via /s/:token → YES (public read-only)
2. Session has user_id AND user_id matches authenticated user → YES
3. Session has client_id AND client_id matches X-Openctl-Client-ID header → YES
4. Otherwise → NO (401/403)
```

Note: A session can have both `user_id` and `client_id`. Either grants access. This supports:
- Authenticated users accessing their sessions from any device
- Anonymous users accessing their sessions via client_id
- Claiming flow linking client_id sessions to user accounts

**Access Control Middleware Implementation:**

```typescript
import { verifyToken } from '@clerk/backend';

async function canAccessSession(
  session: Session,
  req: Request,
  options: { requireOwner?: boolean } = {}
): Promise<{ allowed: boolean; userId?: string; isOwner: boolean }> {

  // 1. Extract auth credentials from request
  const bearerToken = req.headers.get('Authorization')?.replace('Bearer ', '');
  const clientId = req.headers.get('X-Openctl-Client-ID');

  // 2. Verify Bearer token if present (Clerk JWT)
  let userId: string | null = null;
  if (bearerToken) {
    try {
      const payload = await verifyToken(bearerToken, {
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      userId = payload.sub;
    } catch {
      // Invalid token - continue without userId
    }
  }

  // 3. Check ownership
  const isOwner =
    (userId && session.user_id === userId) ||
    (clientId && session.client_id === clientId);

  // 4. If owner access required, check now
  if (options.requireOwner) {
    return { allowed: isOwner, userId, isOwner };
  }

  // 5. Check share token access (public read-only)
  const shareToken = new URL(req.url).pathname.match(/^\/s\/(.+)/)?.[1];
  if (shareToken && session.share_token === shareToken) {
    return { allowed: true, userId, isOwner: false };
  }

  // 6. Owner always has access
  if (isOwner) {
    return { allowed: true, userId, isOwner: true };
  }

  // 7. Check user-to-user shares (Phase 1.5)
  if (userId) {
    const userEmail = await getUserEmail(userId);
    const hasShare = await db.query(
      `SELECT 1 FROM session_shares
       WHERE session_id = ? AND (shared_with_user_id = ? OR LOWER(shared_with_email) = LOWER(?))`,
      [session.id, userId, userEmail]
    );
    if (hasShare) {
      // Cache user_id for faster future lookups
      await db.run(
        `UPDATE session_shares SET shared_with_user_id = ? WHERE session_id = ? AND shared_with_email = ?`,
        [userId, session.id, userEmail]
      );
      return { allowed: true, userId, isOwner: false };
    }
  }

  // 8. No access
  return { allowed: false, userId, isOwner: false };
}
```

**Usage in Route Handlers:**

```typescript
// View session (owner or shared)
app.get('/api/sessions/:id', async (req) => {
  const session = await getSession(req.params.id);
  const access = await canAccessSession(session, req);
  if (!access.allowed) return new Response(null, { status: 403 });
  return Response.json(session);
});

// Delete session (owner only)
app.delete('/api/sessions/:id', async (req) => {
  const session = await getSession(req.params.id);
  const access = await canAccessSession(session, req, { requireOwner: true });
  if (!access.allowed) return new Response(null, { status: 403 });
  await deleteSession(session.id);
  return new Response(null, { status: 204 });
});
```

---

## Sharing Model

### Public Share Tokens (Current, Keep)

Share tokens provide public, read-only access:
- Generated via `POST /api/sessions/:id/share`
- Access via `/s/:shareToken` - no auth required
- Anyone with link can view
- Good for: sharing to social media, public discussion, embedding

### User-to-User Sharing (Phase 1.5)

Share sessions with specific users by email. Recipients must sign in to view.

**Why user-to-user sharing matters:**
- Share work sessions with teammates without making them fully public
- Share with your manager/lead for review
- Collaborate on debugging without exposing to the world

**Sharing Flow:**

```
1. Owner opens session, clicks "Share"
2. Modal shows:
   - Public link toggle (existing share token)
   - "Share with people" section
   - Email input field
3. Owner enters email, clicks "Add"
4. Recipient added to share list (shown in modal)
5. Owner can remove recipients from list
```

**Recipient Experience:**

```
1. Recipient receives email: "X shared a session with you"
2. Email contains link to session: /sessions/:id
3. Recipient clicks link
4. If not signed in: redirected to sign-in, then back to session
5. If signed in: session loads (if their email matches share list)
6. If email doesn't match: 403 "You don't have access to this session"
```

**Data Model:**

```sql
CREATE TABLE session_shares (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  shared_with_email TEXT NOT NULL,      -- Email of recipient (NORMALIZED TO LOWERCASE)
  shared_with_user_id TEXT,             -- Clerk user ID (set when they first access)
  shared_by_user_id TEXT NOT NULL,      -- Who shared it
  permission TEXT DEFAULT 'view',       -- 'view' only for now
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, shared_with_email)
);

CREATE INDEX idx_session_shares_session ON session_shares(session_id);
CREATE INDEX idx_session_shares_email ON session_shares(shared_with_email);
CREATE INDEX idx_session_shares_user ON session_shares(shared_with_user_id);
```

**Email Normalization:**
- All emails normalized to lowercase before storage and comparison
- `User@Gmail.com` → `user@gmail.com`
- Prevents duplicate shares due to case differences
- Google OAuth emails from Clerk are already lowercase

**Access Control Update:**

```
Can request access session?

1. Session has share_token AND accessed via /s/:token → YES (public read-only)
2. Session has user_id AND user_id matches authenticated user → YES (owner)
3. Session has client_id AND client_id matches X-Openctl-Client-ID header → YES (client owner)
4. User's email in session_shares for this session → YES (shared with)
5. User's user_id in session_shares for this session → YES (shared with, cached)
6. Otherwise → NO (401/403)
```

**API Endpoints:**

| Endpoint | Auth | Notes |
|----------|------|-------|
| `GET /api/sessions/:id/shares` | Owner | List who session is shared with |
| `POST /api/sessions/:id/shares` | Owner | Add email to share list |
| `DELETE /api/sessions/:id/shares/:email` | Owner | Remove from share list |

**Request/Response:**

```
POST /api/sessions/:id/shares
{
  "email": "teammate@example.com"
}

Response:
{
  "email": "teammate@example.com",
  "created_at": "2024-01-15T10:00:00Z"
}
```

```
GET /api/sessions/:id/shares

Response:
{
  "shares": [
    {
      "email": "teammate@example.com",
      "created_at": "2024-01-15T10:00:00Z"
    },
    {
      "email": "lead@example.com",
      "created_at": "2024-01-14T09:00:00Z"
    }
  ]
}
```

**Email Notifications:**

When a session is shared:
- Send email to recipient with session link
- Email should include: sharer name, session title, link
- Keep it simple - no fancy templates initially

**UI Components:**

1. **Share Modal** (on session detail page)
   - Tab or section for "Public link" (existing)
   - Tab or section for "Share with people"
   - Email input with "Add" button
   - List of current shares with "Remove" button

2. **Shared With Me** (on sessions list)
   - Filter/tab to show sessions shared with you
   - Or mixed into main list with "Shared by X" indicator

3. **Access Denied Page**
   - When user tries to access session they don't have access to
   - "You don't have access to this session"
   - "Request access" button (future, not Phase 1.5)

**Edge Cases:**

1. **Recipient doesn't have account**: They sign up with Google, email must match
2. **Recipient uses different email**: Can't access - must use email they were shared with
3. **Owner revokes access**: Recipient loses access immediately
4. **Session deleted**: Shares deleted via CASCADE
5. **Recipient already has access** (is owner): No-op, maybe show message

**Permissions (Future):**

For Phase 1.5, all shares are "view" only. Future permissions could include:
- `view` - Can view session (default)
- `comment` - Can add comments/annotations
- `reshare` - Can share with others
- `admin` - Can manage shares

**Implementation Order:**

1. Database schema (session_shares table)
2. API endpoints (list/add/remove shares)
3. Access control check update
4. Share modal UI
5. Email notifications
6. "Shared with me" filtering

### Future: Team/Org Sharing (Phase 2+)

Not in scope for Phase 1.5, but design accommodates:
- Share with GitHub collaborators (auto-scoped to repo access)
- Share with team/org
- Workspace-level default sharing settings

---

## Implementation Phases

### Phase 1: Core Auth (Critical)

**Must have for launch:**

1. **Clerk integration (web)**
   - Sign in with Google button
   - Session management
   - Protected route middleware for `/sessions` routes

2. **CLI localhost callback auth flow**
   - `openctl auth login/logout/status/whoami`
   - Local HTTP server for callback
   - Token storage and refresh
   - Auth header on all requests (when authenticated)

3. **API protection**
   - Bearer token validation middleware
   - User extraction from token
   - Dual ownership model: user_id OR client_id grants access
   - Anonymous uploads continue to work (client_id only)

4. **Session ownership**
   - Add `user_id` column
   - Set `user_id` on session creation (if authenticated)
   - Keep `client_id` for anonymous uploads
   - Query filtering supports both

5. **Session claiming**
   - Detect unclaimed sessions by `client_id` when user authenticates
   - Prompt and bulk-update to add `user_id`

### Phase 1.5: User-to-User Sharing (Soon After Launch)

1. **Database schema**
   - `session_shares` table
   - Indexes for efficient lookups

2. **API endpoints**
   - `GET /api/sessions/:id/shares` - list shares
   - `POST /api/sessions/:id/shares` - add share
   - `DELETE /api/sessions/:id/shares/:email` - remove share

3. **Access control update**
   - Check `session_shares` table in access control logic
   - Cache user_id on first access for faster lookups

4. **Share modal UI**
   - Add "Share with people" section to existing share modal
   - Email input, add/remove functionality
   - Show current shares

5. **Email notifications**
   - Send email when session shared
   - Simple text email with link

6. **"Shared with me" view**
   - Filter or section in sessions list
   - Show who shared each session

### Phase 2: Polish (Important, Can Wait)

1. **WebSocket auth**
   - Token validation on connection
   - Graceful handling of expired tokens

2. **Token refresh**
   - Automatic refresh before expiry
   - Background refresh in CLI daemon

3. **Error handling**
   - Clear messages for auth failures
   - Redirect to sign-in with return URL
   - CLI prompts to re-authenticate

4. **User profile caching**
   - Store user info locally
   - Display names/avatars in UI

### Phase 3: Advanced (Future)

1. **GitHub-based permissions**
   - Link GitHub account
   - Scope session visibility by repo access

2. **Org/team support**
   - Team creation and management
   - Shared session pools

3. **Additional providers**
   - GitHub sign-in
   - Email/password

---

## Security Considerations

### Token Security

- CLI tokens: Clerk OAuth tokens (access + refresh)
  - Access tokens: Short-lived (1 hour default)
  - Refresh tokens: Long-lived, auto-refresh seamlessly
- CLI tokens: Stored in OS keychain (not plaintext files)
- Web tokens: Standard Clerk session tokens (short-lived, auto-refresh)
- Never log tokens in server logs or error messages
- Revocation: Via Clerk dashboard (invalidates all user sessions)

### CSRF Protection

- Web auth: Clerk handles CSRF
- CLI auth: HMAC-signed state parameter with 5-minute expiry
- API: Bearer tokens (stateless, no CSRF needed)

### Rate Limiting

| Endpoint | Limit | Key |
|----------|-------|-----|
| `GET /auth/cli/callback` | 10/min | IP |
| `POST /api/sessions` | 20/hour | client_id + IP |
| `POST /api/sessions/live` | 20/hour | client_id + IP |
| `POST /api/sessions/:id/share` | 10/hour | user_id |
| `POST /api/sessions/:id/shares` | 50/hour | user_id |
| All authenticated endpoints | 1000/hour | user_id |

### Anonymous Upload Abuse Prevention

Anonymous uploads (without auth) are allowed but rate-limited:

1. **Rate limiting**: 20 sessions/hour per client_id + IP combination
2. **Storage quota**: 500MB total per client_id (before claiming)
3. **Validation**: client_id must be valid UUID format
4. **Auto-cleanup**: Unclaimed sessions auto-deleted after 30 days
5. **Content limits**: Max 10MB per session file, max 50MB diff

**Why allow anonymous uploads:**
- Lower friction for new users trying the product
- Client ID provides ownership for later claiming
- Abuse prevention via rate limits + auto-cleanup

### Share Token Security

- 32 bytes of randomness (256 bits), URL-safe base64 encoded (43 chars)
- Not guessable, not enumerable
- Can be revoked via `DELETE /api/sessions/:id/share`
- No expiry by default (decision made above)
- Track `last_accessed_at` for auditing

### CLI Auth Error Handling

| Error | CLI Behavior |
|-------|--------------|
| Port binding fails | Try 3 random ports, then show manual instructions |
| Browser doesn't open | Print URL for manual copy |
| Auth timeout (5 min) | "Authentication timed out. Run `openctl auth login` to try again." |
| State mismatch | "Authentication failed (invalid state). Please try again." |
| Network error | Retry with exponential backoff (3 attempts) |
| Token refresh fails | Attempt re-auth automatically, prompt user if still fails |
| Refresh token revoked | "Session revoked. Run `openctl auth login` to re-authenticate." |

### Web Auth Error Handling

| Error | Web Behavior |
|-------|--------------|
| Clerk unavailable | Show error page with retry button |
| Google OAuth denied | "Sign-in was cancelled. Please try again." |
| Return URL 403 | Redirect to /sessions with "You don't have access to that session" |
| Token refresh fails | Redirect to sign-in with return URL preserved |

---

## User Experience Flows

### New User (Web)

```
1. User visits openctl.dev
2. Sees landing page explaining product
3. Clicks "Sign in with Google"
4. Google OAuth flow
5. Redirected to /sessions (empty state)
6. Prompted to install CLI or upload first session
```

### New User (CLI First)

```
1. User installs CLI: bun install -g openctl
2. User runs: openctl auth login
3. Browser opens automatically to sign-in page
4. User signs in with Google
5. Browser redirects to localhost, CLI receives tokens
6. CLI: "Authenticated as user@example.com"
7. User runs: openctl repo allow && openctl daemon start
8. Sessions start appearing in web UI
```

### Existing User, New Device

```
1. User installs CLI on new laptop
2. Runs: openctl auth login
3. Signs in with same Google account
4. CLI: "Welcome back! You have 47 sessions."
5. All sessions accessible (no re-claim needed - user_id based)
```

### Legacy User (Has Sessions, No Account)

```
1. User has been using CLI without auth (client_id only)
2. User runs: openctl auth login
3. Signs in with Google
4. CLI: "Found 23 sessions from this device. Claim them?"
5. User confirms, sessions linked to account
6. Sessions now accessible from any device
```

---

## Decisions Made

1. **Anonymous uploads**: Yes, allow uploads without auth
   - Client ID provides ownership for claiming later
   - Lower friction for trying the product
   - Sessions can be claimed when user eventually authenticates

2. **Session visibility default**: Private until share token is generated
   - No auto-generated share tokens
   - User explicitly creates share link when ready

3. **CLI auth flow**: Localhost callback (not device flow)
   - Opens browser, redirects back to localhost
   - No manual code entry required

## Decisions Made (continued)

4. **Share token expiry**: No expiry for now
5. **Multiple devices, same client_id**: Allow it - sessions become user-owned anyway after auth
6. **CLI auth on headless servers**: Support `--token` flag for manual token entry

---

## Headless Server Authentication

For CI/CD pipelines and servers without browsers.

### Option 1: Auth on Local Machine, Copy Tokens

```sh
# On your laptop (has browser)
openctl auth login
openctl auth export > tokens.json  # Exports refresh token

# On headless server
openctl auth import < tokens.json  # Or set OPENCTL_REFRESH_TOKEN env var
openctl daemon start
```

The refresh token auto-refreshes the access token, so this works indefinitely until revoked.

### Option 2: Personal Access Tokens (Phase 2)

If token management becomes cumbersome, implement PATs:

**Design (deferred):**
- Web UI to create long-lived tokens (Settings > Access Tokens)
- Token format: `octl_<random>` (prefix helps identify token type)
- Store hashed in `personal_access_tokens` table
- Can be revoked from web UI

**When to implement:**
- Multiple users request simpler CI/CD setup
- Token export/import feels clunky

**Note:** Since we now have OAuth refresh tokens, the immediate need for PATs is reduced. Refresh tokens work well for most headless scenarios.

---

## Appendix: Clerk Integration Notes

### Server-Side (Bun)

Clerk provides `@clerk/backend` for token validation:

```ts
import { verifyToken } from '@clerk/backend';

async function validateAuth(req: Request) {
  const authHeader = req.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');

  if (!token) return null;

  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    return payload.sub; // user ID
  } catch {
    return null;
  }
}
```

### Client-Side (React)

```tsx
import { ClerkProvider, SignInButton, useUser } from '@clerk/react';

function App() {
  return (
    <ClerkProvider publishableKey={CLERK_KEY}>
      <Router />
    </ClerkProvider>
  );
}
```

### CLI Auth (OAuth with Clerk)

CLI uses OAuth 2.0 Authorization Code flow with PKCE, using Clerk as the identity provider.

**Why OAuth:**
- Standard protocol with well-tested libraries
- Refresh tokens built-in (no 7-day re-auth)
- PKCE provides security for public clients (CLI)
- Single pre-registered redirect URI

**Flow:**

```
1. User runs: openctl auth login
2. CLI starts local HTTP server on random port (e.g., 54321)
3. CLI generates:
   - PKCE code_verifier (random 32 bytes)
   - code_challenge = base64url(sha256(code_verifier))
   - state = sign({ port: 54321, nonce: random, timestamp })
4. CLI opens browser to Clerk OAuth:
   https://clerk.openctl.dev/oauth/authorize?
     client_id=<cli_oauth_client_id>
     &redirect_uri=https://openctl.dev/auth/cli/callback  <-- FIXED URL
     &response_type=code
     &scope=openid profile email offline_access
     &state=<signed_state>
     &code_challenge=<challenge>
     &code_challenge_method=S256

5. User signs in with Google (via Clerk)
6. Clerk redirects to: https://openctl.dev/auth/cli/callback?code=xxx&state=xxx
7. Server (/auth/cli/callback):
   a. Validates state signature, checks timestamp < 5 min
   b. Extracts port from state
   c. Returns HTML page that redirects to localhost with code:
      <script>location.href = 'http://localhost:54321/callback?code=xxx&state=xxx'</script>
8. CLI local server receives code
9. CLI exchanges code for tokens directly with Clerk:
   POST https://clerk.openctl.dev/oauth/token
   { grant_type: authorization_code, code, code_verifier, redirect_uri, client_id }
10. Clerk returns: { access_token, refresh_token, expires_in }
11. CLI stores tokens in OS keychain
12. Done
```

**Why server redirect instead of direct localhost redirect:**
- Clerk requires pre-registered redirect URIs
- Can't register localhost:* with random ports
- Server acts as intermediary, validates state, then redirects to localhost

**Clerk OAuth Configuration:**

In Clerk dashboard, configure OAuth:
- Client ID: `cli_openctl` (public client, no secret)
- Redirect URI: `https://openctl.dev/auth/cli/callback`
- Grant types: Authorization Code
- PKCE: Required
- Scopes: `openid`, `profile`, `email`, `offline_access` (for refresh tokens)

**Token Refresh:**

```
1. CLI detects access_token expired (or about to expire)
2. CLI calls Clerk token endpoint:
   POST https://clerk.openctl.dev/oauth/token
   { grant_type: refresh_token, refresh_token: xxx, client_id: xxx }
3. Clerk returns new access_token (and optionally rotated refresh_token)
4. CLI updates stored tokens
```

**Token Validation (Server-Side):**

```typescript
import { verifyToken } from '@clerk/backend';

async function verifyCliToken(token: string): Promise<{ userId: string }> {
  const payload = await verifyToken(token, {
    secretKey: process.env.CLERK_SECRET_KEY,
  });
  return { userId: payload.sub };
}
```

**Benefits over custom tokens:**
- Refresh tokens handled by Clerk (no custom infrastructure)
- Standard OAuth libraries available for CLI implementation
- Token revocation via Clerk dashboard
- Shorter access token lifetime with seamless refresh

---

## References

- [Clerk Documentation](https://clerk.com/docs)
- [Existing repo_access_control.md](./repo_access_control.md) - client_id model
