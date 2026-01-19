# Auth Phase 2: Polish

Implementation plan for auth polish and refinements. Reference: [specs/auth.md](../specs/auth.md)

**Prereqs:** Phase 1 complete, Phase 1.5 optional

## Overview

Phase 2 focuses on robustness, UX polish, and features that improve the auth experience but aren't blocking for initial launch. These can be implemented incrementally after Phase 1 is stable.

## Tasks (Independent, Can Be Done In Any Order)

```
┌───────────────────────────────────────────────────────────────┐
│                    INDEPENDENT TASKS                          │
│          (can be done in any order, by any engineer)          │
├───────────────────────────────────────────────────────────────┤
│  1. WebSocket Auth         2. Token Refresh       3. Error UX │
│     [1 day]                   [0.5 day]              [1 day]  │
│                                                               │
│  4. User Profile Cache     5. Rate Limiting                   │
│     [0.5 day]                 [1 day]                         │
└───────────────────────────────────────────────────────────────┘
```

**Total estimated time:** ~4 days (can be parallelized across engineers)

---

## 1. WebSocket Authentication

**Priority:** High (live sessions need auth)

**Problem:** WebSocket connections for live session streaming currently don't validate auth tokens, allowing anyone with a session ID to watch live updates.

**Tasks:**

1. Update WebSocket upgrade handler:
   ```typescript
   // src/server.ts - in WebSocket upgrade handler

   server.upgrade(req, {
     beforeUpgrade: async (req) => {
       // Extract token from Sec-WebSocket-Protocol header
       const protocols = req.headers.get('sec-websocket-protocol')?.split(', ');
       const authProtocol = protocols?.find(p => p !== 'openctl-auth');

       if (!authProtocol) {
         throw new Response('Unauthorized', { status: 401 });
       }

       // Verify token
       const userId = await verifyClerkToken(authProtocol);
       if (!userId) {
         throw new Response('Unauthorized', { status: 401 });
       }

       // Extract session ID from path
       const sessionId = extractSessionIdFromPath(req.url);
       const session = await getSession(sessionId);

       if (!session) {
         throw new Response('Not found', { status: 404 });
       }

       // Check access
       const auth: AuthContext = { userId, clientId: null };
       const access = await canAccessSession(session, auth);

       if (!access.allowed) {
         throw new Response('Forbidden', { status: 403 });
       }

       // Store userId for later use in message handlers
       return { userId, sessionId };
     },
   });
   ```

2. Update client WebSocket connection:
   ```typescript
   // src/client/lib/websocket.ts

   export function createAuthenticatedWebSocket(
     sessionId: string,
     accessToken: string
   ): WebSocket {
     const url = `${WS_BASE_URL}/api/sessions/${sessionId}/ws`;

     // Pass token via subprotocol header
     const ws = new WebSocket(url, ['openctl-auth', accessToken]);

     ws.addEventListener('error', (e) => {
       console.error('WebSocket error:', e);
     });

     return ws;
   }
   ```

3. Handle token expiry during long connections:
   ```typescript
   // Periodic token refresh for long-lived connections
   function setupTokenRefresh(ws: WebSocket, getToken: () => Promise<string>) {
     const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes

     const interval = setInterval(async () => {
       // For existing connection, we can't change the protocol
       // Options:
       // 1. Reconnect with new token (cleanest)
       // 2. Send token via message (requires server support)

       // Option 1: Reconnect
       const newToken = await getToken();
       ws.close(1000, 'Token refresh');
       // Caller should handle close and reconnect
     }, REFRESH_INTERVAL);

     ws.addEventListener('close', () => clearInterval(interval));
   }
   ```

4. Graceful handling of expired tokens:
   ```typescript
   // Server: Check token validity periodically
   // If token expired, close with specific code

   const TOKEN_EXPIRED_CODE = 4001;

   // In WebSocket message handler
   if (isTokenExpired(connectionToken)) {
     ws.close(TOKEN_EXPIRED_CODE, 'Token expired');
   }

   // Client: Handle expired token code
   ws.addEventListener('close', (event) => {
     if (event.code === 4001) {
       // Refresh token and reconnect
       refreshAndReconnect();
     }
   });
   ```

