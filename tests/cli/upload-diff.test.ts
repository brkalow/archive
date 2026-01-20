import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { $ } from "bun";
import { getUntrackedFilesDiff } from "../../cli/commands/upload";

const TEST_DIR = join(import.meta.dir, ".test-upload-diff");

describe("Upload Diff - Untracked Files", () => {
  beforeEach(async () => {
    // Clean up any previous test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    // Create test directory and initialize git repo
    mkdirSync(TEST_DIR, { recursive: true });
    await $`git -C ${TEST_DIR} init`.quiet();
    await $`git -C ${TEST_DIR} config user.email "test@test.com"`.quiet();
    await $`git -C ${TEST_DIR} config user.name "Test User"`.quiet();
    // Create initial commit
    writeFileSync(join(TEST_DIR, "initial.txt"), "initial content\n");
    await $`git -C ${TEST_DIR} add initial.txt`.quiet();
    await $`git -C ${TEST_DIR} commit -m "initial commit"`.quiet();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("getUntrackedFilesDiff", () => {
    test("returns empty string when no untracked files", async () => {
      const result = await getUntrackedFilesDiff(TEST_DIR, ["somefile.txt"]);
      expect(result).toBe("");
    });

    test("returns empty string when untracked files not in touched list", async () => {
      // Create an untracked file
      writeFileSync(join(TEST_DIR, "untracked.txt"), "untracked content\n");

      // Request diff for a different file
      const result = await getUntrackedFilesDiff(TEST_DIR, ["other.txt"]);
      expect(result).toBe("");
    });

    test("generates diff for untracked file in touched list", async () => {
      // Create an untracked file
      writeFileSync(join(TEST_DIR, "newfile.txt"), "line1\nline2\nline3\n");

      const result = await getUntrackedFilesDiff(TEST_DIR, ["newfile.txt"]);

      expect(result).toContain("diff --git a/newfile.txt b/newfile.txt");
      expect(result).toContain("new file mode 100644");
      expect(result).toContain("--- /dev/null");
      expect(result).toContain("+++ b/newfile.txt");
      expect(result).toContain("@@ -0,0 +1,3 @@");
      expect(result).toContain("+line1");
      expect(result).toContain("+line2");
      expect(result).toContain("+line3");
    });

    test("filters untracked files to only those in touched list", async () => {
      // Create multiple untracked files
      writeFileSync(join(TEST_DIR, "included.txt"), "included\n");
      writeFileSync(join(TEST_DIR, "excluded.txt"), "excluded\n");

      const result = await getUntrackedFilesDiff(TEST_DIR, ["included.txt"]);

      expect(result).toContain("included.txt");
      expect(result).not.toContain("excluded.txt");
    });

    test("handles multiple touched untracked files", async () => {
      writeFileSync(join(TEST_DIR, "file1.txt"), "content1\n");
      writeFileSync(join(TEST_DIR, "file2.txt"), "content2\n");

      const result = await getUntrackedFilesDiff(TEST_DIR, ["file1.txt", "file2.txt"]);

      expect(result).toContain("diff --git a/file1.txt b/file1.txt");
      expect(result).toContain("diff --git a/file2.txt b/file2.txt");
    });

    test("handles files in subdirectories", async () => {
      mkdirSync(join(TEST_DIR, "subdir"), { recursive: true });
      writeFileSync(join(TEST_DIR, "subdir", "nested.txt"), "nested content\n");

      const result = await getUntrackedFilesDiff(TEST_DIR, ["subdir/nested.txt"]);

      expect(result).toContain("diff --git a/subdir/nested.txt b/subdir/nested.txt");
      expect(result).toContain("+nested content");
    });

    test("normalizes paths with leading ./", async () => {
      writeFileSync(join(TEST_DIR, "dotslash.txt"), "content\n");

      // Request with ./ prefix
      const result = await getUntrackedFilesDiff(TEST_DIR, ["./dotslash.txt"]);

      expect(result).toContain("diff --git a/dotslash.txt b/dotslash.txt");
    });

    test("skips empty files", async () => {
      writeFileSync(join(TEST_DIR, "empty.txt"), "");

      const result = await getUntrackedFilesDiff(TEST_DIR, ["empty.txt"]);

      expect(result).toBe("");
    });

    test("handles file without trailing newline", async () => {
      writeFileSync(join(TEST_DIR, "nonewline.txt"), "no trailing newline");

      const result = await getUntrackedFilesDiff(TEST_DIR, ["nonewline.txt"]);

      expect(result).toContain("@@ -0,0 +1,1 @@");
      expect(result).toContain("+no trailing newline");
    });

    test("handles file with multiple trailing newlines", async () => {
      writeFileSync(join(TEST_DIR, "multinewline.txt"), "line1\n\n\n");

      const result = await getUntrackedFilesDiff(TEST_DIR, ["multinewline.txt"]);

      // Should have 3 lines: "line1", "", ""
      expect(result).toContain("@@ -0,0 +1,3 @@");
    });

    test("skips binary files containing null bytes", async () => {
      // Create a file with null bytes (binary)
      writeFileSync(join(TEST_DIR, "binary.dat"), "some\0binary\0content");
      // Create a text file that should be included
      writeFileSync(join(TEST_DIR, "readme.txt"), "text content\n");

      const result = await getUntrackedFilesDiff(TEST_DIR, [
        "binary.dat",
        "readme.txt",
      ]);

      // Binary file should be skipped
      expect(result).not.toContain("binary.dat");
      // Text file should be included
      expect(result).toContain("readme.txt");
      expect(result).toContain("+text content");
    });

    test("includes files with binary-looking extensions but text content", async () => {
      // A .bin file that's actually text should be included
      writeFileSync(join(TEST_DIR, "data.bin"), "this is actually text\n");

      const result = await getUntrackedFilesDiff(TEST_DIR, ["data.bin"]);

      // Should be included because content has no null bytes
      expect(result).toContain("data.bin");
      expect(result).toContain("+this is actually text");
    });
  });

  describe("combined diff behavior", () => {
    test("git diff HEAD does not include untracked files", async () => {
      // Modify a tracked file
      writeFileSync(join(TEST_DIR, "initial.txt"), "modified content\n");
      // Create an untracked file
      writeFileSync(join(TEST_DIR, "newfile.txt"), "new content\n");

      const trackedDiff = await $`git -C ${TEST_DIR} diff HEAD`.text();

      // Tracked modification shows up
      expect(trackedDiff).toContain("initial.txt");
      expect(trackedDiff).toContain("-initial content");
      expect(trackedDiff).toContain("+modified content");

      // Untracked file does NOT show up in git diff
      expect(trackedDiff).not.toContain("newfile.txt");
    });

    test("ls-files --others shows untracked files", async () => {
      writeFileSync(join(TEST_DIR, "untracked1.txt"), "content1\n");
      writeFileSync(join(TEST_DIR, "untracked2.txt"), "content2\n");

      const untrackedList = await $`git -C ${TEST_DIR} ls-files --others --exclude-standard`.text();

      expect(untrackedList).toContain("untracked1.txt");
      expect(untrackedList).toContain("untracked2.txt");
      // Tracked file should not appear
      expect(untrackedList).not.toContain("initial.txt");
    });
  });
});
