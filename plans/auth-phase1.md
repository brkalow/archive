# Auth Phase 1: Core Authentication

Implementation plan for core auth features. Reference: [specs/auth.md](../specs/auth.md)

## Overview

Phase 1 enables user authentication for both web and CLI, with backwards-compatible support for anonymous (client_id) uploads.

## Parallelization

```
┌─────────────────────────────────────────────────────────────────┐
│                        PARALLEL TRACK A                         │
│                     (Web + Server Setup)                        │
├─────────────────────────────────────────────────────────────────┤
│  A1. Clerk Setup        A2. DB Migration      A3. Web Auth      │
│  (dashboard config)  →  (user_id column)   →  (sign-in UI)      │
│       [1 day]              [0.5 day]           [2 days]         │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        PARALLEL TRACK B                         │
│                        (CLI Auth Flow)                          │
├─────────────────────────────────────────────────────────────────┤
│  B1. CLI OAuth         B2. Keychain          B3. CLI Commands   │
│  (PKCE + flow)      →  Storage            →  (login/logout/etc) │
│     [2 days]            [1 day]               [1 day]           │
└─────────────────────────────────────────────────────────────────┘

                              ↓ Both tracks merge ↓

┌─────────────────────────────────────────────────────────────────┐
│                      SEQUENTIAL (After A+B)                     │
├─────────────────────────────────────────────────────────────────┤
│  C1. API Protection Middleware    →    C2. Session Claiming     │
│           [2 days]                          [1 day]             │
└─────────────────────────────────────────────────────────────────┘
```

**Total estimated time:** ~5-6 days with parallelization (vs ~10 days sequential)

---

## Track A: Web + Server Setup

### A1. Clerk Dashboard Setup

**Prereqs:** Clerk account, domain configured

**Tasks:**
1. Create Clerk application
2. Enable Google OAuth provider
3. Configure OAuth client for CLI:
   - Client ID: `cli_openctl` (public client)
   - Redirect URI: `https://openctl.dev/auth/cli/callback`
   - Grant types: Authorization Code
   - PKCE: Required
   - Scopes: `openid`, `profile`, `email`, `offline_access`
4. Set environment variables:
   ```
   CLERK_PUBLISHABLE_KEY=pk_...
   CLERK_SECRET_KEY=sk_...
   CLERK_OAUTH_CLIENT_ID=cli_openctl
   SERVER_SECRET=<random 32 bytes for HMAC state signing>
   ```

**Output:** Clerk configured, env vars documented

---

### A2. Database Migration

**Prereqs:** None (can start immediately)

**Tasks:**
1. Add `user_id` column to sessions table:
   ```typescript
   // src/db/schema.ts
   safeAddColumn(db, "sessions", "user_id", "TEXT");
   db.run("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)");
   ```

2. Update Session type:
   ```typescript
   interface Session {
     // ... existing fields
     user_id: string | null;
   }
   ```

3. Update repository functions to handle `user_id`:
   - `createSession()` - accept optional `userId` param
   - `getSessions()` - filter by `user_id` when authenticated
   - `getSession()` - no change (access control handled separately)

**Output:** Schema updated, types updated, repository functions ready

---

### A3. Web Auth Integration

**Prereqs:** A1 (Clerk setup)

**Tasks:**
1. Install Clerk React SDK:
   ```sh
   bun add @clerk/react
   ```

2. Add ClerkProvider to app root:
   ```tsx
   // src/client/app.tsx
   import { ClerkProvider } from '@clerk/react';

   export function App() {
     return (
       <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
         <Router />
       </ClerkProvider>
     );
   }
   ```

3. Create sign-in page component:
   ```tsx
   // src/client/pages/sign-in.tsx
   import { SignIn } from '@clerk/react';

   export function SignInPage() {
     return <SignIn routing="path" path="/sign-in" />;
   }
   ```

4. Add protected route wrapper:
   ```tsx
   // src/client/components/protected-route.tsx
   import { useAuth, RedirectToSignIn } from '@clerk/react';

   export function ProtectedRoute({ children }) {
     const { isSignedIn, isLoaded } = useAuth();
     if (!isLoaded) return <Loading />;
     if (!isSignedIn) return <RedirectToSignIn />;
     return children;
   }
   ```

