import { SessionRepository } from "../db/repository";
import type { Message, Diff, ContentBlock, ToolUseBlock, ToolResultBlock, ImageBlock } from "../db/schema";

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
    // Get all sessions
    getSessions(): Response {
      const sessions = repo.getAllSessions();
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

      let shareUrl: string | null = null;
      if (session.share_token && baseUrl) {
        shareUrl = `${baseUrl}/s/${session.share_token}`;
      }

      return json({ session, messages, diffs, shareUrl });
    },

    // Get shared session detail
    getSharedSessionDetail(shareToken: string, baseUrl?: string): Response {
      const session = repo.getSessionByShareToken(shareToken);
      if (!session) {
        return jsonError("Session not found", 404);
      }

      const messages = repo.getMessages(session.id);
      const diffs = repo.getDiffs(session.id);

      const shareUrl = baseUrl ? `${baseUrl}/s/${session.share_token}` : null;

      return json({ session, messages, diffs, shareUrl });
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

function extractMessage(
  item: Record<string, unknown>,
  sessionId: string,
  index: number
): Omit<Message, "id"> | null {
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

  // Extract content blocks
  const content = msgData.content;
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
    message_index: index,
  };
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
