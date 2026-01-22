import { existsSync } from "fs";
import type {
  HarnessAdapter,
  NormalizedMessage,
  SessionInfo,
  ParseContext,
  ContentBlock,
  ToolConfig,
  ToolIconCategory,
  SystemTagPattern,
  AdapterUIConfig,
} from "./types";

// Tool configuration for Claude Code
const CLAUDE_CODE_TOOLS: Record<string, ToolConfig> = {
  Read: { icon: "file" },
  Write: { icon: "edit", modifiesFiles: true, filePathProperty: "file_path" },
  Edit: { icon: "edit", modifiesFiles: true, filePathProperty: "file_path" },
  NotebookEdit: { icon: "edit", modifiesFiles: true, filePathProperty: "notebook_path" },
  Bash: { icon: "terminal" },
  KillShell: { icon: "terminal" },
  Glob: { icon: "search" },
  Grep: { icon: "search" },
  WebFetch: { icon: "web" },
  WebSearch: { icon: "web" },
  Task: { icon: "task", renderer: "task" },
  TaskOutput: { icon: "task" },
  TodoWrite: { icon: "todo", renderer: "todo_write" },
  AskUserQuestion: { icon: "question", renderer: "ask_user_question" },
  "mcp__conductor__AskUserQuestion": { icon: "question", renderer: "ask_user_question" },
};

const CLAUDE_CODE_SYSTEM_TAGS: SystemTagPattern[] = [
  { tag: "system_instruction" },
  { tag: "system-instruction" },
  { tag: "system-reminder" },
  { tag: "local-command-caveat" },
  { tag: "local-command-stdout" },
];

const CLAUDE_CODE_UI_CONFIG: AdapterUIConfig = {
  tools: CLAUDE_CODE_TOOLS,
  systemTags: CLAUDE_CODE_SYSTEM_TAGS,
  defaultToolIcon: "default",
  mcpToolPrefixes: ["mcp__"],
};

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
    const sessionFile = parts[parts.length - 1] ?? "";
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
      if (block && block.type === "tool_use" && typeof block.id === "string") {
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

    // Strip system tags before creating title
    text = stripSystemTags(text);

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

  // UI Configuration methods
  getUIConfig(): AdapterUIConfig {
    return CLAUDE_CODE_UI_CONFIG;
  },

  getFileModifyingTools(): string[] {
    return Object.entries(CLAUDE_CODE_TOOLS)
      .filter(([_, config]) => config.modifiesFiles)
      .map(([name]) => name);
  },

  extractFilePath(toolName: string, input: Record<string, unknown>): string | null {
    const config = CLAUDE_CODE_TOOLS[toolName];
    if (!config?.filePathProperty) return null;
    const value = input[config.filePathProperty];
    return typeof value === "string" ? value : null;
  },

  getToolIcon(toolName: string): ToolIconCategory {
    if (CLAUDE_CODE_TOOLS[toolName]) return CLAUDE_CODE_TOOLS[toolName].icon;
    for (const prefix of CLAUDE_CODE_UI_CONFIG.mcpToolPrefixes || []) {
      if (toolName.startsWith(prefix)) return "mcp";
    }
    return "default";
  },

  stripSystemTags(text: string): string {
    return stripSystemTags(text);
  },

  normalizeRole(rawRole: string): "user" | "assistant" | null {
    if (rawRole === "human" || rawRole === "user") return "user";
    if (rawRole === "assistant") return "assistant";
    return null;
  },
};

/**
 * Decode the project path from the encoded format used in .claude/projects
 *
 * Claude Code uses URL encoding for path components:
 * - "/Users/bryce/my-project" -> "-Users-bryce-my%2Dproject"
 * - The leading hyphen represents the root /
 * - Hyphens within path components are encoded as %2D
 * - Path separators become hyphens
 *
 * Fallback: If no URL encoding detected, use filesystem validation to
 * disambiguate hyphens that are path separators vs literal hyphens.
 */
function decodeProjectPath(encoded: string): string {
  if (!encoded) {
    return "";
  }

  // Check if URL encoding is present (look for %XX patterns)
  if (/%[0-9A-Fa-f]{2}/.test(encoded)) {
    // URL encoded format: replace hyphens with slashes, then URL decode
    // The leading hyphen represents root /, so just replace all hyphens with slashes
    const withSlashes = encoded.replace(/-/g, "/");
    try {
      return decodeURIComponent(withSlashes);
    } catch {
      // Fall through to filesystem validation
    }
  }

  // No URL encoding - use filesystem validation to find the correct path
  // This handles cases where directory names contain literal hyphens
  return decodeProjectPathWithValidation(encoded);
}

/**
 * Decode project path by validating against the filesystem.
 * Uses recursive backtracking to find a segmentation where all path
 * components exist on the filesystem.
 *
 * Example: "-Users-bryce-my-project" with directory "my-project"
 * - Try "/Users" - exists, recurse with "bryce-my-project"
 * - Try "/Users/bryce" - exists, recurse with "my-project"
 * - Try "/Users/bryce/my" - exists but "/Users/bryce/my/project" doesn't
 * - Backtrack, try "/Users/bryce/my-project" - exists! done
 *
 * If no complete valid path is found, falls back to simple hyphen replacement.
 */
function decodeProjectPathWithValidation(encoded: string): string {
  // Split into segments (filter out empty from leading hyphen)
  const segments = encoded.split("-").filter((s) => s);

  if (segments.length === 0) {
    return "/";
  }

  // Try to find a complete valid path using backtracking
  const result = tryDecodePath(segments, 0, "");
  if (result !== null) {
    return result;
  }

  // Fallback: simple hyphen replacement (imperfect for paths containing hyphens)
  return "/" + encoded.replace(/-/g, "/").replace(/\/+/g, "/");
}

/**
 * Recursively try to decode path segments into a valid filesystem path.
 * Returns null if no valid complete path can be found from this state.
 */
function tryDecodePath(
  segments: string[],
  startIndex: number,
  currentPath: string
): string | null {
  // Base case: all segments consumed
  if (startIndex >= segments.length) {
    return currentPath || "/";
  }

  // Try progressively longer combinations of segments as a single component
  let candidateName = "";
  for (let endIndex = startIndex; endIndex < segments.length; endIndex++) {
    candidateName += (candidateName ? "-" : "") + segments[endIndex];
    const testPath = currentPath + "/" + candidateName;

    if (existsSync(testPath)) {
      // This path exists, try to continue from here
      const result = tryDecodePath(segments, endIndex + 1, testPath);
      if (result !== null) {
        return result;
      }
      // Continuation failed, try a longer component name
    }
  }

  // No valid path found from this state
  return null;
}

/**
 * Strip system instruction and reminder tags from text.
 * Uses CLAUDE_CODE_SYSTEM_TAGS config for consistency.
 */
function stripSystemTags(text: string): string {
  let cleaned = text;
  for (const tagPattern of CLAUDE_CODE_SYSTEM_TAGS) {
    if (tagPattern.style === "regex" && tagPattern.pattern) {
      cleaned = cleaned.replace(tagPattern.pattern, "");
    } else {
      // XML style (default)
      const regex = new RegExp(`<${tagPattern.tag}>[\\s\\S]*?<\\/${tagPattern.tag}>`, "gi");
      cleaned = cleaned.replace(regex, "");
    }
  }
  return cleaned.trim();
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