5. Protect `/sessions` routes:
   - Wrap session list and detail pages with ProtectedRoute
   - Keep `/s/:shareToken` public (no auth required)

6. Add sign-in/sign-out buttons to header:
   ```tsx
   import { SignedIn, SignedOut, UserButton, SignInButton } from '@clerk/react';

   <SignedOut>
     <SignInButton />
   </SignedOut>
   <SignedIn>
     <UserButton />
   </SignedIn>
   ```

**Output:** Web sign-in working, protected routes enforced

---

## Track B: CLI Auth Flow

### B1. CLI OAuth Implementation

**Prereqs:** A1 (Clerk OAuth client configured)

**Tasks:**
1. Create OAuth module:
   ```typescript
   // cli/lib/oauth.ts

   export async function startOAuthFlow(serverUrl: string): Promise<Tokens> {
     // 1. Generate PKCE
     const codeVerifier = generateCodeVerifier();
     const codeChallenge = await generateCodeChallenge(codeVerifier);

     // 2. Generate state (HMAC-signed with port)
     const port = await findAvailablePort();
     const state = signState({ port, nonce: randomBytes(16), timestamp: Date.now() });

     // 3. Start local server
     const { promise, server } = createCallbackServer(port);

     // 4. Open browser to Clerk OAuth
     const authUrl = buildAuthUrl({ codeChallenge, state, serverUrl });
     await openBrowser(authUrl);

     // 5. Wait for callback (with timeout)
     const { code } = await withTimeout(promise, 5 * 60 * 1000);
     server.close();

     // 6. Exchange code for tokens
     const tokens = await exchangeCodeForTokens({ code, codeVerifier, serverUrl });

     return tokens;
   }
   ```

2. Implement PKCE helpers:
   ```typescript
   // cli/lib/pkce.ts
   function generateCodeVerifier(): string {
     return base64url(crypto.randomBytes(32));
   }

   async function generateCodeChallenge(verifier: string): Promise<string> {
     const hash = crypto.createHash('sha256').update(verifier).digest();
     return base64url(hash);
   }
   ```

3. Implement local callback server:
   ```typescript
   // cli/lib/callback-server.ts
   function createCallbackServer(port: number) {
     return new Promise((resolve, reject) => {
       const server = Bun.serve({
         port,
         fetch(req) {
           const url = new URL(req.url);
           if (url.pathname === '/callback') {
             const code = url.searchParams.get('code');
             const state = url.searchParams.get('state');
             resolve({ code, state });
             return new Response('<html><body>Authentication successful! You can close this tab.</body></html>', {
               headers: { 'Content-Type': 'text/html' },
             });
           }
           return new Response('Not found', { status: 404 });
         },
       });
       return { promise, server };
     });
   }
   ```

4. Implement token exchange:
   ```typescript
   // cli/lib/token-exchange.ts
   async function exchangeCodeForTokens({ code, codeVerifier, serverUrl }) {
     const response = await fetch(`${getClerkOAuthUrl()}/oauth/token`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
       body: new URLSearchParams({
         grant_type: 'authorization_code',
         code,
         code_verifier: codeVerifier,
         redirect_uri: `${serverUrl}/auth/cli/callback`,
         client_id: CLERK_OAUTH_CLIENT_ID,
       }),
     });
     return response.json();
   }
   ```

5. Implement server callback endpoint:
   ```typescript
   // src/server.ts - add route
   if (pathname === '/auth/cli/callback') {
     const code = url.searchParams.get('code');
     const state = url.searchParams.get('state');

     // Validate state
     const { valid, port } = validateState(state);
     if (!valid) {
       return new Response('Invalid state', { status: 400 });
     }

     // Redirect to localhost with code
     return new Response(`
       <html>
         <script>location.href = 'http://localhost:${port}/callback?code=${code}&state=${state}'</script>
       </html>
     `, { headers: { 'Content-Type': 'text/html' } });
   }
   ```

**Output:** OAuth flow working end-to-end

---

### B2. Keychain Storage

**Prereqs:** None (can start with B1)

**Tasks:**
1. Create keychain abstraction:
   ```typescript
   // cli/lib/keychain.ts

   interface TokenStore {
     get(serverUrl: string): Promise<Tokens | null>;
     set(serverUrl: string, tokens: Tokens): Promise<void>;
     delete(serverUrl: string): Promise<void>;
   }
   ```

