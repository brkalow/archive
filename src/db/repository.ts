import { Database, Statement } from "bun:sqlite";
import type { Session, Message, Diff, Review, Annotation, AnnotationType, FeedbackMessage, FeedbackMessageType, FeedbackMessageStatus, AnalyticsEventType, StatType } from "./schema";

// Generate SQLite-compatible UTC timestamp (YYYY-MM-DD HH:MM:SS)
function sqliteDatetimeNow(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

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
    insertDiffReturningId: Statement;
    getDiffs: Statement;
    clearDiffs: Statement;
    // Review statements
    insertReview: Statement;
    getReview: Statement;
    getReviewWithCount: Statement;
    clearReview: Statement;
    // Annotation statements
    insertAnnotation: Statement;
    getAnnotationsByDiff: Statement;
    getAnnotationsBySession: Statement;
    // Live session statements
    getLiveSessionByHarnessId: Statement;
    getSessionByHarnessId: Statement;
    getLiveSessions: Statement;
    // Session lookup by claude_session_id
    getSessionByClaudeSessionId: Statement;
    // Session lookup by agent_session_id
    getSessionByAgentSessionId: Statement;
    // Feedback message statements
    insertFeedbackMessage: Statement;
    updateFeedbackStatus: Statement;
    getPendingFeedback: Statement;
    // Analytics statements
    insertEvent: Statement;
    upsertDailyStat: Statement;
    getStatsByDateRange: Statement;
    getToolStats: Statement;
    getTimeseries: Statement;
  };

  constructor(private db: Database) {
    // Initialize cached prepared statements
    this.stmts = {
      createSession: db.prepare(`
        INSERT INTO sessions (id, title, description, claude_session_id, pr_url, share_token, project_path, model, harness, repo_url, status, last_activity_at, stream_token_hash, client_id, user_id, interactive, remote)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      insertDiffReturningId: db.prepare(`
        INSERT INTO diffs (session_id, filename, diff_content, diff_index, additions, deletions, is_session_relevant)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `),
      getDiffs: db.prepare("SELECT * FROM diffs WHERE session_id = ? ORDER BY diff_index ASC"),
      clearDiffs: db.prepare("DELETE FROM diffs WHERE session_id = ?"),
      // Review statements
      insertReview: db.prepare(`
        INSERT INTO reviews (session_id, summary, model)
        VALUES (?, ?, ?)
        RETURNING *
      `),
      getReview: db.prepare("SELECT * FROM reviews WHERE session_id = ?"),
      getReviewWithCount: db.prepare(`
        SELECT r.*, COUNT(a.id) as annotation_count
        FROM reviews r
        LEFT JOIN annotations a ON a.review_id = r.id
        WHERE r.session_id = ?
        GROUP BY r.id
      `),
      clearReview: db.prepare("DELETE FROM reviews WHERE session_id = ?"),
      // Annotation statements
      insertAnnotation: db.prepare(`
        INSERT INTO annotations (review_id, diff_id, line_number, side, annotation_type, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      getAnnotationsByDiff: db.prepare("SELECT * FROM annotations WHERE diff_id = ?"),
      getAnnotationsBySession: db.prepare(`
        SELECT a.* FROM annotations a
        JOIN reviews r ON a.review_id = r.id
        WHERE r.session_id = ?
      `),
      // Live session statements
      getLiveSessionByHarnessId: db.prepare(`
        SELECT * FROM sessions
        WHERE claude_session_id = ? AND harness = ? AND status = 'live'
        ORDER BY created_at DESC
        LIMIT 1
      `),
      getSessionByHarnessId: db.prepare(`
        SELECT * FROM sessions
        WHERE claude_session_id = ? AND harness = ?
        ORDER BY
          CASE WHEN status = 'live' THEN 0 ELSE 1 END,
          created_at DESC
        LIMIT 1
      `),
      getLiveSessions: db.prepare("SELECT * FROM sessions WHERE status = 'live' ORDER BY last_activity_at DESC"),
      // Session lookup by claude_session_id (most recent first)
      getSessionByClaudeSessionId: db.prepare(`
        SELECT * FROM sessions
        WHERE claude_session_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `),
      // Session lookup by agent_session_id (most recent first)
      getSessionByAgentSessionId: db.prepare(`
        SELECT * FROM sessions
        WHERE agent_session_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `),
      // Feedback message statements
      insertFeedbackMessage: db.prepare(`
        INSERT INTO feedback_messages (id, session_id, content, source, type, context_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      updateFeedbackStatus: db.prepare(`
        UPDATE feedback_messages
        SET status = ?, resolved_at = datetime('now', 'utc')
        WHERE id = ?
      `),
      getPendingFeedback: db.prepare(`
        SELECT * FROM feedback_messages
        WHERE session_id = ? AND status = 'pending'
        ORDER BY created_at ASC
      `),
      // Analytics statements
      insertEvent: db.prepare(`
        INSERT INTO analytics_events (event_type, session_id, client_id, timestamp, properties)
        VALUES (?, ?, ?, datetime('now', 'utc'), ?)
      `),
      upsertDailyStat: db.prepare(`
        INSERT INTO analytics_daily_stats (date, client_id, model, stat_type, value)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date, client_id, model, stat_type)
        DO UPDATE SET value = value + excluded.value
      `),
      getStatsByDateRange: db.prepare(`
        SELECT stat_type, SUM(value) as total
        FROM analytics_daily_stats
        WHERE date >= ? AND date <= ?
          AND ((? IS NULL AND client_id IS NULL) OR client_id = ?)
          AND stat_type NOT LIKE 'tool_%'
        GROUP BY stat_type
      `),
      getToolStats: db.prepare(`
        SELECT SUBSTR(stat_type, 6) as tool, SUM(value) as count
        FROM analytics_daily_stats
        WHERE date >= ? AND date <= ?
          AND ((? IS NULL AND client_id IS NULL) OR client_id = ?)
          AND stat_type LIKE 'tool_%'
        GROUP BY stat_type
        ORDER BY count DESC
      `),
      getTimeseries: db.prepare(`
        SELECT date, SUM(value) as value
        FROM analytics_daily_stats
        WHERE date >= ? AND date <= ?
          AND ((? IS NULL AND client_id IS NULL) OR client_id = ?)
          AND stat_type = ?
        GROUP BY date
        ORDER BY date ASC
      `),
    };
  }

  // Note: client_id and user_id are passed separately to avoid duplication in session object
  createSession(session: Omit<Session, "created_at" | "updated_at" | "client_id" | "user_id">, clientId?: string, userId?: string): Session {
    const result = this.stmts.createSession.get(
      session.id,
      session.title,
      session.description,
      session.claude_session_id,
      session.pr_url,
      session.share_token,
      session.project_path,
      session.model,
      session.harness,
      session.repo_url,
      session.status || "archived",
      session.last_activity_at,
      null, // stream_token_hash deprecated, using client_id for auth
      clientId || null,
      userId || null,
      session.interactive ? 1 : 0,
      session.remote ? 1 : 0
    ) as Record<string, unknown>;

    // Convert SQLite integers to booleans for the returned object
    return this.normalizeSession(result);
  }

  // Create session with messages and diffs in a single transaction
  // Note: client_id and user_id are passed separately to avoid duplication in session object
  createSessionWithData(
    session: Omit<Session, "created_at" | "updated_at" | "client_id" | "user_id">,
    messages: Omit<Message, "id">[],
    diffs: Omit<Diff, "id">[],
    clientId?: string,
    userId?: string
  ): Session {
    const transaction = this.db.transaction(() => {
      const created = this.stmts.createSession.get(
        session.id,
        session.title,
        session.description,
        session.claude_session_id,
        session.pr_url,
        session.share_token,
        session.project_path,
        session.model,
        session.harness,
        session.repo_url,
        session.status || "archived",
        session.last_activity_at,
        null, // stream_token_hash not used for batch uploads
        clientId || null,
        userId || null,
        session.interactive ? 1 : 0,
        session.remote ? 1 : 0
      ) as Record<string, unknown>;

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

      // Convert SQLite integers to booleans
      return this.normalizeSession(created);
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
    if (updates.model !== undefined) {
      fields.push("model = ?");
      values.push(updates.model);
    }
    if (updates.harness !== undefined) {
      fields.push("harness = ?");
      values.push(updates.harness);
    }
    if (updates.repo_url !== undefined) {
      fields.push("repo_url = ?");
      values.push(updates.repo_url);
    }
    if (updates.branch !== undefined) {
      fields.push("branch = ?");
      values.push(updates.branch);
    }
    if (updates.agent_session_id !== undefined) {
      fields.push("agent_session_id = ?");
      values.push(updates.agent_session_id);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.last_activity_at !== undefined) {
      fields.push("last_activity_at = ?");
      values.push(updates.last_activity_at);
    }
    if (updates.client_id !== undefined) {
      fields.push("client_id = ?");
      values.push(updates.client_id);
    }

    if (fields.length === 0) return this.getSession(id);

    fields.push("updated_at = datetime('now', 'utc')");
    values.push(id);

    // Dynamic query - can't be cached
    const stmt = this.db.prepare(`
      UPDATE sessions SET ${fields.join(", ")} WHERE id = ? RETURNING *
    `);
    return stmt.get(...values) as Session | null;
  }

  getSession(id: string): Session | null {
    const result = this.stmts.getSession.get(id) as Record<string, unknown> | null;
    return result ? this.normalizeSession(result) : null;
  }

  getSessionByShareToken(token: string): Session | null {
    const result = this.stmts.getSessionByShareToken.get(token) as Record<string, unknown> | null;
    return result ? this.normalizeSession(result) : null;
  }

  /**
   * Find a live session by harness session ID.
   * Used to resume streaming to an existing session after daemon restart.
   */
  getLiveSessionByHarnessId(harnessSessionId: string, harness: string): Session | null {
    const result = this.stmts.getLiveSessionByHarnessId.get(harnessSessionId, harness) as Record<string, unknown> | null;
    return result ? this.normalizeSession(result) : null;
  }

  /**
   * Find any session by harness session ID (regardless of status).
   * Used to restore a completed session back to live streaming.
   * Prefers live sessions, then archived/completed by most recent.
   */
  getSessionByHarnessId(harnessSessionId: string, harness: string): Session | null {
    const result = this.stmts.getSessionByHarnessId.get(harnessSessionId, harness) as Record<string, unknown> | null;
    return result ? this.normalizeSession(result) : null;
  }

  /**
   * Find a session by claude_session_id (the agent's UUID).
   * Used for upserting sessions during batch upload.
   * Returns most recent session with matching UUID.
   */
  getSessionByClaudeSessionId(claudeSessionId: string): Session | null {
    const result = this.stmts.getSessionByClaudeSessionId.get(claudeSessionId) as Record<string, unknown> | null;
    return result ? this.normalizeSession(result) : null;
  }

  /**
   * Find a session by agent_session_id.
   * Returns most recent session with matching agent ID.
   */
  getSessionByAgentSessionId(agentSessionId: string): Session | null {
    const result = this.stmts.getSessionByAgentSessionId.get(agentSessionId) as Record<string, unknown> | null;
    return result ? this.normalizeSession(result) : null;
  }

  getAllSessions(): Session[] {
    const results = this.stmts.getAllSessions.all() as Record<string, unknown>[];
    return results.map(r => this.normalizeSession(r));
  }

  /**
   * Get sessions filtered by client ID (uses database index for efficiency).
   */
  getSessionsByClientId(clientId: string): Session[] {
    const stmt = this.db.prepare("SELECT * FROM sessions WHERE client_id = ? ORDER BY created_at DESC");
    const results = stmt.all(clientId) as Record<string, unknown>[];
    return results.map(r => this.normalizeSession(r));
  }

  /**
   * Get sessions filtered by user ID (uses database index for efficiency).
   */
  getSessionsByUserId(userId: string): Session[] {
    const stmt = this.db.prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC");
    const results = stmt.all(userId) as Record<string, unknown>[];
    return results.map(r => this.normalizeSession(r));
  }

  /**
   * Get sessions owned by either user_id or client_id.
   * Used for authenticated users who may have both user-owned and device-owned sessions.
   */
  getSessionsByOwner(userId?: string, clientId?: string): Session[] {
    if (!userId && !clientId) return [];

    let query: string;
    let params: string[];

    if (userId && clientId) {
      query = "SELECT * FROM sessions WHERE user_id = ? OR client_id = ? ORDER BY created_at DESC";
      params = [userId, clientId];
    } else if (userId) {
      query = "SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC";
      params = [userId];
    } else {
      query = "SELECT * FROM sessions WHERE client_id = ? ORDER BY created_at DESC";
      params = [clientId!];
    }

    const stmt = this.db.prepare(query);
    const results = stmt.all(...params) as Record<string, unknown>[];
    return results.map(r => this.normalizeSession(r));
  }

  /**
   * Convert SQLite integer fields to proper booleans for Session objects.
   */
  private normalizeSession(result: Record<string, unknown>): Session {
    return {
      ...result,
      interactive: Boolean(result.interactive),
      remote: Boolean(result.remote),
    } as Session;
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

  // Live session methods
  getLiveSessions(): Session[] {
    return this.stmts.getLiveSessions.all() as Session[];
  }

  // Get live sessions with message counts in a single query (avoids N+1)
  getLiveSessionsWithCounts(): Array<Session & { message_count: number }> {
    const stmt = this.db.prepare(`
      SELECT s.*, COALESCE(m.cnt, 0) as message_count
      FROM sessions s
      LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM messages GROUP BY session_id) m
        ON s.id = m.session_id
      WHERE s.status = 'live'
      ORDER BY s.last_activity_at DESC
    `);
    return stmt.all() as Array<Session & { message_count: number }>;
  }

  getMessageCount(sessionId: string): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?");
    const result = stmt.get(sessionId) as { count: number };
    return result.count;
  }

  getLastMessageIndex(sessionId: string): number {
    const stmt = this.db.prepare("SELECT MAX(message_index) as last_index FROM messages WHERE session_id = ?");
    const result = stmt.get(sessionId) as { last_index: number | null };
    return result.last_index ?? -1;
  }

  // Atomically add messages with sequential indices (prevents race conditions)
  addMessagesWithIndices(sessionId: string, messages: Array<Omit<Message, "id" | "message_index">>): { lastIndex: number; count: number } {
    const transaction = this.db.transaction(() => {
      // Get current max index within transaction
      const stmt = this.db.prepare("SELECT MAX(message_index) as last_index FROM messages WHERE session_id = ?");
      const result = stmt.get(sessionId) as { last_index: number | null };
      let lastIndex = result.last_index ?? -1;

      for (const msg of messages) {
        lastIndex++;
        this.stmts.insertMessage.run(
          msg.session_id,
          msg.role,
          msg.content,
          JSON.stringify(msg.content_blocks || []),
          msg.timestamp,
          lastIndex
        );
      }

      return { lastIndex, count: messages.length };
    });

    return transaction();
  }

  /**
   * Verify that the given client ID owns the session.
   * Returns true if the session exists and belongs to the client.
   * For live sessions, also verifies the session is still live.
   */
  verifyClientOwnership(sessionId: string, clientId: string | null, requireLive: boolean = true): boolean {
    if (!clientId) return false;

    const query = requireLive
      ? "SELECT client_id FROM sessions WHERE id = ? AND status = 'live'"
      : "SELECT client_id FROM sessions WHERE id = ?";

    const stmt = this.db.prepare(query);
    const result = stmt.get(sessionId) as { client_id: string | null } | null;

    if (!result) return false;

    // If session has no client_id (legacy), allow any authenticated client
    if (!result.client_id) return true;

    return result.client_id === clientId;
  }

  /**
   * Verify ownership of a session using either user_id or client_id.
   * Returns { allowed: boolean, isOwner: boolean } for access control decisions.
   *
   * Ownership is granted if:
   * - The user_id matches the session's user_id, OR
   * - The client_id matches the session's client_id
   *
   * Sessions with no owner (legacy) are NOT accessible via this method.
   * They must be accessed via share_token or migrated to have an owner.
   */
  verifyOwnership(
    sessionId: string,
    userId: string | null,
    clientId: string | null,
    options: { requireLive?: boolean; requireOwner?: boolean } = {}
  ): { allowed: boolean; isOwner: boolean } {
    const { requireLive = false, requireOwner = false } = options;

    if (!userId && !clientId) {
      return { allowed: false, isOwner: false };
    }

    const query = requireLive
      ? "SELECT user_id, client_id FROM sessions WHERE id = ? AND status = 'live'"
      : "SELECT user_id, client_id FROM sessions WHERE id = ?";

    const stmt = this.db.prepare(query);
    const result = stmt.get(sessionId) as { user_id: string | null; client_id: string | null } | null;

    if (!result) {
      return { allowed: false, isOwner: false };
    }

    // Check ownership: user_id match OR client_id match
    const isOwner =
      (userId && result.user_id === userId) ||
      (clientId && result.client_id === clientId) ||
      false;

    if (requireOwner && !isOwner) {
      return { allowed: false, isOwner: false };
    }

    return { allowed: isOwner, isOwner };
  }

  /**
   * Get unclaimed sessions for a client (sessions with client_id but no user_id).
   * Used for session claiming flow after user authentication.
   */
  getUnclaimedSessions(clientId: string): Session[] {
    const stmt = this.db.prepare(
      "SELECT * FROM sessions WHERE client_id = ? AND user_id IS NULL ORDER BY created_at DESC"
    );
    const results = stmt.all(clientId) as Record<string, unknown>[];
    return results.map(r => this.normalizeSession(r));
  }

  /**
   * Claim all unclaimed sessions for a client, assigning them to a user.
   * Returns the number of sessions claimed.
   */
  claimSessions(clientId: string, userId: string): number {
    const stmt = this.db.prepare(
      "UPDATE sessions SET user_id = ?, updated_at = datetime('now', 'utc') WHERE client_id = ? AND user_id IS NULL"
    );
    const result = stmt.run(userId, clientId);
    return result.changes;
  }

  /**
   * Update the user_id for a specific session.
   * Used for individual session claiming.
   */
  setSessionUserId(sessionId: string, userId: string): boolean {
    const stmt = this.db.prepare(
      "UPDATE sessions SET user_id = ?, updated_at = datetime('now', 'utc') WHERE id = ?"
    );
    const result = stmt.run(userId, sessionId);
    return result.changes > 0;
  }

  /**
   * Restore a session to live status.
   * Used to resume streaming to a completed/archived session.
   */
  restoreSessionToLive(sessionId: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE sessions SET
        status = 'live',
        last_activity_at = datetime('now', 'utc'),
        updated_at = datetime('now', 'utc')
      WHERE id = ?
    `);
    const result = stmt.run(sessionId);
    return result.changes > 0;
  }

  getMessagesFromIndex(sessionId: string, fromIndex: number): Message[] {
    const stmt = this.db.prepare(
      "SELECT * FROM messages WHERE session_id = ? AND message_index >= ? ORDER BY message_index ASC"
    );
    const rows = stmt.all(sessionId, fromIndex) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      ...row,
      content_blocks: JSON.parse((row.content_blocks as string) || '[]'),
    })) as Message[];
  }

  // Review methods
  createReview(review: Omit<Review, "id" | "created_at">): Review {
    return this.stmts.insertReview.get(
      review.session_id,
      review.summary,
      review.model
    ) as Review;
  }

  getReview(sessionId: string): Review | null {
    return this.stmts.getReview.get(sessionId) as Review | null;
  }

  getReviewWithCount(sessionId: string): (Review & { annotation_count: number }) | null {
    return this.stmts.getReviewWithCount.get(sessionId) as (Review & { annotation_count: number }) | null;
  }

  // Annotation methods
  addAnnotation(annotation: Omit<Annotation, "id">): void {
    this.stmts.insertAnnotation.run(
      annotation.review_id,
      annotation.diff_id,
      annotation.line_number,
      annotation.side,
      annotation.annotation_type,
      annotation.content
    );
  }

  addAnnotations(annotations: Omit<Annotation, "id">[]): void {
    const transaction = this.db.transaction(() => {
      for (const annotation of annotations) {
        this.stmts.insertAnnotation.run(
          annotation.review_id,
          annotation.diff_id,
          annotation.line_number,
          annotation.side,
          annotation.annotation_type,
          annotation.content
        );
      }
    });
    transaction();
  }

  getAnnotationsByDiff(diffId: number): Annotation[] {
    return this.stmts.getAnnotationsByDiff.all(diffId) as Annotation[];
  }

  getAnnotationsBySession(sessionId: string): Annotation[] {
    return this.stmts.getAnnotationsBySession.all(sessionId) as Annotation[];
  }

  getAnnotationsGroupedByDiff(sessionId: string): Record<number, Annotation[]> {
    const annotations = this.getAnnotationsBySession(sessionId);
    const grouped: Record<number, Annotation[]> = {};
    for (const annotation of annotations) {
      if (!grouped[annotation.diff_id]) {
        grouped[annotation.diff_id] = [];
      }
      grouped[annotation.diff_id].push(annotation);
    }
    return grouped;
  }

  // Input type for annotations during upload (uses filename instead of diff_id)
  // Note: client_id and user_id are passed separately to avoid duplication in session object
  createSessionWithDataAndReview(
    session: Omit<Session, "created_at" | "updated_at" | "client_id" | "user_id">,
    messages: Omit<Message, "id">[],
    diffs: Omit<Diff, "id">[],
    reviewData?: {
      summary: string;
      model?: string;
      annotations: Array<{
        filename: string;
        line_number: number;
        side: "additions" | "deletions";
        annotation_type: AnnotationType;
        content: string;
      }>;
    },
    clientId?: string,
    userId?: string
  ): Session {
    const transaction = this.db.transaction(() => {
      // Create session
      const created = this.stmts.createSession.get(
        session.id,
        session.title,
        session.description,
        session.claude_session_id,
        session.pr_url,
        session.share_token,
        session.project_path,
        session.model,
        session.harness,
        session.repo_url,
        session.status || "archived",
        session.last_activity_at,
        null, // stream_token_hash not used for batch uploads
        clientId || null,
        userId || null,
        session.interactive ? 1 : 0,
        session.remote ? 1 : 0
      ) as Record<string, unknown>;

      // Insert messages
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

      // Insert diffs and track their IDs by filename
      const diffIdByFilename = new Map<string, number>();
      for (const diff of diffs) {
        const result = this.db.prepare(`
          INSERT INTO diffs (session_id, filename, diff_content, diff_index, additions, deletions, is_session_relevant)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          RETURNING id
        `).get(
          diff.session_id,
          diff.filename,
          diff.diff_content,
          diff.diff_index,
          diff.additions || 0,
          diff.deletions || 0,
          diff.is_session_relevant ? 1 : 0
        ) as { id: number };

        if (diff.filename) {
          diffIdByFilename.set(diff.filename, result.id);
        }
      }

      // Create review and annotations if provided
      if (reviewData) {
        const review = this.stmts.insertReview.get(
          session.id,
          reviewData.summary,
          reviewData.model || null
        ) as Review;

        for (const ann of reviewData.annotations) {
          const diffId = diffIdByFilename.get(ann.filename);
          if (diffId) {
            this.stmts.insertAnnotation.run(
              review.id,
              diffId,
              ann.line_number,
              ann.side,
              ann.annotation_type,
              ann.content
            );
          }
        }
      }

      // Convert SQLite integers to booleans
      return this.normalizeSession(created);
    });

    return transaction();
  }

