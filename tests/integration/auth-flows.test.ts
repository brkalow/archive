/**
 * Integration tests for authentication flows.
 *
 * These tests cover the user ID (Clerk) authentication, session claiming,
 * and the dual ownership model (user_id + client_id).
 *
 * NOTE: Tests that require actual Clerk interaction need manual setup:
 * - Set CLERK_SECRET_KEY environment variable
 * - Obtain valid test tokens from Clerk
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initializeDatabase } from "../../src/db/schema";
import { SessionRepository } from "../../src/db/repository";
import { Database } from "bun:sqlite";

describe("Auth Flows - Dual Ownership Model", () => {
  let db: Database;
  let repo: SessionRepository;
  let server: ReturnType<typeof Bun.serve>;
  let serverPort: number;

  beforeEach(async () => {
    db = initializeDatabase(":memory:");
    repo = new SessionRepository(db);

    const { createApiRoutes } = await import("../../src/routes/api");
    const api = createApiRoutes(repo);

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);

        // Sessions filtering
        if (url.pathname === "/api/sessions" && req.method === "GET") {
          return api.getSessions(req);
        }

        // Unclaimed sessions
        if (url.pathname === "/api/sessions/unclaimed" && req.method === "GET") {
          return api.getUnclaimedSessions(req);
        }

        // Claim sessions
        if (url.pathname === "/api/sessions/claim" && req.method === "POST") {
          return api.claimSessions(req);
        }

        // Live session creation
        if (url.pathname === "/api/sessions/live" && req.method === "POST") {
          return api.createLiveSession(req);
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    serverPort = server.port;
  });

  afterEach(() => {
    server?.stop();
    db?.close();
  });

  describe("verifyOwnership - dual ownership", () => {
    test("allows access by user_id match", () => {
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
        "client-123", // client_id
        "user-456"    // user_id
      );

      // User ID match should work - Result.isOk() means allowed
      const result = repo.verifyOwnership(session.id, "user-456", null);
      expect(result.isOk()).toBe(true);
      expect(result.unwrap().isOwner).toBe(true);
    });

    test("allows access by client_id match", () => {
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
        "client-123",
        "user-456"
      );

      // Client ID match should work
      const result = repo.verifyOwnership(session.id, null, "client-123");
      expect(result.isOk()).toBe(true);
      expect(result.unwrap().isOwner).toBe(true);
    });

    test("denies access when neither user_id nor client_id match", () => {
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
        "client-123",
        "user-456"
      );

      // Neither match should deny - Result.isErr() means not allowed
      const result = repo.verifyOwnership(session.id, "other-user", "other-client");
      expect(result.isErr()).toBe(true);
    });

    test("denies access to legacy sessions without matching owner", () => {
      // Session with no user_id or client_id (legacy)
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

      // Legacy sessions should NOT be accessible without matching owner
      const resultWithUser = repo.verifyOwnership(session.id, "any-user", null);
      expect(resultWithUser.isErr()).toBe(true);

      const resultWithClient = repo.verifyOwnership(session.id, null, "any-client");
      expect(resultWithClient.isErr()).toBe(true);
    });
  });

  describe("getSessionsByOwner - filtering", () => {
    beforeEach(() => {
      // Create sessions with various ownership
      repo.createSession(
        { id: "s1", title: "User A Client 1", description: null, claude_session_id: null, pr_url: null, share_token: null, project_path: "/tmp", model: null, harness: null, repo_url: null, status: "complete", last_activity_at: null, interactive: false },
        "client-1",
        "user-a"
      );
      repo.createSession(
        { id: "s2", title: "User A Client 2", description: null, claude_session_id: null, pr_url: null, share_token: null, project_path: "/tmp", model: null, harness: null, repo_url: null, status: "complete", last_activity_at: null, interactive: false },
        "client-2",
        "user-a"
      );
      repo.createSession(
        { id: "s3", title: "User B Client 1", description: null, claude_session_id: null, pr_url: null, share_token: null, project_path: "/tmp", model: null, harness: null, repo_url: null, status: "complete", last_activity_at: null, interactive: false },
        "client-1",
        "user-b"
      );
      repo.createSession(
        { id: "s4", title: "Client 1 only", description: null, claude_session_id: null, pr_url: null, share_token: null, project_path: "/tmp", model: null, harness: null, repo_url: null, status: "complete", last_activity_at: null, interactive: false },
        "client-1"
      );
    });

    test("returns sessions for user_id only", () => {
      const sessions = repo.getSessionsByOwner("user-a", undefined);
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.id).sort()).toEqual(["s1", "s2"]);
    });

    test("returns sessions for client_id only", () => {
      const sessions = repo.getSessionsByOwner(undefined, "client-1");
      expect(sessions).toHaveLength(3);
      expect(sessions.map(s => s.id).sort()).toEqual(["s1", "s3", "s4"]);
    });

    test("returns sessions for both user_id and client_id", () => {
      const sessions = repo.getSessionsByOwner("user-a", "client-1");
      // Should return sessions owned by user-a OR client-1
      expect(sessions).toHaveLength(4);
    });

    test("returns empty for no identity", () => {
      const sessions = repo.getSessionsByOwner(undefined, undefined);
      expect(sessions).toHaveLength(0);
    });
  });

  describe("session upload with user ID", () => {
    test("upsertSessionWithDataAndReview stores user_id when provided", () => {
      const { session } = repo.upsertSessionWithDataAndReview(
        {
          id: "upload_test_session",
          title: "Uploaded Session",
          description: null,
          claude_session_id: "claude_123",
          agent_session_id: "claude_123",
          pr_url: null,
          share_token: null,
          project_path: "/tmp",
          model: "claude-3-opus",
          harness: "claude-code",
          repo_url: null,
          status: "archived",
          last_activity_at: null,
          interactive: false,
        },
        [], // no messages
        [], // no diffs
        undefined, // no review
        "upload-client-123", // client_id
        "upload-user-456" // user_id
      );

      expect(session.id).toBe("upload_test_session");
      expect(session.client_id).toBe("upload-client-123");
      expect(session.user_id).toBe("upload-user-456");

      // Verify the session can be accessed by user_id
      const result = repo.verifyOwnership(session.id, "upload-user-456", null);
      expect(result.isOk()).toBe(true);
      expect(result.unwrap().isOwner).toBe(true);
    });

    test("upsertSessionWithDataAndReview works without user_id (client-only upload)", () => {
      const { session } = repo.upsertSessionWithDataAndReview(
        {
          id: "client_only_upload",
          title: "Client-Only Upload",
          description: null,
          claude_session_id: "claude_456",
          agent_session_id: "claude_456",
          pr_url: null,
          share_token: null,
          project_path: "/tmp",
          model: null,
          harness: null,
          repo_url: null,
          status: "archived",
          last_activity_at: null,
          interactive: false,
        },
        [],
        [],
        undefined,
        "client-only-123" // client_id only, no user_id
      );

      expect(session.client_id).toBe("client-only-123");
      expect(session.user_id).toBeNull();

      // Can still access by client_id
      const result = repo.verifyOwnership(session.id, null, "client-only-123");
      expect(result.isOk()).toBe(true);
    });
  });

  describe("session claiming", () => {
    beforeEach(() => {
      // Create unclaimed sessions (client_id only, no user_id)
      repo.createSession(
        { id: "unclaimed1", title: "Unclaimed 1", description: null, claude_session_id: null, pr_url: null, share_token: null, project_path: "/tmp", model: null, harness: null, repo_url: null, status: "complete", last_activity_at: null, interactive: false },
        "device-client"
      );
      repo.createSession(
        { id: "unclaimed2", title: "Unclaimed 2", description: null, claude_session_id: null, pr_url: null, share_token: null, project_path: "/tmp", model: null, harness: null, repo_url: null, status: "complete", last_activity_at: null, interactive: false },
        "device-client"
      );
      // Already claimed session
      repo.createSession(
        { id: "claimed", title: "Already Claimed", description: null, claude_session_id: null, pr_url: null, share_token: null, project_path: "/tmp", model: null, harness: null, repo_url: null, status: "complete", last_activity_at: null, interactive: false },
        "device-client",
        "existing-user"
      );
    });

    test("getUnclaimedSessions returns only sessions without user_id", () => {
      const unclaimed = repo.getUnclaimedSessions("device-client");
      expect(unclaimed).toHaveLength(2);
      expect(unclaimed.map(s => s.id).sort()).toEqual(["unclaimed1", "unclaimed2"]);
    });

    test("getUnclaimedSessions returns empty for other client", () => {
      const unclaimed = repo.getUnclaimedSessions("other-client");
      expect(unclaimed).toHaveLength(0);
    });

    test("claimSessions assigns user_id to unclaimed sessions", () => {
      const claimed = repo.claimSessions("device-client", "new-user");
      expect(claimed).toBe(2);

      // Verify the sessions are now claimed
      const session1Result = repo.getSession("unclaimed1");
      expect(session1Result.isOk()).toBe(true);
      expect(session1Result.unwrap().user_id).toBe("new-user");

      const session2Result = repo.getSession("unclaimed2");
      expect(session2Result.isOk()).toBe(true);
      expect(session2Result.unwrap().user_id).toBe("new-user");

      // Already claimed session should not change
      const claimedResult = repo.getSession("claimed");
      expect(claimedResult.isOk()).toBe(true);
      expect(claimedResult.unwrap().user_id).toBe("existing-user");
    });

    test("claimSessions returns 0 when no unclaimed sessions", () => {
      const claimed = repo.claimSessions("nonexistent-client", "new-user");
      expect(claimed).toBe(0);
    });

    test("setSessionUserId updates single session", () => {
      const result = repo.setSessionUserId("unclaimed1", "specific-user");
      expect(result).toBe(true);

      const sessionResult = repo.getSession("unclaimed1");
      expect(sessionResult.isOk()).toBe(true);
      expect(sessionResult.unwrap().user_id).toBe("specific-user");

      // Other session should remain unclaimed
      const otherResult = repo.getSession("unclaimed2");
      expect(otherResult.isOk()).toBe(true);
      expect(otherResult.unwrap().user_id).toBeNull();
    });
  });
});

describe("Auth Flows - API Endpoints", () => {
  let db: Database;
  let repo: SessionRepository;
  let server: ReturnType<typeof Bun.serve>;
  let serverPort: number;

  beforeEach(async () => {
    db = initializeDatabase(":memory:");
    repo = new SessionRepository(db);

    const { createApiRoutes } = await import("../../src/routes/api");
    const api = createApiRoutes(repo);

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/api/sessions/unclaimed" && req.method === "GET") {
          return api.getUnclaimedSessions(req);
        }

        if (url.pathname === "/api/sessions/claim" && req.method === "POST") {
          return api.claimSessions(req);
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    serverPort = server.port;
  });

  afterEach(() => {
    server?.stop();
    db?.close();
  });

  describe("GET /api/sessions/unclaimed", () => {
    test("rejects requests without authentication", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/unclaimed`);
      expect(res.status).toBe(401);
    });

    test("rejects requests with client_id but no Bearer token", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/unclaimed`, {
        headers: {
          "X-Openctl-Client-ID": "test-client",
        },
      });
      expect(res.status).toBe(401);
    });

    // Note: Testing with valid Bearer tokens requires Clerk setup
    // These tests verify the endpoint exists and rejects invalid requests
  });

  describe("POST /api/sessions/claim", () => {
    test("rejects requests without authentication", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/claim`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });

    test("rejects requests with client_id but no Bearer token", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/claim`, {
        method: "POST",
        headers: {
          "X-Openctl-Client-ID": "test-client",
        },
      });
      expect(res.status).toBe(401);
    });
  });
});

/**
 * Tests that require Clerk setup (marked as skipped by default).
 *
 * To run these tests:
 * 1. Set CLERK_SECRET_KEY in environment
 * 2. Create test users in Clerk dashboard
 * 3. Generate valid access tokens
 * 4. Update the TEST_TOKEN constant below
 */