2. Implement macOS Keychain (primary):
   ```typescript
   // cli/lib/keychain-macos.ts
   import { exec } from 'child_process';

   export class MacOSKeychain implements TokenStore {
     private service = 'openctl-cli';

     async get(serverUrl: string): Promise<Tokens | null> {
       try {
         const result = await exec(
           `security find-generic-password -s "${this.service}" -a "${serverUrl}" -w`
         );
         return JSON.parse(result);
       } catch {
         return null;
       }
     }

     async set(serverUrl: string, tokens: Tokens): Promise<void> {
       await exec(
         `security add-generic-password -s "${this.service}" -a "${serverUrl}" -w '${JSON.stringify(tokens)}' -U`
       );
     }

     async delete(serverUrl: string): Promise<void> {
       await exec(
         `security delete-generic-password -s "${this.service}" -a "${serverUrl}"`
       );
     }
   }
   ```

3. Implement encrypted file fallback (Linux without Secret Service):
   ```typescript
   // cli/lib/keychain-file.ts
   export class FileKeychain implements TokenStore {
     private path = join(homedir(), '.openctl', 'auth.enc');

     // Use machine ID + user ID for key derivation
     // Encrypt with AES-256-GCM
   }
   ```

4. Create factory to select implementation:
   ```typescript
   // cli/lib/keychain.ts
   export function getKeychain(): TokenStore {
     if (process.platform === 'darwin') {
       return new MacOSKeychain();
     }
     // Try libsecret, fallback to file
     return new FileKeychain();
   }
   ```

**Output:** Secure token storage working on macOS, Linux fallback

---

### B3. CLI Auth Commands

**Prereqs:** B1, B2

**Tasks:**
1. Implement `openctl auth login`:
   ```typescript
   // cli/commands/auth/login.ts
   export async function loginCommand(options: { server?: string }) {
     const serverUrl = options.server || getConfig().server;

     console.log('Opening browser for authentication...');
     const tokens = await startOAuthFlow(serverUrl);

     const keychain = getKeychain();
     await keychain.set(serverUrl, tokens);

     // Get user info
     const userInfo = await getUserInfo(tokens.access_token);
     console.log(`Authenticated as ${userInfo.email}`);

     // Check for unclaimed sessions (triggers claiming flow)
     await checkUnclaimedSessions(serverUrl, tokens);
   }
   ```

2. Implement `openctl auth logout`:
   ```typescript
   // cli/commands/auth/logout.ts
   export async function logoutCommand(options: { server?: string }) {
     const serverUrl = options.server || getConfig().server;
     const keychain = getKeychain();
     await keychain.delete(serverUrl);
     console.log('Logged out successfully');
   }
   ```

3. Implement `openctl auth status`:
   ```typescript
   // cli/commands/auth/status.ts
   export async function statusCommand() {
     const serverUrl = getConfig().server;
     const keychain = getKeychain();
     const tokens = await keychain.get(serverUrl);

     if (!tokens) {
       console.log('Not authenticated');
       return;
     }

     // Check if token is valid
     try {
       const userInfo = await getUserInfo(tokens.access_token);
       console.log(`Authenticated as ${userInfo.email}`);
       console.log(`Server: ${serverUrl}`);
     } catch {
       console.log('Token expired - run `openctl auth login` to re-authenticate');
     }
   }
   ```

4. Implement `openctl auth whoami`:
   ```typescript
   // cli/commands/auth/whoami.ts
   export async function whoamiCommand() {
     const tokens = await getAuthenticatedTokens();
     const userInfo = await getUserInfo(tokens.access_token);
     console.log(JSON.stringify(userInfo, null, 2));
   }
   ```

5. Implement token refresh helper:
   ```typescript
   // cli/lib/auth.ts
   export async function getAuthenticatedTokens(): Promise<Tokens> {
     const serverUrl = getConfig().server;
     const keychain = getKeychain();
     let tokens = await keychain.get(serverUrl);

     if (!tokens) {
       throw new Error('Not authenticated. Run `openctl auth login` first.');
     }

     // Check if access token expired
     if (isTokenExpired(tokens.accessToken)) {
       // Refresh
       tokens = await refreshTokens(tokens.refreshToken);
       await keychain.set(serverUrl, tokens);
     }

     return tokens;
   }
   ```

