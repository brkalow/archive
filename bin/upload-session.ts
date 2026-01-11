#!/usr/bin/env bun
/**
 * Upload a Claude Code session to the archive server.
 *
 * Usage:
 *   bun bin/upload-session.ts [options]
 *
 * Options:
 *   --session, -s   Path to session JSONL file (default: auto-detect current session)
 *   --title, -t     Session title (default: derived from first user message)
 *   --diff, -d      Include git diff (default: true)
 *   --server        Server URL (default: http://localhost:3000)
 *   --help, -h      Show help
 */

import { $ } from "bun";
import { existsSync } from "fs";
import { basename, join } from "path";

const args = process.argv.slice(2);

function parseArgs() {
  const options: {
    session?: string;
    title?: string;
    diff: boolean;
    server: string;
    help: boolean;
  } = {
    diff: true,
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
      case "--diff":
      case "-d":
        options.diff = args[++i] !== "false";
        break;
      case "--no-diff":
        options.diff = false;
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

async function uploadSession(
  sessionPath: string,
  title: string,
  diffContent: string | null,
  serverUrl: string
): Promise<void> {
  const sessionContent = await Bun.file(sessionPath).text();
  const sessionId = basename(sessionPath, ".jsonl");

  const formData = new FormData();
  formData.append("title", title);
  formData.append("claude_session_id", sessionId);
  formData.append("project_path", process.cwd());
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
Upload a Claude Code session to the archive server.

Usage:
  bun bin/upload-session.ts [options]

Options:
  --session, -s   Path to session JSONL file (default: auto-detect current session)
  --title, -t     Session title (default: derived from first user message)
  --diff, -d      Include git diff (default: true)
  --no-diff       Exclude git diff
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
  }

  if (!existsSync(sessionPath)) {
    console.error(`Session file not found: ${sessionPath}`);
    process.exit(1);
  }

  console.log(`Session: ${sessionPath}`);

  // Read session content
  const sessionContent = await Bun.file(sessionPath).text();

  // Extract or use provided title
  const title = options.title || extractTitle(sessionContent);
  console.log(`Title: ${title}`);

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

  // Upload
  console.log(`Uploading to ${options.server}...`);
  await uploadSession(sessionPath, title, diffContent, options.server);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
