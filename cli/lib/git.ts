/**
 * Git utilities for capturing diffs during live sessions.
 */

import { $ } from "bun";

/**
 * Check if a directory is a git repository.
 */
export async function isGitRepo(projectPath: string): Promise<boolean> {
  try {
    const result = await $`git -C ${projectPath} rev-parse --git-dir`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Capture the current git diff for a project.
 * Returns the combined diff of staged, unstaged, and untracked files.
 * Returns null if the directory is not a git repo or an error occurs.
 */
export async function captureGitDiff(projectPath: string): Promise<string | null> {
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
        try {
          // Read file content and generate a "new file" diff
          const content = await Bun.file(`${projectPath}/${file}`).text();

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