**Testing:**
- [ ] WebSocket without token rejected (401)
- [ ] WebSocket with invalid token rejected (401)
- [ ] WebSocket with valid token but wrong session rejected (403)
- [ ] WebSocket with valid token and access works
- [ ] Token expiry during connection handled gracefully

---

## 2. Token Refresh

**Priority:** High (CLI UX)

**Problem:** Access tokens expire after ~1 hour. Without automatic refresh, users get 401 errors and have to re-authenticate manually.

**Tasks:**

1. CLI: Automatic token refresh:
   ```typescript
   // cli/lib/auth.ts

   export async function getAuthenticatedTokens(): Promise<Tokens> {
     const serverUrl = getConfig().server;
     const keychain = getKeychain();
     let tokens = await keychain.get(serverUrl);

     if (!tokens) {
       throw new Error('Not authenticated. Run `openctl auth login` first.');
     }

     // Check if access token expired or about to expire (5 min buffer)
     const expiresAt = new Date(tokens.expiresAt).getTime();
     const buffer = 5 * 60 * 1000;

     if (Date.now() > expiresAt - buffer) {
       console.log('Refreshing access token...');
       try {
         tokens = await refreshAccessToken(tokens.refreshToken);
         await keychain.set(serverUrl, tokens);
       } catch (err) {
         // Refresh failed - token may be revoked
         throw new Error('Session expired. Run `openctl auth login` to re-authenticate.');
       }
     }

     return tokens;
   }

   async function refreshAccessToken(refreshToken: string): Promise<Tokens> {
     const response = await fetch(`${getClerkOAuthUrl()}/oauth/token`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
       body: new URLSearchParams({
         grant_type: 'refresh_token',
         refresh_token: refreshToken,
         client_id: CLERK_OAUTH_CLIENT_ID,
       }),
     });

     if (!response.ok) {
       throw new Error('Token refresh failed');
     }

     const data = await response.json();
     return {
       accessToken: data.access_token,
       refreshToken: data.refresh_token || refreshToken, // May or may not rotate
       expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
     };
   }
   ```

2. CLI Daemon: Background token refresh:
   ```typescript
   // cli/daemon/token-refresh.ts

   export function startTokenRefreshLoop() {
     const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes

     setInterval(async () => {
       try {
         // This will refresh if needed
         await getAuthenticatedTokens();
       } catch (err) {
         console.error('Token refresh failed:', err.message);
         // Don't crash daemon, just log
       }
     }, REFRESH_INTERVAL);
   }
   ```

3. Web: Clerk handles automatically (no work needed)

**Testing:**
- [ ] CLI refreshes token when expired
- [ ] CLI refreshes token when about to expire (5 min buffer)
- [ ] Daemon refreshes token in background
- [ ] Revoked refresh token prompts re-auth
- [ ] Refresh token rotation handled correctly

---

## 3. Error Handling UX

**Priority:** Medium (polish)

**Problem:** Auth errors currently show generic messages. Users need clear guidance on what went wrong and how to fix it.

**Tasks:**

1. CLI error messages:
   ```typescript
   // cli/lib/errors.ts

   export class AuthError extends Error {
     constructor(
       message: string,
       public suggestion?: string
     ) {
       super(message);
     }
   }

   // Usage in commands
   try {
     await loginCommand();
   } catch (err) {
     if (err instanceof AuthError) {
       console.error(`Error: ${err.message}`);
       if (err.suggestion) {
         console.error(`\n${err.suggestion}`);
       }
     }
   }
   ```

2. Implement error table from spec:
   ```typescript
   // cli/lib/auth-errors.ts

   export function handleAuthError(error: any): never {
     if (error.code === 'EADDRINUSE') {
       throw new AuthError(
         'Could not start local server for authentication',
         'Try again, or use `openctl auth login --manual` for manual code entry'
       );
     }

     if (error.message?.includes('timeout')) {
       throw new AuthError(
         'Authentication timed out',
         'Run `openctl auth login` to try again'
       );
     }

     if (error.message?.includes('state')) {
       throw new AuthError(
         'Authentication failed (invalid state)',
         'This may be a security issue. Run `openctl auth login` to try again'
       );
     }

     if (error.code === 'REFRESH_REVOKED') {
       throw new AuthError(
         'Session revoked',
         'Run `openctl auth login` to re-authenticate'
       );
     }

     throw new AuthError(
       'Authentication failed',
       `Error: ${error.message}\n\nIf this persists, try:\n  openctl auth logout\n  openctl auth login`
     );
   }
   ```

