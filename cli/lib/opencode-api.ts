/**
 * OpenCode API Module — Portable HTTP handler for OpenCode TUI compatibility.
 *
 * createOpenCodeAPI(backend, opts) → { handleRequest, broadcast, close }
 *
 * Handles all routes from the OpenCode route table. Backend-agnostic:
 * the daemon implements OpenCodeBackend with SpawnedSessionManager,
 * the server can implement its own backend later.
 *
 * SSE connections are managed internally by the SSE module.
 */

import { OpenCodeSSEManager } from "./opencode-sse";
import type {
  OpenCodeBackend,
  InputPart,
  PermissionReply,
} from "./opencode-backend";
import type {
  OCEvent,
  OCSession,
  OCAgent,
  OCModel,
  OCProject,
  OCConfigProvider,
} from "../../src/lib/opencode/types";
import { debug } from "./debug";

export interface OpenCodeAPIOptions {
  directory: string;
  version?: string;
}

export interface OpenCodeAPI {
  handleRequest(req: Request): Promise<Response | null>;
  broadcast(event: OCEvent): void;
  close(): void;
}

// ============================================
// CORS helper
// ============================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

function corsHeaders(headers?: Record<string, string>): Record<string, string> {
  return { ...CORS_HEADERS, ...headers };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json" }),
  });
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function notFound(message = "Not found"): Response {
  return json({ error: message }, 404);
}

function badRequest(message = "Bad request"): Response {
  return json({ error: message }, 400);
}

// ============================================
// Route matching
// ============================================

interface RouteMatch {
  params: Record<string, string>;
}

function matchRoute(
  pattern: string,
  pathname: string
): RouteMatch | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }

  return { params };
}

// ============================================
// Bootstrap data
// ============================================

function getDefaultModel(): OCModel {
  return {
    id: "claude-sonnet-4-5-20250514",
    name: "Claude Sonnet 4.5",
    limit: { context: 200000, output: 16384 },
    attachment: true,
    family: "claude",
    release_date: "2025-05-14",
    capabilities: { interleaved: true },
  };
}

function getDefaultProvider(): OCConfigProvider {
  return {
    id: "anthropic",
    name: "Anthropic",
    source: "custom",
    env: [],
    models: {
      "claude-sonnet-4-5-20250514": getDefaultModel(),
    },
  };
}

function getDefaultAgent(): OCAgent {
  return {
    name: "code",
    description: "General purpose coding agent",
    mode: "code",
    native: true,
    options: {},
    permission: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
  };
}

// ============================================
// API Factory
// ============================================

