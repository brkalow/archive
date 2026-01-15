import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

function safeAddColumn(db: Database, table: string, column: string, definition: string): void {
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch {
    // Column already exists, ignore
  }
}

export function initializeDatabase(dbPath: string = process.env.DATABASE_PATH || "data/sessions.db"): Database {
  const dir = dirname(dbPath);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

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
      created_at TEXT DEFAULT (datetime('now', 'utc')),
      updated_at TEXT DEFAULT (datetime('now', 'utc'))
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

  // Reviews table (one per session, optional)
  db.run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      model TEXT,
      created_at TEXT DEFAULT (datetime('now', 'utc')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Annotations table (line-level review comments)
  db.run(`
    CREATE TABLE IF NOT EXISTS annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL,
      diff_id INTEGER NOT NULL,
      line_number INTEGER NOT NULL,
      side TEXT NOT NULL DEFAULT 'additions',
      annotation_type TEXT NOT NULL,
      content TEXT NOT NULL,
      FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE,
      FOREIGN KEY (diff_id) REFERENCES diffs(id) ON DELETE CASCADE
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_reviews_session ON reviews(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_annotations_review ON annotations(review_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_annotations_diff ON annotations(diff_id)`);

  // Migrations - add new columns safely
  safeAddColumn(db, "messages", "content_blocks", "TEXT DEFAULT '[]'");
  safeAddColumn(db, "diffs", "additions", "INTEGER DEFAULT 0");
  safeAddColumn(db, "diffs", "deletions", "INTEGER DEFAULT 0");
  safeAddColumn(db, "diffs", "is_session_relevant", "INTEGER DEFAULT 1");
  safeAddColumn(db, "sessions", "model", "TEXT");
  safeAddColumn(db, "sessions", "harness", "TEXT");
  safeAddColumn(db, "sessions", "repo_url", "TEXT");

  // Live streaming support
  safeAddColumn(db, "sessions", "status", "TEXT DEFAULT 'archived'");
  safeAddColumn(db, "sessions", "last_activity_at", "TEXT");
  safeAddColumn(db, "sessions", "stream_token_hash", "TEXT");

  // Client-based session ownership
  safeAddColumn(db, "sessions", "client_id", "TEXT");

  // Index for live session queries
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_client_id ON sessions(client_id)`);

  // Interactive session support
  safeAddColumn(db, "sessions", "interactive", "INTEGER DEFAULT 0");

  // Feedback messages table (for interactive sessions)
  db.run(`
    CREATE TABLE IF NOT EXISTS feedback_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT,
      type TEXT NOT NULL DEFAULT 'message',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
      resolved_at TEXT,
      context_json TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback_messages(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_messages(status)`);

  // Index for session lookup by claude_session_id (for upsert on upload)
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_claude_session_id ON sessions(claude_session_id)`);

  return db;
}

export type SessionStatus = "live" | "complete" | "archived";

export type Session = {
  id: string;
  title: string;
  description: string | null;
  claude_session_id: string | null;
  pr_url: string | null;
  share_token: string | null;
  project_path: string | null;
  model: string | null;
  harness: string | null;
  repo_url: string | null;
  status: SessionStatus;
  last_activity_at: string | null;
  client_id: string | null;
  interactive: boolean;
  created_at: string;
  updated_at: string;
};

// Feedback message types for interactive sessions
export type FeedbackMessageType = "message" | "diff_comment" | "suggested_edit";
export type FeedbackMessageStatus = "pending" | "delivered" | "approved" | "rejected" | "expired";

export type FeedbackMessage = {
  id: string;
  session_id: string;
  content: string;
  source: string | null;
  type: FeedbackMessageType;
  status: FeedbackMessageStatus;
  created_at: string;
  resolved_at: string | null;
  context?: { file: string; line: number };
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

// Code review types
export type AnnotationType = "suggestion" | "issue" | "praise" | "question";

export type Review = {
  id: number;
  session_id: string;
  summary: string;
  model: string | null;
  created_at: string;
};

export type Annotation = {
  id: number;
  review_id: number;
  diff_id: number;
  line_number: number;
  side: "additions" | "deletions";
  annotation_type: AnnotationType;
  content: string;
};
