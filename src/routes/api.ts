import { SessionRepository } from "../db/repository";
import type { Message, Diff } from "../db/schema";

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

// URL validation
function isValidHttpUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function createApiRoutes(repo: SessionRepository) {
  return {
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

        let diffs: Omit<Diff, "id">[] = [];
        if (diffFile && diffFile.size > 0) {
          const content = await diffFile.text();
          diffs = parseDiffData(content, id);
        } else if (diffData) {
          diffs = parseDiffData(diffData, id);
        }

        // Create session with all data in a transaction
        repo.createSessionWithData(
          {
            id,
            title,
            description: (formData.get("description") as string) || null,
            claude_session_id: (formData.get("claude_session_id") as string) || null,
            pr_url: prUrl || null,
            share_token: null,
            project_path: (formData.get("project_path") as string) || null,
          },
          messages,
          diffs
        );

        return new Response(null, {
          status: 303,
          headers: { Location: `/sessions/${id}` },
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

        // Process diff data
        const diffFile = formData.get("diff_file") as File | null;
        const diffData = formData.get("diff_data") as string;

        let diffs: Omit<Diff, "id">[] = [];

        if (diffFile && diffFile.size > 0) {
          const content = await diffFile.text();
          diffs = parseDiffData(content, sessionId);
        } else if (diffData) {
          diffs = parseDiffData(diffData, sessionId);
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
    deleteSession(sessionId: string): Response {
      const deleted = repo.deleteSession(sessionId);
      if (!deleted) {
        return jsonError("Session not found", 404);
      }
      return json({ success: true });
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
  };
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

  // Try to detect if it's JSONL (Claude Code native format) or JSON array
  const trimmed = content.trim();

  if (trimmed.startsWith("[")) {
    // JSON array format
    try {
      const data = JSON.parse(trimmed);
      if (Array.isArray(data)) {
        data.forEach((item, index) => {
          const msg = extractMessage(item, sessionId, index);
          if (msg) messages.push(msg);
        });
      }
    } catch (e) {
      console.error("Failed to parse JSON:", e);
    }
  } else {
    // JSONL format (one JSON object per line)
    const lines = trimmed.split("\n");
    let messageIndex = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        const msg = extractMessage(item, sessionId, messageIndex);
        if (msg) {
          messages.push(msg);
          messageIndex++;
        }
      } catch {
        // Skip invalid lines
      }
    }
  }

  return messages;
}

function extractMessage(
  item: Record<string, unknown>,
  sessionId: string,
  index: number
): Omit<Message, "id"> | null {
  // Handle various Claude session formats
  let role: string | null = null;
  let content: string | null = null;
  let timestamp: string | null = null;

  // Direct role/content format
  if (item.role && typeof item.role === "string") {
    role = item.role === "human" ? "user" : item.role;
  }

  if (item.content) {
    if (typeof item.content === "string") {
      content = item.content;
    } else if (Array.isArray(item.content)) {
      // Handle content array format (like Claude API format)
      content = item.content
        .map((c: Record<string, unknown>) => {
          if (c.type === "text" && typeof c.text === "string") return c.text;
          if (c.type === "tool_use") return `[Tool: ${c.name}]`;
          if (c.type === "tool_result") return `[Tool Result]`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }

  // Handle message wrapper format
  if (item.message && typeof item.message === "object") {
    const msg = item.message as Record<string, unknown>;
    if (msg.role && typeof msg.role === "string") {
      role = msg.role === "human" ? "user" : msg.role;
    }
    if (msg.content) {
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = (msg.content as Array<Record<string, unknown>>)
          .map((c) => {
            if (c.type === "text" && typeof c.text === "string") return c.text;
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }
    }
  }

  // Handle type-based format
  if (item.type === "human" || item.type === "user") {
    role = "user";
    if (typeof item.text === "string") content = item.text;
  } else if (item.type === "assistant") {
    role = "assistant";
    if (typeof item.text === "string") content = item.text;
  }

  // Timestamp handling
  if (item.timestamp) {
    timestamp = String(item.timestamp);
  } else if (item.created_at) {
    timestamp = String(item.created_at);
  }

  if (role && content) {
    return {
      session_id: sessionId,
      role,
      content,
      timestamp,
      message_index: index,
    };
  }

  return null;
}

function parseDiffData(content: string, sessionId: string): Omit<Diff, "id">[] {
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

    diffs.push({
      session_id: sessionId,
      filename,
      diff_content: partTrimmed,
      diff_index: index,
    });
  });

  // If no "diff --git" markers, treat as single diff
  if (diffs.length === 0 && trimmed) {
    diffs.push({
      session_id: sessionId,
      filename: null,
      diff_content: trimmed,
      diff_index: 0,
    });
  }

  return diffs;
}
