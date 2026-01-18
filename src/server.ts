import { initializeDatabase } from "./db/schema";
import { SessionRepository } from "./db/repository";
import { createApiRoutes, addSessionSubscriber, removeSessionSubscriber, closeAllConnections, broadcastToSession } from "./routes/api";
import { createPageRoutes } from "./routes/pages";
import { handleBrowserMessage } from "./routes/browser-messages";
import { handleGetPendingFeedback, handleMarkFeedbackDelivered, handleGetPendingFeedbackByClaudeSession, handleMarkSessionInteractive, handleMarkSessionFinished } from "./routes/feedback-api";
import type { BrowserToServerMessage } from "./routes/websocket-types";

// Import HTML template - Bun will bundle CSS and JS referenced in this file
import homepage from "../public/index.html";

// Import install script as text
import installScript from "../install.sh" with { type: "text" };

const DEFAULT_PORT = 3000;
const HOST = process.env.HOST || "0.0.0.0";

/**
 * Get the port to use. If PORT env is set, use it.
 * Otherwise try default port, falling back to 0 (OS picks) if unavailable.
 */
function getPort(): number {
  if (process.env.PORT) {
    return parseInt(process.env.PORT);
  }

  // Check if default port is available
  try {
    const listener = Bun.listen({
      hostname: HOST,
      port: DEFAULT_PORT,
      socket: { data() {} },
    });
    listener.stop();
    return DEFAULT_PORT;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      return 0; // Let OS pick
    }
    throw e;
  }
}

const PORT = getPort();

// Initialize database and repository
const db = initializeDatabase();
const repo = new SessionRepository(db);
const api = createApiRoutes(repo);
const pages = createPageRoutes(repo);

// WebSocket data attached to each connection
interface BrowserWebSocketData {
  sessionId: string;
}

type WebSocketData = BrowserWebSocketData;

// Start server
const server = Bun.serve({
  port: PORT,
  hostname: HOST,

  // Enable development mode for HMR and better error messages
  development: process.env.NODE_ENV !== "production",

  routes: {
    // HTML routes - all pages use the same template with client-side routing
    "/": homepage,
    "/sessions": homepage,
    "/sessions/:id": homepage,
    "/s/:shareToken": homepage,
    "/_components": homepage,

    // Server-rendered stats page
    "/stats": {
      GET: (req) => pages.statsPage(req),
    },

    // Install script for CLI setup
    "/setup/install.sh": () => new Response(installScript, {
      headers: { "Content-Type": "text/x-shellscript" },
    }),

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

    "/api/sessions/:id/interactive": {
      POST: (req) => api.markInteractive(req, req.params.id),
      DELETE: (req) => api.disableInteractive(req, req.params.id),
    },

    // Feedback API endpoints for plugin-based interactive sessions
    // Note: by-claude-session route must come before :id routes to avoid matching conflicts
    "/api/sessions/by-claude-session/:claudeSessionId/feedback/pending": {
      GET: (req) => handleGetPendingFeedbackByClaudeSession(req.params.claudeSessionId, repo),
    },

    "/api/sessions/by-claude-session/:claudeSessionId/interactive": {
      POST: (req) => handleMarkSessionInteractive(req.params.claudeSessionId, repo),
    },

    "/api/sessions/by-claude-session/:claudeSessionId/finished": {
      POST: (req) => handleMarkSessionFinished(req.params.claudeSessionId, repo),
    },

    "/api/sessions/:id/feedback/pending": {
      GET: (req) => handleGetPendingFeedback(req.params.id, repo),
    },

    "/api/sessions/:id/feedback/:messageId/delivered": {
      POST: (req) => handleMarkFeedbackDelivered(req.params.id, req.params.messageId, repo),
    },

    // Analytics Stats endpoints
    "/api/stats": {
      GET: (req) => api.getStats(req),
    },

    "/api/stats/timeseries": {
      GET: (req) => api.getStatsTimeseries(req),
    },

    "/api/stats/tools": {
      GET: (req) => api.getStatsTools(req),
    },

    "/api/stats/dashboard": {
      GET: (req) => api.getDashboardStats(req),
    },
  },

  fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade for live session subscriptions (browser clients)
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

      const upgraded = server.upgrade<BrowserWebSocketData>(req, {
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
      const data = ws.data as WebSocketData;

      // Add to subscriber list
      addSessionSubscriber(data.sessionId, ws as unknown as WebSocket);

      // Send connected message with current state including interactive info
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
        claude_state: "unknown" as const,
      }));
    },

    message(ws, message) {
      const data = ws.data as WebSocketData;

      try {
        const msg = JSON.parse(message.toString());

        // Handle browser messages (subscribe, ping, user_message, etc.)
        handleBrowserMessage(
          data.sessionId,
          msg as BrowserToServerMessage,
          repo,
          (response) => ws.send(JSON.stringify(response))
        );
      } catch {
        // Invalid message, ignore
      }
    },

    close(ws) {
      const data = ws.data as WebSocketData;
      removeSessionSubscriber(data.sessionId, ws as unknown as WebSocket);
    },

    error(ws, error) {
      console.error("WebSocket error:", error);
      const data = ws.data as WebSocketData;
      removeSessionSubscriber(data.sessionId, ws as unknown as WebSocket);
    },
  },
});

if (server.port !== DEFAULT_PORT && !process.env.PORT) {
  console.log(`Port ${DEFAULT_PORT} in use, using ${server.port} instead`);
}
console.log(`openctl running at http://${HOST}:${server.port}`);

// Graceful shutdown handling
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.log("Shutdown already in progress...");
    return;
  }
  isShuttingDown = true;

  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  // Close all WebSocket connections
  console.log("Closing WebSocket connections...");
  closeAllConnections();

  // Stop accepting new connections and close existing ones
  console.log("Stopping server...");
  server.stop();

  // Close database connection
  console.log("Closing database...");
  db.close();

  console.log("Shutdown complete.");
  process.exit(0);
}

// Handle termination signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
