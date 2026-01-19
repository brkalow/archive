# Auth Phase 1.5: User-to-User Sharing

Implementation plan for user-to-user sharing by email. Reference: [specs/auth.md](../specs/auth.md)

**Prereqs:** Phase 1 complete (user authentication working)

## Overview

Phase 1.5 enables sharing sessions with specific users by email, requiring sign-in to view. This complements the existing public share token mechanism with more controlled sharing.

## Parallelization

```
┌─────────────────────────────────────────────────────────────────┐
│                        PARALLEL TRACK A                         │
│                       (Backend + API)                           │
├─────────────────────────────────────────────────────────────────┤
│  A1. DB Schema        A2. API Endpoints      A3. Access Control │
│  (session_shares)  →  (CRUD for shares)   →  (update middleware)│
│     [0.5 day]            [1 day]                [0.5 day]       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        PARALLEL TRACK B                         │
│                           (UI)                                  │
├─────────────────────────────────────────────────────────────────┤
│  B1. Share Modal      B2. Shared With Me     B3. Access Denied  │
│  (email input)     →  (list filtering)    →  (error page)       │
│     [1.5 days]           [0.5 day]             [0.5 day]        │
└─────────────────────────────────────────────────────────────────┘

                              ↓ Both tracks merge ↓

┌─────────────────────────────────────────────────────────────────┐
│                      SEQUENTIAL (After A+B)                     │
├─────────────────────────────────────────────────────────────────┤
│              C1. Email Notifications (simple text)              │
│                          [1 day]                                │
└─────────────────────────────────────────────────────────────────┘
```

**Total estimated time:** ~3-4 days with parallelization

---

## Track A: Backend + API

### A1. Database Schema

**Prereqs:** None

**Tasks:**
1. Create `session_shares` table:
   ```typescript
   // src/db/schema.ts
   db.run(`
     CREATE TABLE IF NOT EXISTS session_shares (
       id INTEGER PRIMARY KEY,
       session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
       shared_with_email TEXT NOT NULL,
       shared_with_user_id TEXT,
       shared_by_user_id TEXT NOT NULL,
       permission TEXT DEFAULT 'view',
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       UNIQUE(session_id, shared_with_email)
     )
   `);
   ```

2. Add indexes:
   ```typescript
   db.run("CREATE INDEX IF NOT EXISTS idx_session_shares_session ON session_shares(session_id)");
   db.run("CREATE INDEX IF NOT EXISTS idx_session_shares_email ON session_shares(shared_with_email)");
   db.run("CREATE INDEX IF NOT EXISTS idx_session_shares_user ON session_shares(shared_with_user_id)");
   ```

3. Add email normalization helper:
   ```typescript
   // src/lib/email.ts
   export function normalizeEmail(email: string): string {
     return email.toLowerCase().trim();
   }
   ```

**Output:** Schema created with proper indexes

---

### A2. API Endpoints

**Prereqs:** A1 (schema)

**Tasks:**
1. Create share repository functions:
   ```typescript
   // src/repository/shares.ts

   interface SessionShare {
     id: number;
     session_id: string;
     shared_with_email: string;
     shared_with_user_id: string | null;
     shared_by_user_id: string;
     permission: string;
     created_at: string;
   }

   export function getSessionShares(sessionId: string): SessionShare[] {
     return db.query(
       `SELECT * FROM session_shares WHERE session_id = ? ORDER BY created_at DESC`,
       [sessionId]
     );
   }

   export function addSessionShare(
     sessionId: string,
     email: string,
     sharedByUserId: string
   ): SessionShare {
     const normalizedEmail = normalizeEmail(email);

     db.run(
       `INSERT OR IGNORE INTO session_shares (session_id, shared_with_email, shared_by_user_id)
        VALUES (?, ?, ?)`,
       [sessionId, normalizedEmail, sharedByUserId]
     );

     return db.query(
       `SELECT * FROM session_shares WHERE session_id = ? AND shared_with_email = ?`,
       [sessionId, normalizedEmail]
     )[0];
   }

   export function removeSessionShare(sessionId: string, email: string): boolean {
     const normalizedEmail = normalizeEmail(email);
     const result = db.run(
       `DELETE FROM session_shares WHERE session_id = ? AND shared_with_email = ?`,
       [sessionId, normalizedEmail]
     );
     return result.changes > 0;
   }

   export function getSessionsSharedWithUser(userId: string, email: string): Session[] {
     const normalizedEmail = normalizeEmail(email);
     return db.query(
       `SELECT s.* FROM sessions s
        INNER JOIN session_shares ss ON s.id = ss.session_id
        WHERE ss.shared_with_user_id = ? OR ss.shared_with_email = ?
        ORDER BY s.created_at DESC`,
       [userId, normalizedEmail]
     );
   }

   export function cacheUserIdForShare(sessionId: string, email: string, userId: string): void {
     const normalizedEmail = normalizeEmail(email);
     db.run(
       `UPDATE session_shares SET shared_with_user_id = ?
        WHERE session_id = ? AND shared_with_email = ?`,
       [userId, sessionId, normalizedEmail]
     );
   }
   ```