6. Add auth header to API client:
   ```typescript
   // cli/lib/api.ts
   export async function apiRequest(path: string, options: RequestInit = {}) {
     const tokens = await getAuthenticatedTokens().catch(() => null);

     const headers = new Headers(options.headers);
     if (tokens) {
       headers.set('Authorization', `Bearer ${tokens.accessToken}`);
     }
     headers.set('X-Openctl-Client-ID', getClientId());

     return fetch(`${getConfig().server}${path}`, { ...options, headers });
   }
   ```

**Output:** All auth commands working, API client authenticated

---

## Sequential: After Tracks A+B Merge

### C1. API Protection Middleware

**Prereqs:** A1, A2, A3, B1 (Clerk configured, DB ready, tokens working)

**Tasks:**
1. Install Clerk backend SDK:
   ```sh
   bun add @clerk/backend
   ```

2. Create auth middleware:
   ```typescript
   // src/middleware/auth.ts
   import { verifyToken } from '@clerk/backend';

   export interface AuthContext {
     userId: string | null;
     clientId: string | null;
   }

   export async function extractAuth(req: Request): Promise<AuthContext> {
     const authHeader = req.headers.get('Authorization');
     const clientId = req.headers.get('X-Openctl-Client-ID');

     let userId: string | null = null;

     if (authHeader?.startsWith('Bearer ')) {
       const token = authHeader.slice(7);
       try {
         const payload = await verifyToken(token, {
           secretKey: process.env.CLERK_SECRET_KEY,
         });
         userId = payload.sub;
       } catch {
         // Invalid token - continue without userId
       }
     }

     return { userId, clientId };
   }
   ```

3. Create access control helper:
   ```typescript
   // src/middleware/access-control.ts
   export async function canAccessSession(
     session: Session,
     auth: AuthContext,
     options: { requireOwner?: boolean } = {}
   ): Promise<{ allowed: boolean; isOwner: boolean }> {
     const isOwner =
       (auth.userId && session.user_id === auth.userId) ||
       (auth.clientId && session.client_id === auth.clientId);

     if (options.requireOwner) {
       return { allowed: isOwner, isOwner };
     }

     // Owner always has access
     if (isOwner) {
       return { allowed: true, isOwner: true };
     }

     // No access
     return { allowed: false, isOwner: false };
   }
   ```

4. Update API routes to use auth:
   ```typescript
   // src/server.ts

   // GET /api/sessions
   if (method === 'GET' && pathname === '/api/sessions') {
     const auth = await extractAuth(req);

     if (!auth.userId && !auth.clientId) {
       return new Response('Unauthorized', { status: 401 });
     }

     // Get sessions user owns (by user_id) or client owns (by client_id)
     const sessions = await getSessions({
       userId: auth.userId,
       clientId: auth.clientId,
     });

     return Response.json(sessions);
   }

   // GET /api/sessions/:id
   if (method === 'GET' && sessionIdMatch) {
     const session = await getSession(sessionIdMatch[1]);
     if (!session) return new Response('Not found', { status: 404 });

     const auth = await extractAuth(req);
     const access = await canAccessSession(session, auth);

     if (!access.allowed) {
       return new Response('Forbidden', { status: 403 });
     }

     return Response.json(session);
   }

   // POST /api/sessions (upload - optional auth)
   if (method === 'POST' && pathname === '/api/sessions') {
     const auth = await extractAuth(req);

     // Create session with user_id if authenticated, otherwise client_id only
     const session = await createSession({
       ...sessionData,
       user_id: auth.userId,
       client_id: auth.clientId,
     });

     return Response.json(session);
   }

   // DELETE /api/sessions/:id (owner only)
   if (method === 'DELETE' && sessionIdMatch) {
     const session = await getSession(sessionIdMatch[1]);
     const auth = await extractAuth(req);
     const access = await canAccessSession(session, auth, { requireOwner: true });

     if (!access.allowed) {
       return new Response('Forbidden', { status: 403 });
     }

     await deleteSession(session.id);
     return new Response(null, { status: 204 });
   }
   ```

5. Update all protected endpoints:
   - `PATCH /api/sessions/:id` - owner only
   - `POST /api/sessions/:id/share` - owner only
   - `POST /api/sessions/:id/messages` - owner only (live)
   - `POST /api/sessions/:id/complete` - owner only (live)
   - `PUT /api/sessions/:id/diff` - owner only
   - `GET /api/stats/*` - filter by user_id

