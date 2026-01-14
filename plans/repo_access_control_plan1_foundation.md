# Plan 1: Foundation - Client ID & Config Infrastructure

**Spec**: `specs/repo_access_control.md`

## Goal

Establish the foundational infrastructure for client identification and extended config schema.

## Files to Create/Modify

### 1. `cli/lib/client-id.ts` (new file)

- `getClientId()` - returns UUID, generates on first use
- Store at `~/.archive/client-id` with chmod 600
- Use `crypto.randomUUID()` for generation

### 2. `cli/lib/config.ts` (modify)

Extend `Config` interface:
```typescript
interface ServerConfig {
  allowedRepos: string[];
}
interface Config {
  server?: string;
  db?: string;
  autoOpen?: boolean;
  servers?: Record<string, ServerConfig>;
}
```

Add helper functions:
- `getAllowedRepos(serverUrl: string): string[]`
- `addAllowedRepo(serverUrl: string, repoId: string): void`
- `removeAllowedRepo(serverUrl: string, repoId: string): boolean`
- `isRepoAllowed(serverUrl: string, repoId: string): boolean`
- `getAllServersWithRepos(): Record<string, string[]>`

### 3. `cli/lib/git.ts` (modify)

Add git remote URL resolution and normalization:
- `getRepoIdentifier(projectPath: string): Promise<string | null>`
- `getGitRemoteUrl(projectPath: string): Promise<string | null>`
- `getGitRootPath(projectPath: string): Promise<string | null>`
- `normalizeRemoteUrl(remoteUrl: string): string`

Normalization rules:
- `git@github.com:org/repo.git` → `github.com/org/repo`
- `https://github.com/org/repo.git` → `github.com/org/repo`
- Strip `.git`, lowercase hostname

## Verification

```bash
# Test client ID generation
bun run cli/index.ts config get server  # Should create ~/.archive/client-id as side effect
cat ~/.archive/client-id  # Should show UUID
ls -la ~/.archive/client-id  # Should show -rw------- permissions
```