2. Add API routes:
   ```typescript
   // src/server.ts

   // GET /api/sessions/:id/shares - list shares
   if (method === 'GET' && sharesMatch) {
     const sessionId = sharesMatch[1];
     const session = await getSession(sessionId);
     if (!session) return new Response('Not found', { status: 404 });

     const auth = await extractAuth(req);
     const access = await canAccessSession(session, auth, { requireOwner: true });
     if (!access.allowed) {
       return new Response('Forbidden', { status: 403 });
     }

     const shares = getSessionShares(sessionId);
     return Response.json({ shares: shares.map(s => ({
       email: s.shared_with_email,
       created_at: s.created_at,
     })) });
   }

   // POST /api/sessions/:id/shares - add share
   if (method === 'POST' && sharesMatch) {
     const sessionId = sharesMatch[1];
     const session = await getSession(sessionId);
     if (!session) return new Response('Not found', { status: 404 });

     const auth = await extractAuth(req);
     const access = await canAccessSession(session, auth, { requireOwner: true });
     if (!access.allowed) {
       return new Response('Forbidden', { status: 403 });
     }

     const { email } = await req.json();
     if (!email || !isValidEmail(email)) {
       return new Response('Invalid email', { status: 400 });
     }

     const share = addSessionShare(sessionId, email, auth.userId);

     // Queue email notification (handled in C1)
     await queueShareNotification(session, email, auth.userId);

     return Response.json({
       email: share.shared_with_email,
       created_at: share.created_at,
     });
   }

   // DELETE /api/sessions/:id/shares/:email - remove share
   if (method === 'DELETE' && shareEmailMatch) {
     const sessionId = shareEmailMatch[1];
     const email = decodeURIComponent(shareEmailMatch[2]);

     const session = await getSession(sessionId);
     if (!session) return new Response('Not found', { status: 404 });

     const auth = await extractAuth(req);
     const access = await canAccessSession(session, auth, { requireOwner: true });
     if (!access.allowed) {
       return new Response('Forbidden', { status: 403 });
     }

     const removed = removeSessionShare(sessionId, email);
     if (!removed) {
       return new Response('Share not found', { status: 404 });
     }

     return new Response(null, { status: 204 });
   }
   ```

3. Add route matching patterns:
   ```typescript
   const sharesMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/shares$/);
   const shareEmailMatch = pathname.match(/^\/api\/sessions\/([^\/]+)\/shares\/(.+)$/);
   ```

**Output:** CRUD API for session shares working

---

### A3. Access Control Update

**Prereqs:** A1, A2

