import type {
  HarnessAdapter,
  NormalizedMessage,
  SessionInfo,
  ParseContext,
  ContentBlock,
} from "./types";

/**
 * Claude Code adapter for parsing .claude/projects session files
 */
export const claudeCodeAdapter: HarnessAdapter = {
  id: "claude-code",
  name: "Claude Code",

  getWatchPaths(): string[] {
    const home = Bun.env.HOME;
    if (!home) {
      return [];
    }
    return [`${home}/.claude/projects`];
  },

  canHandle(filePath: string): boolean {
    // Must be a .jsonl file in .claude/projects
    if (!filePath.includes("/.claude/projects/") || !filePath.endsWith(".jsonl")) {
      return false;
    }
    // Exclude subagent session files (stored in <session>/subagents/)
    if (filePath.includes("/subagents/")) {
      return false;
    }
    return true;
  },

  getSessionInfo(filePath: string): SessionInfo {
    // Path format: ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
    const projectsIndex = filePath.indexOf("/.claude/projects/");
    if (projectsIndex === -1) {
      return {
        localPath: filePath,
        projectPath: "",
      };
    }

    const relativePath = filePath.slice(projectsIndex + "/.claude/projects/".length);
    const parts = relativePath.split("/");

    // The encoded project path is everything except the last part (session file)
    const encodedProjectPath = parts.slice(0, -1).join("/");
    const sessionFile = parts[parts.length - 1];
    const sessionId = sessionFile.replace(".jsonl", "");

    // Decode the project path (replace hyphens with slashes, handle encoding)
    const projectPath = decodeProjectPath(encodedProjectPath);

    return {
      localPath: filePath,
      projectPath,
      harnessSessionId: sessionId,
    };
  },

  parseLine(line: string, context: ParseContext): NormalizedMessage[] | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const data = parsed as Record<string, unknown>;

    // Handle wrapped message format: { message: { role, content } }
    const messageData = data.message
      ? (data.message as Record<string, unknown>)
      : data;

    // Extract role
    let role = messageData.role as string | undefined;
    if (!role) {
      return null;
    }

    // Normalize role: "human" -> "user"
    if (role === "human") {
      role = "user";
    }

    if (role !== "user" && role !== "assistant") {
      return null;
    }

    // Extract content
    const rawContent = messageData.content;
    const contentBlocks = normalizeContent(rawContent);

    // Handle tool_result - attach to pending tool_use
    for (const block of contentBlocks) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const pending = context.pendingToolUses.get(block.tool_use_id);
        if (pending) {
          const targetMessage = context.messages[pending.messageIndex];
          if (targetMessage) {
            const toolUseBlock = targetMessage.content_blocks[pending.blockIndex];
            if (toolUseBlock) {
              // Attach result to the tool_use block
              toolUseBlock.result = block.content;
              toolUseBlock.is_error = block.is_error;
            }
          }
          context.pendingToolUses.delete(block.tool_use_id);
        }
      }
    }

    // Don't create a new message for tool_result-only content
    const nonToolResultBlocks = contentBlocks.filter((b) => b.type !== "tool_result");
    if (nonToolResultBlocks.length === 0) {
      return null;
    }

    const message: NormalizedMessage = {
      role: role as "user" | "assistant",
      content_blocks: nonToolResultBlocks,
    };

    // Extract timestamp if available
    if (typeof data.timestamp === "string") {
      message.timestamp = data.timestamp;
    }

    // Track tool_use blocks for later pairing with tool_result
    const messageIndex = context.messages.length;
    for (let i = 0; i < nonToolResultBlocks.length; i++) {
      const block = nonToolResultBlocks[i];
      if (block.type === "tool_use" && typeof block.id === "string") {
        context.pendingToolUses.set(block.id, {
          messageIndex,
          blockIndex: i,
        });
      }
    }

    return [message];
  },

  deriveTitle(messages: NormalizedMessage[]): string {
    // Find first user message
    const firstUserMessage = messages.find((m) => m.role === "user");
    if (!firstUserMessage) {
      return "Untitled Session";
    }

    // Extract text from content blocks
    let text = "";
    for (const block of firstUserMessage.content_blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        text = block.text;
        break;
      }
    }

    if (!text) {
      return "Untitled Session";
    }

    // Clean up and truncate
    const cleaned = text
      .replace(/\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned.length <= 80) {
      return cleaned;
    }

    // Truncate at word boundary
    const truncated = cleaned.slice(0, 80);
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > 40) {
      return truncated.slice(0, lastSpace) + "...";
    }

    return truncated + "...";
  },
};

/**
 * Decode the project path from the encoded format used in .claude/projects
 * The encoding replaces path separators with hyphens
 */
function decodeProjectPath(encoded: string): string {
  if (!encoded) {
    return "";
  }

  // The format typically encodes the full path with hyphens
  // e.g., "Users-bryce-projects-myapp" -> "/Users/bryce/projects/myapp"
  const decoded = "/" + encoded.replace(/-/g, "/");

  return decoded;
}

/**
 * Normalize content to an array of ContentBlock
 */
function normalizeContent(content: unknown): ContentBlock[] {
  if (!content) {
    return [];
  }

  // String content -> single text block
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  // Array of content blocks
  if (Array.isArray(content)) {
    return content
      .filter((item): item is Record<string, unknown> => {
        return item && typeof item === "object";
      })
      .map((item) => {
        // Ensure type field exists
        if (typeof item.type !== "string") {
          return { type: "unknown", ...item };
        }
        return item as ContentBlock;
      });
  }

  // Single object that might be a content block
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.type === "string") {
      return [obj as ContentBlock];
    }
  }

  return [];
}
