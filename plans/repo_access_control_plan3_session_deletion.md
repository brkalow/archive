# Plan 3: Session Deletion & Client ID Integration

**Spec**: `specs/repo_access_control.md`
**Depends on**: Plan 1 (Foundation)

## Goal

Enable session deletion with client-based ownership.

## Files to Create/Modify

### 1. `src/db/schema.ts` (modify)

- Add migration for `client_id` column:
  ```typescript
  safeAddColumn(db, "sessions", "client_id", "TEXT");
  ```
- Add index: `CREATE INDEX IF NOT EXISTS idx_sessions_client_id ON sessions(client_id)`
- Update `Session` type to include `client_id: string | null`

### 2. `src/db/repository.ts` (modify)

- Update `createSession` INSERT to include `client_id`
- Update `createSessionWithData` and `createSessionWithDataAndReview` to accept `clientId` parameter
- Add method: `getSessionsByClientId(clientId: string): Session[]`

### 3. `src/routes/api.ts` (modify)

- Add helper: `getClientId(req: Request): string | null` (reads `X-Archive-Client-ID` header)
- Update `createSession()`: extract client ID, pass to repository
- Update `createLiveSession()`: extract client ID, pass to repository
- Update `deleteSession()`:
  ```typescript
  const clientId = getClientId(req);
  const session = repo.getSession(sessionId);
  if (!session) return jsonError("Session not found", 404);
  // Legacy sessions (no client_id) can be deleted by anyone
  if (session.client_id && session.client_id !== clientId) {
    return jsonError("Permission denied", 403);
  }
  ```
- Update `getSessions()`: support `?mine=true` query param to filter by client ID

### 4. `cli/commands/upload.ts` (modify)

- Import `getClientId` from `../lib/client-id`
- Add header to upload fetch: `"X-Archive-Client-ID": getClientId()`

### 5. `cli/daemon/api-client.ts` (modify)

- Import `getClientId` from `../lib/client-id`
- Store client ID in constructor
- Add `X-Archive-Client-ID` header to all API requests

### 6. `cli/commands/session.ts` (new file)

Subcommands: `list`, `delete`

**`archive session list`**:
- Fetch from `/api/sessions` with client ID header
- Support `--mine`, `--project`, `--limit`, `--json`, `--server` flags

**`archive session delete <id>`**:
- Prompt for confirmation (unless `--force`)
- DELETE to `/api/sessions/:id` with client ID header
- Handle 403 (permission denied) and 404 (not found) errors

### 7. `cli/index.ts` (modify)

- Import and register `session` command
- Add `list` as alias: `list: (args) => session(["list", ...args])`
- Update help text

## Verification

```bash
# Test session commands
bun run cli/index.ts session list
bun run cli/index.ts session list --mine
bun run cli/index.ts list  # Alias should work

# Test upload includes client ID
bun run cli/index.ts upload --session test.jsonl
# Check server logs or DB for client_id

# Test deletion
bun run cli/index.ts session delete <session-id>
# Should prompt for confirmation
# Should succeed for own sessions, fail for others
```
