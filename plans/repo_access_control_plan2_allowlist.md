# Plan 2: Repository Access Control

**Spec**: `specs/repo_access_control.md`
**Depends on**: Plan 1 (Foundation)

## Goal

Implement the daemon allowlist feature with CLI commands.

## Files to Create/Modify

### 1. `cli/commands/repo.ts` (new file)

Subcommands: `allow`, `deny`, `list`

**`archive repo allow [path]`**:
- Default path: current directory
- Resolve git remote URL via `getRepoIdentifier()`
- Add to allowlist via `addAllowedRepo()`
- Support `--server` flag

**`archive repo deny [path]`**:
- Remove from allowlist via `removeAllowedRepo()`
- Support `--server` and `--all` flags

**`archive repo list`**:
- Display allowed repos for current server
- Support `--server` and `--all` flags

### 2. `cli/index.ts` (modify)

- Import and register `repo` command
- Update help text

### 3. `cli/daemon/session-tracker.ts` (modify)

- Add `private serverUrl: string` property to class
- In constructor, store: `this.serverUrl = serverUrl`
- In `startSession()`, after `getSessionInfo()` and before `createLiveSession()`:
  ```typescript
  const repoId = await getRepoIdentifier(sessionInfo.projectPath);
  if (!repoId || !isRepoAllowed(this.serverUrl, repoId)) {
    console.log(`Session skipped: Repository not in allowlist`);
    console.log(`  Path: ${sessionInfo.projectPath}`);
    console.log(`  Repo: ${repoId || '(not a git repo)'}`);
    console.log(`\nTo allow this repository, run:`);
    console.log(`  archive repo allow ${sessionInfo.projectPath}`);
    return;
  }
  ```

### 4. `cli/daemon/index.ts` (modify)

After adapter initialization, show first-run message if allowlist empty:
```
No repositories allowed for automatic upload.
The daemon only uploads sessions from explicitly allowed repositories.
To allow a repository: archive repo allow /path/to/repo
```

## Verification

```bash
# Test repo commands
cd /path/to/test/repo
bun run cli/index.ts repo allow
bun run cli/index.ts repo list
cat ~/.archive/config.json  # Should show allowedRepos

# Test daemon behavior
bun run cli/index.ts daemon start --verbose
# Create a session in allowed repo - should upload
# Create a session in non-allowed repo - should skip with message
```
