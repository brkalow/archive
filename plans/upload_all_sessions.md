# Implementation Plan: Upload All Sessions for Project

## Spec Reference
[specs/upload_all_sessions.md](../specs/upload_all_sessions.md)

## Overview

Add `--all` flag to `openctl upload` that uploads all Claude Code sessions for a project in a single command. This enables bulk import of session history with deduplication, filtering, and progress reporting.

## Dependencies

This feature builds on existing infrastructure:
- Upload command (`cli/commands/upload.ts`) - well-factored functions for session extraction and upload
- Shared sessions library (`cli/lib/shared-sessions.ts`) - session discovery, path encoding/decoding
- API endpoint (`GET /api/sessions?claude_session_id=<uuid>`) - deduplication check

## Implementation Phases

### Phase 0: Enable Branch Field in Upload API

The session JSONL contains a `gitBranch` field that we want to preserve. The database already supports a `branch` column, but the API doesn't accept it. Add support for the branch field.

**File:** `src/lib/validation.ts` (modify)

Add `branch` to the form schema:

```typescript
export const CreateSessionFormSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  claude_session_id: z.string().optional(),
  pr_url: optionalUrlString,
  project_path: z.string().optional(),
  model: z.string().optional(),
  harness: z.string().optional(),
  repo_url: z.string().optional(),
  branch: z.string().optional(),  // Add this line
});
```

**File:** `src/routes/api.ts` (modify)

Use the validated branch field instead of hardcoded null:

```typescript
// In createSession(), change:
branch: null,
// To:
branch: validated.branch || null,
```

**File:** `cli/commands/upload.ts` (modify)

Update `UploadOptions` interface and `uploadSession()` to include branch:

```typescript
interface UploadOptions {
  // ... existing fields ...
  branch: string | null;  // Add this
}

async function uploadSession(options: UploadOptions): Promise<void> {
  // ... existing code ...

  if (options.branch) {
    formData.append("branch", options.branch);
  }

  // ... rest of function ...
}
```

Update the caller in `upload()` to pass the branch:

```typescript
await uploadSession({
  // ... existing fields ...
  branch: gitBranch,  // Already extracted via extractGitBranch()
});
```

---

### Phase 1: Session Discovery for Project

**File:** `cli/lib/shared-sessions.ts` (modify)

First, export the existing `encodeProjectPath()` function (currently private at line 254):

```typescript
// Change from:
function encodeProjectPath(projectPath: string): string {
// To:
export function encodeProjectPath(projectPath: string): string {
```

Then add a new function to list all sessions for a specific project directory.

```typescript
/**
 * List all sessions for a specific project path.
 * Returns sessions sorted by modification time (oldest first for chronological upload).
 */
export async function listSessionsForProject(
  projectPath: string,
  options?: { since?: Date }
): Promise<LocalSessionInfo[]> {
  const home = Bun.env.HOME;
  if (!home) return [];

  const projectsDir = join(home, ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  // Encode project path to Claude's format
  const encodedPath = encodeProjectPath(projectPath);
  const sessionDir = join(projectsDir, encodedPath);

  if (!existsSync(sessionDir)) {
    return [];
  }

  const sessions: LocalSessionInfo[] = [];

  // Use existing collectSessions but only for this project directory
  await collectSessionsInDir(sessionDir, sessions, projectPath);

  // Apply date filter if specified
  let filtered = sessions;
  if (options?.since) {
    filtered = sessions.filter(s => s.modifiedAt >= options.since!);
  }

  // Sort by modification time (oldest first for chronological upload)
  filtered.sort((a, b) => a.modifiedAt.getTime() - b.modifiedAt.getTime());

  return filtered;
}

/**
 * Collect sessions from a single project directory (non-recursive into subprojects).
 */
async function collectSessionsInDir(
  dir: string,
  sessions: LocalSessionInfo[],
  projectPath: string
): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const projectName = projectPath.split("/").pop() || projectPath;

    for (const entry of entries) {
      // Skip directories entirely (including subagents/)
      if (entry.isDirectory()) continue;

      if (entry.name.endsWith(".jsonl")) {
        const fullPath = join(dir, entry.name);
        try {
          const fileStat = await stat(fullPath);
          const uuid = entry.name.replace(".jsonl", "");
          const titlePreview = await extractTitlePreview(fullPath);

          sessions.push({
            uuid,
            filePath: fullPath,
            projectPath,
            projectName,
            modifiedAt: fileStat.mtime,
            titlePreview,
          });
        } catch {
          // Skip files we can't read
        }
      }
    }
  } catch {
    // Ignore directory read errors
  }
}
```

