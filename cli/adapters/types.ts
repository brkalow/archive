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
}
