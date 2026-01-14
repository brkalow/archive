import { initializeDatabase } from "./db/schema";
import { SessionRepository } from "./db/repository";
import { createApiRoutes, addSessionSubscriber, removeSessionSubscriber } from "./routes/api";

// Import HTML template - Bun will bundle CSS and JS referenced in this file
import homepage from "../public/index.html";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const HOST = process.env.HOST || "0.0.0.0";

// Initialize database and repository
const db = initializeDatabase();
const repo = new SessionRepository(db);
const api = createApiRoutes(repo);

// WebSocket data attached to each connection
interface WebSocketData {
  sessionId: string;
}

// Start server
const server = Bun.serve({
  port: PORT,
  hostname: HOST,

  // Enable development mode for HMR and better error messages
  development: process.env.NODE_ENV !== "production",

  routes: {
    // HTML routes - all pages use the same template with client-side routing
    "/": homepage,
    "/sessions/:id": homepage,
    "/s/:shareToken": homepage,

    // API routes for data
    "/api/sessions": {
      GET: (req) => api.getSessions(req),
      POST: (req) => api.createSession(req),
    },

    "/api/sessions/:id": {
      GET: (req) => {
        const url = new URL(req.url);
        const baseUrl = `${url.protocol}//${url.host}`;
        return api.getSessionDetail(req.params.id, baseUrl);
      },
      POST: (req) => api.updateSession(req, req.params.id),
      PATCH: (req) => api.patchSession(req, req.params.id),
      DELETE: (req) => api.deleteSession(req.params.id, req),
    },

    "/api/sessions/:id/share": {
      POST: (req) => api.shareSession(req.params.id),
    },

    "/api/sessions/:id/export": {
      GET: (req) => api.getSessionJson(req.params.id),
    },

    "/api/sessions/:id/diffs": {
      GET: (req) => api.getSessionDiffs(req.params.id),
    },

    "/api/sessions/:id/annotations": {
      GET: (req) => api.getAnnotations(req.params.id),
    },

    "/api/s/:shareToken": {
      GET: (req) => {
        const url = new URL(req.url);
        const baseUrl = `${url.protocol}//${url.host}`;
        return api.getSharedSessionDetail(req.params.shareToken, baseUrl);
      },
    },

    // Live streaming endpoints
    "/api/sessions/live": {
      GET: () => api.getLiveSessions(),
      POST: (req) => api.createLiveSession(req),
    },

    "/api/sessions/:id/messages": {
      POST: (req) => api.pushMessages(req, req.params.id),
    },

    "/api/sessions/:id/tool-results": {
      POST: (req) => api.pushToolResults(req, req.params.id),
    },

    "/api/sessions/:id/diff": {
      PUT: (req) => api.updateDiff(req, req.params.id),
    },

    "/api/sessions/:id/complete": {
      POST: (req) => api.completeSession(req, req.params.id),
    },
  },

  fetch(req, server) {
    // Handle WebSocket upgrade for live session subscriptions
    const url = new URL(req.url);
    const wsMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/ws$/);

    if (wsMatch) {
      const sessionId = wsMatch[1];
      const session = repo.getSession(sessionId);

      if (!session) {
        return new Response("Session not found", { status: 404 });
      }

      // Only allow WebSocket connections for live sessions
      // Once a session is complete/archived, use the regular API to fetch static data
      if (session.status !== "live") {
        return new Response("WebSocket only available for live sessions", { status: 410 });
      }

      const upgraded = server.upgrade<WebSocketData>(req, {
        data: { sessionId },
      });

      if (upgraded) {
        return undefined; // Bun handles the upgrade
      }

      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      const { sessionId } = ws.data as WebSocketData;
      addSessionSubscriber(sessionId, ws as unknown as WebSocket);

      // Send connected message with current state
      const session = repo.getSession(sessionId);
      const messageCount = repo.getMessageCount(sessionId);
      const lastIndex = repo.getLastMessageIndex(sessionId);

      ws.send(JSON.stringify({
        type: "connected",
        session_id: sessionId,
        status: session?.status || "unknown",
        message_count: messageCount,
        last_index: lastIndex,
      }));
    },

    message(ws, message) {
      const { sessionId } = ws.data as WebSocketData;

      try {
        const data = JSON.parse(message.toString());

        if (data.type === "subscribe" && typeof data.from_index === "number") {
          // Client wants to resume from a specific index
          const messages = repo.getMessagesFromIndex(sessionId, data.from_index);
          if (messages.length > 0) {
            ws.send(JSON.stringify({
              type: "message",
              messages,
              index: messages[messages.length - 1].message_index,
            }));
          }
        } else if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
        }
      } catch {
        // Invalid message, ignore
      }
    },

    close(ws) {
      const { sessionId } = ws.data as WebSocketData;
      removeSessionSubscriber(sessionId, ws as unknown as WebSocket);
    },

    error(ws, error) {
      console.error("WebSocket error:", error);
      const { sessionId } = ws.data as WebSocketData;
      removeSessionSubscriber(sessionId, ws as unknown as WebSocket);
    },
  },
});

console.log(`Claude Session Archive running at http://${HOST}:${server.port}`);
