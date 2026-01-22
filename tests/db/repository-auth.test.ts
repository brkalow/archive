import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initializeDatabase } from "../../src/db/schema";
import { SessionRepository } from "../../src/db/repository";
import { Database } from "bun:sqlite";

describe("SessionRepository - Client Ownership", () => {
  let db: Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = initializeDatabase(":memory:");
    repo = new SessionRepository(db);
  });

  afterEach(() => {
    db?.close();
  });

  describe("verifyClientOwnership", () => {
    test("returns true for matching client ID", () => {
      const session = repo.createSession(
        {
          id: "test_session",
          title: "Test",
          description: null,
          claude_session_id: null,
          pr_url: null,
          share_token: null,
          project_path: "/tmp",
          model: null,
          harness: null,
          repo_url: null,
          status: "live",
          last_activity_at: null,
          interactive: false,
        },
        "owner-client-123"
      );

      expect(repo.verifyClientOwnership(session.id, "owner-client-123")).toBe(true);
    });

    test("returns false for wrong client ID", () => {
      const session = repo.createSession(
        {
          id: "test_session",
          title: "Test",
          description: null,
          claude_session_id: null,
          pr_url: null,
          share_token: null,
          project_path: "/tmp",
          model: null,
          harness: null,
          repo_url: null,
          status: "live",
          last_activity_at: null,
          interactive: false,
        },
        "owner-client-123"
      );

      expect(repo.verifyClientOwnership(session.id, "other-client-456")).toBe(false);
    });

    test("returns false for null client ID", () => {
      const session = repo.createSession(
        {
          id: "test_session",
          title: "Test",
          description: null,
          claude_session_id: null,
          pr_url: null,
          share_token: null,
          project_path: "/tmp",
          model: null,
          harness: null,
          repo_url: null,
          status: "live",
          last_activity_at: null,
          interactive: false,
        },
        "owner-client-123"
      );

      expect(repo.verifyClientOwnership(session.id, null)).toBe(false);
    });

    test("returns true for legacy sessions without client_id", () => {
      // Create session without client ID (legacy behavior)
      const session = repo.createSession({
        id: "legacy_session",
        title: "Legacy",
        description: null,
        claude_session_id: null,
        pr_url: null,
        share_token: null,
        project_path: "/tmp",
        model: null,
        harness: null,
        repo_url: null,
        status: "live",
        last_activity_at: null,
        interactive: false,
      });

      // Any authenticated client should be able to access legacy sessions
      expect(repo.verifyClientOwnership(session.id, "any-client")).toBe(true);
    });

    test("returns false for non-existent session", () => {
      expect(repo.verifyClientOwnership("nonexistent", "any-client")).toBe(false);
    });

    describe("requireLive parameter", () => {
      test("returns false for complete session when requireLive=true", () => {
        const session = repo.createSession(
          {
            id: "test_session",
            title: "Test",
            description: null,
            claude_session_id: null,
            pr_url: null,
            share_token: null,
            project_path: "/tmp",
            model: null,
            harness: null,
            repo_url: null,
            status: "live",
            last_activity_at: null,
            interactive: false,
          },
          "owner-client-123"
        );

        // Complete the session
        repo.updateSession(session.id, { status: "complete" });

        // Should fail with requireLive=true (default)
        expect(repo.verifyClientOwnership(session.id, "owner-client-123", true)).toBe(false);
      });

      test("returns true for complete session when requireLive=false", () => {
        const session = repo.createSession(
          {
            id: "test_session",
            title: "Test",
            description: null,
            claude_session_id: null,
            pr_url: null,
            share_token: null,
            project_path: "/tmp",
            model: null,
            harness: null,
            repo_url: null,
            status: "live",
            last_activity_at: null,
            interactive: false,
          },
          "owner-client-123"
        );

        // Complete the session
        repo.updateSession(session.id, { status: "complete" });

        // Should succeed with requireLive=false
        expect(repo.verifyClientOwnership(session.id, "owner-client-123", false)).toBe(true);
      });

      test("returns true for live session regardless of requireLive", () => {
        const session = repo.createSession(
          {
            id: "test_session",
            title: "Test",
            description: null,
            claude_session_id: null,
            pr_url: null,
            share_token: null,
            project_path: "/tmp",
            model: null,
            harness: null,
            repo_url: null,
            status: "live",
            last_activity_at: null,
            interactive: false,
          },
          "owner-client-123"
        );

        expect(repo.verifyClientOwnership(session.id, "owner-client-123", true)).toBe(true);
        expect(repo.verifyClientOwnership(session.id, "owner-client-123", false)).toBe(true);
      });
    });
  });

  describe("restoreSessionToLive", () => {
    test("restores complete session to live status", () => {
      const session = repo.createSession(
        {
          id: "test_session",
          title: "Test",
          description: null,
          claude_session_id: null,
          pr_url: null,
          share_token: null,
          project_path: "/tmp",
          model: null,
          harness: null,
          repo_url: null,
          status: "complete",
          last_activity_at: null,
          interactive: false,
        },
        "owner-client"
      );

      expect(session.status).toBe("complete");

      const result = repo.restoreSessionToLive(session.id);
      expect(result).toBe(true);

      const updated = repo.getSession(session.id);
      expect(updated.isOk()).toBe(true);
      expect(updated.unwrap().status).toBe("live");
    });

    test("returns false for non-existent session", () => {
      const result = repo.restoreSessionToLive("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("getRecentProjectPaths", () => {
    test("returns empty array when no userId or clientId provided", () => {
      expect(repo.getRecentProjectPaths()).toEqual([]);
      expect(repo.getRecentProjectPaths(undefined, undefined)).toEqual([]);
    });

    test("returns distinct project paths", () => {
      // Create sessions with different project paths
      repo.createSession({
        id: "session_1",
        title: "First",
        description: null,
        claude_session_id: null,
        pr_url: null,
        share_token: null,
        project_path: "/path/a",
        model: null,
        harness: null,
        repo_url: null,
        status: "complete",
        last_activity_at: null,
        interactive: false,
      }, "client-123");

      repo.createSession({
        id: "session_2",
        title: "Second",
        description: null,
        claude_session_id: null,
        pr_url: null,
        share_token: null,
        project_path: "/path/b",
        model: null,
        harness: null,
        repo_url: null,
        status: "complete",
        last_activity_at: null,
        interactive: false,
      }, "client-123");

      repo.createSession({
        id: "session_3",
        title: "Third",
        description: null,
        claude_session_id: null,
        pr_url: null,
        share_token: null,
        project_path: "/path/a", // Same path as first session
        model: null,
        harness: null,
        repo_url: null,
        status: "complete",
        last_activity_at: null,
        interactive: false,
      }, "client-123");

      const paths = repo.getRecentProjectPaths(undefined, "client-123");
      // Should have 2 distinct paths
      expect(paths).toHaveLength(2);
      expect(paths).toContain("/path/a");
      expect(paths).toContain("/path/b");
    });

    test("excludes sessions with null project_path", () => {
      repo.createSession({
        id: "session_1",
        title: "With path",
        description: null,
        claude_session_id: null,
        pr_url: null,
        share_token: null,
        project_path: "/valid/path",
        model: null,
        harness: null,
        repo_url: null,
        status: "complete",
        last_activity_at: null,
        interactive: false,
      }, "client-123");

      repo.createSession({
        id: "session_2",
        title: "Without path",
        description: null,
        claude_session_id: null,
        pr_url: null,
        share_token: null,
        project_path: null,
        model: null,
        harness: null,
        repo_url: null,
        status: "complete",
        last_activity_at: null,
        interactive: false,
      }, "client-123");

      const paths = repo.getRecentProjectPaths(undefined, "client-123");
      expect(paths).toEqual(["/valid/path"]);
    });

    test("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        repo.createSession({
          id: `session_${i}`,
          title: `Session ${i}`,
          description: null,
          claude_session_id: null,
          pr_url: null,
          share_token: null,
          project_path: `/path/${i}`,
          model: null,
          harness: null,
          repo_url: null,
          status: "complete",
          last_activity_at: null,
          interactive: false,
        }, "client-123");
      }

      const paths = repo.getRecentProjectPaths(undefined, "client-123", 3);
      expect(paths).toHaveLength(3);
    });

    test("filters by userId when provided", () => {
      repo.createSession({
        id: "user_session",
        title: "User session",
        description: null,
        claude_session_id: null,
        pr_url: null,
        share_token: null,
        project_path: "/user/path",
        model: null,
        harness: null,
        repo_url: null,
        status: "complete",
        last_activity_at: null,
        interactive: false,
      }, undefined, "user-123");

      repo.createSession({
        id: "other_session",
        title: "Other session",
        description: null,
        claude_session_id: null,
        pr_url: null,
        share_token: null,
        project_path: "/other/path",
        model: null,
        harness: null,
        repo_url: null,
        status: "complete",
        last_activity_at: null,
        interactive: false,
      }, "client-456");

      const paths = repo.getRecentProjectPaths("user-123");
      expect(paths).toEqual(["/user/path"]);
    });
  });
});
