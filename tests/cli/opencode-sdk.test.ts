/**
 * OpenCode SDK Integration Tests
 *
 * Uses the actual @opencode-ai/sdk v2 client as the test harness.
 * If the SDK client can successfully call every endpoint and parse responses,
 * the TUI will work too (same client code).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createOpenCodeAPI, type OpenCodeAPI } from "../../cli/lib/opencode-api";
import type {
  OpenCodeBackend,
  InputPart,
  PermissionReply,
  SessionStatusInfo,
} from "../../cli/lib/opencode-backend";
import type {
  OCSession,
  OCMessageWithParts,
  OCFileDiff,
  OCSessionStatus,
  OCPermissionRequest,
  OCQuestion,
  OCEvent,
} from "../../src/lib/opencode/types";
import { generateAscendingId } from "../../src/lib/opencode/id";

// ============================================
// Mock Backend
// ============================================

class MockBackend implements OpenCodeBackend {
  sessions = new Map<string, OCSession>();
  messages = new Map<string, OCMessageWithParts[]>();
  diffs = new Map<string, OCFileDiff[]>();
  statuses = new Map<string, SessionStatusInfo>();
  permissions: OCPermissionRequest[] = [];
  questions: OCQuestion[] = [];
  cwd = "/tmp/test-project";

  // Track calls for assertions
  lastSendMessage: { sessionId: string; parts: InputPart[]; messageId?: string } | null = null;
  lastAbort: string | null = null;
  lastPermissionReply: { requestId: string; reply: PermissionReply } | null = null;
  lastQuestionReply: { requestId: string; answers: string[][] } | null = null;
  lastQuestionReject: string | null = null;

  async listSessions(): Promise<OCSession[]> {
    return Array.from(this.sessions.values());
  }

  async getSession(id: string): Promise<OCSession | null> {
    return this.sessions.get(id) || null;
  }

  async createSession(opts: { title?: string }): Promise<OCSession> {
    const id = generateAscendingId("ses");
    const now = Date.now();
    const session: OCSession = {
      id,
      slug: id,
      projectID: "test-project",
      directory: this.cwd,
      title: opts.title || "New Session",
      version: "1.0.0",
      time: { created: now, updated: now },
    };
    this.sessions.set(id, session);
    return session;
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async updateSession(id: string, patch: { title?: string }): Promise<OCSession | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (patch.title) session.title = patch.title;
    session.time.updated = Date.now();
    return session;
  }

  async sendMessage(
    sessionId: string,
    parts: InputPart[],
    messageId?: string
  ): Promise<OCMessageWithParts | null> {
    this.lastSendMessage = { sessionId, parts, messageId };
    const msgId = messageId || generateAscendingId("msg");
    const now = Date.now();
    return {
      info: {
        id: msgId,
        sessionID: sessionId,
        role: "assistant",
        time: { created: now },
        parentID: "",
        modelID: "claude-sonnet-4-5-20250514",
        providerID: "anthropic",
        mode: "code",
        agent: "code",
        path: { cwd: this.cwd, root: this.cwd },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [],
    };
  }

  async abortSession(sessionId: string): Promise<boolean> {
    this.lastAbort = sessionId;
    return true;
  }

  async respondToPermission(requestId: string, reply: PermissionReply): Promise<boolean> {
    this.lastPermissionReply = { requestId, reply };
    return true;
  }

  async replyToQuestion(requestId: string, answers: string[][]): Promise<boolean> {
    this.lastQuestionReply = { requestId, answers };
    return true;
  }

  async rejectQuestion(requestId: string): Promise<boolean> {
    this.lastQuestionReject = requestId;
    return true;
  }

  async getMessages(sessionId: string): Promise<OCMessageWithParts[]> {
    return this.messages.get(sessionId) || [];
  }

  async getSessionDiffs(sessionId: string): Promise<OCFileDiff[]> {
    return this.diffs.get(sessionId) || [];
  }

  getSessionStatus(sessionId: string): SessionStatusInfo | null {
    return this.statuses.get(sessionId) || null;
  }

  getAllSessionStatuses(): Record<string, OCSessionStatus> {
    const result: Record<string, OCSessionStatus> = {};
    for (const [id, status] of this.statuses) {
      result[id] = status.status;
    }
    return result;
  }

  getPermissions(): OCPermissionRequest[] {
    return this.permissions;
  }

  getQuestions(): OCQuestion[] {
    return this.questions;
  }

  getCwd(): string {
    return this.cwd;
  }

  getDirectory(_req: Request): string {
    return this.cwd;
  }
}

// ============================================
// Test Setup
// ============================================

let server: ReturnType<typeof Bun.serve>;
let api: OpenCodeAPI;
let backend: MockBackend;
let sdk: ReturnType<typeof createOpencodeClient>;
let port: number;

beforeAll(() => {
  backend = new MockBackend();
  api = createOpenCodeAPI(backend, {
    directory: "/tmp/test-project",
  });

  server = Bun.serve({
    port: 0, // Random available port
    idleTimeout: 255,
    async fetch(req) {
      const response = await api.handleRequest(req);
      if (response) return response;
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  port = server.port;
  sdk = createOpencodeClient({
    baseUrl: `http://localhost:${port}`,
  });
});

afterAll(() => {
  api.close();
  server.stop();
});

// ============================================
// Tests
// ============================================

describe("OpenCode SDK Integration", () => {
  // ------------------------------------------
  // Health and Global
  // ------------------------------------------

  describe("health and global", () => {
    test("GET /global/health returns healthy", async () => {
      const result = await sdk.global.health();
      expect(result.data).toBeDefined();
      expect(result.data!.healthy).toBe(true);
      expect(result.data!.version).toBeDefined();
    });

    test("POST /global/dispose returns true", async () => {
      const result = await sdk.global.dispose();
      expect(result.data).toBe(true);
    });
  });

  // ------------------------------------------
  // Bootstrap Endpoints
  // ------------------------------------------

  describe("bootstrap stubs", () => {
    test("GET /config returns valid config", async () => {
      const result = await sdk.config.get();
      expect(result.data).toBeDefined();
    });

    test("GET /config/providers returns providers with models", async () => {
      const result = await sdk.config.providers();
      expect(result.data).toBeDefined();
      expect(result.data!.providers).toBeArray();
      expect(result.data!.providers.length).toBeGreaterThan(0);

      const provider = result.data!.providers[0];
      expect(provider.id).toBe("anthropic");
      expect(provider.source).toBe("custom");
      expect(provider.env).toEqual([]); // Empty = pre-configured
    });

    test("GET /provider returns provider list", async () => {
      const result = await sdk.provider.list();
      expect(result.data).toBeDefined();
      expect(result.data!.all).toBeArray();
      expect(result.data!.connected).toContain("anthropic");
    });

    test("GET /provider/auth returns object", async () => {
      const result = await sdk.provider.auth();
      expect(result.data).toBeDefined();
    });

    test("GET /agent returns agents", async () => {
      const result = await sdk.app.agents();
      expect(result.data).toBeArray();
      expect(result.data!.length).toBeGreaterThan(0);
      expect(result.data![0].native).toBe(true);
    });

    test("GET /project/current returns project", async () => {
      const result = await sdk.project.current();
      expect(result.data).toBeDefined();
      expect(result.data!.worktree).toBe("/tmp/test-project");
      expect(result.data!.vcs).toBe("git");
    });

    test("GET /project returns project list", async () => {
      const result = await sdk.project.list();
      expect(result.data).toBeArray();
      expect(result.data!.length).toBeGreaterThan(0);
    });

    test("GET /path returns paths", async () => {
      const result = await sdk.path.get();
      expect(result.data).toBeDefined();
      expect(result.data!.directory).toBe("/tmp/test-project");
      expect(result.data!.worktree).toBe("/tmp/test-project");
    });

    test("GET /command returns empty array", async () => {
      const result = await sdk.command.list();
      expect(result.data).toEqual([]);
    });

    test("GET /lsp returns empty array", async () => {
      const result = await sdk.lsp.status();
      expect(result.data).toBeDefined();
    });

    test("GET /vcs returns object", async () => {
      const result = await sdk.vcs.get();
      expect(result.data).toBeDefined();
    });

    test("GET /skill returns empty array", async () => {
      const result = await sdk.app.skills();
      expect(result.data).toEqual([]);
    });

    test("GET /formatter returns object", async () => {
      const result = await sdk.formatter.status();
      expect(result.data).toBeDefined();
    });

    test("GET /mcp returns object", async () => {
      const result = await sdk.mcp.status();
      expect(result.data).toBeDefined();
    });

    test("POST /log returns 204", async () => {
      const result = await sdk.app.log({
        level: "info",
        message: "test",
      });
      // SDK may not parse 204 into data, but it shouldn't error
      expect(result.error).toBeUndefined();
    });
  });

  // ------------------------------------------
  // Session CRUD
  // ------------------------------------------

  describe("session CRUD", () => {
    let sessionId: string;

    test("POST /session creates session", async () => {
      const result = await sdk.session.create({ title: "Test Session" });
      expect(result.data).toBeDefined();
      expect(result.data!.id).toBeDefined();
      expect(result.data!.title).toBe("Test Session");
      expect(result.data!.directory).toBe("/tmp/test-project");
      sessionId = result.data!.id;
    });

    test("GET /session lists sessions", async () => {
      const result = await sdk.session.list();
      expect(result.data).toBeArray();
      expect(result.data!.length).toBeGreaterThan(0);
    });

    test("GET /session/:id gets session", async () => {
      const result = await sdk.session.get({ sessionID: sessionId });
      expect(result.data).toBeDefined();
      expect(result.data!.id).toBe(sessionId);
      expect(result.data!.title).toBe("Test Session");
    });

    test("PATCH /session/:id updates session", async () => {
      const result = await sdk.session.update({
        sessionID: sessionId,
        title: "Updated Title",
      });
      expect(result.data).toBeDefined();
      expect(result.data!.title).toBe("Updated Title");
    });

    test("GET /session/status returns statuses", async () => {
      const result = await sdk.session.status();
      expect(result.data).toBeDefined();
    });

    test("GET /session/:id/message returns messages", async () => {
      const result = await sdk.session.messages({ sessionID: sessionId });
      expect(result.data).toBeArray();
    });

    test("GET /session/:id/diff returns diffs", async () => {
      const result = await sdk.session.diff({ sessionID: sessionId });
      expect(result.data).toBeDefined();
    });

    test("POST /session/:id/message sends prompt", async () => {
      const result = await sdk.session.prompt({
        sessionID: sessionId,
        parts: [{ type: "text", text: "Hello, Claude!" }],
      });
      expect(result.data).toBeDefined();
      expect(backend.lastSendMessage).toBeDefined();
      expect(backend.lastSendMessage!.sessionId).toBe(sessionId);
      expect(backend.lastSendMessage!.parts[0].text).toBe("Hello, Claude!");
    });

    test("POST /session/:id/abort aborts session", async () => {
      const result = await sdk.session.abort({ sessionID: sessionId });
      expect(result.data).toBe(true);
      expect(backend.lastAbort).toBe(sessionId);
    });

    test("DELETE /session/:id deletes session", async () => {
      const result = await sdk.session.delete({ sessionID: sessionId });
      expect(result.data).toBe(true);
    });
  });

  // ------------------------------------------
  // Permission Handling
  // ------------------------------------------

  describe("permissions", () => {
    test("GET /permission lists permissions", async () => {
      backend.permissions = [
        {
          id: "perm-1",
          sessionID: "ses-1",
          permission: "Bash",
          patterns: [],
          metadata: {},
          always: false,
        },
      ];

      const result = await sdk.permission.list();
      expect(result.data).toBeArray();
      expect(result.data!.length).toBe(1);
    });

    test("POST /permission/:id/reply responds to permission", async () => {
      const result = await sdk.permission.reply({
        requestID: "perm-1",
        reply: "once",
      });
      expect(result.data).toBe(true);
      expect(backend.lastPermissionReply).toBeDefined();
      expect(backend.lastPermissionReply!.requestId).toBe("perm-1");
      expect(backend.lastPermissionReply!.reply.reply).toBe("once");
    });
  });

  // ------------------------------------------
  // Question Handling
  // ------------------------------------------

  describe("questions", () => {
    test("GET /question lists questions", async () => {
      backend.questions = [
        {
          id: "q-1",
          sessionID: "ses-1",
          questions: [
            { question: "Which option?", options: ["A", "B"], custom: true },
          ],
        },
      ];

      const result = await sdk.question.list();
      expect(result.data).toBeArray();
      expect(result.data!.length).toBe(1);
    });

    test("POST /question/:id/reply answers question", async () => {
      const result = await sdk.question.reply({
        requestID: "q-1",
        answers: [["A"]],
      });
      expect(result.data).toBe(true);
      expect(backend.lastQuestionReply).toBeDefined();
      expect(backend.lastQuestionReply!.answers).toEqual([["A"]]);
    });

    test("POST /question/:id/reject rejects question", async () => {
      const result = await sdk.question.reject({ requestID: "q-2" });
      expect(result.data).toBe(true);
      expect(backend.lastQuestionReject).toBe("q-2");
    });
  });

  // ------------------------------------------
  // SSE Connection
  // ------------------------------------------

  describe("SSE events", () => {
    test("GET /event connects and receives server.connected", async () => {
      const response = await fetch(`http://localhost:${port}/event`, {
        headers: { Accept: "text/event-stream" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      const { value } = await reader.read();
      const text = decoder.decode(value);

      // Should contain server.connected event in bare format
      expect(text).toContain("server.connected");
      // Parse the data line
      const dataMatch = text.match(/data: (.+)/);
      expect(dataMatch).toBeTruthy();
      const event = JSON.parse(dataMatch![1]);
      expect(event.type).toBe("server.connected");
      expect(event.properties).toEqual({});

      reader.cancel();
    });

    test("GET /global/event sends envelope format", async () => {
      const response = await fetch(`http://localhost:${port}/global/event`, {
        headers: { Accept: "text/event-stream" },
      });

      expect(response.status).toBe(200);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      const { value } = await reader.read();
      const text = decoder.decode(value);

      const dataMatch = text.match(/data: (.+)/);
      expect(dataMatch).toBeTruthy();
      const event = JSON.parse(dataMatch![1]);
      // Envelope format: { payload: { type, properties } }
      expect(event.payload).toBeDefined();
      expect(event.payload.type).toBe("server.connected");

      reader.cancel();
    });

    test("broadcast sends events to connected SSE clients", async () => {
      const response = await fetch(`http://localhost:${port}/event`, {
        headers: { Accept: "text/event-stream" },
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      // Read server.connected
      await reader.read();

      // Broadcast an event
      api.broadcast({
        type: "session.created",
        properties: {
          info: {
            id: "test-ses",
            title: "Test",
            directory: "/tmp",
          },
        },
      });

      // Small delay for the event to propagate
      await new Promise((r) => setTimeout(r, 50));

      const { value } = await reader.read();
      const text = decoder.decode(value);

      const dataMatch = text.match(/data: (.+)/);
      expect(dataMatch).toBeTruthy();
      const event = JSON.parse(dataMatch![1]);
      expect(event.type).toBe("session.created");
      expect(event.properties.info.id).toBe("test-ses");

      reader.cancel();
    });
  });

  // ------------------------------------------
  // Ascending IDs
  // ------------------------------------------

  describe("ascending IDs", () => {
    test("IDs sort lexicographically by creation time", () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push(generateAscendingId("msg"));
      }

      // Verify sorted order
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    });

    test("IDs have correct prefix format", () => {
      const msgId = generateAscendingId("msg");
      const prtId = generateAscendingId("prt");
      const sesId = generateAscendingId("ses");

      expect(msgId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(prtId).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(sesId).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    });
  });

  // ------------------------------------------
  // Route Priority
  // ------------------------------------------

  describe("route priority", () => {
    test("/session/status is matched before /session/:id", async () => {
      // This verifies the routing gotcha: /session/status must match
      // before /session/:id, otherwise "status" would be treated as a session ID
      const result = await sdk.session.status();
      expect(result.data).toBeDefined();
      // If it was incorrectly matched as /session/:id with id="status",
      // we'd get a different response shape
      expect(typeof result.data).toBe("object");
    });
  });

  // ------------------------------------------
  // CORS
  // ------------------------------------------

  describe("CORS headers", () => {
    test("OPTIONS preflight returns CORS headers", async () => {
      const response = await fetch(`http://localhost:${port}/session`, {
        method: "OPTIONS",
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    });

    test("API responses include CORS headers", async () => {
      const response = await fetch(`http://localhost:${port}/global/health`);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });
});
