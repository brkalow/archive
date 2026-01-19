export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface NormalizedMessage {
  role: "user" | "assistant";
  content_blocks: ContentBlock[];
  timestamp?: string;
}

export interface SessionInfo {
  localPath: string;
  projectPath: string;
  harnessSessionId?: string;
  model?: string;
  repoUrl?: string;
}

export interface ParseContext {
  messages: NormalizedMessage[];
  pendingToolUses: Map<string, { messageIndex: number; blockIndex: number }>;
}

// UI Configuration Types
export type ToolIconCategory =
  | "file" | "edit" | "terminal" | "search" | "web"
  | "todo" | "question" | "task" | "thinking" | "mcp" | "default";

export interface ToolConfig {
  icon: ToolIconCategory;
  modifiesFiles?: boolean;
  filePathProperty?: string;
  renderer?: string;
}

export interface SystemTagPattern {
  tag: string;
  style?: "xml" | "regex";
  pattern?: RegExp;
}

export interface AdapterUIConfig {
  tools?: Record<string, ToolConfig>;
  systemTags?: SystemTagPattern[];
  defaultToolIcon?: ToolIconCategory;
  mcpToolPrefixes?: string[];
}

export interface HarnessAdapter {
  id: string;
  name: string;

  /** Directories to watch for session files */
  getWatchPaths(): string[];

  /** Check if this adapter handles a given file */
  canHandle(filePath: string): boolean;

  /** Extract session metadata from file path */
  getSessionInfo(filePath: string): SessionInfo;

  /** Parse a line from the session file */
  parseLine(line: string, context: ParseContext): NormalizedMessage[] | null;

  /** Optional: Detect if session has ended */
  detectSessionEnd?(filePath: string): Promise<boolean>;

  /** Optional: Derive title from messages */
  deriveTitle?(messages: NormalizedMessage[]): string;

  // UI Configuration
  /** Get UI configuration for this adapter */
  getUIConfig?(): AdapterUIConfig;

  /** Get the icon category for a tool */
  getToolIcon?(toolName: string): ToolIconCategory;

  /** Get a short summary for a tool call */
  getToolSummary?(toolName: string, input: Record<string, unknown>): string;

  // File Modification Detection
  /** Get the list of tools that modify files */
  getFileModifyingTools?(): string[];

  /** Extract file path from a tool call */
  extractFilePath?(toolName: string, input: Record<string, unknown>): string | null;

  // Content Processing
  /** Strip system tags from text */
  stripSystemTags?(text: string): string;

  /** Normalize a raw role string to user/assistant */
  normalizeRole?(rawRole: string): "user" | "assistant" | null;
}

export const DEFAULT_ADAPTER_ID = "claude-code";