**Tasks:**
1. Update `canAccessSession` to check shares:
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

     // Check user-to-user shares
     if (auth.userId) {
       const userEmail = await getUserEmail(auth.userId);
       const hasShare = checkUserHasShare(session.id, auth.userId, userEmail);

       if (hasShare) {
         // Cache user_id for faster future lookups
         cacheUserIdForShare(session.id, userEmail, auth.userId);
         return { allowed: true, isOwner: false };
       }
     }

     // No access
     return { allowed: false, isOwner: false };
   }

   function checkUserHasShare(sessionId: string, userId: string, email: string): boolean {
     const normalizedEmail = normalizeEmail(email);
     const result = db.query(
       `SELECT 1 FROM session_shares
        WHERE session_id = ? AND (shared_with_user_id = ? OR shared_with_email = ?)`,
       [sessionId, userId, normalizedEmail]
     );
     return result.length > 0;
   }
   ```

2. Add helper to get user email from Clerk:
   ```typescript
   // src/lib/clerk.ts
   import { clerkClient } from '@clerk/backend';

   const emailCache = new Map<string, { email: string; expires: number }>();

   export async function getUserEmail(userId: string): Promise<string | null> {
     // Check cache (5 min TTL)
     const cached = emailCache.get(userId);
     if (cached && cached.expires > Date.now()) {
       return cached.email;
     }

     try {
       const user = await clerkClient.users.getUser(userId);
       const email = user.primaryEmailAddress?.emailAddress || null;

       if (email) {
         emailCache.set(userId, {
           email: normalizeEmail(email),
           expires: Date.now() + 5 * 60 * 1000,
         });
       }

       return email ? normalizeEmail(email) : null;
     } catch {
       return null;
     }
   }
   ```

**Output:** Access control respects user-to-user shares

---

## Track B: UI

### B1. Share Modal Enhancement

**Prereqs:** Phase 1 complete (basic share modal exists)

**Tasks:**
1. Create share modal component with people section:
   ```tsx
   // src/client/components/share-modal.tsx

   interface ShareModalProps {
     sessionId: string;
     isOpen: boolean;
     onClose: () => void;
   }

   export function ShareModal({ sessionId, isOpen, onClose }: ShareModalProps) {
     const [shares, setShares] = useState<Share[]>([]);
     const [email, setEmail] = useState('');
     const [loading, setLoading] = useState(false);
     const [error, setError] = useState<string | null>(null);

     useEffect(() => {
       if (isOpen) {
         loadShares();
       }
     }, [isOpen, sessionId]);

     async function loadShares() {
       const res = await fetch(`/api/sessions/${sessionId}/shares`);
       const data = await res.json();
       setShares(data.shares);
     }

     async function addShare(e: React.FormEvent) {
       e.preventDefault();
       if (!email.trim()) return;

       setLoading(true);
       setError(null);

       try {
         const res = await fetch(`/api/sessions/${sessionId}/shares`, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ email: email.trim() }),
         });

         if (!res.ok) {
           throw new Error(await res.text());
         }

         setEmail('');
         await loadShares();
       } catch (err) {
         setError(err.message);
       } finally {
         setLoading(false);
       }
     }

     async function removeShare(emailToRemove: string) {
       await fetch(`/api/sessions/${sessionId}/shares/${encodeURIComponent(emailToRemove)}`, {
         method: 'DELETE',
       });
       await loadShares();
     }

     if (!isOpen) return null;

     return (
       <Modal onClose={onClose}>
         <h2>Share Session</h2>

         {/* Public link section (existing) */}
         <section>
           <h3>Public Link</h3>
           <PublicLinkToggle sessionId={sessionId} />
         </section>

         {/* Share with people section (new) */}
         <section>
           <h3>Share with People</h3>
           <p className="text-sm text-gray-500">
             People you share with must sign in to view this session.
           </p>

           <form onSubmit={addShare} className="flex gap-2 mt-3">
             <input
               type="email"
               value={email}
               onChange={(e) => setEmail(e.target.value)}
               placeholder="Enter email address"
               className="flex-1 px-3 py-2 border rounded"
             />
             <button
               type="submit"
               disabled={loading || !email.trim()}
               className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
             >
               Add
             </button>
           </form>

           {error && <p className="text-red-500 text-sm mt-2">{error}</p>}

           {shares.length > 0 && (
             <ul className="mt-4 space-y-2">
               {shares.map((share) => (
                 <li key={share.email} className="flex items-center justify-between">
                   <span>{share.email}</span>
                   <button
                     onClick={() => removeShare(share.email)}
                     className="text-red-500 hover:text-red-700"
                   >
                     Remove
                   </button>
                 </li>
               ))}
             </ul>
           )}
         </section>
       </Modal>
     );
   }
   ```

2. Add validation feedback:
   - Email format validation (client-side)
   - "Share added" confirmation
   - "Already shared" message (handle duplicate gracefully)
   - Loading states for add/remove

**Output:** Enhanced share modal with email sharing

---

### B2. Shared With Me View

**Prereqs:** A2 (API endpoints)

**Tasks:**
1. Add "Shared with me" API endpoint:
   ```typescript
   // src/server.ts

   // GET /api/sessions/shared-with-me
   if (method === 'GET' && pathname === '/api/sessions/shared-with-me') {
     const auth = await extractAuth(req);
     if (!auth.userId) {
       return new Response('Unauthorized', { status: 401 });
     }

     const userEmail = await getUserEmail(auth.userId);
     if (!userEmail) {
       return Response.json({ sessions: [] });
     }

     const sessions = getSessionsSharedWithUser(auth.userId, userEmail);

     // Enrich with sharer info
     const enriched = await Promise.all(sessions.map(async (session) => {
       const shares = getSessionShares(session.id);
       const sharer = shares.find(s => s.shared_with_email === normalizeEmail(userEmail));
       return {
         ...session,
         shared_by: sharer ? await getSharerInfo(sharer.shared_by_user_id) : null,
       };
     }));

     return Response.json({ sessions: enriched });
   }
   ```

2. Add filter/tab to sessions list:
   ```tsx
   // src/client/pages/sessions.tsx

   type Filter = 'my-sessions' | 'shared-with-me';

   export function SessionsPage() {
     const [filter, setFilter] = useState<Filter>('my-sessions');
     const [sessions, setSessions] = useState<Session[]>([]);

     useEffect(() => {
       loadSessions();
     }, [filter]);

     async function loadSessions() {
       const endpoint = filter === 'shared-with-me'
         ? '/api/sessions/shared-with-me'
         : '/api/sessions';
       const res = await fetch(endpoint);
       const data = await res.json();
       setSessions(data.sessions);
     }

     return (
       <div>
         <div className="flex gap-2 mb-4">
           <button
             onClick={() => setFilter('my-sessions')}
             className={filter === 'my-sessions' ? 'font-bold' : ''}
           >
             My Sessions
           </button>
           <button
             onClick={() => setFilter('shared-with-me')}
             className={filter === 'shared-with-me' ? 'font-bold' : ''}
           >
             Shared with Me
           </button>
         </div>

         <SessionList sessions={sessions} showSharedBy={filter === 'shared-with-me'} />
       </div>
     );
   }
   ```

3. Show "Shared by X" indicator on session cards:
   ```tsx
   // In session card
   {session.shared_by && (
     <span className="text-sm text-gray-500">
       Shared by {session.shared_by.name || session.shared_by.email}
     </span>
   )}
   ```

**Output:** "Shared with me" tab in sessions list

---

### B3. Access Denied Page

**Prereqs:** None

**Tasks:**
1. Create access denied component:
   ```tsx
   // src/client/pages/access-denied.tsx

   export function AccessDeniedPage() {
     const { isSignedIn } = useAuth();

     return (
       <div className="flex flex-col items-center justify-center min-h-[400px]">
         <h1 className="text-2xl font-bold mb-4">Access Denied</h1>

         {isSignedIn ? (
           <>
             <p className="text-gray-600 mb-6">
               You don't have access to this session.
             </p>
             <p className="text-sm text-gray-500">
               The session owner needs to share it with your email address.
             </p>
           </>
         ) : (
           <>
             <p className="text-gray-600 mb-6">
               Sign in to see if you have access to this session.
             </p>
             <SignInButton>
               <button className="px-4 py-2 bg-blue-500 text-white rounded">
                 Sign In
               </button>
             </SignInButton>
           </>
         )}

         <Link href="/sessions" className="mt-8 text-blue-500 hover:underline">
           Go to your sessions
         </Link>
       </div>
     );
   }
   ```

2. Handle 403 responses in session detail page:
   ```tsx
   // src/client/pages/session-detail.tsx

   export function SessionDetailPage({ sessionId }) {
     const [session, setSession] = useState(null);
     const [error, setError] = useState<number | null>(null);

     useEffect(() => {
       fetch(`/api/sessions/${sessionId}`)
         .then(res => {
           if (res.status === 403) {
             setError(403);
             return null;
           }
           if (res.status === 404) {
             setError(404);
             return null;
           }
           return res.json();
         })
         .then(data => data && setSession(data));
     }, [sessionId]);

     if (error === 403) return <AccessDeniedPage />;
     if (error === 404) return <NotFoundPage />;
     if (!session) return <Loading />;

     return <SessionViewer session={session} />;
   }
   ```

**Output:** Clean error experience for unauthorized access

---

## Sequential: After Tracks A+B

### C1. Email Notifications

**Prereqs:** A2 (sharing API working)

**Tasks:**
1. Choose email provider (recommendations):
   - **Resend** - Simple API, good DX, generous free tier
   - **Postmark** - Reliable delivery, transactional focus
   - **SendGrid** - Most common, more complex

   For simplicity, use Resend initially:
   ```sh
   bun add resend
   ```

2. Create email service:
   ```typescript
   // src/lib/email.ts
   import { Resend } from 'resend';

   const resend = new Resend(process.env.RESEND_API_KEY);

   interface ShareNotificationParams {
     recipientEmail: string;
     sharerName: string;
     sessionTitle: string;
     sessionUrl: string;
   }

   export async function sendShareNotification({
     recipientEmail,
     sharerName,
     sessionTitle,
     sessionUrl,
   }: ShareNotificationParams) {
     await resend.emails.send({
       from: 'openctl <notifications@openctl.dev>',
       to: recipientEmail,
       subject: `${sharerName} shared a session with you`,
       text: `
${sharerName} shared a coding session with you.

Session: ${sessionTitle}
View it here: ${sessionUrl}

Sign in with your Google account to view the session.

---
You received this email because someone shared an openctl session with you.
       `.trim(),
     });
   }
   ```

3. Queue notification when share is added:
   ```typescript
   // src/server.ts (in POST /api/sessions/:id/shares handler)

   // After addSessionShare()
   const sharerInfo = await getUserInfo(auth.userId);
   const sessionUrl = `${process.env.APP_URL}/sessions/${sessionId}`;

   // Fire and forget (don't block response)
   sendShareNotification({
     recipientEmail: normalizeEmail(email),
     sharerName: sharerInfo.name || sharerInfo.email,
     sessionTitle: session.title,
     sessionUrl,
   }).catch(err => {
     console.error('Failed to send share notification:', err);
   });
   ```

4. Set up environment variables:
   ```
   RESEND_API_KEY=re_...
   APP_URL=https://openctl.dev
   ```

**Output:** Email notifications sent when sessions are shared

---

## Testing Checklist

### API
- [ ] `GET /api/sessions/:id/shares` returns shares (owner only)
- [ ] `POST /api/sessions/:id/shares` adds share
- [ ] `POST /api/sessions/:id/shares` normalizes email to lowercase
- [ ] `POST /api/sessions/:id/shares` is idempotent (no error on duplicate)
- [ ] `DELETE /api/sessions/:id/shares/:email` removes share
- [ ] Non-owner gets 403 on share endpoints

### Access Control
- [ ] Owner can access their sessions
- [ ] User in share list can access session
- [ ] User NOT in share list gets 403
- [ ] user_id cached on first access
- [ ] Case variations of email work (User@Gmail.com = user@gmail.com)

### UI
- [ ] Share modal shows "Share with People" section
- [ ] Can add email to share list
- [ ] Can remove email from share list
- [ ] "Shared with me" tab shows sessions shared with user
- [ ] "Shared by X" indicator shown on shared sessions
- [ ] Access denied page shown for 403

### Email
- [ ] Email sent when session shared
- [ ] Email contains correct session title and link
- [ ] Email from address configured correctly
- [ ] Link in email goes to session (requires sign-in)

---

## Rollout Plan

1. **Deploy database migration** (A1) - backwards compatible
2. **Deploy API endpoints** (A2, A3) - protected by owner check
3. **Deploy UI updates** (B1-B3) - feature behind flag initially
4. **Configure email provider** - test with internal emails
5. **Enable email notifications** (C1) - monitor delivery
6. **Remove feature flag** - full launch
