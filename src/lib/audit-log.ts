/**
 * Audit Logging System
 *
 * Logs all session activity for security review.
 * Uses NDJSON format (one JSON object per line) for easy parsing.
 */

import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";

export type AuditAction =
  | "session_started"
  | "session_ended"
  | "input_sent"
  | "permission_granted"
  | "permission_denied"
  | "limit_exceeded";

export interface AuditActor {
  type: "browser" | "daemon" | "system";
  ip_address?: string;
  user_agent?: string;
  client_id?: string;
}

export interface AuditLogEntry {
  timestamp: string;
  session_id: string;
  action: AuditAction;
  actor: AuditActor;
  details: Record<string, unknown>;
}

export class AuditLogger {
  private logPath: string;
  private buffer: AuditLogEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(logPath: string) {
    this.logPath = logPath;
    this.startFlushInterval();
  }

  /**
   * Log an audit entry.
   */
  log(entry: Omit<AuditLogEntry, "timestamp">): void {
    this.buffer.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }

  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      this.flush().catch((error) => {
        console.error("[audit] Flush failed:", error);
      });
    }, 5000); // Flush every 5 seconds
  }

  /**
   * Ensure the log directory exists.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          await mkdir(dirname(this.logPath), { recursive: true });
          this.initialized = true;
        } catch (error) {
          // Directory might already exist, that's fine
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            console.error("[audit] Failed to create log directory:", error);
          }
          this.initialized = true;
        }
      })();
    }

    return this.initPromise;
  }

  /**
   * Flush buffered entries to disk.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    await this.ensureInitialized();

    const entries = this.buffer;
    this.buffer = [];

    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

    try {
      await appendFile(this.logPath, lines);
    } catch (error) {
      console.error("[audit] Failed to write audit log:", error);
      // Re-add entries to buffer on failure
      this.buffer = [...entries, ...this.buffer];
    }
  }

  /**
   * Close the logger (flush and stop interval).
   */
  async close(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flush();
  }

  /**
   * Get the log path.
   */
  getLogPath(): string {
    return this.logPath;
  }
}

// Initialize with path from config or default
const auditLogPath =
  process.env.AUDIT_LOG_PATH ||
  `${process.cwd()}/logs/audit.log`;

export const auditLogger = new AuditLogger(auditLogPath);

// Helper functions for common log entries

export function logSessionStarted(
  sessionId: string,
  cwd: string,
  prompt: string,
  actor: AuditActor
): void {
  auditLogger.log({
    session_id: sessionId,
    action: "session_started",
    actor,
    details: {
      cwd,
      prompt_preview: prompt.slice(0, 200),
    },
  });
}

export function logSessionEnded(
  sessionId: string,
  reason: string,
  exitCode?: number
): void {
  auditLogger.log({
    session_id: sessionId,
    action: "session_ended",
    actor: { type: "system" },
    details: { reason, exit_code: exitCode },
  });
}

export function logInputSent(
  sessionId: string,
  contentPreview: string,
  actor: AuditActor
): void {
  auditLogger.log({
    session_id: sessionId,
    action: "input_sent",
    actor,
    details: { content_preview: contentPreview.slice(0, 200) },
  });
}

export function logPermissionDecision(
  sessionId: string,
  tool: string,
  allowed: boolean,
  actor: AuditActor
): void {
  auditLogger.log({
    session_id: sessionId,
    action: allowed ? "permission_granted" : "permission_denied",
    actor,
    details: { tool },
  });
}

export function logLimitExceeded(
  sessionId: string,
  limitType: string,
  details: Record<string, unknown> = {}
): void {
  auditLogger.log({
    session_id: sessionId,
    action: "limit_exceeded",
    actor: { type: "system" },
    details: { limit_type: limitType, ...details },
  });
}