Implementation notes:
- Exports and reuses existing `encodeProjectPath()` function (line 254)
- `collectSessionsInDir()` is intentionally separate from the existing `collectSessions()` because:
  - It's non-recursive (only scans one project directory)
  - It takes an explicit `projectPath` parameter instead of deriving it from the file path
  - The existing `collectSessions()` recurses into all projects; this one is project-specific
- Skips `subagents/` and all subdirectories
- Sorts oldest-first for chronological upload order
- Reuses the existing private `extractTitlePreview()` helper (no export needed since `collectSessionsInDir` is in the same file)

---

### Phase 2: Deduplication Check

**File:** `cli/commands/upload.ts` (modify)

Add a function to check if a session already exists on the server.

**Note:** The `GET /api/sessions?claude_session_id=<uuid>` endpoint requires authentication and verifies ownership. The function must pass the auth token, and will only find sessions owned by the authenticated user.

```typescript
/**
 * Check if a session already exists on the server by its Claude session ID.
 * Returns the server session URL if it exists, null otherwise.
 *
 * Note: Requires authentication. Only finds sessions owned by the authenticated user.
 */
async function checkSessionExists(
  claudeSessionId: string,
  serverUrl: string,
  authToken: string | null
): Promise<{ exists: boolean; url?: string }> {
  const headers: Record<string, string> = {
    "X-Openctl-Client-ID": getClientId(),
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  try {
    const response = await fetch(
      `${serverUrl}/api/sessions?claude_session_id=${encodeURIComponent(claudeSessionId)}`,
      { headers }
    );

    if (!response.ok) {
      // Treat errors as "not found" to allow upload attempt
      return { exists: false };
    }

    const data = await response.json();
    if (data.session?.id) {
      const baseUrl = serverUrl.replace(/\/$/, "");
      return { exists: true, url: `${baseUrl}/sessions/${data.session.id}` };
    }

    return { exists: false };
  } catch {
    // Network errors: assume session doesn't exist, upload will fail if server is down
    return { exists: false };
  }
}
```

---

### Phase 3: Update parseArgs and Add New Flags

**File:** `cli/commands/upload.ts` (modify)

Update the `ParsedOptions` interface and `parseArgs` function to support new flags.

```typescript
interface ParsedOptions {
  session?: string;
  title?: string;
  model?: string;
  harness: string;
  repo?: string;
  diff: boolean;
  review: boolean;
  server: string;
  yes: boolean;
  help: boolean;
  list: boolean;
  // New flags for --all
  all: boolean;
  project?: string;
  since?: string;
  skipExisting: boolean;
  dryRun: boolean;
}

function parseArgs(args: string[]): ParsedOptions {
  const options: ParsedOptions = {
    harness: "Claude Code",
    diff: true,
    review: false,
    server: getServerUrl(),
    yes: false,
    help: false,
    list: false,
    all: false,
    skipExisting: true,  // Default to skipping existing
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      // ... existing cases ...

      case "--all":
      case "-a":
        options.all = true;
        break;
      case "--project":
      case "-p":
        options.project = args[++i];
        break;
      case "--since":
        options.since = args[++i];
        break;
      case "--skip-existing":
        options.skipExisting = true;
        break;
      case "--no-skip-existing":
        options.skipExisting = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
    }
  }

  return options;
}
```

