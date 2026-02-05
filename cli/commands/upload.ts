/**
 * Upload a Claude Code session to the server.
 */

import { $ } from "bun";
import { existsSync } from "fs";
import { basename, join } from "path";
import { Glob } from "bun";
import { getClientId } from "../lib/client-id";
import { DEFAULT_SERVER, getServerUrl } from "../lib/config";
import {
  listRecentSessions,
  promptSessionSelection,
  listSessionsForProject,
  formatRelativeTime,
  extractTitleFromContent,
  type LocalSessionInfo,
} from "../lib/shared-sessions";
import { getAccessTokenIfAuthenticated } from "../lib/oauth";
import { isGitRepo } from "../lib/git";
import * as readline from "readline";

interface SessionExistsResult {
  exists: boolean;
  url?: string;
}

async function promptConfirmation(message: string): Promise<boolean> {
  // Skip prompt in non-interactive environments
  if (!process.stdin.isTTY) {
    console.log("Non-interactive environment detected. Use --yes to skip confirmation.");
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

// UUID v4 pattern
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Review types
interface ReviewAnnotation {
  filename: string;
  line_number: number;
  side: "additions" | "deletions";
  annotation_type: "suggestion" | "issue" | "praise" | "question";
  content: string;
}

interface ReviewOutput {
  summary: string;
  model: string;
  annotations: ReviewAnnotation[];
}

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
    skipExisting: true,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--session":
      case "-s":
        options.session = args[++i];
        break;
      case "--title":
      case "-t":
        options.title = args[++i];
        break;
      case "--model":
      case "-m":
        options.model = args[++i];
        break;
      case "--harness":
        options.harness = args[++i] ?? options.harness;
        break;
      case "--repo":
        options.repo = args[++i];
        break;
      case "--diff":
      case "-d":
        options.diff = args[++i] !== "false";
        break;
      case "--no-diff":
        options.diff = false;
        break;
      case "--review":
      case "-r":
        options.review = true;
        break;
      case "--server":
        options.server = args[++i] ?? options.server;
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--list":
      case "-l":
        options.list = true;
        break;
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

async function findCurrentSession(): Promise<string | null> {
  // Get the current working directory and find the corresponding Claude project
  const cwd = process.cwd();
  // Claude uses format like "-Users-bryce-code-archive" (leading dash, then path with dashes)
  const projectSlug = cwd.replace(/\//g, "-");
  const claudeProjectDir = join(
    Bun.env.HOME || "~",
    ".claude/projects",
    projectSlug
  );

  if (!existsSync(claudeProjectDir)) {
    console.error(`No Claude project found at: ${claudeProjectDir}`);
    return null;
  }

  // Find the most recently modified .jsonl file
  const result =
    await $`/bin/ls -t ${claudeProjectDir}/*.jsonl 2>/dev/null | head -1`.text();
  const sessionPath = result.trim();

  if (!sessionPath || !existsSync(sessionPath)) {
    console.error("No session files found");
    return null;
  }

  return sessionPath;
}

async function findSessionByUuid(uuid: string): Promise<string | null> {
  // Search all Claude project directories for a session file with this UUID
  const claudeProjectsDir = join(Bun.env.HOME || "~", ".claude/projects");

  if (!existsSync(claudeProjectsDir)) {
    console.error(`Claude projects directory not found: ${claudeProjectsDir}`);
    return null;
  }

  const glob = new Glob(`*/${uuid}.jsonl`);
  for await (const file of glob.scan({ cwd: claudeProjectsDir, absolute: true })) {
    return file;
  }

  console.error(`No session file found for UUID: ${uuid}`);
  console.error(`Searched in: ${claudeProjectsDir}/*/`);
  return null;
}

function extractProjectPathFromSessionPath(sessionPath: string): string | null {
  // Extract project path from session file path
  // e.g., /Users/bryce/.claude/projects/-Users-bryce-code-foo/session.jsonl
  //       -> /Users/bryce/code/foo
  //
  // The challenge is that hyphens can be either:
  // 1. Path separators (should become /)
  // 2. Part of folder names (should stay -)
  //
  // We use a greedy approach: try the most specific path first,
  // then progressively try combining path segments until we find one that exists.

  const dir = basename(sessionPath.replace(/\/[^/]+\.jsonl$/, ""));
  if (!dir.startsWith("-")) {
    return null;
  }

  // Split by hyphens and try to find the actual path
  const parts = dir.slice(1).split("-"); // Remove leading dash and split

  // Try building paths by progressively joining segments with hyphens
  // Start with all slashes, then try combining from the end
  function tryPaths(segments: string[], start: number): string | null {
    if (start >= segments.length) {
      const path = "/" + segments.join("/");
      return existsSync(path) ? path : null;
    }

    // Try with slash at this position
    const withSlash = tryPaths(segments, start + 1);
    if (withSlash) return withSlash;

    // Try combining this segment with the next using hyphen
    if (start + 1 < segments.length) {
      const combined = [...segments];
      combined[start] = combined[start] + "-" + combined[start + 1];
      combined.splice(start + 1, 1);
      const withHyphen = tryPaths(combined, start + 1);
      if (withHyphen) return withHyphen;
    }

    return null;
  }

  const result = tryPaths(parts, 0);
  if (result) return result;

  // Fallback: just convert all hyphens to slashes (may not exist)
  return "/" + parts.join("/");
}

async function getPrBaseBranch(projectDir: string, headBranch: string): Promise<string | null> {
  try {
    // Use gh CLI to find PR with this head branch and get its base
    const result = await $`gh pr list --head ${headBranch} --json baseRefName --limit 1`.cwd(projectDir).text();
    const prs = JSON.parse(result.trim() || "[]");
    if (prs.length > 0 && prs[0].baseRefName) {
      return prs[0].baseRefName;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if content is binary by looking for null bytes.
 * This is the same heuristic git uses - binary files contain null bytes, text files don't.
 * We only check the first 8KB for performance.
 */
function isBinaryContent(content: string): boolean {
  return content.slice(0, 8000).includes("\0");
}

/**
 * Generate diff content for untracked files that are in the touched files list.
 * This handles net new files that git diff doesn't show by default.
 */
export async function getUntrackedFilesDiff(cwd: string, touchedFiles: string[]): Promise<string> {
  try {
    // Get list of untracked files
    const untrackedOutput = await $`git -C ${cwd} ls-files --others --exclude-standard`.text();
    if (!untrackedOutput.trim()) return "";

    const untrackedFiles = untrackedOutput.trim().split("\n");
    const touchedSet = new Set(touchedFiles.map(f => f.replace(/^\.\//, "").replace(/\/+/g, "/")));

    let untrackedDiff = "";
    for (const file of untrackedFiles) {
      // Only include files that were touched by the session
      const normalizedFile = file.replace(/^\.\//, "").replace(/\/+/g, "/");
      if (!touchedSet.has(normalizedFile)) continue;

      try {
        const absolutePath = join(cwd, file);
        const content = await Bun.file(absolutePath).text();

        // Skip binary files - they produce garbled diff output
        if (isBinaryContent(content)) continue;

        // Split into lines, handling trailing newline properly
        let lines = content.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") {
          lines = lines.slice(0, -1);
        }

        // Skip empty files
        if (lines.length === 0) continue;

        // Generate "new file" diff format
        untrackedDiff += `diff --git a/${file} b/${file}\n`;
        untrackedDiff += `new file mode 100644\n`;
        untrackedDiff += `--- /dev/null\n`;
        untrackedDiff += `+++ b/${file}\n`;
        untrackedDiff += `@@ -0,0 +1,${lines.length} @@\n`;
        for (const line of lines) {
          untrackedDiff += `+${line}\n`;
        }
      } catch {
        // Gracefully skip files that can't be read (e.g., permission errors, files
        // deleted between listing and reading). This is intentional - we'd rather
        // include partial diff output than fail the entire upload.
      }
    }

    return untrackedDiff;
  } catch {
    // If git commands fail (not a git repo, git not installed, etc.), return empty
    // string rather than failing. The diff is optional enhancement, not required.
    return "";
  }
}

async function getGitDiff(projectDir?: string, branch?: string, touchedFiles?: string[]): Promise<string | null> {
  const cwd = projectDir || process.cwd();

  // Check if directory exists
  if (projectDir && !existsSync(projectDir)) {
    console.log(`Project directory not found: ${projectDir}`);
    return null;
  }

  try {
    // Try to get base branch from PR if we have a branch name
    let baseBranch: string | null = null;
    if (branch && projectDir) {
      baseBranch = await getPrBaseBranch(projectDir, branch);
      if (baseBranch) {
        console.log(`PR base branch: ${baseBranch}`);
      }
    }

    // Fall back to main or master
    if (!baseBranch) {
      baseBranch =
        (await $`git -C ${cwd} rev-parse --verify main 2>/dev/null`.text().catch(() => "")).trim() ||
        (await $`git -C ${cwd} rev-parse --verify master 2>/dev/null`.text().catch(() => "")).trim();
    }

    if (!baseBranch) {
      console.log("No base branch found");
      return null;
    }

    // Build file filter args if we have touched files
    const fileArgs = touchedFiles && touchedFiles.length > 0 ? ["--", ...touchedFiles] : [];
    const hasFileFilter = fileArgs.length > 0;

    // Helper to combine tracked diff with untracked files diff
    const combineWithUntracked = async (trackedDiff: string): Promise<string | null> => {
      let combined = trackedDiff;
      // Add untracked files that were touched by the session
      if (touchedFiles && touchedFiles.length > 0) {
        const untrackedDiff = await getUntrackedFilesDiff(cwd, touchedFiles);
        combined += untrackedDiff;
      }
      return combined.trim() ? combined : null;
    };

    // If a specific branch was provided (from session metadata), use it
    if (branch) {
      // Check if the branch exists locally
      const branchExists = await $`git -C ${cwd} rev-parse --verify refs/heads/${branch} 2>/dev/null`.text().catch(() => "");
      if (branchExists.trim()) {
        console.log(`Using session branch: ${branch}${hasFileFilter ? ` (filtered to ${touchedFiles!.length} files)` : ""}`);
        const diff = hasFileFilter
          ? await $`git -C ${cwd} diff ${baseBranch}...${branch} ${fileArgs}`.text()
          : await $`git -C ${cwd} diff ${baseBranch}...${branch}`.text();
        return await combineWithUntracked(diff);
      } else {
        // Try remote branch
        const remoteBranchExists = await $`git -C ${cwd} rev-parse --verify refs/remotes/origin/${branch} 2>/dev/null`.text().catch(() => "");
        if (remoteBranchExists.trim()) {
          console.log(`Using remote session branch: origin/${branch}${hasFileFilter ? ` (filtered to ${touchedFiles!.length} files)` : ""}`);
          const diff = hasFileFilter
            ? await $`git -C ${cwd} diff ${baseBranch}...origin/${branch} ${fileArgs}`.text()
            : await $`git -C ${cwd} diff ${baseBranch}...origin/${branch}`.text();
          return await combineWithUntracked(diff);
        } else {
          console.log(`Session branch '${branch}' no longer exists (may have been merged or deleted)`);
          return null;
        }
      }
    }

    // Fall back to current HEAD diff (for non-UUID uploads from cwd)
    const diff = hasFileFilter
      ? await $`git -C ${cwd} diff ${baseBranch}...HEAD ${fileArgs}`.text()
      : await $`git -C ${cwd} diff ${baseBranch}...HEAD`.text();
    const combinedDiff = await combineWithUntracked(diff);
    if (combinedDiff) return combinedDiff;

    // Fall back to uncommitted changes
    const uncommitted = hasFileFilter
      ? await $`git -C ${cwd} diff HEAD ${fileArgs}`.text()
      : await $`git -C ${cwd} diff HEAD`.text();
    return await combineWithUntracked(uncommitted);
  } catch {
    return null;
  }
}

async function getRepoUrl(projectDir?: string): Promise<string | null> {
  const cwd = projectDir || process.cwd();

  // First verify this is actually a git repository
  if (!(await isGitRepo(cwd))) {
    return null;
  }

  try {
    const remote = await $`git -C ${cwd} remote get-url origin 2>/dev/null`.text();
    const url = remote.trim();
    if (!url) return null;

    // Convert SSH to HTTPS format
    // git@github.com:user/repo.git -> https://github.com/user/repo
    if (url.startsWith("git@github.com:")) {
      return url
        .replace("git@github.com:", "https://github.com/")
        .replace(/\.git$/, "");
    }

    // Already HTTPS, just clean up
    if (url.includes("github.com")) {
      return url.replace(/\.git$/, "");
    }

    return url;
  } catch {
    return null;
  }
}

// JSON schema for review output
const reviewSchema = JSON.stringify({
  type: "object",
  properties: {
    summary: { type: "string", description: "2-3 sentence summary of the review findings" },
    annotations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          filename: { type: "string", description: "File path from diff header" },
          line_number: { type: "number", description: "Line number in the new file" },
          side: { enum: ["additions", "deletions"], description: "Which side of the diff" },
          annotation_type: { enum: ["issue", "suggestion"], description: "Type of finding" },
          content: { type: "string", description: "Concise description of the issue" },
        },
        required: ["filename", "line_number", "side", "annotation_type", "content"],
      },
    },
  },
  required: ["summary", "annotations"],
});

const reviewPrompt = `You are a code reviewer. Review the diff using a parallel strategy:

## Review Strategy

Launch 3 parallel review passes, each with a different focus:

1. **Defects** - Logic errors, boundary conditions, null/undefined handling, missing validation, error handling gaps, edge cases
2. **Security** - Injection risks, authentication/authorization issues, exposed secrets, unsafe operations
3. **Architecture** - Pattern violations, unnecessary complexity, performance issues (N+1 queries, quadratic algorithms on unbounded data)

Aggregate findings by: deduplicating similar issues, ranking by severity, keeping only issues with realistic impact.

## Review Standards

- **Be certain** - Don't speculate about bugs; verify before flagging
- **Be realistic** - Only raise edge cases with plausible scenarios
- **Stay focused** - Only review modified code, not pre-existing issues
- **Skip style** - No nitpicks on formatting or preferences
- **Be direct** - Factual tone, specific file/line references, actionable suggestions

Return a summary and annotations for significant findings only.`;

async function generateReview(diffContent: string): Promise<ReviewOutput | null> {
  console.log("Generating code review...");

  const prompt = `${reviewPrompt}

<diff>
${diffContent}
</diff>`;

  try {
    // Use Bun.spawn for better control over argument passing
    const proc = Bun.spawn([
      "claude",
      "-p", prompt,
      "--output-format", "json",
      "--json-schema", reviewSchema,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude CLI error:", stderr || output);
      return null;
    }

    const reviewResult = JSON.parse(output) as { summary: string; annotations: ReviewOutput["annotations"] };

    console.log(`Review found ${reviewResult.annotations.length} issues`);

    return {
      summary: reviewResult.summary,
      model: "claude",
      annotations: reviewResult.annotations,
    };
  } catch (err) {
    console.error("Review generation failed:", err);
    return null;
  }
}

function extractModel(sessionContent: string): string | null {
  // Parse JSONL and look for model info in assistant messages
  const lines = sessionContent.split("\n").filter(Boolean);

  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      // Check for model field directly on the item
      if (item.model) return item.model;
      // Check in message object
      if (item.message?.model) return item.message.model;
    } catch {
      continue;
    }
  }

  return null;
}

function extractGitBranch(sessionContent: string): string | null {
  // Parse JSONL and look for gitBranch in message metadata
  const lines = sessionContent.split("\n").filter(Boolean);

  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item.gitBranch) return item.gitBranch;
    } catch {
      continue;
    }
  }

  return null;
}

function extractTouchedFiles(sessionContent: string, projectPath?: string): string[] {
  // Parse JSONL and look for Write/Edit/NotebookEdit tool_use blocks
  const files = new Set<string>();
  const lines = sessionContent.split("\n").filter(Boolean);

  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      const msg = item.message || item;
      const content = msg.content;

      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type === "tool_use" && ["Write", "Edit", "NotebookEdit"].includes(block.name)) {
          const input = block.input as Record<string, unknown>;
          let path = (input.file_path || input.notebook_path) as string;
          if (path) {
            // Make path relative to project if it's absolute
            if (projectPath && path.startsWith(projectPath)) {
              path = path.slice(projectPath.length + 1);
            }
            // Normalize path
            path = path.replace(/^\.\//, "").replace(/\/+/g, "/");
            files.add(path);
          }
        }
      }
    } catch {
      continue;
    }
  }

  return Array.from(files);
}

