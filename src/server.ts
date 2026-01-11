import { initializeDatabase } from "./db/schema";
import { SessionRepository } from "./db/repository";
import { createApiRoutes } from "./routes/api";
import { SessionList } from "./components/SessionList";
import { SessionDetail } from "./components/SessionDetail";
import { join } from "path";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const HOST = process.env.HOST || "0.0.0.0";

// Initialize database and repository
const db = initializeDatabase();
const repo = new SessionRepository(db);
const api = createApiRoutes(repo);

// HTML response helper
function html(content: string): Response {
  return new Response(content, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// JavaScript response helper
function js(content: string): Response {
  return new Response(content, {
    headers: { "Content-Type": "application/javascript; charset=utf-8" },
  });
}

const publicDir = join(import.meta.dir, "public");
const stylesDir = join(import.meta.dir, "styles");

// Start server
const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  routes: {
    // Static files - CSS
    "/css/main.css": async () => {
      const file = Bun.file(join(stylesDir, "main.css"));
      const content = await file.text();
      return new Response(content, {
        headers: { "Content-Type": "text/css; charset=utf-8" },
      });
    },
    // Legacy CSS routes (redirect to new)
    "/css/style.css": async () => {
      const file = Bun.file(join(stylesDir, "main.css"));
      const content = await file.text();
      return new Response(content, {
        headers: { "Content-Type": "text/css; charset=utf-8" },
      });
    },
    "/css/diff.css": async () => {
      const file = Bun.file(join(stylesDir, "main.css"));
      const content = await file.text();
      return new Response(content, {
        headers: { "Content-Type": "text/css; charset=utf-8" },
      });
    },

    // JavaScript files
    "/js/app.js": new Response(Bun.file(join(publicDir, "js/app.js"))),
    "/js/diff-renderer.js": new Response(Bun.file(join(publicDir, "js/diff-renderer.js")), {
      headers: { "Content-Type": "application/javascript; charset=utf-8" },
    }),

    // Page routes
    "/": () => {
      const sessions = repo.getAllSessions();
      const result = SessionList({ sessions });
      return html(result.html);
    },

    "/sessions/:id": (req) => {
      const sessionId = req.params.id;
      const session = repo.getSession(sessionId);

      if (!session) {
        return new Response("Not Found", { status: 404 });
      }

      const messages = repo.getMessages(sessionId);
      const diffs = repo.getDiffs(sessionId);
      const url = new URL(req.url);

      const shareUrl = session.share_token
        ? `${url.protocol}//${url.host}/s/${session.share_token}`
        : null;

      const result = SessionDetail({ session, messages, diffs, shareUrl });
      return html(result.html);
    },

    "/s/:shareToken": (req) => {
      const shareToken = req.params.shareToken;
      const session = repo.getSessionByShareToken(shareToken);

      if (!session) {
        return new Response("Not Found", { status: 404 });
      }

      const messages = repo.getMessages(session.id);
      const diffs = repo.getDiffs(session.id);
      const url = new URL(req.url);

      const shareUrl = `${url.protocol}//${url.host}/s/${session.share_token}`;

      const result = SessionDetail({ session, messages, diffs, shareUrl });
      return html(result.html);
    },

    // API routes
    "/api/sessions": {
      POST: (req) => api.createSession(req),
    },

    "/api/sessions/:id": {
      POST: (req) => api.updateSession(req, req.params.id),
      DELETE: (req) => api.deleteSession(req.params.id),
    },

    "/api/sessions/:id/share": {
      POST: (req) => api.shareSession(req.params.id),
    },

    "/api/sessions/:id/export": {
      GET: (req) => api.getSessionJson(req.params.id),
    },
  },

  fetch() {
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Claude Session Archive running at http://${HOST}:${server.port}`);