---

### Phase 4: Implement uploadAll Function

**File:** `cli/commands/upload.ts` (modify)

Add the main bulk upload orchestration function.

```typescript
interface BulkUploadResult {
  uploaded: number;
  skipped: number;
  failed: number;
  failures: Array<{ uuid: string; title: string; error: string }>;
}

async function uploadAll(options: ParsedOptions): Promise<void> {
  // Validate mutual exclusivity
  if (options.review) {
    console.error("Error: --review cannot be used with --all (too slow for bulk uploads)");
    process.exit(1);
  }
  if (options.list) {
    console.error("Error: --list cannot be used with --all");
    process.exit(1);
  }
  if (options.session) {
    console.error("Error: Session argument cannot be used with --all");
    process.exit(1);
  }

  // Determine project path
  const projectPath = options.project || process.cwd();
  if (options.project && !existsSync(options.project)) {
    console.error(`Error: Project path does not exist: ${options.project}`);
    process.exit(1);
  }

  // Parse --since date
  let sinceDate: Date | undefined;
  if (options.since) {
    sinceDate = new Date(options.since);
    if (isNaN(sinceDate.getTime())) {
      console.error(`Error: Invalid date format for --since: ${options.since}`);
      process.exit(1);
    }
  }

  console.log(`Scanning sessions for ${projectPath}...`);

  // Discover sessions
  const sessions = await listSessionsForProject(projectPath, { since: sinceDate });

  if (sessions.length === 0) {
    console.log("No sessions found for this project.");
    return;
  }

  // Get auth token
  const authToken = await getAccessTokenIfAuthenticated(options.server);

  // Check which sessions already exist (if skip-existing is enabled)
  console.log("Checking for existing sessions...");

  const sessionsToUpload: LocalSessionInfo[] = [];
  const existingSessions: Array<{ session: LocalSessionInfo; url: string }> = [];

  for (const session of sessions) {
    if (options.skipExisting) {
      const check = await checkSessionExists(session.uuid, options.server, authToken);
      if (check.exists) {
        existingSessions.push({ session, url: check.url! });
        continue;
      }
    }
    sessionsToUpload.push(session);
  }

  // Display summary
  console.log(`\nFound ${sessions.length} sessions (${sessionsToUpload.length} new, ${existingSessions.length} already uploaded)`);

  if (sessionsToUpload.length === 0) {
    console.log("\nNo new sessions to upload.");
    return;
  }

  // Display sessions to upload
  console.log("\nSessions to upload:");
  for (const session of sessionsToUpload) {
    const timeAgo = formatRelativeTime(session.modifiedAt);
    console.log(`  - ${session.titlePreview} (${session.uuid.slice(0, 8)}) - ${timeAgo}`);
  }

  // Dry run exits here
  if (options.dryRun) {
    console.log("\n[Dry run] No sessions were uploaded.");
    return;
  }

  // Prompt for confirmation (unless --yes)
  if (!options.yes) {
    console.log();
    const confirmed = await promptConfirmation(
      `Upload ${sessionsToUpload.length} sessions? [y/N] `
    );
    if (!confirmed) {
      console.log("Upload cancelled.");
      return;
    }
  }

  // Upload sessions with progress reporting
  console.log("\nUploading sessions:");

  const result: BulkUploadResult = {
    uploaded: 0,
    skipped: existingSessions.length,
    failed: 0,
    failures: [],
  };

  for (let i = 0; i < sessionsToUpload.length; i++) {
    const session = sessionsToUpload[i]!;
    const progress = `[${i + 1}/${sessionsToUpload.length}]`;

    try {
      await uploadSessionForBulk(session, options, authToken);
      console.log(`  ${progress} ${session.titlePreview} (${session.uuid.slice(0, 8)}) ✓`);
      result.uploaded++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`  ${progress} ${session.titlePreview} (${session.uuid.slice(0, 8)}) ✗`);
      result.failures.push({
        uuid: session.uuid,
        title: session.titlePreview,
        error: errorMsg,
      });
      result.failed++;
    }

    // Small delay between uploads to avoid overwhelming the server
    if (i < sessionsToUpload.length - 1) {
      await Bun.sleep(100);
    }
  }

  // Final summary
  console.log();
  console.log(`Done. Uploaded ${result.uploaded} sessions, skipped ${result.skipped} (already uploaded)${result.failed > 0 ? `, ${result.failed} failed` : ""}.`);

  if (result.failures.length > 0) {
    console.log("\nFailed:");
    for (const failure of result.failures) {
      console.log(`  - ${failure.uuid.slice(0, 8)}: ${failure.error}`);
    }
  }
}
```

