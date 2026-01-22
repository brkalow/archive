import { initializeDatabase, type ContentBlock as SchemaContentBlock } from "./db/schema";
import { SessionRepository } from "./db/repository";
import { AnalyticsRecorder } from "./analytics/events";
import { daemonConnections, type DaemonWebSocketData } from "./lib/daemon-connections";
import { spawnedSessionRegistry, type ParsedDiff } from "./lib/spawned-session-registry";
import { createApiRoutes, addSessionSubscriber, removeSessionSubscriber, closeAllConnections, broadcastToSession } from "./routes/api";
import { createPageRoutes } from "./routes/pages";
import { handleBrowserMessage } from "./routes/browser-messages";
import { handleGetPendingFeedback, handleMarkFeedbackDelivered, handleGetPendingFeedbackByClaudeSession, handleMarkSessionInteractive, handleMarkSessionFinished } from "./routes/feedback-api";
import type { BrowserToServerMessage } from "./routes/websocket-types";
import type { DaemonToServerMessage } from "./types/daemon-ws";
import type { BrowserToServerMessage as SpawnedBrowserMessage } from "./types/browser-ws";
import { sessionLimitEnforcer, getLimitExceededMessage } from "./lib/session-limits";
import { sendInputLimiter, stopCleanupInterval } from "./lib/rate-limiter";
import { logSessionEnded, logPermissionDecision, logLimitExceeded, auditLogger } from "./lib/audit-log";

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
const analytics = new AnalyticsRecorder(repo);
const api = createApiRoutes(repo);
const pages = createPageRoutes(repo);

/**
 * Extract text content from content blocks array.
 * Used for message storage and analytics content length calculation.
 */
