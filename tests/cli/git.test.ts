import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getCurrentBranch, getRepoHttpsUrl, isGitRepo } from "../../cli/lib/git";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Git utilities", () => {
  let tempDir: string;
  let gitDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "git-util-test-"));
    gitDir = mkdtempSync(join(tmpdir(), "git-repo-test-"));

    // Initialize git repo
    Bun.spawnSync(["git", "init"], { cwd: gitDir });
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: gitDir });
    Bun.spawnSync(["git", "config", "user.name", "Test User"], { cwd: gitDir });

    // Create initial commit to establish a branch
    writeFileSync(join(gitDir, "README.md"), "# Test");
    Bun.spawnSync(["git", "add", "."], { cwd: gitDir });
    Bun.spawnSync(["git", "commit", "-m", "Initial commit"], { cwd: gitDir });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
      rmSync(gitDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("isGitRepo", () => {
    test("returns true for git repository", async () => {
      expect(await isGitRepo(gitDir)).toBe(true);
    });

    test("returns false for non-git directory", async () => {
      expect(await isGitRepo(tempDir)).toBe(false);
    });

    test("returns false for nonexistent directory", async () => {
      expect(await isGitRepo("/nonexistent/path")).toBe(false);
    });
  });

  describe("getCurrentBranch", () => {
    test("returns branch name for git repository", async () => {
      // Default branch after init is usually 'main' or 'master'
      const branch = await getCurrentBranch(gitDir);
      expect(branch).toBeTruthy();
      expect(typeof branch).toBe("string");
    });

    test("returns correct branch after checkout", async () => {
      // Create and checkout a new branch
      Bun.spawnSync(["git", "checkout", "-b", "feature-branch"], { cwd: gitDir });

      const branch = await getCurrentBranch(gitDir);
      expect(branch).toBe("feature-branch");
    });

    test("returns null for non-git directory", async () => {
      const branch = await getCurrentBranch(tempDir);
      expect(branch).toBeNull();
    });

    test("returns null for nonexistent directory", async () => {
      const branch = await getCurrentBranch("/nonexistent/path");
      expect(branch).toBeNull();
    });

    test("returns null for detached HEAD state", async () => {
      // Get current commit hash
      const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: gitDir });
      const commitHash = result.stdout.toString().trim();

      // Checkout the commit directly (detached HEAD)
      Bun.spawnSync(["git", "checkout", commitHash], { cwd: gitDir });

      const branch = await getCurrentBranch(gitDir);
      expect(branch).toBeNull();
    });

    test("handles branch names with special characters", async () => {
      // Create a branch with special characters
      Bun.spawnSync(["git", "checkout", "-b", "feature/add-login"], { cwd: gitDir });

      const branch = await getCurrentBranch(gitDir);
      expect(branch).toBe("feature/add-login");
    });
  });

  describe("getRepoHttpsUrl", () => {
    test("returns null for repo without remote", async () => {
      const url = await getRepoHttpsUrl(gitDir);
      expect(url).toBeNull();
    });

    test("returns null for non-git directory", async () => {
      const url = await getRepoHttpsUrl(tempDir);
      expect(url).toBeNull();
    });

    test("converts SSH remote to HTTPS", async () => {
      // Add SSH remote
      Bun.spawnSync(
        ["git", "remote", "add", "origin", "git@github.com:test/repo.git"],
        { cwd: gitDir }
      );

      const url = await getRepoHttpsUrl(gitDir);
      expect(url).toBe("https://github.com/test/repo");
    });

    test("handles HTTPS remote", async () => {
      // Add HTTPS remote
      Bun.spawnSync(
        ["git", "remote", "add", "origin", "https://github.com/test/repo.git"],
        { cwd: gitDir }
      );

      const url = await getRepoHttpsUrl(gitDir);
      expect(url).toBe("https://github.com/test/repo");
    });
  });
});