---

### Phase 5: Add Bulk Session Upload Helper

**File:** `cli/commands/upload.ts` (modify)

Add a helper function for uploading sessions in bulk mode (without diffs).

```typescript
/**
 * Upload a single session for bulk upload mode.
 * Throws on failure.
 *
 * Note: Diffs are skipped entirely in bulk mode because:
 * - Historical session branches may no longer exist
 * - Current working tree doesn't reflect code state during those sessions
 * - Session content is the primary value; diffs can be added later via single upload
 */
async function uploadSessionForBulk(
  session: LocalSessionInfo,
  options: ParsedOptions,
  authToken: string | null
): Promise<void> {
  const sessionPath = session.filePath;
  const sessionContent = await Bun.file(sessionPath).text();

  // Validate session has messages
  const messageCount = countMessages(sessionContent);
  if (messageCount === 0) {
    throw new Error("Session has no messages (only metadata)");
  }

  // Extract metadata
  const title = extractTitle(sessionContent);
  const model = options.model || extractModel(sessionContent);
  const branch = extractGitBranch(sessionContent);  // Preserve branch metadata

  // Get repo URL
  const repoUrl = options.repo || (await getRepoUrl(session.projectPath));

  // Upload without diff (historical diffs would be inaccurate)
  await uploadSession({
    sessionPath,
    title,
    model,
    harness: options.harness,
    repoUrl,
    diffContent: null,
    serverUrl: options.server,
    review: null,
    projectPath: session.projectPath,
    authToken,
    branch,  // Include branch for historical context
  });
}
```

---

### Phase 6: Update Main upload() Function

**File:** `cli/commands/upload.ts` (modify)

Update the main entry point to route to bulk upload when `--all` is specified.

```typescript
export async function upload(args: string[]): Promise<void> {
  const options = parseArgs(args);

  if (options.help) {
    showHelp();
    return;
  }

  // Route to bulk upload if --all specified
  if (options.all) {
    return uploadAll(options);
  }

  // ... existing single-upload logic ...
}
```

---

### Phase 7: Update Help Text

**File:** `cli/commands/upload.ts` (modify)

Update `showHelp()` to document new flags.

```typescript
function showHelp(): void {
  console.log(`
Upload Claude Code sessions to the server.

Usage:
  openctl upload [options]
  openctl upload --all [options]

Options:
  -s, --session     Session UUID or path to JSONL file (default: auto-detect current session)
  -l, --list        Interactively select from recent sessions
  -t, --title       Session title (default: derived from first user message)
  -m, --model       Model used (default: auto-detect from session)
  --harness         Harness/client used (default: "Claude Code")
  --repo            GitHub repository URL (default: auto-detect from git remote)
  -d, --diff        Include git diff (default: true)
  --no-diff         Exclude git diff
  -r, --review      Generate code review using Claude CLI (requires diff)
  --server          Server URL (default: from config or ${DEFAULT_SERVER})
  -y, --yes         Skip confirmation prompts
  -h, --help        Show this help

Bulk Upload Options:
  -a, --all           Upload all sessions for a project (diffs skipped)
  -p, --project       Project path (default: current directory)
  --since <date>      Only upload sessions modified after date (e.g., 2025-01-01)
  --skip-existing     Skip sessions already on server (default: true)
  --no-skip-existing  Re-upload sessions even if they exist
  --dry-run           Show what would be uploaded without uploading

