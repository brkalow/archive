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
  // Reject paths with shell metacharacters
  if (/[;&|`$(){}[\]<>!*?#~]/.test(projectPath)) {
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
