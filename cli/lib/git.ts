/**
 * Git utilities for capturing diffs during live sessions.
 */

import { $ } from "bun";
import { join, isAbsolute } from "path";
import { existsSync } from "fs";

/**
 * Validate that a path is safe to use in shell commands.
 * Must be an absolute path that exists and doesn't contain dangerous characters.
 */
function isValidProjectPath(projectPath: string): boolean {
  if (!projectPath || !isAbsolute(projectPath)) {
    return false;
  }
  // Reject paths with shell metacharacters, newlines, and null bytes
  if (/[;&|`$(){}[\]<>!*?#~\r\n\0]/.test(projectPath)) {
    return false;
  }
  return existsSync(projectPath);
}

/**
 * Check if a directory is a git repository.
 */
export async function isGitRepo(projectPath: string): Promise<boolean> {
  if (!isValidProjectPath(projectPath)) {
    return false;
  }
  try {
    const result = await $`git -C ${projectPath} rev-parse --git-dir`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export interface CaptureGitDiffOptions {
  /**
   * If provided, only include untracked files that are in this set.
   * File paths should be absolute paths.
   * This prevents accidentally uploading unrelated untracked files.
   */
  allowedUntrackedFiles?: Set<string>;
}

/**
 * Capture the current git diff for a project.
 * Returns the combined diff of staged, unstaged, and (optionally filtered) untracked files.
 * Returns null if the directory is not a git repo or an error occurs.
 */
export async function captureGitDiff(
  projectPath: string,
  options?: CaptureGitDiffOptions
): Promise<string | null> {
  try {
    // Check if it's a git repo
    if (!(await isGitRepo(projectPath))) {
      return null;
    }

    // Get diff of tracked files (staged + unstaged) against HEAD
    const trackedDiff = await $`git -C ${projectPath} diff HEAD`.text();

    // Get list of untracked files
    const untrackedFiles = await $`git -C ${projectPath} ls-files --others --exclude-standard`.text();

    // Generate diff for untracked files
    let untrackedDiff = "";
    if (untrackedFiles.trim()) {
      const files = untrackedFiles.trim().split("\n");
      for (const file of files) {
        // Construct the absolute path for this file
        const absolutePath = join(projectPath, file);

        // If allowedUntrackedFiles is provided, only include files in the set
        if (options?.allowedUntrackedFiles) {
          if (!options.allowedUntrackedFiles.has(absolutePath)) {
            continue; // Skip untracked files not modified by the session
          }
        }

        try {
          // Read file content and generate a "new file" diff
          const content = await Bun.file(absolutePath).text();

          // Split into lines, handling trailing newline properly
          let lines = content.split("\n");

          // If file ends with newline, remove the empty string at the end
          // (the newline is implicit in diff format)
          if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines = lines.slice(0, -1);
          }

          // Skip empty files
          if (lines.length === 0) {
            continue;
          }

          untrackedDiff += `diff --git a/${file} b/${file}\n`;
          untrackedDiff += `new file mode 100644\n`;
          untrackedDiff += `--- /dev/null\n`;
          untrackedDiff += `+++ b/${file}\n`;
          untrackedDiff += `@@ -0,0 +1,${lines.length} @@\n`;
          for (const line of lines) {
            untrackedDiff += `+${line}\n`;
          }
        } catch {
          // Skip files that can't be read (binary, permissions, etc.)
        }
      }
    }

    const combinedDiff = trackedDiff + untrackedDiff;
    return combinedDiff || null;
  } catch {
    return null;
  }
}

/**
 * Get the normalized repository identifier for access control.
 * Returns the normalized git remote URL, or the absolute repo root path for local repos.
 * Parallelizes git subprocess calls for better performance.
 */
export async function getRepoIdentifier(projectPath: string): Promise<string | null> {
  if (!isValidProjectPath(projectPath)) {
    return null;
  }

  // Run git commands in parallel for better performance
  // Both commands will fail if not a git repo, so we don't need separate isGitRepo check
  const [remoteUrl, rootPath] = await Promise.all([
    getGitRemoteUrl(projectPath),
    getGitRootPath(projectPath),
  ]);

  // If remote URL exists, prefer it (normalized)
  if (remoteUrl) {
    return normalizeRemoteUrl(remoteUrl);
  }

  // Fallback: use repository root path for local-only repos
  // (null if not a git repo)
  return rootPath;
}

/**
 * Get the origin remote URL for a repository.
 */
export async function getGitRemoteUrl(projectPath: string): Promise<string | null> {
  if (!isValidProjectPath(projectPath)) {
    return null;
  }

  try {
    const result = await $`git -C ${projectPath} remote get-url origin`.quiet();
    if (result.exitCode === 0) {
      return result.text().trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the root path of a git repository.
 */
export async function getGitRootPath(projectPath: string): Promise<string | null> {
  if (!isValidProjectPath(projectPath)) {
    return null;
  }

  try {
    const result = await $`git -C ${projectPath} rev-parse --show-toplevel`.quiet();
    if (result.exitCode === 0) {
      return result.text().trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the current git branch name.
 * Returns null if not a git repo or in detached HEAD state.
 */
export async function getCurrentBranch(projectPath: string): Promise<string | null> {
  if (!isValidProjectPath(projectPath)) {
    return null;
  }

  try {
    const result = await $`git -C ${projectPath} rev-parse --abbrev-ref HEAD`.quiet();
    if (result.exitCode === 0) {
      const branch = result.text().trim();
      // Return null for detached HEAD state
      if (branch === "HEAD") {
        return null;
      }
      return branch;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the HTTPS URL for a repository (for display/linking purposes).
 * Converts SSH URLs to HTTPS format.
 *
 * Examples:
 *   git@github.com:org/repo.git -> https://github.com/org/repo
 *   https://github.com/org/repo.git -> https://github.com/org/repo
 *
 * Returns null if not a git repo or no remote URL.
 */
export async function getRepoHttpsUrl(projectPath: string): Promise<string | null> {
  const remoteUrl = await getGitRemoteUrl(projectPath);
  if (!remoteUrl) {
    return null;
  }

  // Convert SSH format to HTTPS
  // git@github.com:user/repo.git -> https://github.com/user/repo
  if (remoteUrl.startsWith("git@github.com:")) {
    return remoteUrl
      .replace("git@github.com:", "https://github.com/")
      .replace(/\.git$/, "");
  }

  // Already HTTPS or other format, just clean up .git suffix
  if (remoteUrl.includes("github.com")) {
    return remoteUrl.replace(/\.git$/, "");
  }

  // For other hosts, return as-is (may need protocol added)
  return remoteUrl.replace(/\.git$/, "");
}

/**
 * Normalize a git remote URL to a canonical identifier.
 *
 * Examples:
 *   git@github.com:org/repo.git -> github.com/org/repo
 *   https://github.com/org/repo.git -> github.com/org/repo
 *   ssh://git@github.com/org/repo -> github.com/org/repo
 */
export function normalizeRemoteUrl(remoteUrl: string): string {
  let url = remoteUrl.trim();

  // Handle SSH format: git@hostname:path
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch && sshMatch[1] && sshMatch[2]) {
    const hostname = sshMatch[1];
    const path = sshMatch[2];
    url = `${hostname.toLowerCase()}/${path}`;
  } else {
    // Handle HTTPS/SSH URL format
    // Remove protocol
    url = url.replace(/^(https?|ssh|git):\/\//, "");
    // Remove user@ prefix (e.g., git@)
    url = url.replace(/^[^@]+@/, "");

    // Lowercase hostname (first segment before /)
    const slashIndex = url.indexOf("/");
    if (slashIndex > 0) {
      const hostname = url.slice(0, slashIndex).toLowerCase();
      const path = url.slice(slashIndex + 1);
      url = `${hostname}/${path}`;
    } else {
      // No slash found - entire string is hostname, lowercase it
      url = url.toLowerCase();
    }
  }

  // Strip .git suffix
  url = url.replace(/\.git$/, "");

  return url;
}
