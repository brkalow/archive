/**
 * Spawned Session Registry
 *
 * Tracks ephemeral state for spawned sessions (browser-initiated via daemon).
 * Persistent data (messages, diffs) is stored in the database.
 * This registry tracks:
 * - Daemon connection info (for routing messages)
 * - Runtime status (for quick lookup without DB query)
 * - Permission requests and history
 * - Recovery info for daemon reconnection
 */

export type SpawnedSessionStatus =
  | "starting"
  | "running"
  | "waiting"
  | "ending"
  | "ended"
  | "failed"
  | "disconnected";

/**
 * A permission decision recorded during a session.
 */
export interface PermissionDecision {
  id: string;
  tool: string;
  description: string;
  decision: "allowed" | "denied";
  timestamp: Date;
}

/**
 * Recovery information for disconnected sessions.
 * Allows potential reconnection if daemon comes back online.
 */
export interface SessionRecoveryInfo {
  claudeSessionId: string;
  cwd: string;
  canResume: boolean;
  disconnectedAt: Date;
}

/** Parsed diff file for UI display (used for broadcast, stored in DB) */
export interface ParsedDiff {
  filename: string;
  diff_content: string;
  additions: number;
  deletions: number;
  is_session_relevant: boolean;
}

export interface SpawnedSessionRecord {
  id: string;
  daemonClientId: string;
  cwd: string;
  harness: string;
  model?: string;
  status: SpawnedSessionStatus;
  createdAt: Date;
  claudeSessionId?: string;
  lastActivityAt?: Date;
  endedAt?: Date;
  exitCode?: number;
  error?: string;
  permissionHistory: PermissionDecision[];
  pendingPermissionRequest?: {
    id: string;
    tool: string;
    description: string;
    details: Record<string, unknown>;
  };
  recoveryInfo?: SessionRecoveryInfo;
}

class SpawnedSessionRegistry {
  private sessions = new Map<string, SpawnedSessionRecord>();

  createSession(record: Omit<SpawnedSessionRecord, "permissionHistory"> & { permissionHistory?: PermissionDecision[] }): void {
    this.sessions.set(record.id, {
      ...record,
      permissionHistory: record.permissionHistory || [],
    });
  }

  getSession(sessionId: string): SpawnedSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  updateSession(
    sessionId: string,
    updates: Partial<SpawnedSessionRecord>
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      Object.assign(session, updates, { lastActivityAt: new Date() });
    }
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getSessionsByDaemon(clientId: string): SpawnedSessionRecord[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.daemonClientId === clientId
    );
  }

  getActiveSessions(): SpawnedSessionRecord[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status !== "ended" && s.status !== "failed"
    );
  }

  getAllSessions(): SpawnedSessionRecord[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Check if session is a spawned session (vs. plugin-based live session).
   */
  isSpawnedSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Record a pending permission request for a session.
   */
  setPendingPermission(
    sessionId: string,
    request: {
      id: string;
      tool: string;
      description: string;
      details: Record<string, unknown>;
    }
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pendingPermissionRequest = request;
      session.lastActivityAt = new Date();
    }
  }

  /**
   * Record a permission decision for a session.
   */
  recordPermissionDecision(
    sessionId: string,
    decision: Omit<PermissionDecision, "timestamp">
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.permissionHistory.push({
        ...decision,
        timestamp: new Date(),
      });
      session.pendingPermissionRequest = undefined;
      session.lastActivityAt = new Date();
    }
  }

  /**
   * Get the permission history for a session.
   */
  getPermissionHistory(sessionId: string): PermissionDecision[] {
    const session = this.sessions.get(sessionId);
    return session?.permissionHistory || [];
  }

  /**
   * Update session with recovery info when daemon disconnects.
   * This preserves information needed to potentially resume the session.
   */
  updateForRecovery(sessionId: string, claudeSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.recoveryInfo = {
        claudeSessionId,
        cwd: session.cwd,
        canResume: true,
        disconnectedAt: new Date(),
      };
    }
  }

  /**
   * Get recovery info for a session.
   */
  getRecoveryInfo(sessionId: string): SessionRecoveryInfo | undefined {
    const session = this.sessions.get(sessionId);
    return session?.recoveryInfo;
  }

  /**
   * Get all sessions with recovery info (for potential reconnection).
   */
  getRecoverableSessions(): SpawnedSessionRecord[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.recoveryInfo?.canResume === true
    );
  }

  /**
   * Clear all sessions. Used for testing.
   */
  clear(): void {
    this.sessions.clear();
  }
}

export const spawnedSessionRegistry = new SpawnedSessionRegistry();