3. Web error pages:
   ```tsx
   // src/client/components/error-boundary.tsx

   export function AuthErrorBoundary({ children }) {
     const [error, setError] = useState<Error | null>(null);

     if (error) {
       if (error.message.includes('401')) {
         return <SignInPrompt returnUrl={window.location.pathname} />;
       }
       if (error.message.includes('403')) {
         return <AccessDeniedPage />;
       }
       return <GenericErrorPage error={error} />;
     }

     return children;
   }
   ```

4. Return URL preservation on sign-in:
   ```tsx
   // When redirecting to sign-in, preserve return URL
   function SignInPrompt({ returnUrl }: { returnUrl: string }) {
     return (
       <div>
         <p>Please sign in to continue</p>
         <SignInButton redirectUrl={returnUrl}>
           <button>Sign In</button>
         </SignInButton>
       </div>
     );
   }
   ```

**Testing:**
- [ ] Port binding failure shows helpful message
- [ ] Auth timeout shows retry instructions
- [ ] State mismatch shows security warning
- [ ] Token refresh failure prompts re-auth
- [ ] Web 401 redirects to sign-in with return URL
- [ ] Web 403 shows access denied page

---

## 4. User Profile Caching

**Priority:** Low (optimization)

**Problem:** Displaying user names/avatars requires Clerk API calls. For session lists, this can be slow with many sessions.

**Tasks:**

1. Create users table:
   ```typescript
   // src/db/schema.ts
   db.run(`
     CREATE TABLE IF NOT EXISTS users (
       id TEXT PRIMARY KEY,
       email TEXT,
       name TEXT,
       avatar_url TEXT,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
     )
   `);
   ```

2. Cache user info on auth:
   ```typescript
   // src/middleware/auth.ts

   export async function extractAuth(req: Request): Promise<AuthContext> {
     // ... existing token verification

     if (userId) {
       // Check if user cached
       const cachedUser = getUserById(userId);
       if (!cachedUser) {
         // Fetch from Clerk and cache
         const clerkUser = await clerkClient.users.getUser(userId);
         upsertUser({
           id: userId,
           email: normalizeEmail(clerkUser.primaryEmailAddress?.emailAddress || ''),
           name: clerkUser.firstName ? `${clerkUser.firstName} ${clerkUser.lastName || ''}`.trim() : null,
           avatar_url: clerkUser.imageUrl,
         });
       }
     }

     return { userId, clientId };
   }
   ```

3. Use cached data in queries:
   ```typescript
   // src/repository/sessions.ts

   export function getSessionsWithOwners(filters: SessionFilters): SessionWithOwner[] {
     return db.query(`
       SELECT s.*, u.name as owner_name, u.avatar_url as owner_avatar
       FROM sessions s
       LEFT JOIN users u ON s.user_id = u.id
       WHERE ...
       ORDER BY s.created_at DESC
     `);
   }
   ```

4. Periodic cache refresh (optional):
   ```typescript
   // Refresh user info weekly or on mismatch
   const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week

   function shouldRefreshUser(user: User): boolean {
     const updatedAt = new Date(user.updated_at).getTime();
     return Date.now() - updatedAt > CACHE_TTL;
   }
   ```

**Testing:**
- [ ] User info cached on first auth
- [ ] Session list includes owner names
- [ ] Session list includes owner avatars
- [ ] Cache refreshed when stale

---

## 5. Rate Limiting

**Priority:** Medium (security)

**Problem:** Without rate limiting, the API is vulnerable to abuse (anonymous upload spam, brute force, etc).

**Tasks:**

1. Install rate limiting library:
   ```sh
   bun add rate-limiter-flexible
   ```

