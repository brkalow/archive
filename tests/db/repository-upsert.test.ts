import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../../src/db/schema";
import { SessionRepository } from "../../src/db/repository";
import { unlinkSync, existsSync } from "fs";

const TEST_DB_PATH = "data/test-upsert.db";

describe("SessionRepository upsert", () => {
  let db: Database;
  let repo: SessionRepository;

  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    db = initializeDatabase(TEST_DB_PATH);
    repo = new SessionRepository(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  describe("getSessionByClaudeSessionId", () => {
    test("returns null when no session exists", () => {
      const result = repo.getSessionByClaudeSessionId("nonexistent-uuid");
      expect(result).toBeNull();
    });

    test("finds session by claude_session_id", () => {
      repo.createSession({
        id: "sess_123",
        title: "Test Session",
        description: null,
        claude_session_id: "uuid-12345",
        pr_url: null,
        share_token: null,
        project_path: null,
        model: null,
        harness: null,
        repo_url: null,
        status: "archived",
        last_activity_at: null,
      });

      const result = repo.getSessionByClaudeSessionId("uuid-12345");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("sess_123");
      expect(result!.claude_session_id).toBe("uuid-12345");
    });
  });

  describe("upsertSessionWithDataAndReview", () => {
    test("creates new session when claude_session_id does not exist", () => {
      const { session, isUpdate } = repo.upsertSessionWithDataAndReview(
        {
          id: "sess_new",
          title: "New Session",
          description: "A new session",
          claude_session_id: "uuid-new",
          pr_url: null,
          share_token: null,
          project_path: "/path/to/project",
          model: "claude-3",
          harness: "claude-code",
          repo_url: null,
          status: "archived",
          last_activity_at: null,
        },
        [
          {
            session_id: "sess_new",
            role: "user",
            content: "Hello",
            content_blocks: [{ type: "text", text: "Hello" }],
            timestamp: "2024-01-01T00:00:00Z",
            message_index: 0,
          },
        ],
        [],
        undefined,
        "client-123"
      );

      expect(isUpdate).toBe(false);
      expect(session.id).toBe("sess_new");
      expect(session.title).toBe("New Session");

      const messages = repo.getMessages("sess_new");
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe("Hello");
    });

    test("updates existing session when claude_session_id matches", () => {
      // First, create initial session
      repo.upsertSessionWithDataAndReview(
        {
          id: "sess_original",
          title: "Original Title",
          description: "Original description",
          claude_session_id: "uuid-existing",
          pr_url: null,
          share_token: null,
          project_path: "/original/path",
          model: "claude-2",
          harness: "claude-code",
          repo_url: null,
          status: "archived",
          last_activity_at: null,
        },
        [
          {
            session_id: "sess_original",
            role: "user",
            content: "Original message",
            content_blocks: [{ type: "text", text: "Original message" }],
            timestamp: "2024-01-01T00:00:00Z",
            message_index: 0,
          },
        ],
        [],
        undefined,
        "client-123"
      );

      // Now upsert with same claude_session_id
      const { session, isUpdate } = repo.upsertSessionWithDataAndReview(
        {
          id: "sess_should_not_be_used",
          title: "Updated Title",
          description: "Updated description",
          claude_session_id: "uuid-existing",
          pr_url: "https://github.com/pr/1",
          share_token: null,
          project_path: "/updated/path",
          model: "claude-3",
          harness: "claude-code",
          repo_url: null,
          status: "archived",
          last_activity_at: null,
        },
        [
          {
            session_id: "sess_should_not_be_used",
            role: "user",
            content: "Updated message 1",
            content_blocks: [{ type: "text", text: "Updated message 1" }],
            timestamp: "2024-01-02T00:00:00Z",
            message_index: 0,
          },
          {
            session_id: "sess_should_not_be_used",
            role: "assistant",
            content: "Updated message 2",
            content_blocks: [{ type: "text", text: "Updated message 2" }],
            timestamp: "2024-01-02T00:00:01Z",
            message_index: 1,
          },
        ],
        [],
        undefined,
        "client-123"
      );

      expect(isUpdate).toBe(true);
      // Should keep the original session ID
      expect(session.id).toBe("sess_original");
      // Should update the title and other metadata
      expect(session.title).toBe("Updated Title");
      expect(session.description).toBe("Updated description");
      expect(session.pr_url).toBe("https://github.com/pr/1");
      expect(session.project_path).toBe("/updated/path");
      expect(session.model).toBe("claude-3");

      // Should have the new messages (old ones cleared)
      const messages = repo.getMessages("sess_original");
      expect(messages.length).toBe(2);
      expect(messages[0].content).toBe("Updated message 1");
      expect(messages[1].content).toBe("Updated message 2");
    });

    test("creates new session when claude_session_id is null", () => {
      const { session, isUpdate } = repo.upsertSessionWithDataAndReview(
        {
          id: "sess_no_uuid",
          title: "No UUID Session",
          description: null,
          claude_session_id: null,
          pr_url: null,
          share_token: null,
          project_path: null,
          model: null,
          harness: null,
          repo_url: null,
          status: "archived",
          last_activity_at: null,
        },
        [],
        [],
        undefined,
        "client-123"
      );

      expect(isUpdate).toBe(false);
      expect(session.id).toBe("sess_no_uuid");
    });

    test("preserves existing diffs for touched files not covered by new diffs", () => {
      // First, create session with 4 diffs (simulating full diff from first upload)
      repo.upsertSessionWithDataAndReview(
        {
          id: "sess_diffs",
          title: "Session with Diffs",
          description: null,
          claude_session_id: "uuid-diffs-test",
          pr_url: null,
          share_token: null,
          project_path: "/project",
          model: null,
          harness: "claude-code",
          repo_url: null,
          status: "archived",
          last_activity_at: null,
        },
        [],
        [
          {
            session_id: "sess_diffs",
            filename: "src/db/schema.ts",
            diff_content: "diff --git a/src/db/schema.ts b/src/db/schema.ts\n+// schema changes",
            diff_index: 0,
            additions: 1,
            deletions: 0,
            is_session_relevant: true,
          },
          {
            session_id: "sess_diffs",
            filename: "src/db/repository.ts",
            diff_content: "diff --git a/src/db/repository.ts b/src/db/repository.ts\n+// repo changes",
            diff_index: 1,
            additions: 1,
            deletions: 0,
            is_session_relevant: true,
          },
          {
            session_id: "sess_diffs",
            filename: "src/routes/api.ts",
            diff_content: "diff --git a/src/routes/api.ts b/src/routes/api.ts\n+// api changes",
            diff_index: 2,
            additions: 1,
            deletions: 0,
            is_session_relevant: true,
          },
          {
            session_id: "sess_diffs",
            filename: "tests/db/test.ts",
            diff_content: "diff --git a/tests/db/test.ts b/tests/db/test.ts\n+// test changes",
            diff_index: 3,
            additions: 1,
            deletions: 0,
            is_session_relevant: true,
          },
        ],
        undefined,
        "client-123"
      );

      // Verify initial state: 4 diffs
      let diffs = repo.getDiffs("sess_diffs");
      expect(diffs.length).toBe(4);

      // Now upsert with only 1 diff (simulating re-upload after some files were committed)
      // But we pass touchedFiles indicating all 4 files were modified in the session
      const touchedFiles = new Set([
        "src/db/schema.ts",
        "src/db/repository.ts",
        "src/routes/api.ts",
        "tests/db/test.ts",
      ]);

      const { session, isUpdate } = repo.upsertSessionWithDataAndReview(
        {
          id: "sess_new_id",
          title: "Updated Session",
          description: null,
          claude_session_id: "uuid-diffs-test",
          pr_url: null,
          share_token: null,
          project_path: "/project",
          model: null,
          harness: "claude-code",
          repo_url: null,
          status: "archived",
          last_activity_at: null,
        },
        [],
        [
          // Only 1 diff in new upload (repository.ts with updated content)
          {
            session_id: "sess_new_id",
            filename: "src/db/repository.ts",
            diff_content: "diff --git a/src/db/repository.ts b/src/db/repository.ts\n+// newer repo changes",
            diff_index: 0,
            additions: 2,
            deletions: 0,
            is_session_relevant: true,
          },
        ],
        undefined,
        "client-123",
        touchedFiles
      );

      expect(isUpdate).toBe(true);
      expect(session.id).toBe("sess_diffs");

      // Should have 4 diffs total:
      // - 1 new diff (repository.ts with updated content)
      // - 3 preserved diffs (schema.ts, api.ts, test.ts from existing)
      diffs = repo.getDiffs("sess_diffs");
      expect(diffs.length).toBe(4);

      // The new repository.ts diff should have the updated content
      const repoDiff = diffs.find(d => d.filename === "src/db/repository.ts");
      expect(repoDiff).toBeDefined();
      expect(repoDiff!.diff_content).toContain("newer repo changes");
      expect(repoDiff!.additions).toBe(2);

      // The preserved diffs should still be there
      const schemaDiff = diffs.find(d => d.filename === "src/db/schema.ts");
      expect(schemaDiff).toBeDefined();
      expect(schemaDiff!.diff_content).toContain("schema changes");

      const apiDiff = diffs.find(d => d.filename === "src/routes/api.ts");
      expect(apiDiff).toBeDefined();
      expect(apiDiff!.diff_content).toContain("api changes");

      const testDiff = diffs.find(d => d.filename === "tests/db/test.ts");
      expect(testDiff).toBeDefined();
      expect(testDiff!.diff_content).toContain("test changes");
    });

    test("does not preserve diffs for files not in touchedFiles", () => {
      // Create session with a diff for a file that won't be in touchedFiles
      repo.upsertSessionWithDataAndReview(
        {
          id: "sess_extra",
          title: "Session with Extra Diff",
          description: null,
          claude_session_id: "uuid-extra-test",
          pr_url: null,
          share_token: null,
          project_path: "/project",
          model: null,
          harness: "claude-code",
          repo_url: null,
          status: "archived",
          last_activity_at: null,
        },
        [],
        [
          {
            session_id: "sess_extra",
            filename: "src/file1.ts",
            diff_content: "diff --git a/src/file1.ts b/src/file1.ts\n+// file1",
            diff_index: 0,
            additions: 1,
            deletions: 0,
            is_session_relevant: true,
          },
          {
            session_id: "sess_extra",
            filename: "src/unrelated.ts",
            diff_content: "diff --git a/src/unrelated.ts b/src/unrelated.ts\n+// unrelated",
            diff_index: 1,
            additions: 1,
            deletions: 0,
            is_session_relevant: false,
          },
        ],
        undefined,
        "client-123"
      );

      // Upsert with empty diffs but touchedFiles only includes file1.ts
      const touchedFiles = new Set(["src/file1.ts"]);

      repo.upsertSessionWithDataAndReview(
        {
          id: "sess_new",
          title: "Updated",
          description: null,
          claude_session_id: "uuid-extra-test",
          pr_url: null,
          share_token: null,
          project_path: "/project",
          model: null,
          harness: "claude-code",
          repo_url: null,
          status: "archived",
          last_activity_at: null,
        },
        [],
        [], // No new diffs
        undefined,
        "client-123",
        touchedFiles
      );

      // Should only preserve file1.ts (which is in touchedFiles)
      // unrelated.ts should NOT be preserved (not in touchedFiles)
      const diffs = repo.getDiffs("sess_extra");
      expect(diffs.length).toBe(1);
      expect(diffs[0].filename).toBe("src/file1.ts");
    });
  });
});