Note: Bulk uploads skip git diffs since historical branches may not exist.

Examples:
  openctl upload                   # Upload current/latest session
  openctl upload --list            # Pick from recent sessions
  openctl upload -s abc-123-def    # Upload a specific session
  openctl upload --all             # Upload all sessions for current project
  openctl upload --all -p /path    # Upload all sessions for specified project
  openctl upload --all --since 2025-01-01  # Upload sessions from this year
  openctl upload --all --dry-run   # Preview what would be uploaded
  `);
}
```

---

### Phase 8: Add formatRelativeTime Helper and Imports

**File:** `cli/commands/upload.ts` (modify)

Add the import for the new shared-sessions exports:

```typescript
import { listSessionsForProject, type LocalSessionInfo } from "../lib/shared-sessions";
```

Add a compact relative time formatting helper. Note: `shared-sessions.ts` has a similar function (line 547) but uses verbose format ("2 hours ago"). This version uses compact format ("2h ago") which is better for progress output with many lines:

```typescript
/**
 * Format a relative time string (e.g., "2h ago", "1d ago").
 * Compact format for progress output - intentionally different from
 * shared-sessions.ts formatRelativeTime() which uses verbose format.
 */
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
```

---

### Phase 9: Testing

**File:** `tests/cli/upload-all.test.ts` (new)

**Note:** Some tests below are placeholders (empty test bodies). These should be implemented during development. The `listSessionsForProject` tests have full implementations as examples.

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