6. Keep public endpoints unchanged:
   - `GET /api/s/:shareToken` - no auth required

**Output:** All API endpoints properly protected

---

### C2. Session Claiming

**Prereqs:** C1 (API protection working)

**Tasks:**
1. Create claiming check function:
   ```typescript
   // src/repository/claiming.ts
   export async function getUnclaimedSessions(clientId: string): Promise<Session[]> {
     return db.query(
       `SELECT * FROM sessions WHERE client_id = ? AND user_id IS NULL`,
       [clientId]
     );
   }

   export async function claimSessions(clientId: string, userId: string): Promise<number> {
     const result = db.run(
       `UPDATE sessions SET user_id = ? WHERE client_id = ? AND user_id IS NULL`,
       [userId, clientId]
     );
     return result.changes;
   }
   ```

2. Add claiming API endpoint:
   ```typescript
   // src/server.ts

   // GET /api/sessions/unclaimed - get unclaimed sessions for current client
   if (method === 'GET' && pathname === '/api/sessions/unclaimed') {
     const auth = await extractAuth(req);
     if (!auth.userId || !auth.clientId) {
       return new Response('Unauthorized', { status: 401 });
     }

     const sessions = await getUnclaimedSessions(auth.clientId);
     return Response.json({ count: sessions.length, sessions });
   }

   // POST /api/sessions/claim - claim all unclaimed sessions for current client
   if (method === 'POST' && pathname === '/api/sessions/claim') {
     const auth = await extractAuth(req);
     if (!auth.userId || !auth.clientId) {
       return new Response('Unauthorized', { status: 401 });
     }

     const claimed = await claimSessions(auth.clientId, auth.userId);
     return Response.json({ claimed });
   }
   ```

3. Implement CLI claiming flow:
   ```typescript
   // cli/lib/claiming.ts
   export async function checkUnclaimedSessions(serverUrl: string, tokens: Tokens) {
     const response = await fetch(`${serverUrl}/api/sessions/unclaimed`, {
       headers: {
         'Authorization': `Bearer ${tokens.accessToken}`,
         'X-Openctl-Client-ID': getClientId(),
       },
     });

     const { count, sessions } = await response.json();

     if (count === 0) return;

     console.log(`\nFound ${count} sessions from this device that aren't linked to your account.`);
     console.log('Claim these sessions? They\'ll be accessible from any device you sign into. [Y/n]');

     const answer = await prompt();
     if (answer.toLowerCase() !== 'n') {
       await fetch(`${serverUrl}/api/sessions/claim`, {
         method: 'POST',
         headers: {
           'Authorization': `Bearer ${tokens.accessToken}`,
           'X-Openctl-Client-ID': getClientId(),
         },
       });
       console.log(`Claimed ${count} sessions.`);
     }
   }
   ```

**Output:** Session claiming working in CLI

---

## Testing Checklist

### Web Auth
- [ ] Sign in with Google works
- [ ] Sign out works
- [ ] `/sessions` requires auth
- [ ] `/sessions/:id` requires auth (unless shared)
- [ ] `/s/:shareToken` works without auth
- [ ] User button shows email/avatar

### CLI Auth
- [ ] `openctl auth login` opens browser
- [ ] OAuth callback works
- [ ] Tokens stored in keychain
- [ ] `openctl auth status` shows auth state
- [ ] `openctl auth logout` clears tokens
- [ ] `openctl auth whoami` shows user info
- [ ] Token refresh works when expired

### API Protection
- [ ] Authenticated requests include user_id
- [ ] Anonymous requests use client_id
- [ ] Owner can view/edit/delete their sessions
- [ ] Non-owner gets 403
- [ ] Share token grants read-only access
- [ ] Stats filtered by user

### Session Claiming
- [ ] Unclaimed sessions detected on login
- [ ] Claiming prompt shown
- [ ] Claiming updates user_id
- [ ] Claimed sessions accessible cross-device

---

## Rollout Plan

1. **Deploy database migration** (A2) - backwards compatible
2. **Deploy Clerk integration** (A1, A3) - behind feature flag initially
3. **Release CLI update** (B1-B3) - backwards compatible
4. **Enable API protection** (C1) - gradual rollout
5. **Enable claiming** (C2) - after API protection stable
