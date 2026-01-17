import { SessionRepository } from "../db/repository";
import type { Message, Diff, ContentBlock, ToolUseBlock, ToolResultBlock, ImageBlock, SessionStatus, AnnotationType } from "../db/schema";

// Payload size limits to prevent DoS attacks
const MAX_JSON_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10MB for JSON payloads
const MAX_DIFF_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50MB for diff content

// Validate content length before parsing
function validateContentLength(req: Request, maxBytes: number): Response | null {
  const contentLength = req.headers.get("Content-Length");
  if (contentLength) {
    const length = parseInt(contentLength, 10);
    if (!isNaN(length) && length > maxBytes) {
      return jsonError(`Payload too large (max ${Math.round(maxBytes / 1024 / 1024)}MB)`, 413);
    }
  }
  return null;
}

// JSON response helper
function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function jsonError(error: string, status: number): Response {
  return json({ error }, status);
}

// Extract client ID from request header
function getClientId(req: Request): string | null {
  return req.headers.get("X-Openctl-Client-ID");
}

// URL validation
function isValidHttpUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Parse SQLite datetime (YYYY-MM-DD HH:MM:SS) as UTC
function parseSqliteDatetime(datetime: string): Date {
  // SQLite datetime format: "2026-01-12 06:40:10"
  // Convert to ISO format by replacing space with T and adding Z
  return new Date(datetime.replace(" ", "T") + "Z");
}

// Generate SQLite-compatible UTC timestamp (YYYY-MM-DD HH:MM:SS)
function sqliteDatetimeNow(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// Content block parsing helpers
function parseContentBlock(block: Record<string, unknown>): ContentBlock | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text as string };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id as string,
        name: block.name as string,
        input: block.input as Record<string, unknown>,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id as string,
        content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
        is_error: block.is_error as boolean | undefined,
      };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking as string,
        duration_ms: block.duration_ms as number | undefined,
      };
    case "image":
      return {
        type: "image",
        source: block.source as ImageBlock["source"],
        filename: block.filename as string | undefined,
      };
    default:
      return null;
  }
}

