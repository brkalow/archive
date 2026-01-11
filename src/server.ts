import { initializeDatabase } from "./db/schema";
import { SessionRepository } from "./db/repository";
import { createApiRoutes } from "./routes/api";
import { sessionListPage } from "./views/sessionList";
import { sessionDetailPage } from "./views/sessionDetail";
import { join } from "path";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const HOST = process.env.HOST || "localhost";

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

const publicDir = join(import.meta.dir, "public");

// Start server
const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  routes: {
    // Static files
    "/css/style.css": new Response(Bun.file(join(publicDir, "css/style.css"))),
    "/css/diff.css": new Response(Bun.file(join(publicDir, "css/diff.css"))),
    "/js/app.js": new Response(Bun.file(join(publicDir, "js/app.js"))),

    // Page routes
    "/": () => {
      const sessions = repo.getAllSessions();
      return html(sessionListPage(sessions));
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

      return html(sessionDetailPage(session, messages, diffs, shareUrl));
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

      return html(sessionDetailPage(session, messages, diffs, shareUrl));
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

console.log(`🚀 Claude Session Archive running at http://${HOST}:${server.port}`);