function extractTextContent(contentBlocks: Array<{ type: string; text?: string }>): string {
  return contentBlocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

// WebSocket data attached to each connection
interface BrowserWebSocketData {
  type: "browser";
  sessionId: string;
  isSpawned?: boolean; // True for browser-initiated sessions via daemon
}

type WebSocketData = BrowserWebSocketData | DaemonWebSocketData;

/**
 * Handle messages from daemon WebSocket connections.
 * These include connection announcements and session output.
 */
function handleDaemonMessage(
  ws: import("bun").ServerWebSocket<DaemonWebSocketData>,
  message: DaemonToServerMessage
): void {
  switch (message.type) {
    case "daemon_connected": {
      // Store the clientId in ws.data for later reference
      ws.data.clientId = message.client_id;

      daemonConnections.addDaemon(message.client_id, ws, message.capabilities);
      break;
    }

    case "session_output": {
      const session = spawnedSessionRegistry.getSession(message.session_id);
      if (!session) {
        console.warn(`[relay] Unknown session: ${message.session_id}`);
        return;
      }

      // Track output size and check limits
      const outputSize = JSON.stringify(message.messages).length;
      const limitCheck = sessionLimitEnforcer.recordOutput(message.session_id, outputSize);

      if (limitCheck.exceeded) {
        // Log the limit exceeded
        logLimitExceeded(message.session_id, limitCheck.exceeded);

        // End the session due to limit
        daemonConnections.sendToDaemon(session.daemonClientId, {
          type: "end_session",
          session_id: message.session_id,
        });

        broadcastToSession(message.session_id, {
          type: "limit_exceeded",
          limit: limitCheck.exceeded,
          message: getLimitExceededMessage(limitCheck.exceeded),
        });

        console.log(`[limits] Ending session ${message.session_id} due to ${limitCheck.exceeded}`);
        return;
      }

      // Store messages to DB for persistence (instead of in-memory cache)
      const messagesToStore = message.messages.map((msg) => {
        const contentBlocks = msg.message?.content || [];
        return {
          session_id: message.session_id,
          role: msg.message?.role || msg.type,
          content: extractTextContent(contentBlocks),
          // Cast daemon-ws ContentBlock[] to schema ContentBlock[] (compatible structure)
          content_blocks: contentBlocks as SchemaContentBlock[],
          timestamp: new Date().toISOString(),
        };
      });

      if (messagesToStore.length > 0) {
        repo.addMessagesWithIndices(message.session_id, messagesToStore);
      }

      // Record analytics and accumulate token usage (grouped by model for analytics)
      const totalTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
      const tokensByModel = new Map<string | undefined, typeof totalTokens>();

      for (const msg of message.messages) {
        const role = msg.message?.role || msg.type;
        const contentBlocks = msg.message?.content || [];
        const usage = msg.message?.usage;
        const model = msg.message?.model;

        if (usage) {
          const input = usage.input_tokens || 0;
          const output = usage.output_tokens || 0;
          const cacheCreation = usage.cache_creation_input_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;

          totalTokens.input += input;
          totalTokens.output += output;
          totalTokens.cacheCreation += cacheCreation;
          totalTokens.cacheRead += cacheRead;

          // Group by model for analytics
          const existing = tokensByModel.get(model) || { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
          tokensByModel.set(model, {
            input: existing.input + input,
            output: existing.output + output,
            cacheCreation: existing.cacheCreation + cacheCreation,
            cacheRead: existing.cacheRead + cacheRead,
          });
        }

        if (role === "user") {
          analytics.recordMessageSent(message.session_id, {
            clientId: ws.data.clientId,
            contentLength: extractTextContent(contentBlocks).length,
          });
        }

        if (role === "assistant") {
          analytics.recordToolsFromMessage(
            message.session_id,
            contentBlocks as Array<{ type: string; name?: string }>,
            { clientId: ws.data.clientId }
          );
        }
      }

      // Update session token totals
      const hasTokens = totalTokens.input > 0 || totalTokens.output > 0 ||
                        totalTokens.cacheCreation > 0 || totalTokens.cacheRead > 0;
      if (hasTokens) {
        repo.incrementTokenUsage(message.session_id, totalTokens);
      }

      // Record token analytics by model
      for (const [model, tokens] of tokensByModel) {
        analytics.recordTokenUsage(tokens, {
          clientId: ws.data.clientId,
          model,
        });
      }

      // Update DB activity timestamp
      repo.updateSession(message.session_id, {
        last_activity_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      });

      // Update session status based on messages
      for (const msg of message.messages) {
        if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
          // Start tracking limits when session initializes
          sessionLimitEnforcer.startTracking(message.session_id);
          spawnedSessionRegistry.updateSession(message.session_id, {
            claudeSessionId: msg.session_id,
            status: "running",
          });
          // Update DB with claude session ID
          repo.updateSession(message.session_id, {
            claude_session_id: msg.session_id,
          });
          // Broadcast the claude session ID to connected browsers
          broadcastToSession(message.session_id, {
            type: "session_init",
            claude_session_id: msg.session_id,
          });
        }
        if (msg.type === "result") {
          spawnedSessionRegistry.updateSession(message.session_id, {
            status: "waiting",
          });
        }
        if (msg.type === "assistant") {
          spawnedSessionRegistry.updateSession(message.session_id, {
            status: "running",
          });
        }
      }

      // Broadcast to browser WebSocket subscribers
      broadcastToSession(message.session_id, {
        type: "message",
        messages: message.messages,
      });
      break;
    }

    case "session_ended": {
      // Get session for analytics (duration calculation)
      const spawnedSession = spawnedSessionRegistry.getSession(message.session_id);

      // Calculate duration in seconds
      let durationSeconds: number | undefined;
      if (spawnedSession?.createdAt) {
        durationSeconds = Math.floor((Date.now() - spawnedSession.createdAt.getTime()) / 1000);
      }

      // Get message count from DB for analytics
      const messageCount = repo.getMessageCount(message.session_id);

      // Record analytics for session completion
      analytics.recordSessionCompleted(message.session_id, {
        clientId: ws.data.clientId,
        durationSeconds,
        messageCount,
      });

      spawnedSessionRegistry.updateSession(message.session_id, {
        status: "ended",
        endedAt: new Date(),
        exitCode: message.exit_code,
        error: message.error,
      });

      // Update DB status to complete
      repo.updateSession(message.session_id, {
        status: "complete",
        last_activity_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      });

      // Stop tracking limits
      sessionLimitEnforcer.stopTracking(message.session_id);

      // Log session end for audit
      logSessionEnded(
        message.session_id,
        message.reason || "completed",
        message.exit_code
      );

      // Unregister from daemon
      const clientId = ws.data.clientId;
      if (clientId) {
        daemonConnections.unregisterSpawnedSession(clientId, message.session_id);
      }

      // Broadcast to browsers
      broadcastToSession(message.session_id, {
        type: "complete",
        exit_code: message.exit_code,
        reason: message.reason,
        error: message.error,
      });
      break;
    }

    case "question_prompt": {
      // Relay AskUserQuestion to browser
      broadcastToSession(message.session_id, {
        type: "question_prompt",
        tool_use_id: message.tool_use_id,
        question: message.question,
        options: message.options,
      });
      break;
    }

    case "permission_prompt": {
      // Record the pending permission request
      spawnedSessionRegistry.setPendingPermission(message.session_id, {
        id: message.request_id,
        tool: message.tool,
        description: message.description,
        details: message.details,
      });

      // Relay permission request to browser
      broadcastToSession(message.session_id, {
        type: "permission_prompt",
        request_id: message.request_id,
        tool: message.tool,
        description: message.description,
        details: message.details,
      });
      break;
    }

    case "control_request": {
      // Record the pending control request
      spawnedSessionRegistry.setPendingPermission(message.session_id, {
        id: message.request_id,
        tool: message.request.tool_name,
        description: message.request.decision_reason || `Use ${message.request.tool_name} tool`,
        details: message.request.input,
      });

      // Relay control request to browser (using the browser-ws format)
      broadcastToSession(message.session_id, {
        type: "control_request",
        request_id: message.request_id,
        tool_name: message.request.tool_name,
        tool_use_id: message.request.tool_use_id,
        input: message.request.input,
        decision_reason: message.request.decision_reason,
        blocked_path: message.request.blocked_path,
      });
      break;
    }

    case "session_diff": {
      // Parse and store the diff
      const parsedDiffs = parseDiffForSpawnedSession(
        message.diff,
        message.session_id,
        new Set(message.modified_files)
      );

      // Store diffs in DB (clear existing and add new)
      repo.clearDiffs(message.session_id);
      if (parsedDiffs.length > 0) {
        repo.addDiffs(parsedDiffs.map((d, index) => ({
          session_id: message.session_id,
          filename: d.filename,
          diff_content: d.diff_content,
          diff_index: index,
          additions: d.additions,
          deletions: d.deletions,
          is_session_relevant: d.is_session_relevant,
          status: d.additions > 0 && d.deletions === 0 ? "added" as const
            : d.additions === 0 && d.deletions > 0 ? "removed" as const
            : "modified" as const,
        })));
      }

      // Broadcast diff update to browsers
      broadcastToSession(message.session_id, {
        type: "diff_update",
        diffs: parsedDiffs,
      });

      console.log(`[relay] Diff update for session ${message.session_id}: ${parsedDiffs.length} files`);
      break;
    }

    case "session_metadata": {
      // Update session with metadata from daemon (agent_session_id, repo_url, branch)
      const updates: Record<string, string | undefined> = {};

      if (message.agent_session_id) {
        updates.agent_session_id = message.agent_session_id;
      }
      if (message.repo_url) {
        updates.repo_url = message.repo_url;
      }
      if (message.branch) {
        updates.branch = message.branch;
      }

      if (Object.keys(updates).length > 0) {
        repo.updateSession(message.session_id, updates);
        console.log(
          `[relay] Updated metadata for session ${message.session_id}:`,
          updates
        );
      }
      break;
    }

    default:
      console.warn("[daemon-msg] Unknown message type:", (message as { type: string }).type);
  }
}

/**
 * Parse a diff string into parsed diff objects for spawned sessions.
 * Similar to parseDiffData in api.ts but returns ParsedDiff format.
 */
function parseDiffForSpawnedSession(
  content: string,
  sessionId: string,
  modifiedFiles: Set<string>
): ParsedDiff[] {
  const diffs: ParsedDiff[] = [];
  const trimmed = content.trim();

  if (!trimmed) return diffs;

  // Split by "diff --git" to handle multiple files
  const parts = trimmed.split(/(?=diff --git)/);

  parts.forEach((part) => {
    const partTrimmed = part.trim();
    if (!partTrimmed) return;

    // Extract filename from diff header
    let filename: string | null = null;
    const filenameMatch = partTrimmed.match(/diff --git a\/(.+?) b\//);
    if (filenameMatch?.[1]) {
      filename = filenameMatch[1];
    } else {
      // Try to get filename from +++ line
      const plusMatch = partTrimmed.match(/\+\+\+ [ab]\/(.+)/);
      if (plusMatch?.[1]) {
        filename = plusMatch[1];
      }
    }

    // Count additions and deletions
    let additions = 0;
    let deletions = 0;
    const lines = partTrimmed.split("\n");
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    // Determine relevance based on modified files
    let isRelevant = true;
    if (filename && modifiedFiles.size > 0) {
      // Normalize path for comparison
      const normalized = filename.replace(/^\.\//, "").replace(/\/+/g, "/");
      isRelevant = modifiedFiles.has(normalized) ||
        modifiedFiles.has(filename) ||
        Array.from(modifiedFiles).some(f => {
          const normalizedModified = f.replace(/^\.\//, "").replace(/\/+/g, "/");
          return f.endsWith(normalized) || normalized.endsWith(normalizedModified) ||
                 normalizedModified.endsWith(normalized);
        });
    }

    diffs.push({
      filename: filename || "unknown",
      diff_content: partTrimmed,
      additions,
      deletions,
      is_session_relevant: isRelevant,
    });
  });

  // If no "diff --git" markers, treat as single diff
  if (diffs.length === 0 && trimmed) {
    let additions = 0;
    let deletions = 0;
    const lines = trimmed.split("\n");
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    diffs.push({
      filename: "unknown",
      diff_content: trimmed,
      additions,
      deletions,
      is_session_relevant: true,
    });
  }

  return diffs;
}

/**
 * Handle messages from browser WebSocket connections for spawned sessions.
 * These include user input, interrupt, end session, and prompt responses.
 */
function handleSpawnedSessionMessage(
  sessionId: string,
  message: SpawnedBrowserMessage,
  sendError?: (error: { type: string; code: string; message: string }) => void
): void {
  switch (message.type) {
    case "user_message": {
      // Rate limit per session
      const rateCheck = sendInputLimiter.check(`input:${sessionId}`);
      if (!rateCheck.allowed) {
        // Send error back via WebSocket if callback provided
        if (sendError) {
          sendError({
            type: "error",
            code: "RATE_LIMITED",
            message: "Too many messages. Please wait.",
          });
        }
        return;
      }

      const session = spawnedSessionRegistry.getSession(sessionId);
      if (!session) {
        console.warn(`[ws] user_message for unknown spawned session: ${sessionId}`);
        return;
      }

      // Record activity for idle timeout
      sessionLimitEnforcer.recordActivity(sessionId);

      // Relay to daemon
      const sent = daemonConnections.sendToDaemon(session.daemonClientId, {
        type: "send_input",
        session_id: sessionId,
        content: message.content,
      });

      if (!sent) {
        console.error(`[ws] Failed to relay user_message to daemon`);
      }
      break;
    }

    case "interrupt": {
      const session = spawnedSessionRegistry.getSession(sessionId);
      if (!session) return;

      daemonConnections.sendToDaemon(session.daemonClientId, {
        type: "interrupt_session",
        session_id: sessionId,
      });
      break;
    }

    case "end_session": {
      const session = spawnedSessionRegistry.getSession(sessionId);
      if (!session) return;

      daemonConnections.sendToDaemon(session.daemonClientId, {
        type: "end_session",
        session_id: sessionId,
      });
      break;
    }

    case "question_response": {
      const session = spawnedSessionRegistry.getSession(sessionId);
      if (!session) return;

      daemonConnections.sendToDaemon(session.daemonClientId, {
        type: "question_response",
        session_id: sessionId,
        tool_use_id: message.tool_use_id,
        answer: message.answer,
      });
      break;
    }

    case "permission_response": {
      const session = spawnedSessionRegistry.getSession(sessionId);
      if (!session) return;

      // Record the permission decision
      const pendingRequest = session.pendingPermissionRequest;
      const tool = pendingRequest?.tool || "unknown";

      spawnedSessionRegistry.recordPermissionDecision(sessionId, {
        id: message.request_id,
        tool,
        description: pendingRequest?.description || "Permission decision",
        decision: message.allow ? "allowed" : "denied",
      });

      // Log permission decision for audit
      logPermissionDecision(sessionId, tool, message.allow, {
        type: "browser",
      });

      // Relay to daemon
      daemonConnections.sendToDaemon(session.daemonClientId, {
        type: "permission_response",
        session_id: sessionId,
        request_id: message.request_id,
        allow: message.allow,
      });
      break;
    }

    case "control_response": {
      const session = spawnedSessionRegistry.getSession(sessionId);
      if (!session) return;

      // Record the permission decision
      const pendingRequest = session.pendingPermissionRequest;
      const tool = pendingRequest?.tool || "unknown";

      spawnedSessionRegistry.recordPermissionDecision(sessionId, {
        id: message.request_id,
        tool,
        description: pendingRequest?.description || "Control request decision",
        decision: message.allow ? "allowed" : "denied",
      });

      // Log permission decision for audit
      logPermissionDecision(sessionId, tool, message.allow, {
        type: "browser",
      });

      // Relay to daemon with SDK format
      // Note: SDK requires updatedInput to be a record for allow responses,
      // so we use the original input if no modifications were provided
      const originalInput = (pendingRequest?.details as Record<string, unknown>) ?? {};
      daemonConnections.sendToDaemon(session.daemonClientId, {
        type: "control_response",
        session_id: sessionId,
        request_id: message.request_id,
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: message.allow
            ? {
                behavior: "allow" as const,
                updatedInput: message.updatedInput ?? originalInput,
              }
            : { behavior: "deny" as const, message: message.message || "User denied the action" },
        },
      });
      break;
    }

    default:
      // Not a spawned session message, ignore
      break;
  }
}

// Type for route handler requests (Bun adds params for parameterized routes)
type RouteRequest = Request & { params: Record<string, string> };

// Start server
const server = Bun.serve<WebSocketData>({
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
      GET: (req: Request) => pages.statsPage(req),
    },

    // Install script for CLI setup
    "/setup/install.sh": () => new Response(installScript, {
      headers: { "Content-Type": "text/x-shellscript" },
    }),

    // API routes for data
    "/api/sessions": {
      GET: (req: Request) => api.getSessions(req),
      POST: (req: Request) => api.createSession(req),
    },

    "/api/sessions/:id": {
      GET: (req: RouteRequest) => {
        const url = new URL(req.url);
        const baseUrl = `${url.protocol}//${url.host}`;
        return api.getSessionDetail(req, req.params.id!, baseUrl);
      },
      POST: (req: RouteRequest) => api.updateSession(req, req.params.id!),
      PATCH: (req: RouteRequest) => api.patchSession(req, req.params.id!),
      DELETE: (req: RouteRequest) => api.deleteSession(req, req.params.id!),
    },

    "/api/sessions/:id/share": {
      POST: (req: RouteRequest) => api.shareSession(req, req.params.id!),
    },

    "/api/sessions/:id/export": {
      GET: (req: RouteRequest) => api.getSessionJson(req, req.params.id!),
    },

    "/api/sessions/:id/diffs": {
      GET: (req: RouteRequest) => api.getSessionDiffs(req, req.params.id!),
    },

    "/api/sessions/:id/annotations": {
      GET: (req: RouteRequest) => api.getAnnotations(req, req.params.id!),
    },

    "/api/s/:shareToken": {
      GET: (req: RouteRequest) => {
        const url = new URL(req.url);
        const baseUrl = `${url.protocol}//${url.host}`;
        return api.getSharedSessionDetail(req.params.shareToken!, baseUrl);
      },
    },

    // Live streaming endpoints
    "/api/sessions/live": {
      GET: () => api.getLiveSessions(),
      POST: (req: Request) => api.createLiveSession(req),
    },

    "/api/sessions/:id/messages": {
      POST: (req: RouteRequest) => api.pushMessages(req, req.params.id!),
    },

    "/api/sessions/:id/tool-results": {
      POST: (req: RouteRequest) => api.pushToolResults(req, req.params.id!),
    },

    "/api/sessions/:id/diff": {
      PUT: (req: RouteRequest) => api.updateDiff(req, req.params.id!),
    },

    "/api/sessions/:id/complete": {
      POST: (req: RouteRequest) => api.completeSession(req, req.params.id!),
    },

    "/api/sessions/:id/interactive": {
      POST: (req: RouteRequest) => api.markInteractive(req, req.params.id!),
      DELETE: (req: RouteRequest) => api.disableInteractive(req, req.params.id!),
    },

    // Feedback API endpoints for plugin-based interactive sessions
    // Note: by-claude-session route must come before :id routes to avoid matching conflicts
    "/api/sessions/by-claude-session/:claudeSessionId/feedback/pending": {
      GET: (req: RouteRequest) => handleGetPendingFeedbackByClaudeSession(req.params.claudeSessionId!, repo),
    },

    "/api/sessions/by-claude-session/:claudeSessionId/interactive": {
      POST: (req: RouteRequest) => handleMarkSessionInteractive(req.params.claudeSessionId!, repo),
    },

    "/api/sessions/by-claude-session/:claudeSessionId/finished": {
      POST: (req: RouteRequest) => handleMarkSessionFinished(req.params.claudeSessionId!, repo),
    },

    "/api/sessions/:id/feedback/pending": {
      GET: (req: RouteRequest) => handleGetPendingFeedback(req.params.id!, repo),
    },

    "/api/sessions/:id/feedback/:messageId/delivered": {
      POST: (req: RouteRequest) => handleMarkFeedbackDelivered(req.params.id!, req.params.messageId!, repo),
    },

    // Auth callback for CLI OAuth flow
    "/auth/cli/callback": {
      GET: (req: Request) => api.handleCliAuthCallback(req),
    },

    // Session claiming endpoints (for authenticated users)
    "/api/sessions/unclaimed": {
      GET: (req: Request) => api.getUnclaimedSessions(req),
    },

    "/api/sessions/claim": {
      POST: (req: Request) => api.claimSessions(req),
    },

    // Analytics Stats endpoints
    "/api/stats": {
      GET: (req: Request) => api.getStats(req),
    },

    "/api/stats/timeseries": {
      GET: (req: Request) => api.getStatsTimeseries(req),
    },

    "/api/stats/tools": {
      GET: (req: Request) => api.getStatsTools(req),
    },

    "/api/stats/dashboard": {
      GET: (req: Request) => api.getDashboardStats(req),
    },

    // Daemon status endpoints
    "/api/daemon/status": {
      GET: (req: Request) => api.getDaemonStatus(req),
    },

    "/api/daemon/repos": {
      GET: (req: Request) => api.getDaemonRepos(req),
    },

    "/api/daemon/list": {
      GET: (req: Request) => api.listConnectedDaemons(req),
    },

    // Spawned session endpoints
    "/api/sessions/spawn": {
      POST: (req: Request) => api.spawnSession(req),
    },

    "/api/sessions/spawned": {
      GET: (req: Request) => api.getSpawnedSessions(req),
    },

    "/api/sessions/:id/resume": {
      POST: (req: RouteRequest) => api.resumeSession(req.params.id!, req),
    },

    "/api/sessions/:id/info": {
      GET: (req: RouteRequest) => api.getSessionInfo(req.params.id!, req),
    },

    // Session sharing endpoints
    "/api/sessions/:id/collaborators": {
      GET: (req) => api.getCollaborators(req, req.params.id),
      POST: (req) => api.addCollaborator(req, req.params.id),
    },

    // Note: /accept must come before /:collaboratorId to avoid "accept" being matched as a collaboratorId
    "/api/sessions/:id/collaborators/accept": {
      POST: (req) => api.acceptInvite(req, req.params.id),
    },

    "/api/sessions/:id/collaborators/:collaboratorId": {
      PATCH: (req) => api.updateCollaborator(req, req.params.id, parseInt(req.params.collaboratorId, 10)),
      DELETE: (req) => api.removeCollaborator(req, req.params.id, parseInt(req.params.collaboratorId, 10)),
    },

    "/api/sessions/:id/visibility": {
      PUT: (req) => api.updateVisibility(req, req.params.id),
    },

    "/api/sessions/:id/audit": {
      GET: (req) => api.getAuditLog(req, req.params.id),
    },

    "/api/sessions/shared-with-me": {
      GET: (req) => api.getSessionsSharedWithMe(req),
    },

    // Health check endpoint
    "/api/health": {
      GET: () => api.getHealth(),
    },
  },

  fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade for daemon connections
    if (url.pathname === "/api/daemon/ws") {
      const clientIdHeader = req.headers.get("X-Openctl-Client-ID");

      const upgraded = server.upgrade(req, {
        data: {
          type: "daemon",
          clientId: clientIdHeader || undefined,
        },
      });

      if (upgraded) {
        return undefined; // Bun handles the upgrade
      }

      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // Handle WebSocket upgrade for live session subscriptions (browser clients)
    const wsMatch = url.pathname.match(/^\/api\/sessions\/([^\/]+)\/ws$/);
    if (wsMatch && wsMatch[1]) {
      const sessionId = wsMatch[1];

      // Check if this is a spawned session (in-memory registry)
      const spawnedSession = spawnedSessionRegistry.getSession(sessionId);
      if (spawnedSession) {
        // Allow WebSocket connection even for ended/failed sessions
        // so the client can receive the error message
        const upgraded = server.upgrade(req, {
          data: { type: "browser", sessionId, isSpawned: true },
        });

        if (upgraded) {
          return undefined;
        }

        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // Check if this is an archived session (database)
      const sessionResult = repo.getSession(sessionId);

      if (sessionResult.isErr()) {
        return new Response("Session not found", { status: 404 });
      }
      const session = sessionResult.unwrap();

      // Only allow WebSocket connections for live sessions
      // Once a session is complete/archived, use the regular API to fetch static data
      if (session.status !== "live") {
        return new Response("WebSocket only available for live sessions", { status: 410 });
      }

      // Use session.remote to determine if this is a spawned session
      // that's not currently in the registry (e.g., daemon disconnected or server restarted)
      const upgraded = server.upgrade(req, {
        data: { type: "browser", sessionId, isSpawned: session.remote },
      });

      if (upgraded) {
        return undefined; // Bun handles the upgrade
      }

      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws: import("bun").ServerWebSocket<WebSocketData>) {
      const data = ws.data;

      // Handle daemon connections
      if (data.type === "daemon") {
        // Daemon connections are fully handled in the message handler
        // after receiving daemon_connected message
        console.log("[ws] Daemon WebSocket opened, awaiting daemon_connected");
        return;
      }

      // Handle browser connections
      // Add to subscriber list
      addSessionSubscriber(data.sessionId, ws as unknown as WebSocket);

      // Check if this is a spawned session (browser-initiated via daemon)
      const browserData = data as BrowserWebSocketData;
      if (browserData.isSpawned) {
        const spawnedSession = spawnedSessionRegistry.getSession(data.sessionId);
        const dbSessionResult = repo.getSession(data.sessionId);
        const dbSession = dbSessionResult.isOk() ? dbSessionResult.unwrap() : null;
        const messageCount = repo.getMessageCount(data.sessionId);
        const lastIndex = repo.getLastMessageIndex(data.sessionId);

        // Determine status: use registry if available, otherwise derive from DB
        // If not in registry but DB says "live", daemon is disconnected
        let status: string;
        if (spawnedSession) {
          status = spawnedSession.status;
        } else if (dbSession?.status === "live") {
          // Spawned session not in registry but DB says live = daemon disconnected
          status = "disconnected";
        } else {
          // Session completed/archived - use DB status
          status = dbSession?.status || "ended";
        }

        ws.send(JSON.stringify({
          type: "connected",
          session_id: data.sessionId,
          status,
          message_count: messageCount,
          last_index: lastIndex,
          interactive: true, // Spawned sessions are always interactive
          claude_state: "unknown" as const,
          is_spawned: true,
          claude_session_id: dbSession?.claude_session_id || spawnedSession?.claudeSessionId,
        }));

        // If session already ended/failed (e.g., startup error), send the complete message immediately
        if (spawnedSession && (spawnedSession.status === "ended" || spawnedSession.status === "failed")) {
          ws.send(JSON.stringify({
            type: "complete",
            exit_code: spawnedSession.exitCode || 1,
            reason: "error",
            error: spawnedSession.error || "Session failed to start",
          }));
        }
        return;
      }

      // Send connected message with current state including interactive info (database sessions)
      const sessionResult = repo.getSession(data.sessionId);
      const session = sessionResult.isOk() ? sessionResult.unwrap() : null;
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

    message(ws: import("bun").ServerWebSocket<WebSocketData>, message: string | Buffer) {
      const data = ws.data;

      try {
        const msg = JSON.parse(message.toString());

        // Handle daemon messages
        if (data.type === "daemon") {
          handleDaemonMessage(ws as unknown as import("bun").ServerWebSocket<DaemonWebSocketData>, msg as DaemonToServerMessage);
          return;
        }

        // Handle browser messages for spawned sessions
        // Check if this session is a spawned session first
        if (spawnedSessionRegistry.isSpawnedSession(data.sessionId)) {
          handleSpawnedSessionMessage(
            data.sessionId,
            msg as SpawnedBrowserMessage,
            (error) => ws.send(JSON.stringify(error))
          );

          // Handle subscribe for spawned sessions - replay messages and diffs from DB
          if (msg.type === "subscribe") {
            const fromIndex = typeof msg.from_index === "number" ? msg.from_index : 0;

            // Query messages from DB
            const dbMessages = repo.getMessages(data.sessionId);
            const filteredMessages = dbMessages.filter((m) => m.message_index >= fromIndex);

            if (filteredMessages.length > 0) {
              // Convert DB messages to StreamJsonMessage format for client
              const streamMessages = filteredMessages.map((m) => ({
                type: m.role === "user" ? "user" as const :
                      m.role === "assistant" ? "assistant" as const :
                      m.role === "result" ? "result" as const : "system" as const,
                message: {
                  id: `msg-${m.id}`,
                  role: m.role,
                  content: m.content_blocks,
                },
              }));

              ws.send(JSON.stringify({
                type: "message",
                messages: streamMessages,
              }));
            }

            // Query diffs from DB
            const dbDiffs = repo.getDiffs(data.sessionId);
            if (dbDiffs.length > 0) {
              ws.send(JSON.stringify({
                type: "diff_update",
                diffs: dbDiffs.map((d) => ({
                  filename: d.filename || "unknown",
                  diff_content: d.diff_content,
                  additions: d.additions,
                  deletions: d.deletions,
                  is_session_relevant: d.is_session_relevant,
                })),
              }));
            }
          }

          // Handle ping for spawned sessions
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
          }
          return;
        }

        // Handle browser messages for regular (plugin-based) sessions
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

    close(ws: import("bun").ServerWebSocket<WebSocketData>) {
      const data = ws.data;

      // Handle daemon disconnection
      if (data.type === "daemon" && data.clientId) {
        daemonConnections.removeDaemon(data.clientId);
        return;
      }

      // Handle browser disconnection
      if (data.type === "browser") {
        removeSessionSubscriber(data.sessionId, ws as unknown as WebSocket);
      }
    },
  },
});

if (server.port !== DEFAULT_PORT && !process.env.PORT) {
  console.log(`Port ${DEFAULT_PORT} in use, using ${server.port} instead`);
}
console.log(`openctl running at http://${HOST}:${server.port}`);

// Idle timeout checker - runs every minute
const idleTimeoutInterval = setInterval(() => {
  const idleSessions = sessionLimitEnforcer.checkAllIdleTimeouts();
  for (const sessionId of idleSessions) {
    const session = spawnedSessionRegistry.getSession(sessionId);
    if (session && session.status !== "ended" && session.status !== "failed") {
      console.log(`[limits] Ending idle session: ${sessionId}`);

      // Log the idle timeout
      logLimitExceeded(sessionId, "idle_timeout");

      // End the session
      daemonConnections.sendToDaemon(session.daemonClientId, {
        type: "end_session",
        session_id: sessionId,
      });

      // Notify browser subscribers
      broadcastToSession(sessionId, {
        type: "limit_exceeded",
        limit: "idle_timeout",
        message: getLimitExceededMessage("idle_timeout"),
      });
    }
  }
}, 60_000); // Check every minute

// Graceful shutdown handling
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.log("Shutdown already in progress...");
    return;
  }
  isShuttingDown = true;

  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  // Stop intervals
  console.log("Stopping intervals...");
  clearInterval(idleTimeoutInterval);
  stopCleanupInterval();

  // Close all WebSocket connections
  console.log("Closing WebSocket connections...");
  closeAllConnections();

  // Stop accepting new connections and close existing ones
  console.log("Stopping server...");
  server.stop();

  // Flush audit logs
  console.log("Flushing audit logs...");
  await auditLogger.close();

  // Close database connection
  console.log("Closing database...");
  db.close();

  console.log("Shutdown complete.");
  process.exit(0);
}

// Handle termination signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
