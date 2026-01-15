import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initializeDatabase } from "../../src/db/schema";
import { SessionRepository } from "../../src/db/repository";
import { Database } from "bun:sqlite";

describe("Interactive Sessions", () => {
  let db: Database;
  let repo: SessionRepository;
  let server: ReturnType<typeof Bun.serve>;
  let serverPort: number;

  beforeEach(async () => {
    // Create an in-memory database for testing
    db = initializeDatabase(":memory:");
    repo = new SessionRepository(db);

    // Import server modules dynamically to avoid port conflicts
    const { createApiRoutes, addSessionSubscriber, removeSessionSubscriber } = await import("../../src/routes/api");
    const { handleBrowserMessage } = await import("../../src/routes/browser-messages");

    const api = createApiRoutes(repo);

    // Start test server on random port
    server = Bun.serve({
      port: 0, // Random available port
      fetch(req, server) {
        const url = new URL(req.url);

        // Live session creation
        if (url.pathname === "/api/sessions/live" && req.method === "POST") {
          return api.createLiveSession(req);
        }

        // Browser WebSocket
        const wsMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/ws$/);
        if (wsMatch) {
          const sessionId = wsMatch[1];
          const session = repo.getSession(sessionId);
          if (!session) {
            return new Response("Session not found", { status: 404 });
          }
          if (session.status !== "live") {
            return new Response("WebSocket only available for live sessions", { status: 410 });
          }
          const upgraded = server.upgrade(req, {
            data: { sessionId },
          });
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        return new Response("Not Found", { status: 404 });
      },
      websocket: {
        open(ws) {
          const data = ws.data as { sessionId: string };
          addSessionSubscriber(data.sessionId, ws as unknown as WebSocket);
          const session = repo.getSession(data.sessionId);
          const messageCount = repo.getMessageCount(data.sessionId);
          const lastIndex = repo.getLastMessageIndex(data.sessionId);
          ws.send(JSON.stringify({
            type: "connected",
            session_id: data.sessionId,
            status: session?.status || "unknown",
            message_count: messageCount,
            last_index: lastIndex,
            interactive: session?.interactive ?? false,
          }));
        },
        message(ws, message) {
          const data = ws.data as { sessionId: string };
          try {
            const msg = JSON.parse(message.toString());
            handleBrowserMessage(
              data.sessionId,
              msg,
              repo,
              (response) => ws.send(JSON.stringify(response))
            );
          } catch {
            // Invalid message
          }
        },
        close(ws) {
          const data = ws.data as { sessionId: string };
          removeSessionSubscriber(data.sessionId, ws as unknown as WebSocket);
        },
      },
    });

    serverPort = server.port;
  });

  afterEach(() => {
    server?.stop();
    db?.close();
  });

  test("creates interactive session", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/sessions/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test Interactive",
        project_path: "/tmp",
        interactive: true,
      }),
    });

    expect(res.ok).toBe(true);
    const data = await res.json();

    expect(data.id).toBeDefined();
    expect(data.stream_token).toBeDefined();
    expect(data.interactive).toBe(true);

    // Verify in database
    const session = repo.getSession(data.id);
    expect(session).not.toBeNull();
    expect(session!.interactive).toBe(true);
  });

  test("creates non-interactive session by default", async () => {
    const res = await fetch(`http://localhost:${serverPort}/api/sessions/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test Non-Interactive",
        project_path: "/tmp",
      }),
    });

    const data = await res.json();
    expect(data.interactive).toBe(false);

    const session = repo.getSession(data.id);
    expect(session!.interactive).toBe(false);
  });
});

describe("Repository Feedback Methods", () => {
  let db: Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = initializeDatabase(":memory:");
    repo = new SessionRepository(db);
  });

  afterEach(() => {
    db?.close();
  });

  test("creates feedback message", () => {
    // Create a session first
    const session = repo.createSession({
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
      interactive: true,
    });

    const feedback = repo.createFeedbackMessage(
      session.id,
      "Please fix this bug",
      "message"
    );

    expect(feedback.id).toBeDefined();
    expect(feedback.session_id).toBe(session.id);
    expect(feedback.content).toBe("Please fix this bug");
    expect(feedback.type).toBe("message");
    expect(feedback.status).toBe("pending");
    expect(feedback.resolved_at).toBeNull();
  });

  test("creates feedback message with context", () => {
    const session = repo.createSession({
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
      interactive: true,
    });

    const feedback = repo.createFeedbackMessage(
      session.id,
      "Fix this line",
      "diff_comment",
      "reviewer@example.com",
      { file: "src/main.ts", line: 42 }
    );

    expect(feedback.type).toBe("diff_comment");
    expect(feedback.source).toBe("reviewer@example.com");
    expect(feedback.context).toEqual({ file: "src/main.ts", line: 42 });
  });

  test("gets pending feedback messages", () => {
    const session = repo.createSession({
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
      interactive: true,
    });

    repo.createFeedbackMessage(session.id, "First", "message");
    repo.createFeedbackMessage(session.id, "Second", "message");

    const pending = repo.getPendingFeedback(session.id);
    expect(pending).toHaveLength(2);
    expect(pending[0].content).toBe("First");
    expect(pending[1].content).toBe("Second");
  });

  test("updates feedback status", () => {
    const session = repo.createSession({
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
      interactive: true,
    });

    const feedback = repo.createFeedbackMessage(session.id, "Test", "message");
    repo.updateFeedbackStatus(feedback.id, "approved");

    const pending = repo.getPendingFeedback(session.id);
    expect(pending).toHaveLength(0); // No longer pending
  });

  test("sets session interactive flag", () => {
    const session = repo.createSession({
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
    });

    expect(session.interactive).toBe(false);

    repo.setSessionInteractive(session.id, true);
    const updated = repo.getSession(session.id);
    expect(updated!.interactive).toBe(true);
  });
});

describe("Rate Limiting", () => {
  let checkRateLimit: (sessionId: string, type: "message" | "diff_comment" | "suggested_edit") => { allowed: boolean; retryAfter?: number };
  let resetRateLimit: (sessionId: string, type?: "message" | "diff_comment" | "suggested_edit") => void;

  beforeEach(async () => {
    const rateLimitModule = await import("../../src/routes/rate-limit");
    checkRateLimit = rateLimitModule.checkRateLimit;
    resetRateLimit = rateLimitModule.resetRateLimit;

    // Reset rate limits before each test
    resetRateLimit("test_session");
  });

  test("allows messages within limit", () => {
    const result = checkRateLimit("test_session", "message");
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBeUndefined();
  });

  test("tracks message count", () => {
    // First message should be allowed
    expect(checkRateLimit("test_session", "message").allowed).toBe(true);

    // Can send many more (limit is 100/hour)
    for (let i = 0; i < 50; i++) {
      expect(checkRateLimit("test_session", "message").allowed).toBe(true);
    }
  });

  test("different sessions have separate limits", () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit("session_1", "message");
    }

    // session_2 should still be allowed
    const result = checkRateLimit("session_2", "message");
    expect(result.allowed).toBe(true);
  });

  test("different types have separate limits", () => {
    // Use up some message quota
    for (let i = 0; i < 10; i++) {
      checkRateLimit("test_session", "message");
    }

    // diff_comment should still be fully available
    const result = checkRateLimit("test_session", "diff_comment");
    expect(result.allowed).toBe(true);
  });
});