function countMessages(sessionContent: string): number {
  // Count actual user/assistant messages (not metadata like file-history-snapshot)
  const lines = sessionContent.split("\n").filter(Boolean);
  let count = 0;

  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      const msg = item.message || item;
      const role = msg.role;

      // Count user and assistant messages
      if (role === "human" || role === "user" || role === "assistant") {
        count++;
      }
    } catch {
      continue;
    }
  }

  return count;
}

function extractTitle(sessionContent: string): string {
  return extractTitleFromContent(sessionContent) ?? `Session ${new Date().toISOString().split("T")[0]}`;
}

interface UploadOptions {
  sessionPath: string;
  title: string;
  model: string | null;
  harness: string;
  repoUrl: string | null;
  diffContent: string | null;
  serverUrl: string;
  review: ReviewOutput | null;
  projectPath: string;
  authToken: string | null;
}

interface UploadResult {
  success: boolean;
  url?: string;
  error?: string;
}

async function uploadSession(options: UploadOptions): Promise<UploadResult> {
  const { sessionPath, title, model, harness, repoUrl, diffContent, serverUrl, review, projectPath, authToken } = options;
  const sessionContent = await Bun.file(sessionPath).text();
  const sessionId = basename(sessionPath, ".jsonl");

  const formData = new FormData();
  formData.append("title", title);
  formData.append("claude_session_id", sessionId);
  formData.append("project_path", projectPath);
  formData.append("harness", harness);

  if (model) {
    formData.append("model", model);
  }

  if (repoUrl) {
    formData.append("repo_url", repoUrl);
  }

  formData.append(
    "session_file",
    new Blob([sessionContent], { type: "application/jsonl" }),
    basename(sessionPath)
  );

  if (diffContent) {
    formData.append(
      "diff_file",
      new Blob([diffContent], { type: "text/plain" }),
      "changes.diff"
    );
  }

  // Add review data if present
  if (review) {
    formData.append("review_summary", review.summary);
    formData.append("review_model", review.model);
    formData.append("annotations", JSON.stringify(review.annotations));
  }

  const headers: Record<string, string> = {
    "X-Openctl-Client-ID": getClientId(),
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const response = await fetch(`${serverUrl}/api/sessions`, {
    method: "POST",
    body: formData,
    redirect: "manual",
    headers,
  });

  if (response.status === 303) {
    const location = response.headers.get("Location");
    console.log(`Session uploaded successfully!`);
    // Remove trailing slash from serverUrl to avoid double slashes
    const baseUrl = serverUrl.replace(/\/$/, "");
    console.log(`View at: ${baseUrl}${location}`);
    return { success: true, url: `${baseUrl}${location}` };
  } else if (response.ok) {
    console.log("Session uploaded successfully!");
    return { success: true };
  } else {
    const error = await response.text();
    console.error(`Upload failed: ${response.status} ${error}`);
    return { success: false, error };
  }
}

async function checkSessionExists(
  sessionUuid: string,
  serverUrl: string,
  authToken: string | null
): Promise<SessionExistsResult> {
  const headers: Record<string, string> = {
    "X-Openctl-Client-ID": getClientId(),
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  try {
    const response = await fetch(
      `${serverUrl}/api/sessions?claude_session_id=${encodeURIComponent(sessionUuid)}`,
      { headers }
    );
    if (!response.ok) {
      return { exists: false };
    }
    const data = (await response.json()) as { session: unknown; url?: string };
    return data.session ? { exists: true, url: data.url } : { exists: false };
  } catch {
    return { exists: false };
  }
}

interface BulkUploadOptions {
  projectPath: string;
  serverUrl: string;
  harness: string;
  since?: Date;
  skipExisting: boolean;
  dryRun: boolean;
  yes: boolean;
  authToken: string | null;
}

interface SessionUploadInfo {
  session: LocalSessionInfo;
  exists: boolean;
  existingUrl?: string;
}

async function uploadAllSessions(options: BulkUploadOptions): Promise<void> {
  const { projectPath, serverUrl, harness, since, skipExisting, dryRun, yes, authToken } = options;

  console.log(`Scanning sessions for ${projectPath}...`);

  // Get all sessions for the project
  const sessions = await listSessionsForProject(projectPath, { since });

  if (sessions.length === 0) {
    if (since) {
      console.log(`No sessions found for project modified after ${since.toISOString().split("T")[0]}`);
    } else {
      console.log("No sessions found for project.");
    }
    return;
  }

  // Check which sessions already exist on server
  const sessionInfos: SessionUploadInfo[] = [];
  let existingCount = 0;

  console.log(`Found ${sessions.length} session(s). Checking server...`);

  for (const session of sessions) {
    const existsResult = await checkSessionExists(session.uuid, serverUrl, authToken);
    sessionInfos.push({
      session,
      exists: existsResult.exists,
      existingUrl: existsResult.url,
    });
    if (existsResult.exists) {
      existingCount++;
    }
  }

  // Determine which sessions to upload
  const toUpload = skipExisting
    ? sessionInfos.filter((info) => !info.exists)
    : sessionInfos;

  const newCount = sessions.length - existingCount;

  // Display summary
  console.log();
  console.log(`Found ${sessions.length} sessions (${newCount} new, ${existingCount} already uploaded)`);

  if (toUpload.length === 0) {
    console.log("No sessions to upload.");
    return;
  }

  console.log();
  console.log("Sessions to upload:");
  for (const info of toUpload) {
    const timeAgo = formatRelativeTime(info.session.modifiedAt);
    const status = info.exists ? " (re-upload)" : "";
    console.log(`  - ${info.session.titlePreview} (${info.session.uuid.slice(0, 8)}) - ${timeAgo}${status}`);
  }
  console.log();

  // Dry run - just show what would be uploaded
  if (dryRun) {
    console.log(`Dry run: Would upload ${toUpload.length} session(s).`);
    return;
  }

  // Prompt for confirmation unless --yes
  if (!yes) {
    const confirmed = await promptConfirmation(`Upload ${toUpload.length} session(s)? [y/N] `);
    if (!confirmed) {
      console.log("Upload cancelled.");
      return;
    }
    console.log();
  }

  // Upload sessions with progress
  let uploadedCount = 0;
  let failedCount = 0;
  let emptyCount = 0;
  const failures: Array<{ session: LocalSessionInfo; error: string }> = [];

  console.log("Uploading sessions:");

  for (let i = 0; i < toUpload.length; i++) {
    const info = toUpload[i];
    if (!info) continue;
    const { session } = info;
    const num = `[${i + 1}/${toUpload.length}]`;

    process.stdout.write(`  ${num} ${session.titlePreview.slice(0, 40)} (${session.uuid.slice(0, 8)}) `);

    try {
      // Read session content
      const sessionContent = await Bun.file(session.filePath).text();

      // Check for actual messages
      const messageCount = countMessages(sessionContent);
      if (messageCount === 0) {
        console.log("⚠ skipped (no messages)");
        emptyCount++;
        continue;
      }

      // Extract metadata
      const title = extractTitle(sessionContent);
      const model = extractModel(sessionContent);

      // Get repo URL from project path
      const repoUrl = await getRepoUrl(session.projectPath);

      // Upload the session (skip diff for bulk uploads - historical diffs unreliable)
      const result = await uploadSession({
        sessionPath: session.filePath,
        title,
        model,
        harness,
        repoUrl,
        diffContent: null, // Skip diff for bulk uploads
        serverUrl,
        review: null,
        projectPath: session.projectPath,
        authToken,
      });

      if (result.success) {
        console.log("✓");
        uploadedCount++;
      } else {
        console.log("✗");
        failedCount++;
        failures.push({ session, error: result.error || "Unknown error" });
      }
    } catch (err) {
      console.log("✗");
      failedCount++;
      failures.push({ session, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Final summary
  console.log();
  const skippedCount = skipExisting ? existingCount : 0;
  let summary = `Done. Uploaded ${uploadedCount} session(s)`;
  if (skippedCount > 0) {
    summary += `, skipped ${skippedCount} (already uploaded)`;
  }
  if (emptyCount > 0) {
    summary += `, ${emptyCount} empty`;
  }
  if (failedCount > 0) {
    summary += `, ${failedCount} failed`;
  }
  console.log(summary + ".");

  // Report failures
  if (failures.length > 0) {
    console.log();
    console.log("Failed:");
    for (const { session, error } of failures) {
      console.log(`  - ${session.uuid.slice(0, 8)}: ${error}`);
    }
  }
}

function showHelp(): void {
  console.log(`
Upload a Claude Code session to the server.

Usage:
  openctl upload [options]

Options:
  -s, --session   Session UUID or path to JSONL file (default: auto-detect current session)
                  Can be a UUID like "c28995d0-7cba-4974-8268-32b94ac183a4" or a file path
  -l, --list      Interactively select from recent sessions
  -t, --title     Session title (default: derived from first user message)
  -m, --model     Model used (default: auto-detect from session)
  --harness       Harness/client used (default: "Claude Code")
  --repo          GitHub repository URL (default: auto-detect from git remote)
  -d, --diff      Include git diff (default: true)
  --no-diff       Exclude git diff
  -r, --review    Generate code review using Claude CLI (requires diff)
  --server        Server URL (default: from config or ${DEFAULT_SERVER})
  -y, --yes       Skip confirmation prompt when auto-detecting session
  -h, --help      Show this help

Bulk Upload:
  -a, --all           Upload all sessions for current project
  -p, --project       Project path (default: current directory)
  --since <date>      Only upload sessions modified after date (YYYY-MM-DD)
  --skip-existing     Skip sessions already uploaded (default: true)
  --no-skip-existing  Re-upload all sessions even if they exist
  --dry-run           Show what would be uploaded without uploading

Examples:
  openctl upload                   # Upload current/latest session
  openctl upload --list            # Pick from recent sessions
  openctl upload -s abc-123-def    # Upload a specific session
  openctl upload --all             # Upload all sessions for current project
  openctl upload --all --project /path/to/project  # Upload for specific project
  openctl upload --all --since 2025-01-01          # Upload sessions from this year
  openctl upload --all --dry-run   # Preview what would be uploaded
  `);
}

export async function upload(args: string[]): Promise<void> {
  const options = parseArgs(args);

  if (options.help) {
    showHelp();
    return;
  }

  // Check for mutual exclusivity with --all
  if (options.all) {
    if (options.session) {
      console.error("Error: --all cannot be used with a session argument");
      process.exit(1);
    }
    if (options.list) {
      console.error("Error: --all cannot be used with --list");
      process.exit(1);
    }
    if (options.review) {
      console.error("Error: --all cannot be used with --review (too slow for bulk uploads)");
      process.exit(1);
    }

    // Parse --since date if provided
    let sinceDate: Date | undefined;
    if (options.since) {
      sinceDate = new Date(options.since);
      if (isNaN(sinceDate.getTime())) {
        console.error(`Error: Invalid date format for --since: ${options.since}`);
        console.error("Use YYYY-MM-DD format (e.g., 2025-01-01)");
        process.exit(1);
      }
    }

    // Determine project path
    const projectPath = options.project || process.cwd();
    if (options.project && !existsSync(options.project)) {
      console.error(`Error: Project path does not exist: ${options.project}`);
      process.exit(1);
    }

    // Get auth token
    const authToken = await getAccessTokenIfAuthenticated(options.server);

    // Run bulk upload
    await uploadAllSessions({
      projectPath,
      serverUrl: options.server,
      harness: options.harness,
      since: sinceDate,
      skipExisting: options.skipExisting,
      dryRun: options.dryRun,
      yes: options.yes,
      authToken,
    });
    return;
  }

  // Find session file
  let sessionPath = options.session;
  let autoDetected = false;

  if (options.list) {
    // Interactive list mode
    const sessions = await listRecentSessions(10);
    const result = await promptSessionSelection(sessions);
    if (!result.session) {
      process.exit(result.cancelled ? 0 : 1);
    }
    sessionPath = result.session.filePath;
  } else if (!sessionPath) {
    console.log("Auto-detecting current session...");
    const foundSession = await findCurrentSession();
    if (!foundSession) {
      process.exit(1);
    }
    sessionPath = foundSession;
    autoDetected = true;
  } else if (UUID_PATTERN.test(sessionPath)) {
    // Session is a UUID, look it up in ~/.claude/projects/*/
    console.log(`Looking up session by UUID: ${sessionPath}`);
    const foundPath = await findSessionByUuid(sessionPath);
    if (!foundPath) {
      process.exit(1);
    }
    sessionPath = foundPath;
  }

  if (!existsSync(sessionPath)) {
    console.error(`Session file not found: ${sessionPath}`);
    process.exit(1);
  }

  console.log(`Session: ${sessionPath}`);

  // Extract project path from session path (for UUID-based lookups)
  // This is the directory where the session was created
  const extractedProjectPath = extractProjectPathFromSessionPath(sessionPath);
  const projectPath = extractedProjectPath || process.cwd();
  if (extractedProjectPath) {
    console.log(`Project: ${extractedProjectPath}`);
  }

  // Read session content
  const sessionContent = await Bun.file(sessionPath).text();

  // Check for actual messages (skip sessions with only metadata)
  const messageCount = countMessages(sessionContent);
  if (messageCount === 0) {
    console.error("Session has no messages (only metadata). Skipping upload.");
    process.exit(1);
  }
  console.log(`Messages: ${messageCount}`);

  // Extract or use provided title
  const title = options.title || extractTitle(sessionContent);
  console.log(`Title: ${title}`);

  // Extract or use provided model
  const model = options.model || extractModel(sessionContent);
  if (model) {
    console.log(`Model: ${model}`);
  }

  // Extract git branch from session metadata
  const gitBranch = extractGitBranch(sessionContent);
  if (gitBranch) {
    console.log(`Branch: ${gitBranch}`);
  }

  // Harness (defaults to "Claude Code")
  console.log(`Harness: ${options.harness}`);

  // Get repo URL (use extracted project path if available)
  const repoUrl = options.repo || (await getRepoUrl(extractedProjectPath || undefined));
  if (repoUrl) {
    console.log(`Repo: ${repoUrl}`);
  }

  // Prompt for confirmation when auto-detecting (unless --yes)
  if (autoDetected && !options.yes) {
    console.log();
    const confirmed = await promptConfirmation("Upload this session? [y/N] ");
    if (!confirmed) {
      console.log("Upload cancelled.");
      process.exit(0);
    }
    console.log();
  }

  // Extract files touched by the session (for filtering diff)
  const touchedFiles = extractTouchedFiles(sessionContent, extractedProjectPath || undefined);
  if (touchedFiles.length > 0) {
    console.log(`Touched files: ${touchedFiles.length}`);
  }

  // Get git diff if requested (use extracted project path, branch, and touched files)
  let diffContent: string | null = null;
  if (options.diff) {
    console.log("Getting git diff...");
    diffContent = await getGitDiff(
      extractedProjectPath || undefined,
      gitBranch || undefined,
      touchedFiles.length > 0 ? touchedFiles : undefined
    );
    if (diffContent) {
      console.log(`Diff: ${diffContent.split("\n").length} lines`);
    } else {
      console.log("No diff available");
    }
  }

  // Generate review if requested (requires diff)
  let review: ReviewOutput | null = null;
  if (options.review) {
    if (!diffContent) {
      console.error("Cannot generate review without diff content. Use --diff or remove --review.");
      process.exit(1);
    }
    review = await generateReview(diffContent);
  }

  // Get auth token if authenticated
  const authToken = await getAccessTokenIfAuthenticated(options.server);

  // Upload
  console.log(`Uploading to ${options.server}...`);
  const result = await uploadSession({
    sessionPath,
    title,
    model,
    harness: options.harness,
    repoUrl,
    diffContent,
    serverUrl: options.server,
    review,
    projectPath,
    authToken,
  });

  if (!result.success) {
    process.exit(1);
  }
}