// === Interactive Session Methods ===

  /**
   * Create a feedback message record.
   */
  createFeedbackMessage(
    sessionId: string,
    content: string,
    type: FeedbackMessageType,
    source?: string,
    context?: { file: string; line: number }
  ): FeedbackMessage {
    const id = crypto.randomUUID().slice(0, 8);
    const contextJson = context ? JSON.stringify(context) : null;

    this.stmts.insertFeedbackMessage.run(id, sessionId, content, source || null, type, contextJson);

    return {
      id,
      session_id: sessionId,
      content,
      source: source || null,
      type,
      status: "pending",
      created_at: sqliteDatetimeNow(),
      resolved_at: null,
      context,
    };
  }

  /**
   * Update the status of a feedback message.
   */
  updateFeedbackStatus(messageId: string, status: FeedbackMessageStatus): void {
    this.stmts.updateFeedbackStatus.run(status, messageId);
  }

  /**
   * Get all pending feedback messages for a session.
   */
  getPendingFeedback(sessionId: string): FeedbackMessage[] {
    const rows = this.stmts.getPendingFeedback.all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      id: row.id as string,
      session_id: row.session_id as string,
      content: row.content as string,
      source: row.source as string | null,
      type: row.type as FeedbackMessageType,
      status: row.status as FeedbackMessageStatus,
      created_at: row.created_at as string,
      resolved_at: row.resolved_at as string | null,
      context: row.context_json ? JSON.parse(row.context_json as string) : undefined,
    }));
  }

  /**
   * Set whether a session is interactive (accepts feedback from browsers).
   */
  setSessionInteractive(sessionId: string, interactive: boolean): void {
    const stmt = this.db.prepare(`
      UPDATE sessions SET interactive = ?, updated_at = datetime('now', 'utc') WHERE id = ?
    `);
    stmt.run(interactive ? 1 : 0, sessionId);
  }

  /**
   * Update session status.
   */
  updateSessionStatus(sessionId: string, status: "live" | "complete" | "archived"): void {
    const stmt = this.db.prepare(`
      UPDATE sessions SET status = ?, updated_at = datetime('now', 'utc') WHERE id = ?
    `);
    stmt.run(status, sessionId);
  }

  clearReview(sessionId: string): void {
    this.stmts.clearReview.run(sessionId);
  }

  /**
   * Upsert a session with data based on claude_session_id.
   * If a session with the same claude_session_id exists, updates it.
   * Otherwise creates a new session.
   * Returns the session and whether it was an update or create.
   */
  upsertSessionWithDataAndReview(
    session: Omit<Session, "created_at" | "updated_at" | "client_id" | "user_id">,
    messages: Omit<Message, "id">[],
    diffs: Omit<Diff, "id">[],
    reviewData?: {
      summary: string;
      model?: string;
      annotations: Array<{
        filename: string;
        line_number: number;
        side: "additions" | "deletions";
        annotation_type: AnnotationType;
        content: string;
      }>;
    },
    clientId?: string,
    userId?: string,
    touchedFiles?: Set<string>
  ): { session: Session; isUpdate: boolean } {
    const transaction = this.db.transaction(() => {
      // Check if session with this claude_session_id already exists
      let existingSession: Session | null = null;
      if (session.claude_session_id) {
        existingSession = this.getSessionByClaudeSessionId(session.claude_session_id);
      }

      let resultSession: Session;
      let isUpdate = false;

      if (existingSession) {
        // Update existing session
        isUpdate = true;
        const sessionId = existingSession.id;

        // Update session metadata
        resultSession = this.updateSession(sessionId, {
          title: session.title,
          description: session.description,
          pr_url: session.pr_url,
          project_path: session.project_path,
          model: session.model,
          harness: session.harness,
          repo_url: session.repo_url,
        }) as Session;

        // Get existing diffs before clearing (for smart diff preservation)
        const existingDiffs = this.getDiffs(sessionId);
        const existingDiffsByFilename = new Map<string, Diff>();
        for (const d of existingDiffs) {
          if (d.filename) {
            existingDiffsByFilename.set(d.filename, d);
          }
        }

        // Helper to normalize file paths for comparison.
        // Removes leading "./" and collapses multiple slashes.
        const normalizeFilePath = (path: string): string =>
          path.replace(/^\.\//, "").replace(/\/+/g, "/");

        // Check if two normalized paths match, accounting for relative vs absolute paths.
        // Paths may come from different sources (git diff headers, file system, etc.)
        // so we allow suffix matching to handle cases like "src/file.ts" matching
        // "project/src/file.ts" when one source uses project-relative and another
        // uses repo-relative paths.
        const normalizedPathsMatch = (norm1: string, norm2: string): boolean =>
          norm1 === norm2 ||
          norm1.endsWith("/" + norm2) ||
          norm2.endsWith("/" + norm1);

        // Build set of normalized filenames covered by new diffs for efficient lookup
        const newDiffFilenamesNormalized = new Set<string>();
        for (const d of diffs) {
          if (d.filename) {
            newDiffFilenamesNormalized.add(normalizeFilePath(d.filename));
          }
        }

        // Clear existing messages, diffs, and reviews
        this.stmts.clearMessages.run(sessionId);
        this.stmts.clearDiffs.run(sessionId);
        this.stmts.clearReview.run(sessionId);

        // Preserve existing diffs for touched files not covered by new diffs.
        // This prevents losing diffs when re-uploading after some files were committed.
        const preservedDiffs: typeof diffs = [];
        if (touchedFiles && touchedFiles.size > 0) {
          for (const touchedFile of touchedFiles) {
            const normalizedTouched = normalizeFilePath(touchedFile);

            // Check if this touched file is covered by any new diff.
            // First try exact match (O(1)), then fall back to suffix matching.
            let isCoveredByNewDiff = newDiffFilenamesNormalized.has(normalizedTouched);
            if (!isCoveredByNewDiff) {
              for (const newNormalized of newDiffFilenamesNormalized) {
                if (normalizedPathsMatch(newNormalized, normalizedTouched)) {
                  isCoveredByNewDiff = true;
                  break;
                }
              }
            }

            if (!isCoveredByNewDiff) {
              // Look for an existing diff that covers this touched file
              for (const [existingFilename, existingDiff] of existingDiffsByFilename) {
                if (normalizedPathsMatch(normalizeFilePath(existingFilename), normalizedTouched)) {
                  preservedDiffs.push({
                    session_id: sessionId,
                    filename: existingDiff.filename,
                    diff_content: existingDiff.diff_content,
                    diff_index: diffs.length + preservedDiffs.length,
                    additions: existingDiff.additions,
                    deletions: existingDiff.deletions,
                    is_session_relevant: existingDiff.is_session_relevant,
                  });
                  break;
                }
              }
            }
          }
        }

        // Append preserved diffs to the diffs array
        diffs.push(...preservedDiffs);
      } else {
        // Create new session
        const created = this.stmts.createSession.get(
          session.id,
          session.title,
          session.description,
          session.claude_session_id,
          session.pr_url,
          session.share_token,
          session.project_path,
          session.model,
          session.harness,
          session.repo_url,
          session.status || "archived",
          session.last_activity_at,
          null, // stream_token_hash not used for batch uploads
          clientId || null,
          userId || null,
          session.interactive ? 1 : 0,
          session.remote ? 1 : 0
        ) as Record<string, unknown>;
        resultSession = this.normalizeSession(created);
      }

      const sessionId = resultSession.id;

      // Insert messages (use sessionId to avoid mutating input arrays)
      for (const msg of messages) {
        this.stmts.insertMessage.run(
          sessionId,
          msg.role,
          msg.content,
          JSON.stringify(msg.content_blocks || []),
          msg.timestamp,
          msg.message_index
        );
      }

      // Insert diffs and track their IDs by filename
      const diffIdByFilename = new Map<string, number>();
      for (const diff of diffs) {
        const result = this.stmts.insertDiffReturningId.get(
          sessionId,
          diff.filename,
          diff.diff_content,
          diff.diff_index,
          diff.additions || 0,
          diff.deletions || 0,
          diff.is_session_relevant ? 1 : 0
        ) as { id: number };

        if (diff.filename) {
          diffIdByFilename.set(diff.filename, result.id);
        }
      }

      // Create review and annotations if provided
      if (reviewData) {
        const review = this.stmts.insertReview.get(
          sessionId,
          reviewData.summary,
          reviewData.model || null
        ) as Review;

        for (const ann of reviewData.annotations) {
          const diffId = diffIdByFilename.get(ann.filename);
          if (diffId) {
            this.stmts.insertAnnotation.run(
              review.id,
              diffId,
              ann.line_number,
              ann.side,
              ann.annotation_type,
              ann.content
            );
          }
        }
      }

      return { session: resultSession, isUpdate };
    });

    return transaction();
  }

  // === Analytics Methods ===

  /**
   * Record an analytics event
   */
  recordEvent(
    eventType: AnalyticsEventType,
    options: {
      sessionId?: string;
      clientId?: string;
      properties?: Record<string, unknown>;
    } = {}
  ): void {
    const { sessionId, clientId, properties = {} } = options;

    this.stmts.insertEvent.run(
      eventType,
      sessionId ?? null,
      clientId ?? null,
      JSON.stringify(properties)
    );
  }

  /**
   * Increment a daily stat (atomic upsert)
   * Automatically updates both global (client_id=null) and per-client rollups
   */
  incrementDailyStat(
    statType: StatType,
    options: {
      clientId?: string;
      model?: string;
      value?: number;
      date?: string;  // YYYY-MM-DD, defaults to today
    } = {}
  ): void {
    const {
      clientId,
      model,
      value = 1,
      date = new Date().toISOString().slice(0, 10)
    } = options;

    // Always update global rollup (client_id = null)
    this.stmts.upsertDailyStat.run(date, null, model ?? null, statType, value);

    // Also update per-client rollup if client_id provided
    if (clientId) {
      this.stmts.upsertDailyStat.run(date, clientId, model ?? null, statType, value);
    }
  }

  /**
   * Record event and increment stat in a single transaction
   */
  recordEventWithStat(
    eventType: AnalyticsEventType,
    statType: StatType,
    options: {
      sessionId?: string;
      clientId?: string;
      model?: string;
      properties?: Record<string, unknown>;
      statValue?: number;
    } = {}
  ): void {
    const { sessionId, clientId, model, properties, statValue = 1 } = options;

    const transaction = this.db.transaction(() => {
      this.recordEvent(eventType, { sessionId, clientId, properties });
      this.incrementDailyStat(statType, { clientId, model, value: statValue });
    });

    transaction();
  }

  /**
   * Record multiple stats in a single transaction (for diff updates)
   */
  recordMultipleStats(
    stats: Array<{
      statType: StatType;
      value: number;
      model?: string;
    }>,
    options: {
      eventType?: AnalyticsEventType;
      sessionId?: string;
      clientId?: string;
      properties?: Record<string, unknown>;
    } = {}
  ): void {
    const { eventType, sessionId, clientId, properties } = options;

    const transaction = this.db.transaction(() => {
      if (eventType) {
        this.recordEvent(eventType, { sessionId, clientId, properties });
      }

      for (const stat of stats) {
        this.incrementDailyStat(stat.statType, {
          clientId,
          model: stat.model,
          value: stat.value,
        });
      }
    });

    transaction();
  }

  /**
   * Get summary stats for a date range
   */
  getStatsSummary(
    startDate: string,
    endDate: string,
    clientId?: string
  ): Record<string, number> {
    const rows = this.stmts.getStatsByDateRange.all(
      startDate,
      endDate,
      clientId ?? null,
      clientId ?? null
    ) as Array<{ stat_type: string; total: number }>;

    const summary: Record<string, number> = {};
    for (const row of rows) {
      summary[row.stat_type] = row.total;
    }
    return summary;
  }

  /**
   * Get tool usage breakdown for a date range
   */
  getToolStats(
    startDate: string,
    endDate: string,
    clientId?: string
  ): Array<{ tool: string; count: number }> {
    return this.stmts.getToolStats.all(
      startDate,
      endDate,
      clientId ?? null,
      clientId ?? null
    ) as Array<{ tool: string; count: number }>;
  }

  /**
   * Get timeseries data for a specific stat
   */
  getStatTimeseries(
    statType: StatType,
    startDate: string,
    endDate: string,
    clientId?: string
  ): Array<{ date: string; value: number }> {
    return this.stmts.getTimeseries.all(
      startDate,
      endDate,
      clientId ?? null,
      clientId ?? null,
      statType
    ) as Array<{ date: string; value: number }>;
  }
}
