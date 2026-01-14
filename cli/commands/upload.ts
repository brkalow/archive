/**
 * Upload a Claude Code session to the archive server.
 */

import { $ } from "bun";
import { existsSync } from "fs";
import { basename, join } from "path";
import { getClientId } from "../lib/client-id";
import { loadConfig } from "../lib/config";

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
  help: boolean;
}

function parseArgs(args: string[]): ParsedOptions {
  const config = loadConfig();

  const options: ParsedOptions = {
    harness: "Claude Code",
    diff: true,
    review: false,
    server: config.server || "http://localhost:3000",
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

async function getGitDiff(): Promise<string | null> {
  try {
    // Get diff of all changes (staged and unstaged) compared to main/master
    const baseBranch =
      (await $`git rev-parse --verify main 2>/dev/null`.text().catch(() => "")) ||
      (await $`git rev-parse --verify master 2>/dev/null`.text().catch(() => ""));

    if (baseBranch.trim()) {
      const diff = await $`git diff ${baseBranch.trim()}...HEAD`.text();
      if (diff.trim()) return diff;
    }

    // Fall back to uncommitted changes
    const uncommitted = await $`git diff HEAD`.text();
    if (uncommitted.trim()) return uncommitted;

    return null;
  } catch {
    return null;
  }
}

async function getRepoUrl(): Promise<string | null> {
  try {
    const remote = await $`git remote get-url origin 2>/dev/null`.text();
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
}

async function uploadSession(options: UploadOptions): Promise<void> {
  const { sessionPath, title, model, harness, repoUrl, diffContent, serverUrl, review } = options;
  const sessionContent = await Bun.file(sessionPath).text();
  const sessionId = basename(sessionPath, ".jsonl");

  const formData = new FormData();
  formData.append("title", title);
  formData.append("claude_session_id", sessionId);
  formData.append("project_path", process.cwd());
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
    headers: {
      "X-Archive-Client-ID": getClientId(),
    },
  });

  if (response.status === 303) {
    const location = response.headers.get("Location");
    console.log(`Session uploaded successfully!`);
    // Remove trailing slash from serverUrl to avoid double slashes
    const baseUrl = serverUrl.replace(/\/$/, "");
    console.log(`View at: ${baseUrl}${location}`);
  } else if (response.ok) {
    console.log("Session uploaded successfully!");
  } else {
    const error = await response.text();
    console.error(`Upload failed: ${response.status} ${error}`);
    process.exit(1);
  }
}

function showHelp(): void {
  console.log(`
Upload a Claude Code session to the archive server.

Usage:
  archive upload [options]

Options:
  --session, -s   Path to session JSONL file (default: auto-detect current session)
  --title, -t     Session title (default: derived from first user message)
  --model, -m     Model used (default: auto-detect from session)
  --harness       Harness/client used (default: "Claude Code")
  --repo          GitHub repository URL (default: auto-detect from git remote)
  --diff, -d      Include git diff (default: true)
  --no-diff       Exclude git diff
  --review, -r    Generate code review using Claude CLI (requires diff)
  --server        Server URL (default: from config or http://localhost:3000)
  --help, -h      Show this help
  `);
}

export async function upload(args: string[]): Promise<void> {
  const options = parseArgs(args);

  if (options.help) {
    showHelp();
    return;
  }

  // Find session file
  let sessionPath = options.session;
  if (!sessionPath) {
    console.log("Auto-detecting current session...");
    sessionPath = await findCurrentSession();
    if (!sessionPath) {
      process.exit(1);
    }
  }

  if (!existsSync(sessionPath)) {
    console.error(`Session file not found: ${sessionPath}`);
    process.exit(1);
  }

  console.log(`Session: ${sessionPath}`);

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

  // Harness (defaults to "Claude Code")
  console.log(`Harness: ${options.harness}`);

  // Get repo URL
  const repoUrl = options.repo || (await getRepoUrl());
  if (repoUrl) {
    console.log(`Repo: ${repoUrl}`);
  }

  // Get git diff if requested
  let diffContent: string | null = null;
  if (options.diff) {
    console.log("Getting git diff...");
    diffContent = await getGitDiff();
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
  });
}
