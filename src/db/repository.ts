import { Database, Statement } from "bun:sqlite";
import type { Session, Message, Diff } from "./schema";

export class SessionRepository {
  // Cached prepared statements
  private readonly stmts: {
    createSession: Statement;
    getSession: Statement;
    getSessionByShareToken: Statement;
    getAllSessions: Statement;
    deleteSession: Statement;
    insertMessage: Statement;
    getMessages: Statement;
    clearMessages: Statement;
    insertDiff: Statement;
    getDiffs: Statement;
    clearDiffs: Statement;
  };

  constructor(private db: Database) {
    // Initialize cached prepared statements
    this.stmts = {
      createSession: db.prepare(`
        INSERT INTO sessions (id, title, description, claude_session_id, pr_url, share_token, project_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `),
      getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
      getSessionByShareToken: db.prepare("SELECT * FROM sessions WHERE share_token = ?"),
      getAllSessions: db.prepare("SELECT * FROM sessions ORDER BY created_at DESC"),
      deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
      insertMessage: db.prepare(`
        INSERT INTO messages (session_id, role, content, content_blocks, timestamp, message_index)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      getMessages: db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY message_index ASC"),
      clearMessages: db.prepare("DELETE FROM messages WHERE session_id = ?"),
      insertDiff: db.prepare(`
        INSERT INTO diffs (session_id, filename, diff_content, diff_index, additions, deletions, is_session_relevant)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      getDiffs: db.prepare("SELECT * FROM diffs WHERE session_id = ? ORDER BY diff_index ASC"),
      clearDiffs: db.prepare("DELETE FROM diffs WHERE session_id = ?"),
    };
  }

  createSession(session: Omit<Session, "created_at" | "updated_at">): Session {
    return this.stmts.createSession.get(
      session.id,
      session.title,
      session.description,
      session.claude_session_id,
      session.pr_url,
      session.share_token,
      session.project_path
    ) as Session;
  }

  // Create session with messages and diffs in a single transaction
  createSessionWithData(
    session: Omit<Session, "created_at" | "updated_at">,
    messages: Omit<Message, "id">[],
    diffs: Omit<Diff, "id">[]
  ): Session {
    const transaction = this.db.transaction(() => {
      const created = this.stmts.createSession.get(
        session.id,
        session.title,
        session.description,
        session.claude_session_id,
        session.pr_url,
        session.share_token,
        session.project_path
      ) as Session;

      for (const msg of messages) {
        this.stmts.insertMessage.run(
          msg.session_id,
          msg.role,
          msg.content,
          JSON.stringify(msg.content_blocks || []),
          msg.timestamp,
          msg.message_index
        );
      }

      for (const diff of diffs) {
        this.stmts.insertDiff.run(
          diff.session_id,
          diff.filename,
          diff.diff_content,
          diff.diff_index,
          diff.additions || 0,
          diff.deletions || 0,
          diff.is_session_relevant ? 1 : 0
        );
      }

      return created;
    });

    return transaction();
  }

  updateSession(id: string, updates: Partial<Omit<Session, "id" | "created_at">>): Session | null {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.title !== undefined) {
      fields.push("title = ?");
      values.push(updates.title);
    }
    if (updates.description !== undefined) {
      fields.push("description = ?");
      values.push(updates.description);
    }
    if (updates.claude_session_id !== undefined) {
      fields.push("claude_session_id = ?");
      values.push(updates.claude_session_id);
    }
    if (updates.pr_url !== undefined) {
      fields.push("pr_url = ?");
      values.push(updates.pr_url);
    }
    if (updates.share_token !== undefined) {
      fields.push("share_token = ?");
      values.push(updates.share_token);
    }
    if (updates.project_path !== undefined) {
      fields.push("project_path = ?");
      values.push(updates.project_path);
    }

    if (fields.length === 0) return this.getSession(id);

    fields.push("updated_at = datetime('now')");
    values.push(id);

    // Dynamic query - can't be cached
    const stmt = this.db.prepare(`
      UPDATE sessions SET ${fields.join(", ")} WHERE id = ? RETURNING *
    `);
    return stmt.get(...values) as Session | null;
  }

  getSession(id: string): Session | null {
    return this.stmts.getSession.get(id) as Session | null;
  }

  getSessionByShareToken(token: string): Session | null {
    return this.stmts.getSessionByShareToken.get(token) as Session | null;
  }

  getAllSessions(): Session[] {
    return this.stmts.getAllSessions.all() as Session[];
  }

  deleteSession(id: string): boolean {
    const result = this.stmts.deleteSession.run(id);
    return result.changes > 0;
  }

  addMessage(message: Omit<Message, "id">): void {
    this.stmts.insertMessage.run(
      message.session_id,
      message.role,
      message.content,
      JSON.stringify(message.content_blocks || []),
      message.timestamp,
      message.message_index
    );
  }

  addMessages(messages: Omit<Message, "id">[]): void {
    const transaction = this.db.transaction(() => {
      for (const msg of messages) {
        this.stmts.insertMessage.run(
          msg.session_id,
          msg.role,
          msg.content,
          JSON.stringify(msg.content_blocks || []),
          msg.timestamp,
          msg.message_index
        );
      }
    });
    transaction();
  }

  getMessages(sessionId: string): Message[] {
    const rows = this.stmts.getMessages.all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      ...row,
      content_blocks: JSON.parse((row.content_blocks as string) || '[]'),
    })) as Message[];
  }

  addDiff(diff: Omit<Diff, "id">): void {
    this.stmts.insertDiff.run(
      diff.session_id,
      diff.filename,
      diff.diff_content,
      diff.diff_index,
      diff.additions || 0,
      diff.deletions || 0,
      diff.is_session_relevant ? 1 : 0
    );
  }

  addDiffs(diffs: Omit<Diff, "id">[]): void {
    const transaction = this.db.transaction(() => {
      for (const diff of diffs) {
        this.stmts.insertDiff.run(
          diff.session_id,
          diff.filename,
          diff.diff_content,
          diff.diff_index,
          diff.additions || 0,
          diff.deletions || 0,
          diff.is_session_relevant ? 1 : 0
        );
      }
    });
    transaction();
  }

  getDiffs(sessionId: string): Diff[] {
    const rows = this.stmts.getDiffs.all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      ...row,
      is_session_relevant: Boolean(row.is_session_relevant),
    })) as Diff[];
  }

  clearMessages(sessionId: string): void {
    this.stmts.clearMessages.run(sessionId);
  }

  clearDiffs(sessionId: string): void {
    this.stmts.clearDiffs.run(sessionId);
  }
}