function deriveTextContent(blocks: ContentBlock[]): string {
  return blocks
    .map(block => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `[Tool: ${block.name}]`;
      if (block.type === "tool_result") return `[Tool Result]`;
      if (block.type === "thinking") return `[Thinking]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function createApiRoutes(repo: SessionRepository) {
  return {
    // Get all sessions or a specific session by claude_session_id
    getSessions(req: Request): Response {
      const url = new URL(req.url);
      const claudeSessionId = url.searchParams.get("claude_session_id");

      // If claude_session_id is provided, return the specific session
      if (claudeSessionId) {
        const session = repo.getSessionByClaudeSessionId(claudeSessionId);
        if (session) {
          return json({
            session,
            url: `/sessions/${session.id}`,
          });
        }
        return json({ session: null });
      }

      const mine = url.searchParams.get("mine") === "true";
      const clientId = getClientId(req);

      // Use database-level filtering when filtering by client ID (more efficient)
      const sessions = mine && clientId
        ? repo.getSessionsByClientId(clientId)
        : repo.getAllSessions();

      return json({ sessions });
    },

    // Get session detail with messages and diffs
    getSessionDetail(sessionId: string, baseUrl?: string): Response {
      const session = repo.getSession(sessionId);
      if (!session) {
        return jsonError("Session not found", 404);
      }

      const messages = repo.getMessages(sessionId);
      const diffs = repo.getDiffs(sessionId);
      const review = repo.getReviewWithCount(sessionId);

      let shareUrl: string | null = null;
      if (session.share_token && baseUrl) {
        shareUrl = `${baseUrl}/s/${session.share_token}`;
      }

      return json({ session, messages, diffs, shareUrl, review });
    },

    // Get diffs for a session
    getSessionDiffs(sessionId: string): Response {
      const session = repo.getSession(sessionId);
      if (!session) {
        return jsonError("Session not found", 404);
      }

      const diffs = repo.getDiffs(sessionId);
      return json({ diffs });
    },

    // Get shared session detail
    getSharedSessionDetail(shareToken: string, baseUrl?: string): Response {
      const session = repo.getSessionByShareToken(shareToken);
      if (!session) {
        return jsonError("Session not found", 404);
      }

      const messages = repo.getMessages(session.id);
      const diffs = repo.getDiffs(session.id);
      const review = repo.getReviewWithCount(session.id);

      const shareUrl = baseUrl ? `${baseUrl}/s/${session.share_token}` : null;

      return json({ session, messages, diffs, shareUrl, review });
    },

    // Create session
    async createSession(req: Request): Promise<Response> {
      try {
        const formData = await req.formData();

        const title = formData.get("title") as string;
        if (!title) {
          return jsonError("Title is required", 400);
        }

        const prUrl = formData.get("pr_url") as string;
        if (prUrl && !isValidHttpUrl(prUrl)) {
          return jsonError("Invalid PR URL - must be a valid HTTP(S) URL", 400);
        }

        // Parse data before creating session (fail fast)
        const sessionFile = formData.get("session_file") as File | null;
        const sessionData = formData.get("session_data") as string;
        const diffFile = formData.get("diff_file") as File | null;
        const diffData = formData.get("diff_data") as string;

        const id = generateId();

        let messages: Omit<Message, "id">[] = [];
        if (sessionFile && sessionFile.size > 0) {
          const content = await sessionFile.text();
          messages = parseSessionData(content, id);
        } else if (sessionData) {
          messages = parseSessionData(sessionData, id);
        }

        // Extract files touched in the conversation for diff relevance detection
        const touchedFiles = extractTouchedFiles(messages);

        let diffs: Omit<Diff, "id">[] = [];
        if (diffFile && diffFile.size > 0) {
          const content = await diffFile.text();
          diffs = parseDiffData(content, id, touchedFiles);
        } else if (diffData) {
          diffs = parseDiffData(diffData, id, touchedFiles);
        }

        // Parse review data if provided
        const reviewSummary = formData.get("review_summary") as string;
        const reviewModel = formData.get("review_model") as string;
        const annotationsJson = formData.get("annotations") as string;

        let reviewData: {
          summary: string;
          model?: string;
          annotations: Array<{
            filename: string;
            line_number: number;
            side: "additions" | "deletions";
            annotation_type: AnnotationType;
            content: string;
          }>;
        } | undefined;

        if (reviewSummary) {
          let annotations: Array<{
            filename: string;
            line_number: number;
            side: "additions" | "deletions";
            annotation_type: AnnotationType;
            content: string;
          }> = [];

          if (annotationsJson) {
            try {
              annotations = JSON.parse(annotationsJson);
            } catch {
              console.error("Failed to parse annotations JSON");
            }
          }

          reviewData = {
            summary: reviewSummary,
            model: reviewModel || undefined,
            annotations,
          };
        }

        // Get client ID from request header
        const clientId = getClientId(req);

        const claudeSessionId = (formData.get("claude_session_id") as string) || null;

        // Upsert session: if claude_session_id exists, update existing session
        const { session, isUpdate } = repo.upsertSessionWithDataAndReview(
          {
            id,
            title,
            description: (formData.get("description") as string) || null,
            claude_session_id: claudeSessionId,
            pr_url: prUrl || null,
            share_token: null,
            project_path: (formData.get("project_path") as string) || null,
            model: (formData.get("model") as string) || null,
            harness: (formData.get("harness") as string) || null,
            repo_url: (formData.get("repo_url") as string) || null,
            status: "archived",
            last_activity_at: null,
          },
          messages,
          diffs,
          reviewData,
          clientId || undefined,
          touchedFiles
        );

        if (isUpdate) {
          console.log(`Updated existing session ${session.id} (claude_session_id: ${claudeSessionId})`);
        }

        return new Response(null, {
          status: 303,
          headers: { Location: `/sessions/${session.id}` },
        });
      } catch (error) {
        console.error("Error creating session:", error);
        return jsonError("Failed to create session", 500);
      }
    },

    // Update session
    async updateSession(req: Request, sessionId: string): Promise<Response> {
      try {
        const existing = repo.getSession(sessionId);
        if (!existing) {
          return jsonError("Session not found", 404);
        }

        const formData = await req.formData();

        const title = formData.get("title") as string;
        if (!title) {
          return jsonError("Title is required", 400);
        }

        const prUrl = formData.get("pr_url") as string;
        if (prUrl && !isValidHttpUrl(prUrl)) {
          return jsonError("Invalid PR URL - must be a valid HTTP(S) URL", 400);
        }

        repo.updateSession(sessionId, {
          title,
          description: (formData.get("description") as string) || null,
          claude_session_id: (formData.get("claude_session_id") as string) || null,
          pr_url: prUrl || null,
          project_path: (formData.get("project_path") as string) || null,
          model: (formData.get("model") as string) || null,
          harness: (formData.get("harness") as string) || null,
          repo_url: (formData.get("repo_url") as string) || null,
        });

        // Process session data
        const sessionFile = formData.get("session_file") as File | null;
        const sessionData = formData.get("session_data") as string;

        let messages: Omit<Message, "id">[] = [];

        if (sessionFile && sessionFile.size > 0) {
          const content = await sessionFile.text();
          messages = parseSessionData(content, sessionId);
        } else if (sessionData) {
          messages = parseSessionData(sessionData, sessionId);
        }

        if (messages.length > 0) {
          repo.clearMessages(sessionId);
          repo.addMessages(messages);
        }

        // Extract files touched in the conversation for diff relevance detection
        const touchedFiles = extractTouchedFiles(messages);

        // Process diff data
        const diffFile = formData.get("diff_file") as File | null;
        const diffData = formData.get("diff_data") as string;

        let diffs: Omit<Diff, "id">[] = [];

        if (diffFile && diffFile.size > 0) {
          const content = await diffFile.text();
          diffs = parseDiffData(content, sessionId, touchedFiles);
        } else if (diffData) {
          diffs = parseDiffData(diffData, sessionId, touchedFiles);
        }

        if (diffs.length > 0) {
          repo.clearDiffs(sessionId);
          repo.addDiffs(diffs);
        }

        return new Response(null, {
          status: 303,
          headers: { Location: `/sessions/${sessionId}` },
        });
      } catch (error) {
        console.error("Error updating session:", error);
        return jsonError("Failed to update session", 500);
      }
    },

    // Delete session
    async deleteSession(sessionId: string, req: Request): Promise<Response> {
      const session = repo.getSession(sessionId);
      if (!session) {
        return jsonError("Session not found", 404);
      }

      // Check authorization: either stream token or client ID ownership
      const authHeader = req.headers.get("Authorization");
      if (authHeader?.startsWith("Bearer ")) {
        // Stream token auth (used by daemon for live sessions)
        const token = authHeader.slice(7);
        const tokenHash = await hashToken(token);
        if (!repo.verifyStreamToken(sessionId, tokenHash)) {
          return jsonError("Invalid stream token", 401);
        }
      } else {
        // Client ID auth (legacy sessions without client_id can be deleted by anyone)
        const clientId = getClientId(req);
        if (session.client_id && session.client_id !== clientId) {
          return jsonError("Permission denied - session owned by different client", 403);
        }
      }

      const deleted = repo.deleteSession(sessionId);
      if (!deleted) {
        return jsonError("Session not found", 404);
      }
      return json({ success: true });
    },

    // Patch session (JSON body for partial updates, used by daemon for title updates)
    async patchSession(req: Request, sessionId: string): Promise<Response> {
      try {
        const session = repo.getSession(sessionId);
        if (!session) {
          return jsonError("Session not found", 404);
        }

        // Live sessions require stream token authorization
        const authHeader = req.headers.get("Authorization");
        if (session.status === "live") {
          if (!authHeader?.startsWith("Bearer ")) {
            return jsonError("Authorization required for live sessions", 401);
          }
          const token = authHeader.slice(7);
          const tokenHash = await hashToken(token);
          if (!repo.verifyStreamToken(sessionId, tokenHash)) {
            return jsonError("Invalid stream token", 401);
          }
        }

        const body = await req.json();
        const updates: Partial<{ title: string; description: string }> = {};

        if (typeof body.title === "string") {
          updates.title = body.title;
        }
        if (typeof body.description === "string") {
          updates.description = body.description;
        }

        if (Object.keys(updates).length === 0) {
          return jsonError("No valid fields to update", 400);
        }

        repo.updateSession(sessionId, updates);

        return json({ updated: true, ...updates });
      } catch (error) {
        console.error("Error patching session:", error);
        return jsonError("Failed to patch session", 500);
      }
    },

    // Create share link
    shareSession(sessionId: string): Response {
      const session = repo.getSession(sessionId);
      if (!session) {
        return jsonError("Session not found", 404);
      }

      if (session.share_token) {
        return json({ share_token: session.share_token });
      }

      const shareToken = generateShareToken();
      repo.updateSession(sessionId, { share_token: shareToken });

      return json({ share_token: shareToken });
    },

    // Get session as JSON (for export)
    getSessionJson(sessionId: string): Response {
      const session = repo.getSession(sessionId);
      if (!session) {
        return jsonError("Session not found", 404);
      }

      const messages = repo.getMessages(sessionId);
      const diffs = repo.getDiffs(sessionId);

      return new Response(JSON.stringify({ session, messages, diffs }, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${session.title.replace(/[^a-zA-Z0-9]/g, "_")}.json"`,
        },
      });
    },

    // === Live Streaming Endpoints ===

    // Get all live sessions (uses single query with JOIN to avoid N+1)
    getLiveSessions(): Response {
      const sessions = repo.getLiveSessionsWithCounts();
      return json({
        sessions: sessions.map(s => ({
          id: s.id,
          title: s.title,
          project_path: s.project_path,
          message_count: s.message_count,
          last_activity_at: s.last_activity_at,
          duration_seconds: s.created_at
            ? Math.floor((Date.now() - parseSqliteDatetime(s.created_at).getTime()) / 1000)
            : 0,
        })),
      });
    },

    // Create or resume a live session
    async createLiveSession(req: Request): Promise<Response> {
      try {
        const body = await req.json();
        const { title, project_path, harness_session_id, harness, model, repo_url, interactive = false } = body;
        // Support both old and new field names for backwards compatibility
        const harnessSessionId = harness_session_id || body.claude_session_id;

        if (!title) {
          return jsonError("Title is required", 400);
        }

        // Check if we can resume an existing session (live or completed)
        if (harnessSessionId && harness) {
          // First check for an already-live session
          let existingSession = repo.getLiveSessionByHarnessId(harnessSessionId, harness);

          if (existingSession) {
            // Generate new stream token for the resumed session
            const streamToken = generateStreamToken();
            const streamTokenHash = await hashToken(streamToken);
            repo.updateStreamToken(existingSession.id, streamTokenHash);

            // Update last activity
            repo.updateSession(existingSession.id, {
              last_activity_at: sqliteDatetimeNow(),
            });

            const messageCount = repo.getMessageCount(existingSession.id);
            const lastIndex = repo.getLastMessageIndex(existingSession.id);

            console.log(`Resumed existing session: ${existingSession.id} (${messageCount} messages)`);

            return json({
              id: existingSession.id,
              url: `/sessions/${existingSession.id}`,
              stream_token: streamToken,
              status: "live",
              resumed: true,
              restored: false,
              message_count: messageCount,
              last_index: lastIndex,
            });
          }

          // No live session, check for completed/archived session to restore
          existingSession = repo.getSessionByHarnessId(harnessSessionId, harness);
          if (existingSession) {
            // Restore the session to live status
            const streamToken = generateStreamToken();
            const streamTokenHash = await hashToken(streamToken);
            repo.restoreSessionToLive(existingSession.id, streamTokenHash);

            const messageCount = repo.getMessageCount(existingSession.id);
            const lastIndex = repo.getLastMessageIndex(existingSession.id);

            console.log(`Restored session to live: ${existingSession.id} (${messageCount} messages)`);

            return json({
              id: existingSession.id,
              url: `/sessions/${existingSession.id}`,
              stream_token: streamToken,
              status: "live",
              resumed: true,
              restored: true,
              message_count: messageCount,
              last_index: lastIndex,
            });
          }
        }

        // Create new session
        const id = generateId();
        const streamToken = generateStreamToken();
        const streamTokenHash = await hashToken(streamToken);
        const clientId = getClientId(req);

        repo.createSession(
          {
            id,
            title,
            description: null,
            claude_session_id: harnessSessionId || null,
            pr_url: null,
            share_token: null,
            project_path: project_path || null,
            model: model || null,
            harness: harness || null,
            repo_url: repo_url || null,
            status: "live" as SessionStatus,
            last_activity_at: sqliteDatetimeNow(),
            interactive: Boolean(interactive),
          },
          streamTokenHash,
          clientId || undefined
        );

        return json({
          id,
          url: `/sessions/${id}`,
          stream_token: streamToken,
          status: "live",
          resumed: false,
          message_count: 0,
          last_index: -1,
          interactive: Boolean(interactive),
        });
      } catch (error) {
        console.error("Error creating live session:", error);
        return jsonError("Failed to create live session", 500);
      }
    },

    // Push messages to a live session
    async pushMessages(req: Request, sessionId: string): Promise<Response> {
      try {
        // Validate payload size
        const sizeError = validateContentLength(req, MAX_JSON_PAYLOAD_BYTES);
        if (sizeError) return sizeError;

        // Verify stream token
        const authHeader = req.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return jsonError("Missing or invalid authorization", 401);
        }

        const token = authHeader.slice(7);
        const tokenHash = await hashToken(token);
        if (!repo.verifyStreamToken(sessionId, tokenHash)) {
          return jsonError("Invalid stream token or session not live", 401);
        }

        const session = repo.getSession(sessionId);
        if (!session) {
          return jsonError("Session not found", 404);
        }
        if (session.status !== "live") {
          return jsonError("Session is not live", 409);
        }

        const body = await req.json();
        const { messages: rawMessages } = body;

        if (!Array.isArray(rawMessages)) {
          return jsonError("messages must be an array", 400);
        }

        // Parse messages without indices first
        const parsedMessages: Array<Omit<Message, "id" | "message_index">> = [];
        for (const item of rawMessages) {
          const msg = extractMessageData(item, sessionId);
          if (msg) {
            parsedMessages.push(msg);
          }
        }

        if (parsedMessages.length === 0) {
          return json({
            appended: 0,
            message_count: repo.getMessageCount(sessionId),
            last_index: repo.getLastMessageIndex(sessionId),
          });
        }

        // Atomically add messages with sequential indices (prevents race conditions)
        const { lastIndex, count } = repo.addMessagesWithIndices(sessionId, parsedMessages);

        // Update last activity
        repo.updateSession(sessionId, {
          last_activity_at: sqliteDatetimeNow(),
        });

        // Reconstruct messages with their assigned indices for broadcast
        const startIndex = lastIndex - count + 1;
        const messagesWithIndices = parsedMessages.map((msg, i) => ({
          ...msg,
          message_index: startIndex + i,
        }));

        // Notify WebSocket subscribers
        broadcastToSession(sessionId, {
          type: "message",
          messages: messagesWithIndices,
          index: lastIndex,
        });

        return json({
          appended: count,
          message_count: repo.getMessageCount(sessionId),
          last_index: lastIndex,
        });
      } catch (error) {
        console.error("Error pushing messages:", error);
        return jsonError("Failed to push messages", 500);
      }
    },

    // Push tool results
    async pushToolResults(req: Request, sessionId: string): Promise<Response> {
      try {
        // Validate payload size
        const sizeError = validateContentLength(req, MAX_JSON_PAYLOAD_BYTES);
        if (sizeError) return sizeError;

        const authHeader = req.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return jsonError("Missing or invalid authorization", 401);
        }

        const token = authHeader.slice(7);
        const tokenHash = await hashToken(token);
        if (!repo.verifyStreamToken(sessionId, tokenHash)) {
          return jsonError("Invalid stream token or session not live", 401);
        }

        const session = repo.getSession(sessionId);
        if (!session || session.status !== "live") {
          return jsonError("Session not found or not live", 404);
        }

        const body = await req.json();
        const { results } = body;

        if (!Array.isArray(results)) {
          return jsonError("results must be an array", 400);
        }

        // Broadcast each tool result
        for (const result of results) {
          broadcastToSession(sessionId, {
            type: "tool_result",
            tool_use_id: result.tool_use_id,
            content: result.content,
            is_error: result.is_error,
            message_index: result.message_index,
          });
        }

        repo.updateSession(sessionId, {
          last_activity_at: sqliteDatetimeNow(),
        });

        return json({
          matched: results.length,
          pending: 0,
        });
      } catch (error) {
        console.error("Error pushing tool results:", error);
        return jsonError("Failed to push tool results", 500);
      }
    },

    // Update diff for a live session
    async updateDiff(req: Request, sessionId: string): Promise<Response> {
      try {
        // Validate payload size (larger limit for diffs)
        const sizeError = validateContentLength(req, MAX_DIFF_PAYLOAD_BYTES);
        if (sizeError) return sizeError;

        const authHeader = req.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return jsonError("Missing or invalid authorization", 401);
        }

        const token = authHeader.slice(7);
        const tokenHash = await hashToken(token);
        if (!repo.verifyStreamToken(sessionId, tokenHash)) {
          return jsonError("Invalid stream token or session not live", 401);
        }

        const session = repo.getSession(sessionId);
        if (!session || session.status !== "live") {
          return jsonError("Session not found or not live", 404);
        }

        const diffContent = await req.text();
        const messages = repo.getMessages(sessionId);
        const touchedFiles = extractTouchedFiles(messages);
        const diffs = parseDiffData(diffContent, sessionId, touchedFiles);

        // Replace existing diffs
        repo.clearDiffs(sessionId);
        repo.addDiffs(diffs);

        // Calculate totals
        let additions = 0;
        let deletions = 0;
        for (const d of diffs) {
          additions += d.additions || 0;
          deletions += d.deletions || 0;
        }

        // Broadcast diff update
        broadcastToSession(sessionId, {
          type: "diff",
          files: diffs.map(d => ({
            filename: d.filename || "unknown",
            additions: d.additions || 0,
            deletions: d.deletions || 0,
          })),
        });

        return json({
          files_changed: diffs.length,
          additions,
          deletions,
        });
      } catch (error) {
        console.error("Error updating diff:", error);
        return jsonError("Failed to update diff", 500);
      }
    },

    // Complete a live session
    async completeSession(req: Request, sessionId: string): Promise<Response> {
      try {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return jsonError("Missing or invalid authorization", 401);
        }

        const token = authHeader.slice(7);
        const tokenHash = await hashToken(token);
        if (!repo.verifyStreamToken(sessionId, tokenHash)) {
          return jsonError("Invalid stream token or session not live", 401);
        }

        const session = repo.getSession(sessionId);
        if (!session) {
          return jsonError("Session not found", 404);
        }

        const body = await req.json().catch(() => ({}));
        const { final_diff, summary } = body;

        // Update description if summary provided
        const updates: Partial<{ status: SessionStatus; description: string; last_activity_at: string }> = {
          status: "complete",
          last_activity_at: sqliteDatetimeNow(),
        };

        if (summary) {
          updates.description = summary;
        }

        repo.updateSession(sessionId, updates);

        // Update diff if provided
        if (final_diff) {
          const messages = repo.getMessages(sessionId);
          const touchedFiles = extractTouchedFiles(messages);
          const diffs = parseDiffData(final_diff, sessionId, touchedFiles);
          repo.clearDiffs(sessionId);
          repo.addDiffs(diffs);
        }

        const messageCount = repo.getMessageCount(sessionId);
        const durationSeconds = session.created_at
          ? Math.floor((Date.now() - parseSqliteDatetime(session.created_at).getTime()) / 1000)
          : 0;

        // Broadcast completion
        broadcastToSession(sessionId, {
          type: "complete",
          final_message_count: messageCount,
        });

        // Close all WebSocket connections for this session
        closeSessionConnections(sessionId);

        return json({
          status: "complete",
          message_count: messageCount,
          duration_seconds: durationSeconds,
        });
      } catch (error) {
        console.error("Error completing session:", error);
        return jsonError("Failed to complete session", 500);
      }
    },

    // Mark a live session as interactive (enables browser feedback)
    async markInteractive(req: Request, sessionId: string): Promise<Response> {
      try {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return jsonError("Missing or invalid authorization", 401);
        }

        const token = authHeader.slice(7);
        const tokenHash = await hashToken(token);
        if (!repo.verifyStreamToken(sessionId, tokenHash)) {
          return jsonError("Invalid stream token or session not live", 401);
        }

        const session = repo.getSession(sessionId);
        if (!session) {
          return jsonError("Session not found", 404);
        }

        repo.setSessionInteractive(sessionId, true);

        return json({ success: true, interactive: true });
      } catch (error) {
        console.error("Error marking session interactive:", error);
        return jsonError("Failed to mark session interactive", 500);
      }
    },

    // Disable interactive mode for a session (called when daemon disconnects)
    async disableInteractive(req: Request, sessionId: string): Promise<Response> {
      try {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return jsonError("Missing or invalid authorization", 401);
        }

        const token = authHeader.slice(7);
        const tokenHash = await hashToken(token);
        if (!repo.verifyStreamToken(sessionId, tokenHash)) {
          return jsonError("Invalid stream token or session not live", 401);
        }

        const session = repo.getSession(sessionId);
        if (!session) {
          return jsonError("Session not found", 404);
        }

        repo.setSessionInteractive(sessionId, false);

        return json({ success: true, interactive: false });
      } catch (error) {
        console.error("Error disabling interactive:", error);
        return jsonError("Failed to disable interactive", 500);
      }
    },

    // Get the repository for WebSocket handling
    getRepository(): SessionRepository {
      return repo;
    },

    // Get annotations for a session (for lazy loading in frontend)
    getAnnotations(sessionId: string): Response {
      const session = repo.getSession(sessionId);
      if (!session) {
        return jsonError("Session not found", 404);
      }

      const review = repo.getReview(sessionId);
      if (!review) {
        return json({ review: null, annotations_by_diff: {} });
      }

      const annotationsByDiff = repo.getAnnotationsGroupedByDiff(sessionId);

      return json({ review, annotations_by_diff: annotationsByDiff });
    },
  };
}