describe("Upload All Sessions", () => {
  const testDir = "/tmp/openctl-upload-all-test";
  const claudeDir = join(testDir, ".claude", "projects");

  beforeEach(() => {
    // Set up test directory structure
    mkdirSync(claudeDir, { recursive: true });
    process.env.HOME = testDir;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.HOME;
  });

  describe("listSessionsForProject", () => {
    test("returns empty array when project has no sessions", async () => {
      const { listSessionsForProject } = await import("../../cli/lib/shared-sessions");
      const sessions = await listSessionsForProject("/some/project");
      expect(sessions).toEqual([]);
    });

    test("returns sessions sorted oldest-first", async () => {
      // Create test sessions with different mtimes
      const projectDir = join(claudeDir, "-test-project");
      mkdirSync(projectDir, { recursive: true });

      const session1 = join(projectDir, "uuid-1.jsonl");
      const session2 = join(projectDir, "uuid-2.jsonl");

      writeFileSync(session1, '{"message":{"role":"user","content":"First"}}');
      writeFileSync(session2, '{"message":{"role":"user","content":"Second"}}');

      // Touch session1 to be older
      const { utimesSync } = await import("fs");
      const past = new Date(Date.now() - 86400000); // 1 day ago
      utimesSync(session1, past, past);

      const { listSessionsForProject } = await import("../../cli/lib/shared-sessions");
      const sessions = await listSessionsForProject("/test/project");

      expect(sessions.length).toBe(2);
      expect(sessions[0]?.uuid).toBe("uuid-1"); // Oldest first
      expect(sessions[1]?.uuid).toBe("uuid-2");
    });

    test("filters by --since date", async () => {
      const projectDir = join(claudeDir, "-test-project");
      mkdirSync(projectDir, { recursive: true });

      const session1 = join(projectDir, "uuid-old.jsonl");
      const session2 = join(projectDir, "uuid-new.jsonl");

      writeFileSync(session1, '{"message":{"role":"user","content":"Old"}}');
      writeFileSync(session2, '{"message":{"role":"user","content":"New"}}');

      const { utimesSync } = await import("fs");
      const past = new Date("2024-01-01");
      utimesSync(session1, past, past);

      const { listSessionsForProject } = await import("../../cli/lib/shared-sessions");
      const sessions = await listSessionsForProject("/test/project", {
        since: new Date("2025-01-01"),
      });

      expect(sessions.length).toBe(1);
      expect(sessions[0]?.uuid).toBe("uuid-new");
    });

    test("skips subagents directory", async () => {
      const projectDir = join(claudeDir, "-test-project");
      const subagentsDir = join(projectDir, "subagents");
      mkdirSync(subagentsDir, { recursive: true });

      writeFileSync(join(projectDir, "main.jsonl"), '{"message":{"role":"user","content":"Main"}}');
      writeFileSync(join(subagentsDir, "sub.jsonl"), '{"message":{"role":"user","content":"Sub"}}');

      const { listSessionsForProject } = await import("../../cli/lib/shared-sessions");
      const sessions = await listSessionsForProject("/test/project");

      expect(sessions.length).toBe(1);
      expect(sessions[0]?.uuid).toBe("main");
    });
  });

  describe("checkSessionExists", () => {
    // Mock fetch for these tests
    test("returns exists: false when session not found");
    test("returns exists: true with URL when session found");
    test("returns exists: false on network error");
  });

  describe("parseArgs", () => {
    test("parses --all flag");
    test("parses --project with value");
    test("parses --since with date");
    test("skipExisting defaults to true");
    test("parses --no-skip-existing");
    test("parses --dry-run");
  });

  describe("mutual exclusivity", () => {
    test("--all conflicts with --review");
    test("--all conflicts with --list");
    test("--all conflicts with session argument");
  });
});
```

---

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `src/lib/validation.ts` | Modify | Add `branch` field to `CreateSessionFormSchema` |
| `src/routes/api.ts` | Modify | Use validated branch field instead of hardcoded null |
| `cli/lib/shared-sessions.ts` | Modify | Export `encodeProjectPath()`, add `listSessionsForProject()` and `collectSessionsInDir()` |
| `cli/commands/upload.ts` | Modify | Add `--all` flags, `checkSessionExists()`, `uploadAll()`, `uploadSessionForBulk()`, `formatRelativeTime()`, pass branch, update help |
| `tests/cli/upload-all.test.ts` | Create | Unit tests for bulk upload functionality (some placeholders) |

---

## Acceptance Criteria

From the spec:

- [ ] `openctl upload --all` uploads all sessions for current project
- [ ] `--project` flag allows specifying a different project path
- [ ] `--since` flag filters sessions by modification date
- [ ] Skips already-uploaded sessions by default
- [ ] `--dry-run` shows what would be uploaded
- [ ] Interactive confirmation prompt before uploading (default no)
- [ ] `--all` is mutually exclusive with `--review`
- [ ] Clear progress reporting during upload
- [ ] Graceful error handling (continues on individual failures)
- [ ] Command is idempotent (safe to run multiple times)

---

## Implementation Notes

### No Diffs for Bulk Uploads

Bulk uploads (`--all`) skip diff extraction entirely. Historical sessions would have inaccurate diffs because:
- The session's branch may have been merged or deleted
- The current working tree doesn't reflect the code state during those sessions
- Computing diffs for many sessions would be slow and error-prone

Session content (the conversation) is the primary value. Users who need diffs for specific historical sessions can re-upload them individually with `openctl upload -s <uuid>`.

### Rate Limiting

The implementation includes a 100ms delay between uploads to avoid overwhelming the server. If the server returns 429 (rate limited), the upload will fail for that session and continue to the next.

**TODO (future enhancement):** Add exponential backoff on 429 responses:
```typescript
// Example backoff logic (not in initial implementation):
// if (response.status === 429) {
//   await Bun.sleep(Math.min(1000 * Math.pow(2, retryCount), 30000));
//   retryCount++;
// }
```

### Deduplication Strategy

The server already handles upserts via `upsertSessionWithDataAndReview()`. The client-side check (`--skip-existing`) is an optimization to:
1. Provide accurate counts in the confirmation prompt
2. Avoid unnecessary uploads and server load
3. Make dry-run output accurate
