import { Database } from "bun:sqlite";

function safeAddColumn(db: Database, table: string, column: string, definition: string): void {
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch {
    // Column already exists, ignore
  }
}

export function initializeDatabase(dbPath: string = "sessions.db"): Database {
  const db = new Database(dbPath);

  // Enable foreign key enforcement
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      claude_session_id TEXT,
      pr_url TEXT,
      share_token TEXT UNIQUE,
      project_path TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT,
      message_index INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS diffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      filename TEXT,
      diff_content TEXT NOT NULL,
      diff_index INTEGER DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_diffs_session ON diffs(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_share_token ON sessions(share_token)`);

  // Migrations - add new columns safely
  safeAddColumn(db, "messages", "content_blocks", "TEXT DEFAULT '[]'");
  safeAddColumn(db, "diffs", "additions", "INTEGER DEFAULT 0");
  safeAddColumn(db, "diffs", "deletions", "INTEGER DEFAULT 0");
  safeAddColumn(db, "diffs", "is_session_relevant", "INTEGER DEFAULT 1");

  return db;
}

export type Session = {
  id: string;
  title: string;
  description: string | null;
  claude_session_id: string | null;
  pr_url: string | null;
  share_token: string | null;
  project_path: string | null;
  created_at: string;
  updated_at: string;
};

// Content block types (matches Claude API structure)
export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  duration_ms?: number;
};

export type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
  filename?: string;
};

export type FileBlock = {
  type: "file";
  filename: string;
  media_type?: string;
  size?: number;
};

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ImageBlock
  | FileBlock;

export type Message = {
  id: number;
  session_id: string;
  role: string;
  content: string; // Keep for backward compat, derived from content_blocks
  content_blocks: ContentBlock[]; // Structured content
  timestamp: string | null;
  message_index: number;
};

export type Diff = {
  id: number;
  session_id: string;
  filename: string | null;
  diff_content: string;
  diff_index: number;
  additions: number; // Pre-computed
  deletions: number; // Pre-computed
  is_session_relevant: boolean; // True if file was touched in conversation
};