export function createOpenCodeAPI(
  backend: OpenCodeBackend,
  opts: OpenCodeAPIOptions
): OpenCodeAPI {
  const sseManager = new OpenCodeSSEManager(opts.directory);
  const version = opts.version || "1.0.0";

  function broadcast(event: OCEvent): void {
    sseManager.broadcast(event);
  }

  async function handleRequest(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    debug(`[opencode-api] ${method} ${pathname}`);

    // ==========================================
    // SSE Endpoints
    // ==========================================

    if (method === "GET" && pathname === "/event") {
      const lastEventId = req.headers.get("Last-Event-ID") || undefined;
      return sseManager.connect("bare", lastEventId);
    }

    if (method === "GET" && pathname === "/global/event") {
      const lastEventId = req.headers.get("Last-Event-ID") || undefined;
      const directory =
        req.headers.get("x-opencode-directory") || opts.directory;
      return sseManager.connect("global", lastEventId, directory);
    }

    // ==========================================
    // Health
    // ==========================================

    if (method === "GET" && pathname === "/global/health") {
      return json({ healthy: true, version });
    }

    // ==========================================
    // Session routes (order matters: /session/status before /session/:id)
    // ==========================================

    if (method === "GET" && pathname === "/session/status") {
      return json(backend.getAllSessionStatuses());
    }

    if (method === "GET" && pathname === "/session") {
      const sessions = await backend.listSessions();
      return json(sessions);
    }

    if (method === "POST" && pathname === "/session") {
      const body = await parseBody(req);
      const session = await backend.createSession({
        title: body?.title,
      });
      return json(session);
    }

    // Session-specific routes
    let match: RouteMatch | null;

    // GET /session/:id
    match = matchRoute("/session/:id", pathname);
    if (match && method === "GET") {
      const session = await backend.getSession(match.params.id);
      if (!session) return notFound("Session not found");
      return json(session);
    }

    // PATCH /session/:id
    match = matchRoute("/session/:id", pathname);
    if (match && method === "PATCH") {
      const body = await parseBody(req);
      const session = await backend.updateSession(match.params.id, {
        title: body?.title,
      });
      if (!session) return notFound("Session not found");
      return json(session);
    }

    // DELETE /session/:id
    match = matchRoute("/session/:id", pathname);
    if (match && method === "DELETE") {
      const result = await backend.deleteSession(match.params.id);
      return json(result);
    }

    // GET /session/:id/message
    match = matchRoute("/session/:id/message", pathname);
    if (match && method === "GET") {
      const messages = await backend.getMessages(match.params.id);
      return json(messages);
    }

    // POST /session/:id/message (prompt)
    match = matchRoute("/session/:id/message", pathname);
    if (match && method === "POST") {
      const body = await parseBody(req);
      if (!body) return badRequest("Request body required");

      // Handle both formats: parts array or content string
      const parts = extractInputParts(body);
      if (!parts.length) return badRequest("No message content");

      const result = await backend.sendMessage(
        match.params.id,
        parts,
        body.messageID
      );
      if (!result) return notFound("Session not found");
      return json(result);
    }

    // POST /session/:id/prompt_async
    match = matchRoute("/session/:id/prompt_async", pathname);
    if (match && method === "POST") {
      const body = await parseBody(req);
      if (!body) return badRequest("Request body required");

      const parts = extractInputParts(body);
      if (!parts.length) return badRequest("No message content");

      // Fire and forget — don't wait for response
      backend.sendMessage(match.params.id, parts, body?.messageID);
      return noContent();
    }

    // POST /session/:id/abort
    match = matchRoute("/session/:id/abort", pathname);
    if (match && method === "POST") {
      const result = await backend.abortSession(match.params.id);
      return json(result);
    }

    // GET /session/:id/diff
    match = matchRoute("/session/:id/diff", pathname);
    if (match && method === "GET") {
      const diffs = await backend.getSessionDiffs(match.params.id);
      return json(diffs);
    }

    // ==========================================
    // Permission routes
    // ==========================================

    match = matchRoute("/permission/:id/reply", pathname);
    if (match && method === "POST") {
      const body = await parseBody(req);
      if (!body) return badRequest("Request body required");

      const reply: PermissionReply = {
        reply: body.reply || "once",
        message: body.message,
      };

      const result = await backend.respondToPermission(
        match.params.id,
        reply
      );
      return json(result);
    }

    // ==========================================
    // Question routes
    // ==========================================

    match = matchRoute("/question/:id/reply", pathname);
    if (match && method === "POST") {
      const body = await parseBody(req);
      // answers is Array<Array<string>>
      const answers: string[][] = body?.answers || [[]];
      const result = await backend.replyToQuestion(match.params.id, answers);
      return json(result);
    }

    match = matchRoute("/question/:id/reject", pathname);
    if (match && method === "POST") {
      const result = await backend.rejectQuestion(match.params.id);
      return json(result);
    }

    // ==========================================
    // Bootstrap stubs (must return valid shapes)
    // ==========================================

    if (method === "GET" && (pathname === "/config" || pathname === "/global/config")) {
      return json({
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250514",
        agent: "code",
        mode: "code",
        keybinds: {},
        theme: {},
      });
    }

    if (method === "PATCH" && pathname === "/config") {
      return json({});
    }

    if (method === "GET" && pathname === "/config/providers") {
      return json({
        providers: [getDefaultProvider()],
        default: {
          id: "anthropic",
          model: "claude-sonnet-4-5-20250514",
        },
      });
    }

    if (method === "GET" && pathname === "/provider") {
      return json({
        all: [
          {
            id: "anthropic",
            name: "Anthropic",
            env: [],
            models: [getDefaultModel()],
          },
        ],
        default: {
          id: "anthropic",
          model: "claude-sonnet-4-5-20250514",
        },
        connected: ["anthropic"],
      });
    }

    if (method === "GET" && pathname === "/provider/auth") {
      return json({});
    }

    if (method === "GET" && pathname === "/agent") {
      return json([getDefaultAgent()]);
    }

    if (method === "GET" && pathname === "/project/current") {
      const cwd = backend.getCwd();
      const now = Date.now();
      const project: OCProject = {
        id: cwd.replace(/\//g, "-").replace(/^-/, ""),
        worktree: cwd,
        vcs: "git",
        sandboxes: [],
        time: { created: now, updated: now },
      };
      return json(project);
    }

    if (method === "GET" && pathname === "/project") {
      const cwd = backend.getCwd();
      const now = Date.now();
      return json([
        {
          id: cwd.replace(/\//g, "-").replace(/^-/, ""),
          worktree: cwd,
          vcs: "git",
          sandboxes: [],
          time: { created: now, updated: now },
        },
      ]);
    }

    if (method === "GET" && pathname === "/command") {
      return json([]);
    }

    if (method === "GET" && pathname === "/path") {
      const cwd = backend.getCwd();
      const home = process.env.HOME || "~";
      return json({
        home,
        state: `${home}/.opencode`,
        config: `${home}/.opencode/config.json`,
        worktree: cwd,
        directory: cwd,
      });
    }

    if (method === "GET" && pathname === "/mcp") {
      return json({});
    }

    if (method === "GET" && pathname === "/lsp") {
      return json([]);
    }

    if (method === "GET" && pathname === "/vcs") {
      return json({});
    }

    if (method === "GET" && pathname === "/skill") {
      return json([]);
    }

    if (method === "GET" && pathname === "/permission") {
      return json(backend.getPermissions());
    }

    if (method === "GET" && pathname === "/question") {
      return json(backend.getQuestions());
    }

    if (method === "GET" && pathname === "/formatter") {
      return json({});
    }

    if (method === "GET" && pathname === "/experimental/resource") {
      return json([]);
    }

    if (method === "POST" && pathname === "/log") {
      return noContent();
    }

    if (method === "POST" && pathname === "/global/dispose") {
      return json(true);
    }

    // No route matched
    return null;
  }

  function close(): void {
    sseManager.close();
  }

  return { handleRequest, broadcast, close };
}

// ============================================
// Helpers
// ============================================

async function parseBody(req: Request): Promise<Record<string, any> | null> {
  try {
    const text = await req.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Extract input parts from request body.
 * Handles both formats: { parts: [{type: "text", text}] } and { content: string }
 */
function extractInputParts(body: Record<string, any>): InputPart[] {
  if (body.parts && Array.isArray(body.parts)) {
    return body.parts
      .filter((p: any) => p.type === "text" && p.text)
      .map((p: any) => ({
        type: "text" as const,
        text: p.text,
        id: p.id,
      }));
  }

  if (typeof body.content === "string" && body.content) {
    return [{ type: "text", text: body.content }];
  }

  return [];
}
