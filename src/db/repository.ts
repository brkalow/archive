import { Database, Statement } from "bun:sqlite";
import type { Session, Message, Diff, Review, Annotation, AnnotationType } from "./schema";

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
  };

  constructor(private db: Database) {
    // Initialize cached prepared statements
    this.stmts = {
      createSession: db.prepare(`
        INSERT INTO sessions (id, title, description, claude_session_id, pr_url, share_token, project_path, model, harness, repo_url, status, last_activity_at, stream_token_hash, client_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    };
  }

  // Note: client_id is passed separately to avoid duplication in session object
  createSession(session: Omit<Session, "created_at" | "updated_at" | "client_id">, streamTokenHash?: string, clientId?: string): Session {
    return this.stmts.createSession.get(
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
      streamTokenHash || null,
      clientId || null
    ) as Session;
  }

  // Create session with messages and diffs in a single transaction
  // Note: client_id is passed separately to avoid duplication in session object
  createSessionWithData(
    session: Omit<Session, "created_at" | "updated_at" | "client_id">,
    messages: Omit<Message, "id">[],
    diffs: Omit<Diff, "id">[],
    clientId?: string
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
        clientId || null
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
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.last_activity_at !== undefined) {
      fields.push("last_activity_at = ?");
      values.push(updates.last_activity_at);
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

  /**
   * Find a live session by harness session ID.
   * Used to resume streaming to an existing session after daemon restart.
   */
  getLiveSessionByHarnessId(harnessSessionId: string, harness: string): Session | null {
    return this.stmts.getLiveSessionByHarnessId.get(harnessSessionId, harness) as Session | null;
  }

  /**
   * Find any session by harness session ID (regardless of status).
   * Used to restore a completed session back to live streaming.
   * Prefers live sessions, then archived/completed by most recent.
   */
  getSessionByHarnessId(harnessSessionId: string, harness: string): Session | null {
    return this.stmts.getSessionByHarnessId.get(harnessSessionId, harness) as Session | null;
  }

  /**
   * Find a session by claude_session_id (the agent's UUID).
   * Used for upserting sessions during batch upload.
   * Returns most recent session with matching UUID.
   */
  getSessionByClaudeSessionId(claudeSessionId: string): Session | null {
    return this.stmts.getSessionByClaudeSessionId.get(claudeSessionId) as Session | null;
  }

  getAllSessions(): Session[] {
    return this.stmts.getAllSessions.all() as Session[];
  }

  /**
   * Get sessions filtered by client ID (uses database index for efficiency).
   */
  getSessionsByClientId(clientId: string): Session[] {
    const stmt = this.db.prepare("SELECT * FROM sessions WHERE client_id = ? ORDER BY created_at DESC");
    return stmt.all(clientId) as Session[];
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

  verifyStreamToken(sessionId: string, tokenHash: string): boolean {
    const stmt = this.db.prepare("SELECT stream_token_hash FROM sessions WHERE id = ? AND status = 'live'");
    const result = stmt.get(sessionId) as { stream_token_hash: string | null } | null;

    const storedHash = result?.stream_token_hash;
    if (!storedHash) return false;

    // Use constant-time comparison to prevent timing attacks
    if (storedHash.length !== tokenHash.length) return false;

    const storedBuffer = Buffer.from(storedHash, 'utf8');
    const providedBuffer = Buffer.from(tokenHash, 'utf8');

    // Bun supports crypto.timingSafeEqual
    const crypto = require('crypto');
    return crypto.timingSafeEqual(storedBuffer, providedBuffer);
  }

  /**
   * Update the stream token hash for an existing live session.
   * Used when resuming a session after daemon restart.
   */
  updateStreamToken(sessionId: string, newTokenHash: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE sessions SET stream_token_hash = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'live'
    `);
    const result = stmt.run(newTokenHash, sessionId);
    return result.changes > 0;
  }

  /**
   * Restore a session to live status and update its stream token.
   * Used to resume streaming to a completed/archived session.
   */
  restoreSessionToLive(sessionId: string, newTokenHash: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE sessions SET
        stream_token_hash = ?,
        status = 'live',
        last_activity_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `);
    const result = stmt.run(newTokenHash, sessionId);
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
  // Note: client_id is passed separately to avoid duplication in session object
  createSessionWithDataAndReview(
    session: Omit<Session, "created_at" | "updated_at" | "client_id">,
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
    clientId?: string
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
        clientId || null
      ) as Session;

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

      return created;
    });

    return transaction();
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
    session: Omit<Session, "created_at" | "updated_at" | "client_id">,
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
        resultSession = this.stmts.createSession.get(
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
          clientId || null
        ) as Session;
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
}