// Stream token generation and hashing
function generateStreamToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `stk_${Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// WebSocket connection management
const sessionSubscribers = new Map<string, Set<WebSocket>>();

export function addSessionSubscriber(sessionId: string, ws: WebSocket): void {
  if (!sessionSubscribers.has(sessionId)) {
    sessionSubscribers.set(sessionId, new Set());
  }
  sessionSubscribers.get(sessionId)!.add(ws);
}

export function removeSessionSubscriber(sessionId: string, ws: WebSocket): void {
  const subscribers = sessionSubscribers.get(sessionId);
  if (subscribers) {
    subscribers.delete(ws);
    if (subscribers.size === 0) {
      sessionSubscribers.delete(sessionId);
    }
  }
}

export function broadcastToSession(sessionId: string, message: unknown): void {
  const subscribers = sessionSubscribers.get(sessionId);
  if (!subscribers) return;

  const data = JSON.stringify(message);
  const toRemove: WebSocket[] = [];

  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
      } catch {
        // Failed to send, mark for removal
        toRemove.push(ws);
      }
    } else {
      // Connection closed, mark for removal
      toRemove.push(ws);
    }
  }

  // Clean up dead connections
  for (const ws of toRemove) {
    subscribers.delete(ws);
  }

  // Clean up empty subscriber sets
  if (subscribers.size === 0) {
    sessionSubscribers.delete(sessionId);
  }
}

export function closeSessionConnections(sessionId: string): void {
  const subscribers = sessionSubscribers.get(sessionId);
  if (!subscribers) return;

  for (const ws of subscribers) {
    ws.close(1000, "Session complete");
  }
  sessionSubscribers.delete(sessionId);
}

// Close all WebSocket connections (for graceful shutdown)
export function closeAllConnections(): void {
  for (const [sessionId, subscribers] of sessionSubscribers) {
    for (const ws of subscribers) {
      ws.close(1001, "Server shutting down");
    }
  }
  sessionSubscribers.clear();
}

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = crypto.randomUUID().replace(/-/g, "").substring(0, 8);
  return `sess_${timestamp}_${randomPart}`;
}

function generateShareToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function parseSessionData(content: string, sessionId: string): Omit<Message, "id">[] {
  const messages: Omit<Message, "id">[] = [];
  const trimmed = content.trim();
  const items: Array<Record<string, unknown>> = [];

  // Parse all items
  if (trimmed.startsWith("[")) {
    try {
      items.push(...JSON.parse(trimmed));
    } catch (e) {
      console.error("Failed to parse JSON:", e);
    }
  } else {
    // JSONL format (one JSON object per line)
    for (const line of trimmed.split("\n")) {
      if (!line.trim()) continue;
      try {
        items.push(JSON.parse(line));
      } catch {
        // Skip invalid lines
      }
    }
  }

  // Collect tool_results separately
  const toolResults = new Map<string, ToolResultBlock>();

  for (const item of items) {
    if (item.type === "tool_result") {
      const block: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: item.tool_use_id as string,
        content: typeof item.content === "string" ? item.content : JSON.stringify(item.content),
        is_error: item.is_error as boolean | undefined,
      };
      toolResults.set(block.tool_use_id, block);
    }
  }

  // Process messages and attach tool_results
  let messageIndex = 0;
  for (const item of items) {
    if (item.type === "tool_result") continue;

    const msg = extractMessage(item, sessionId, messageIndex);
    if (!msg) continue;

    // Find tool_use blocks and attach their results
    const toolUseIds = msg.content_blocks
      .filter((b): b is ToolUseBlock => b.type === "tool_use")
      .map(b => b.id);

    for (const id of toolUseIds) {
      const result = toolResults.get(id);
      if (result) {
        msg.content_blocks.push(result);
        toolResults.delete(id);
      }
    }

    // Re-derive text content after adding results
    msg.content = deriveTextContent(msg.content_blocks);

    messages.push(msg);
    messageIndex++;
  }

  return messages;
}

// Extract message data without index (for atomic insertion)
type MessageData = Omit<Message, "id" | "message_index">;

function extractMessageData(
  item: Record<string, unknown>,
  sessionId: string
): MessageData | null {
  let role: string | null = null;
  let contentBlocks: ContentBlock[] = [];
  let timestamp: string | null = null;

  // Handle message wrapper format (Claude Code JSONL)
  const msgData = (item.message as Record<string, unknown>) || item;

  // Extract role
  if (msgData.role === "human" || msgData.role === "user" || item.type === "human" || item.type === "user") {
    role = "user";
  } else if (msgData.role === "assistant" || item.type === "assistant") {
    role = "assistant";
  }

  if (!role) return null;

  // Extract content blocks (handle both "content" and "content_blocks" field names)
  const content = msgData.content || msgData.content_blocks;
  if (typeof content === "string") {
    contentBlocks = [{ type: "text", text: content }];
  } else if (Array.isArray(content)) {
    contentBlocks = content.map(parseContentBlock).filter(Boolean) as ContentBlock[];
  }

  // Handle type-based format with text field
  if (contentBlocks.length === 0 && typeof item.text === "string") {
    contentBlocks = [{ type: "text", text: item.text }];
  }

  // Timestamp
  if (item.timestamp) timestamp = String(item.timestamp);
  else if (item.created_at) timestamp = String(item.created_at);

  if (contentBlocks.length === 0) return null;

  return {
    session_id: sessionId,
    role,
    content: deriveTextContent(contentBlocks),
    content_blocks: contentBlocks,
    timestamp,
  };
}

function extractMessage(
  item: Record<string, unknown>,
  sessionId: string,
  index: number
): Omit<Message, "id"> | null {
  const data = extractMessageData(item, sessionId);
  if (!data) return null;
  return { ...data, message_index: index };
}

// Diff relevance detection helpers
function extractTouchedFiles(messages: Omit<Message, "id">[]): Set<string> {
  const files = new Set<string>();

  for (const msg of messages) {
    for (const block of msg.content_blocks || []) {
      if (block.type === "tool_use" && ["Write", "Edit", "NotebookEdit"].includes(block.name)) {
        const input = block.input as Record<string, unknown>;
        const path = (input.file_path || input.notebook_path) as string;
        if (path) files.add(normalizePath(path));
      }
    }
  }

  return files;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+/g, "/");
}

function countDiffStats(content: string): { additions: number; deletions: number } {
  let additions = 0, deletions = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

function parseDiffData(
  content: string,
  sessionId: string,
  touchedFiles?: Set<string>
): Omit<Diff, "id">[] {
  const diffs: Omit<Diff, "id">[] = [];
  const trimmed = content.trim();

  if (!trimmed) return diffs;

  // Split by "diff --git" to handle multiple files
  const parts = trimmed.split(/(?=diff --git)/);

  parts.forEach((part, index) => {
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

    // Calculate stats and relevance
    const { additions, deletions } = countDiffStats(partTrimmed);
    let isRelevant = true;

    if (touchedFiles && filename) {
      const normalized = normalizePath(filename);
      isRelevant = touchedFiles.has(normalized) ||
        Array.from(touchedFiles).some(f =>
          f.endsWith(normalized) || normalized.endsWith(f)
        );
    }

    diffs.push({
      session_id: sessionId,
      filename,
      diff_content: partTrimmed,
      diff_index: index,
      additions,
      deletions,
      is_session_relevant: isRelevant,
    });
  });

  // If no "diff --git" markers, treat as single diff
  if (diffs.length === 0 && trimmed) {
    const { additions, deletions } = countDiffStats(trimmed);
    diffs.push({
      session_id: sessionId,
      filename: null,
      diff_content: trimmed,
      diff_index: 0,
      additions,
      deletions,
      is_session_relevant: true,
    });
  }

  return diffs;
}
