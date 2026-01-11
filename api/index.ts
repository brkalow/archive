import { initializeDatabase } from "../src/db/schema";
import { SessionRepository } from "../src/db/repository";
import { createApiRoutes } from "../src/routes/api";
import { SessionList } from "../src/components/SessionList";
import { SessionDetail } from "../src/components/SessionDetail";
import { join } from "path";

// Initialize database and repository (cached between invocations)
const db = initializeDatabase();
const repo = new SessionRepository(db);
const api = createApiRoutes(repo);

// Paths for static assets
const srcDir = join(import.meta.dir, "../src");
const publicDir = join(srcDir, "public");
const stylesDir = join(srcDir, "styles");

// Helper functions
function html(content: string): Response {
  return new Response(content, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function css(content: string): Response {
  return new Response(content, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

function javascript(content: string): Response {
  return new Response(content, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// URL pattern matchers
const sessionDetailPattern = new URLPattern({ pathname: "/sessions/:id" });
const sharePattern = new URLPattern({ pathname: "/s/:shareToken" });
const apiSessionPattern = new URLPattern({ pathname: "/api/sessions/:id" });
const apiSharePattern = new URLPattern({ pathname: "/api/sessions/:id/share" });
const apiExportPattern = new URLPattern({ pathname: "/api/sessions/:id/export" });

// Main request handler for Vercel serverless function
export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  try {
    // Static CSS routes
    if (pathname === "/css/main.css" || pathname === "/css/style.css" || pathname === "/css/diff.css") {
      const file = Bun.file(join(stylesDir, "main.css"));
      const content = await file.text();
      return css(content);
    }

    // Static JS routes
    if (pathname === "/js/app.js") {
      const file = Bun.file(join(publicDir, "js/app.js"));
      const content = await file.text();
      return javascript(content);
    }

    if (pathname === "/js/diff-renderer.js") {
      const file = Bun.file(join(publicDir, "js/diff-renderer.js"));
      const content = await file.text();
      return javascript(content);
    }

    // Home page
    if (pathname === "/" || pathname === "") {
      const sessions = repo.getAllSessions();
      const result = SessionList({ sessions });
      return html(result.html);
    }

    // Session detail page
    const sessionMatch = sessionDetailPattern.exec(url);
    if (sessionMatch && method === "GET") {
      const sessionId = sessionMatch.pathname.groups.id!;
      const session = repo.getSession(sessionId);

      if (!session) {
        return new Response("Not Found", { status: 404 });
      }

      const messages = repo.getMessages(sessionId);
      const diffs = repo.getDiffs(sessionId);

      const shareUrl = session.share_token
        ? `${url.protocol}//${url.host}/s/${session.share_token}`
        : null;

      const result = SessionDetail({ session, messages, diffs, shareUrl });
      return html(result.html);
    }

    // Share page
    const shareMatch = sharePattern.exec(url);
    if (shareMatch && method === "GET") {
      const shareToken = shareMatch.pathname.groups.shareToken!;
      const session = repo.getSessionByShareToken(shareToken);

      if (!session) {
        return new Response("Not Found", { status: 404 });
      }

      const messages = repo.getMessages(session.id);
      const diffs = repo.getDiffs(session.id);

      const shareUrl = `${url.protocol}//${url.host}/s/${session.share_token}`;

      const result = SessionDetail({ session, messages, diffs, shareUrl });
      return html(result.html);
    }

    // API: Create session
    if (pathname === "/api/sessions" && method === "POST") {
      return api.createSession(req);
    }

    // API: Export session
    const exportMatch = apiExportPattern.exec(url);
    if (exportMatch && method === "GET") {
      const sessionId = exportMatch.pathname.groups.id!;
      return api.getSessionJson(sessionId);
    }

    // API: Share session
    const apiShareMatch = apiSharePattern.exec(url);
    if (apiShareMatch && method === "POST") {
      const sessionId = apiShareMatch.pathname.groups.id!;
      return api.shareSession(sessionId);
    }

    // API: Update/Delete session
    const apiMatch = apiSessionPattern.exec(url);
    if (apiMatch) {
      const sessionId = apiMatch.pathname.groups.id!;
      if (method === "POST") {
        return api.updateSession(req, sessionId);
      }
      if (method === "DELETE") {
        return api.deleteSession(sessionId);
      }
    }

    // 404 fallback
    return new Response("Not Found", { status: 404 });
  } catch (error) {
    console.error("Request error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
