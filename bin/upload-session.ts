#!/usr/bin/env bun
/**
 * Upload a Claude Code session to the server.
 *
 * Usage:
 *   bun bin/upload-session.ts [options]
 *
 * Options:
 *   --session, -s   Path to session JSONL file (default: auto-detect current session)
 *   --title, -t     Session title (default: derived from first user message)
 *   --model, -m     Model used (default: auto-detect from session)
 *   --harness       Harness/client used (default: "Claude Code")
 *   --repo          GitHub repository URL (default: auto-detect from git remote)
 *   --diff, -d      Include git diff (default: true)
 *   --review, -r    Generate code review using Claude CLI (default: false)
 *   --server        Server URL (default: http://localhost:3000)
 *   --help, -h      Show help
 */

import { $ } from "bun";
import { existsSync } from "fs";
import { basename, join } from "path";
import { Glob } from "bun";
import { getAdapterById, getFileModifyingToolsForAdapter, extractFilePathFromTool } from "../cli/adapters";

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

const args = process.argv.slice(2);

function parseArgs() {
  const options: {
    session?: string;
    title?: string;
    model?: string;
    harness: string;
    repo?: string;
    diff: boolean;
    review: boolean;
    server: string;
    help: boolean;
  } = {
    harness: "Claude Code",
    diff: true,
    review: false,
    server: "http://localhost:3000",
    help: false,
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
        options.harness = args[++i];
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
        options.server = args[++i];
        break;
      case "--help":
      case "-h":
        options.help = true;
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
    process.env.HOME || "~",
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
  const claudeProjectsDir = join(process.env.HOME || "~", ".claude/projects");

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

    // If a specific branch was provided (from session metadata), use it
    if (branch) {
      // Check if the branch exists locally
      const branchExists = await $`git -C ${cwd} rev-parse --verify refs/heads/${branch} 2>/dev/null`.text().catch(() => "");
      if (branchExists.trim()) {
        console.log(`Using session branch: ${branch}${hasFileFilter ? ` (filtered to ${touchedFiles!.length} files)` : ""}`);
        const diff = hasFileFilter
          ? await $`git -C ${cwd} diff ${baseBranch}...${branch} ${fileArgs}`.text()
          : await $`git -C ${cwd} diff ${baseBranch}...${branch}`.text();
        if (diff.trim()) return diff;
      } else {
        // Try remote branch
        const remoteBranchExists = await $`git -C ${cwd} rev-parse --verify refs/remotes/origin/${branch} 2>/dev/null`.text().catch(() => "");
        if (remoteBranchExists.trim()) {
          console.log(`Using remote session branch: origin/${branch}${hasFileFilter ? ` (filtered to ${touchedFiles!.length} files)` : ""}`);
          const diff = hasFileFilter
            ? await $`git -C ${cwd} diff ${baseBranch}...origin/${branch} ${fileArgs}`.text()
            : await $`git -C ${cwd} diff ${baseBranch}...origin/${branch}`.text();
          if (diff.trim()) return diff;
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
    if (diff.trim()) return diff;

    // Fall back to uncommitted changes
    const uncommitted = hasFileFilter
      ? await $`git -C ${cwd} diff HEAD ${fileArgs}`.text()
      : await $`git -C ${cwd} diff HEAD`.text();
    if (uncommitted.trim()) return uncommitted;

    return null;
  } catch {
    return null;
  }
}

async function getRepoUrl(projectDir?: string): Promise<string | null> {
  const cwd = projectDir || process.cwd();
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

function extractTouchedFiles(sessionContent: string, projectPath?: string, harness?: string): string[] {
  // Get adapter-specific file modifying tools, or fall back to defaults
  const adapter = harness ? getAdapterById(harness) : null;
  const fileModifyingTools = adapter
    ? getFileModifyingToolsForAdapter(adapter)
    : ["Write", "Edit", "NotebookEdit"];

  // Parse JSONL and look for file-modifying tool_use blocks
  const files = new Set<string>();
  const lines = sessionContent.split("\n").filter(Boolean);

  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      const msg = item.message || item;
      const content = msg.content;

      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type === "tool_use" && fileModifyingTools.includes(block.name)) {
          const input = block.input as Record<string, unknown>;
          // Use adapter's extractFilePath if available, otherwise fall back
          let path = adapter
            ? extractFilePathFromTool(adapter, block.name, input)
            : (input.file_path || input.notebook_path) as string;
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

function extractTitle(sessionContent: string): string {
  // Parse JSONL and find first user message
  const lines = sessionContent.split("\n").filter(Boolean);

  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      const msg = item.message || item;

      if (msg.role === "human" || msg.role === "user" || item.type === "human") {
        const content = msg.content;
        let text = "";

        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          const textBlock = content.find(
            (c: { type: string }) => c.type === "text"
          );
          if (textBlock) text = textBlock.text;
        }

        if (text) {
          // Take first line, truncate to 100 chars
          const firstLine = text.split("\n")[0].trim();
          return firstLine.length > 100
            ? firstLine.slice(0, 97) + "..."
            : firstLine;
        }
      }
    } catch {
      continue;
    }
  }

  return `Session ${new Date().toISOString().split("T")[0]}`;
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
}

async function uploadSession(options: UploadOptions): Promise<void> {
  const { sessionPath, title, model, harness, repoUrl, diffContent, serverUrl, review, projectPath } = options;
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

  const response = await fetch(`${serverUrl}/api/sessions`, {
    method: "POST",
    body: formData,
    redirect: "manual",
  });

  if (response.status === 303) {
    const location = response.headers.get("Location");
    console.log(`Session uploaded successfully!`);
    console.log(`View at: ${serverUrl}${location}`);
  } else if (response.ok) {
    console.log("Session uploaded successfully!");
  } else {
    const error = await response.text();
    console.error(`Upload failed: ${response.status} ${error}`);
    process.exit(1);
  }
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    console.log(`
Upload a Claude Code session to the server.

Usage:
  bun bin/upload-session.ts [options]

Options:
  --session, -s   Session UUID or path to JSONL file (default: auto-detect current session)
                  Can be a UUID like "c28995d0-7cba-4974-8268-32b94ac183a4" or a file path
  --title, -t     Session title (default: derived from first user message)
  --model, -m     Model used (default: auto-detect from session)
  --harness       Harness/client used (default: "Claude Code")
  --repo          GitHub repository URL (default: auto-detect from git remote)
  --diff, -d      Include git diff (default: true)
  --no-diff       Exclude git diff
  --review, -r    Generate code review using Claude CLI (requires diff)
  --server        Server URL (default: http://localhost:3000)
  --help, -h      Show this help
    `);
    process.exit(0);
  }

  // Find session file
  let sessionPath = options.session;
  if (!sessionPath) {
    console.log("Auto-detecting current session...");
    sessionPath = await findCurrentSession();
    if (!sessionPath) {
      process.exit(1);
    }
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

  // Extract files touched by the session (for filtering diff)
  const touchedFiles = extractTouchedFiles(sessionContent, extractedProjectPath || undefined, options.harness);
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

  // Upload
  console.log(`Uploading to ${options.server}...`);
  await uploadSession({
    sessionPath,
    title,
    model,
    harness: options.harness,
    repoUrl,
    diffContent,
    serverUrl: options.server,
    review,
    projectPath,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
