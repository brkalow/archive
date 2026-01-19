/**
 * Session Resource Limits
 *
 * Enforces resource limits for spawned sessions:
 * - Maximum runtime (4 hours)
 * - Maximum output size (100 MB)
 * - Idle timeout (30 minutes)
 */

export interface SessionLimits {
  maxRuntimeMs: number; // Maximum session duration
  maxOutputBytes: number; // Maximum total output size
  idleTimeoutMs: number; // Timeout with no activity
}

export const DEFAULT_LIMITS: SessionLimits = {
  maxRuntimeMs: 4 * 60 * 60 * 1000, // 4 hours
  maxOutputBytes: 100 * 1024 * 1024, // 100 MB
  idleTimeoutMs: 30 * 60 * 1000, // 30 minutes
};

interface SessionStats {
  startTime: number;
  outputBytes: number;
  lastActivityTime: number;
}

export type LimitExceeded = "max_runtime" | "max_output" | "idle_timeout" | null;

export class SessionLimitEnforcer {
  private sessionStats = new Map<string, SessionStats>();
  private limits: SessionLimits;

  constructor(limits: SessionLimits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  /**
   * Start tracking a new session.
   */
  startTracking(sessionId: string): void {
    const now = Date.now();
    this.sessionStats.set(sessionId, {
      startTime: now,
      outputBytes: 0,
      lastActivityTime: now,
    });
  }

  /**
   * Record output for a session and check if limits are exceeded.
   */
  recordOutput(sessionId: string, bytes: number): { exceeded: LimitExceeded } {
    const stats = this.sessionStats.get(sessionId);
    if (!stats) return { exceeded: null };

    stats.outputBytes += bytes;
    stats.lastActivityTime = Date.now();

    // Check limits
    const now = Date.now();
    const runtime = now - stats.startTime;

    if (runtime > this.limits.maxRuntimeMs) {
      return { exceeded: "max_runtime" };
    }

    if (stats.outputBytes > this.limits.maxOutputBytes) {
      return { exceeded: "max_output" };
    }

    return { exceeded: null };
  }

  /**
   * Check if a session has exceeded its idle timeout.
   */
  checkIdleTimeout(sessionId: string): boolean {
    const stats = this.sessionStats.get(sessionId);
    if (!stats) return false;

    const idleTime = Date.now() - stats.lastActivityTime;
    return idleTime > this.limits.idleTimeoutMs;
  }

  /**
   * Record activity (keeps session alive).
   */
  recordActivity(sessionId: string): void {
    const stats = this.sessionStats.get(sessionId);
    if (stats) {
      stats.lastActivityTime = Date.now();
    }
  }

  /**
   * Stop tracking a session.
   */
  stopTracking(sessionId: string): void {
    this.sessionStats.delete(sessionId);
  }

  /**
   * Check all sessions for idle timeout.
   * Returns list of session IDs that have exceeded idle timeout.
   */
  checkAllIdleTimeouts(): string[] {
    const idleSessions: string[] = [];
    for (const [sessionId, stats] of this.sessionStats) {
      const idleTime = Date.now() - stats.lastActivityTime;
      if (idleTime > this.limits.idleTimeoutMs) {
        idleSessions.push(sessionId);
      }
    }
    return idleSessions;
  }

  /**
   * Get stats for a session (for debugging/monitoring).
   */
  getStats(sessionId: string): {
    runtime: number;
    outputBytes: number;
    idleTime: number;
  } | null {
    const stats = this.sessionStats.get(sessionId);
    if (!stats) return null;

    const now = Date.now();
    return {
      runtime: now - stats.startTime,
      outputBytes: stats.outputBytes,
      idleTime: now - stats.lastActivityTime,
    };
  }

  /**
   * Get all tracked session IDs.
   */
  getTrackedSessions(): string[] {
    return Array.from(this.sessionStats.keys());
  }

  /**
   * Clear all tracked sessions. Used for testing.
   */
  clear(): void {
    this.sessionStats.clear();
  }
}

// Singleton instance with default limits
export const sessionLimitEnforcer = new SessionLimitEnforcer();

/**
 * Get a human-readable message for a limit being exceeded.
 */
export function getLimitExceededMessage(limit: LimitExceeded): string {
  switch (limit) {
    case "max_runtime":
      return "Session ended: maximum runtime exceeded (4 hours)";
    case "max_output":
      return "Session ended: maximum output size exceeded (100 MB)";
    case "idle_timeout":
      return "Session ended due to inactivity (30 minutes)";
    default:
      return "Session ended: resource limit exceeded";
  }
}
