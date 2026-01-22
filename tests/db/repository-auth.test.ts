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
          remote: false,
          agent_session_id: null,
          branch: null,
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
          remote: false,
          agent_session_id: null,
          branch: null,
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
          remote: false,
          agent_session_id: null,
          branch: null,
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
        remote: false,
        agent_session_id: null,
        branch: null,
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
            remote: false,
            agent_session_id: null,
            branch: null,
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
            remote: false,
            agent_session_id: null,
            branch: null,
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
            remote: false,
            agent_session_id: null,
            branch: null,
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
          remote: false,
          agent_session_id: null,
          branch: null,
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
});