2. Create rate limiter configuration:
   ```typescript
   // src/middleware/rate-limit.ts
   import { RateLimiterMemory } from 'rate-limiter-flexible';

   // Anonymous upload limit (stricter)
   const anonymousUploadLimiter = new RateLimiterMemory({
     points: 20,      // 20 requests
     duration: 3600,  // per hour
     keyPrefix: 'anon_upload',
   });

   // Authenticated requests (generous)
   const authenticatedLimiter = new RateLimiterMemory({
     points: 1000,
     duration: 3600,
     keyPrefix: 'auth',
   });

   // Auth callback (strict, prevent brute force)
   const authCallbackLimiter = new RateLimiterMemory({
     points: 10,
     duration: 60,  // per minute
     keyPrefix: 'auth_callback',
   });

   // Share operations (moderate)
   const shareLimiter = new RateLimiterMemory({
     points: 50,
     duration: 3600,
     keyPrefix: 'share',
   });
   ```

3. Create rate limiting middleware:
   ```typescript
   // src/middleware/rate-limit.ts

   export async function checkRateLimit(
     limiter: RateLimiterMemory,
     key: string
   ): Promise<Response | null> {
     try {
       await limiter.consume(key);
       return null; // OK, continue
     } catch (rejRes) {
       const retryAfter = Math.ceil(rejRes.msBeforeNext / 1000);
       return new Response('Too Many Requests', {
         status: 429,
         headers: {
           'Retry-After': String(retryAfter),
           'X-RateLimit-Remaining': '0',
         },
       });
     }
   }
   ```

4. Apply rate limits to routes:
   ```typescript
   // src/server.ts

   // POST /api/sessions (upload)
   if (method === 'POST' && pathname === '/api/sessions') {
     const auth = await extractAuth(req);
     const key = auth.userId || `${auth.clientId}_${getClientIP(req)}`;

     const limiter = auth.userId ? authenticatedLimiter : anonymousUploadLimiter;
     const blocked = await checkRateLimit(limiter, key);
     if (blocked) return blocked;

     // ... rest of handler
   }

   // GET /auth/cli/callback
   if (pathname === '/auth/cli/callback') {
     const ip = getClientIP(req);
     const blocked = await checkRateLimit(authCallbackLimiter, ip);
     if (blocked) return blocked;

     // ... rest of handler
   }

   // POST /api/sessions/:id/shares
   if (method === 'POST' && sharesMatch) {
     const auth = await extractAuth(req);
     if (!auth.userId) return new Response('Unauthorized', { status: 401 });

     const blocked = await checkRateLimit(shareLimiter, auth.userId);
     if (blocked) return blocked;

     // ... rest of handler
   }
   ```

5. Add rate limit headers to responses:
   ```typescript
   function addRateLimitHeaders(response: Response, limiterRes: any): Response {
     const headers = new Headers(response.headers);
     headers.set('X-RateLimit-Limit', String(limiterRes.totalPoints));
     headers.set('X-RateLimit-Remaining', String(limiterRes.remainingPoints));
     headers.set('X-RateLimit-Reset', String(Math.ceil(limiterRes.msBeforeNext / 1000)));
     return new Response(response.body, { ...response, headers });
   }
   ```

**Testing:**
- [ ] Anonymous uploads limited to 20/hour
- [ ] Authenticated requests limited to 1000/hour
- [ ] Auth callback limited to 10/minute
- [ ] Share operations limited to 50/hour
- [ ] 429 response includes Retry-After header
- [ ] Rate limit headers included in responses

---

## Future Considerations (Not in Phase 2)

These items are noted for later phases:

### Personal Access Tokens (PATs)
If OAuth token export/import becomes cumbersome for CI/CD:
- Web UI to create long-lived tokens
- Token format: `octl_<random>`
- Store hashed in database
- Revocable from web UI

### GitHub-Based Permissions (Phase 3)
- Link GitHub account
- Scope session visibility by repo access
- Auto-share with repo collaborators

### Org/Team Support (Phase 3)
- Team creation and management
- Shared session pools
- Team-wide settings

---

## Testing Checklist Summary

### WebSocket Auth
- [ ] Connections require valid token
- [ ] Invalid tokens rejected
- [ ] Token expiry handled

### Token Refresh
- [ ] CLI auto-refreshes expired tokens
- [ ] Daemon refreshes in background
- [ ] Revoked tokens prompt re-auth

### Error UX
- [ ] Clear error messages with suggestions
- [ ] Return URL preserved on sign-in redirect

### User Cache
- [ ] User info cached on auth
- [ ] Session lists show owner info efficiently

### Rate Limiting
- [ ] Limits enforced per endpoint
- [ ] Proper 429 responses with headers