describe.skip("Auth Flows - Clerk Integration", () => {
  // Replace with valid test token
  const TEST_TOKEN = "sk_test_...";
  const TEST_USER_ID = "user_...";

  let db: Database;
  let repo: SessionRepository;
  let server: ReturnType<typeof Bun.serve>;
  let serverPort: number;

  beforeEach(async () => {
    db = initializeDatabase(":memory:");
    repo = new SessionRepository(db);

    const { createApiRoutes } = await import("../../src/routes/api");
    const api = createApiRoutes(repo);

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/api/sessions/unclaimed" && req.method === "GET") {
          return api.getUnclaimedSessions(req);
        }

        if (url.pathname === "/api/sessions/claim" && req.method === "POST") {
          return api.claimSessions(req);
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    serverPort = server.port;
  });

  afterEach(() => {
    server?.stop();
    db?.close();
  });

  test("authenticated user can list unclaimed sessions", async () => {
    // Create unclaimed sessions
    repo.createSession(
      { id: "test1", title: "Test", description: null, claude_session_id: null, pr_url: null, share_token: null, project_path: "/tmp", model: null, harness: null, repo_url: null, status: "complete", last_activity_at: null, interactive: false },
      "test-client"
    );

    const res = await fetch(`http://localhost:${serverPort}/api/sessions/unclaimed`, {
      headers: {
        "Authorization": `Bearer ${TEST_TOKEN}`,
        "X-Openctl-Client-ID": "test-client",
      },
    });

    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.count).toBe(1);
  });

  test("authenticated user can claim sessions", async () => {
    repo.createSession(
      { id: "test1", title: "Test", description: null, claude_session_id: null, pr_url: null, share_token: null, project_path: "/tmp", model: null, harness: null, repo_url: null, status: "complete", last_activity_at: null, interactive: false },
      "test-client"
    );

    const res = await fetch(`http://localhost:${serverPort}/api/sessions/claim`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TEST_TOKEN}`,
        "X-Openctl-Client-ID": "test-client",
      },
    });

    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.claimed).toBe(1);

    // Verify session is now owned by user
    const session = repo.getSession("test1");
    expect(session?.user_id).toBe(TEST_USER_ID);
  });
});
