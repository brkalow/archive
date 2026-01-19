import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initializeDatabase } from "../../src/db/schema";
import { SessionRepository } from "../../src/db/repository";
import { Database } from "bun:sqlite";

describe("Client ID Authentication", () => {
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

        // Live session creation
        if (url.pathname === "/api/sessions/live" && req.method === "POST") {
          return api.createLiveSession(req);
        }

        // Push messages
        const pushMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/messages$/);
        if (pushMatch && req.method === "POST") {
          return api.pushMessages(req, pushMatch[1]!);
        }

        // Complete session
        const completeMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/complete$/);
        if (completeMatch && req.method === "POST") {
          return api.completeSession(req, completeMatch[1]!);
        }

        // Delete session
        const deleteMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)$/);
        if (deleteMatch && req.method === "DELETE") {
          return api.deleteSession(req, deleteMatch[1]!);
        }

        // Patch session (JSON body for title updates)
        const patchMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)$/);
        if (patchMatch && req.method === "PATCH") {
          return api.patchSession(req, patchMatch[1]!);
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

  describe("session creation", () => {
    test("rejects requests without client ID header", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/live`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "Test Session",
          project_path: "/tmp",
        }),
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain("X-Openctl-Client-ID");
    });

    test("creates session with valid client ID", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/live`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Openctl-Client-ID": "test-client-123",
        },
        body: JSON.stringify({
          title: "Test Session",
          project_path: "/tmp",
        }),
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.id).toBeDefined();

      // Verify client_id is stored
      const session = repo.getSession(data.id);
      expect(session?.client_id).toBe("test-client-123");
    });
  });

  describe("session operations", () => {
    let sessionId: string;
    const ownerClientId = "owner-client-123";
    const otherClientId = "other-client-456";

    beforeEach(async () => {
      // Create a session owned by ownerClientId
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/live`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Openctl-Client-ID": ownerClientId,
        },
        body: JSON.stringify({
          title: "Owner's Session",
          project_path: "/tmp",
        }),
      });
      const data = await res.json();
      sessionId = data.id;
    });

    test("owner can push messages", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Openctl-Client-ID": ownerClientId,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      expect(res.ok).toBe(true);
    });

    test("non-owner cannot push messages", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Openctl-Client-ID": otherClientId,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      expect(res.status).toBe(403);
    });

    test("owner can complete session", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/${sessionId}/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Openctl-Client-ID": ownerClientId,
        },
        body: JSON.stringify({}),
      });

      expect(res.ok).toBe(true);
      const session = repo.getSession(sessionId);
      expect(session?.status).toBe("complete");
    });

    test("non-owner cannot complete session", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/${sessionId}/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Openctl-Client-ID": otherClientId,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(403);
    });

    test("owner can delete session", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/${sessionId}`, {
        method: "DELETE",
        headers: {
          "X-Openctl-Client-ID": ownerClientId,
        },
      });

      expect(res.ok).toBe(true);
      expect(repo.getSession(sessionId)).toBeNull();
    });

    test("non-owner cannot delete session", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/${sessionId}`, {
        method: "DELETE",
        headers: {
          "X-Openctl-Client-ID": otherClientId,
        },
      });

      expect(res.status).toBe(403);
    });

    test("client ownership persists across multiple operations", async () => {
      // Push message
      let res = await fetch(`http://localhost:${serverPort}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Openctl-Client-ID": ownerClientId,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "First message" }],
        }),
      });
      expect(res.ok).toBe(true);

      // Update title
      res = await fetch(`http://localhost:${serverPort}/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Openctl-Client-ID": ownerClientId,
        },
        body: JSON.stringify({ title: "Updated Title" }),
      });
      expect(res.ok).toBe(true);

      // Complete session
      res = await fetch(`http://localhost:${serverPort}/api/sessions/${sessionId}/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Openctl-Client-ID": ownerClientId,
        },
        body: JSON.stringify({}),
      });
      expect(res.ok).toBe(true);
    });
  });

  describe("legacy sessions (no client_id)", () => {
    let legacySessionId: string;

    beforeEach(() => {
      // Create a legacy session directly in the database without client_id
      const session = repo.createSession({
        id: "legacy_session_123",
        title: "Legacy Session",
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
      legacySessionId = session.id;
    });

    test("random client cannot access legacy session", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/${legacySessionId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Openctl-Client-ID": "random-client",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      // Legacy sessions (no owner) should not be accessible
      expect(res.status).toBe(403);
    });

    test("random client cannot delete legacy session", async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions/${legacySessionId}`, {
        method: "DELETE",
        headers: {
          "X-Openctl-Client-ID": "random-client",
        },
      });

      // Legacy sessions (no owner) should not be accessible
      expect(res.status).toBe(403);
    });
  });
});
