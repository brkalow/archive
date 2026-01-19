# Phase 7: Security & Polish

> **Spec reference:** [specs/browser_initiated_sessions.md](../specs/browser_initiated_sessions.md)

## Overview

This plan covers security hardening, resource limits, rate limiting, audit logging, and polish for browser-initiated sessions. These features ensure the system is production-ready and safe to use.

## Dependencies

- **All previous phases** (1-6)

## Tasks

### 1. Implement Rate Limiting

Add rate limits to prevent abuse.

**Note:** The codebase already has `src/routes/rate-limit.ts` for feedback rate limiting. This new rate limiter is a general-purpose class that can be reused. Consider whether to extend the existing implementation or create this new one. If creating new, place it in `src/lib/` to distinguish from the feedback-specific rate limiting.

**File:** `src/lib/rate-limiter.ts`

```typescript
interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private limits = new Map<string, RateLimitEntry>();

  constructor(private config: RateLimitConfig) {}

  check(key: string): { allowed: boolean; remaining: number; resetIn: number } {
    const now = Date.now();
    const entry = this.limits.get(key);

    // If no entry or window expired, allow and reset
    if (!entry || now >= entry.resetAt) {
      this.limits.set(key, {
        count: 1,
        resetAt: now + this.config.windowMs,
      });
      return {
        allowed: true,
        remaining: this.config.maxRequests - 1,
        resetIn: this.config.windowMs,
      };
    }

    // Check if under limit
    if (entry.count < this.config.maxRequests) {
      entry.count++;
      return {
        allowed: true,
        remaining: this.config.maxRequests - entry.count,
        resetIn: entry.resetAt - now,
      };
    }

    // Over limit
    return {
      allowed: false,
      remaining: 0,
      resetIn: entry.resetAt - now,
    };
  }

  // Clean up expired entries periodically
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.limits) {
      if (now >= entry.resetAt) {
        this.limits.delete(key);
      }
    }
  }
}

// Rate limit configurations
export const spawnSessionLimiter = new RateLimiter({
  windowMs: 60_000, // 1 minute
  maxRequests: 5,   // 5 spawns per minute
});

export const sendInputLimiter = new RateLimiter({
  windowMs: 60_000, // 1 minute
  maxRequests: 60,  // 60 inputs per minute per session
});

// Cleanup interval
setInterval(() => {
  spawnSessionLimiter.cleanup();
  sendInputLimiter.cleanup();
}, 60_000);
```

### 2. Apply Rate Limits to API Endpoints

Integrate rate limiting into spawn and input endpoints.

**File:** `src/routes/api.ts` (modify)

```typescript
import { spawnSessionLimiter, sendInputLimiter } from "../lib/rate-limiter";

async spawnSession(req: Request): Promise<Response> {
  // Rate limit by client IP or session
  const clientId = req.headers.get("X-Client-ID") || getClientIP(req);
  const rateCheck = spawnSessionLimiter.check(`spawn:${clientId}`);

  if (!rateCheck.allowed) {
    return json({
      error: "Rate limit exceeded",
      retry_after_ms: rateCheck.resetIn,
    }, 429);
  }

  // ... existing spawn logic
}

// In WebSocket message handler for user_message:
function handleBrowserSessionMessage(sessionId: string, message: any): void {
  switch (message.type) {
    case "user_message": {
      // Rate limit per session
      const rateCheck = sendInputLimiter.check(`input:${sessionId}`);
      if (!rateCheck.allowed) {
        // Send error back via WebSocket
        wsManager.sendTo(sessionId, {
          type: "error",
          code: "RATE_LIMITED",
          message: "Too many messages. Please wait.",
        });
        return;
      }
      // ... existing input handling
    }
  }
}
```

### 3. Implement Resource Limits

Add limits for session runtime, output size, and idle timeout.

**File:** `src/lib/session-limits.ts`

```typescript
export interface SessionLimits {
  maxRuntimeMs: number;      // Maximum session duration
  maxOutputBytes: number;     // Maximum total output size
  idleTimeoutMs: number;      // Timeout with no activity
}

export const DEFAULT_LIMITS: SessionLimits = {
  maxRuntimeMs: 4 * 60 * 60 * 1000,  // 4 hours
  maxOutputBytes: 100 * 1024 * 1024,  // 100 MB
  idleTimeoutMs: 30 * 60 * 1000,      // 30 minutes
};

export class SessionLimitEnforcer {
  private sessionStats = new Map<string, {
    startTime: number;
    outputBytes: number;
    lastActivityTime: number;
  }>();

  startTracking(sessionId: string): void {
    const now = Date.now();
    this.sessionStats.set(sessionId, {
      startTime: now,
      outputBytes: 0,
      lastActivityTime: now,
    });
  }

  recordOutput(sessionId: string, bytes: number): { exceeded: string | null } {
    const stats = this.sessionStats.get(sessionId);
    if (!stats) return { exceeded: null };

    stats.outputBytes += bytes;
    stats.lastActivityTime = Date.now();

    // Check limits
    const now = Date.now();
    const runtime = now - stats.startTime;

    if (runtime > DEFAULT_LIMITS.maxRuntimeMs) {
      return { exceeded: "max_runtime" };
    }

    if (stats.outputBytes > DEFAULT_LIMITS.maxOutputBytes) {
      return { exceeded: "max_output" };
    }

    return { exceeded: null };
  }

  checkIdleTimeout(sessionId: string): boolean {
    const stats = this.sessionStats.get(sessionId);
    if (!stats) return false;

    const idleTime = Date.now() - stats.lastActivityTime;
    return idleTime > DEFAULT_LIMITS.idleTimeoutMs;
  }

  recordActivity(sessionId: string): void {
    const stats = this.sessionStats.get(sessionId);
    if (stats) {
      stats.lastActivityTime = Date.now();
    }
  }

  stopTracking(sessionId: string): void {
    this.sessionStats.delete(sessionId);
  }

  // Check all sessions for idle timeout
  checkAllIdleTimeouts(): string[] {
    const idleSessions: string[] = [];
    for (const [sessionId, stats] of this.sessionStats) {
      const idleTime = Date.now() - stats.lastActivityTime;
      if (idleTime > DEFAULT_LIMITS.idleTimeoutMs) {
        idleSessions.push(sessionId);
      }
    }
    return idleSessions;
  }
}

export const sessionLimitEnforcer = new SessionLimitEnforcer();
```

### 4. Integrate Limits with Session Manager

Apply limits in the session spawning and output handling.

**File:** `src/server.ts` (modify)

```typescript
import { sessionLimitEnforcer } from "./lib/session-limits";

// When session is spawned:
spawnedSessionRegistry.createSession({
  // ... existing fields
});
sessionLimitEnforcer.startTracking(sessionId);

// In handleDaemonMessage for session_output:
case "session_output": {
  const session = spawnedSessionRegistry.getSession(message.session_id);
  if (!session) return;

  // Track output size
  const outputSize = JSON.stringify(message.messages).length;
  const limitCheck = sessionLimitEnforcer.recordOutput(message.session_id, outputSize);

  if (limitCheck.exceeded) {
    // End the session due to limit
    daemonConnections.sendToDaemon(session.daemonClientId, {
      type: "end_session",
      session_id: message.session_id,
    });

    wsManager.broadcast(message.session_id, {
      type: "limit_exceeded",
      limit: limitCheck.exceeded,
      message: getLimitExceededMessage(limitCheck.exceeded),
    });
    return;
  }

  // ... continue with normal handling
}

function getLimitExceededMessage(limit: string): string {
  switch (limit) {
    case "max_runtime":
      return "Session ended: maximum runtime exceeded (4 hours)";
    case "max_output":
      return "Session ended: maximum output size exceeded (100 MB)";
    default:
      return "Session ended: resource limit exceeded";
  }
}

// Idle timeout checker (run periodically)
setInterval(() => {
  const idleSessions = sessionLimitEnforcer.checkAllIdleTimeouts();
  for (const sessionId of idleSessions) {
    const session = spawnedSessionRegistry.getSession(sessionId);
    if (session && session.status !== "ended") {
      console.log(`[limits] Ending idle session: ${sessionId}`);
      daemonConnections.sendToDaemon(session.daemonClientId, {
        type: "end_session",
        session_id: sessionId,
      });
      wsManager.broadcast(sessionId, {
        type: "limit_exceeded",
        limit: "idle_timeout",
        message: "Session ended due to inactivity (30 minutes)",
      });
    }
  }
}, 60_000); // Check every minute
```

### 5. Implement Audit Logging

Log all session activity for security review.

**File:** `src/lib/audit-log.ts`

```typescript
import { appendFile } from "fs/promises";
import { join } from "path";

export interface AuditLogEntry {
  timestamp: string;
  session_id: string;
  action: "session_started" | "session_ended" | "input_sent" | "permission_granted" | "permission_denied" | "limit_exceeded";
  actor: {
    type: "browser" | "daemon" | "system";
    ip_address?: string;
    user_agent?: string;
    client_id?: string;
  };
  details: Record<string, unknown>;
}

export class AuditLogger {
  private logPath: string;
  private buffer: AuditLogEntry[] = [];
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(logPath: string) {
    this.logPath = logPath;
    this.startFlushInterval();
  }

  log(entry: Omit<AuditLogEntry, "timestamp">): void {
    this.buffer.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }

  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      this.flush();
    }, 5000); // Flush every 5 seconds
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

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

  async close(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    await this.flush();
  }
}

// Initialize with path from config or default
const auditLogPath = process.env.AUDIT_LOG_PATH || join(process.cwd(), "audit.log");
export const auditLogger = new AuditLogger(auditLogPath);

// Helper functions for common log entries
export function logSessionStarted(
  sessionId: string,
  cwd: string,
  prompt: string,
  actor: AuditLogEntry["actor"]
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

export function logPermissionDecision(
  sessionId: string,
  tool: string,
  allowed: boolean,
  actor: AuditLogEntry["actor"]
): void {
  auditLogger.log({
    session_id: sessionId,
    action: allowed ? "permission_granted" : "permission_denied",
    actor,
    details: { tool },
  });
}
```

### 6. Integrate Audit Logging

Add audit log calls throughout the codebase.

**File:** `src/routes/api.ts` (modify)

```typescript
import { logSessionStarted } from "../lib/audit-log";

async spawnSession(req: Request): Promise<Response> {
  // ... existing validation and spawn logic

  // Log session start
  logSessionStarted(sessionId, body.cwd, body.prompt, {
    type: "browser",
    ip_address: getClientIP(req),
    user_agent: req.headers.get("User-Agent") || undefined,
  });

  return json({ session_id: sessionId, status: "starting", harness }, 201);
}
```

**File:** `src/server.ts` (modify)

```typescript
import { logSessionEnded, logPermissionDecision } from "./lib/audit-log";

// In handleDaemonMessage for session_ended:
case "session_ended": {
  logSessionEnded(message.session_id, message.reason || "completed", message.exit_code);
  // ... existing handling
}

// In handleBrowserSessionMessage for permission_response:
case "permission_response": {
  logPermissionDecision(sessionId, "unknown", message.allow, {
    type: "browser",
    // Would need to pass IP from ws connection
  });
  // ... existing handling
}
```

### 7. Add Concurrent Session Limits

Limit number of simultaneous spawned sessions per daemon.

**File:** `src/lib/daemon-connections.ts` (modify)

```typescript
const MAX_CONCURRENT_SESSIONS_PER_DAEMON = 3;

// In registerSpawnedSession:
registerSpawnedSession(clientId: string, sessionId: string): boolean {
  const daemon = this.daemons.get(clientId);
  if (!daemon) return false;

  if (daemon.activeSpawnedSessions.size >= MAX_CONCURRENT_SESSIONS_PER_DAEMON) {
    console.warn(`[daemon-mgr] Max concurrent sessions reached for ${clientId}`);
    return false;
  }

  daemon.activeSpawnedSessions.add(sessionId);
  return true;
}
```

**File:** `src/routes/api.ts` (modify)

```typescript
async spawnSession(req: Request): Promise<Response> {
  // ... existing daemon check

  // Check concurrent session limit
  const registered = daemonConnections.registerSpawnedSession(daemon.clientId, sessionId);
  if (!registered) {
    return json({
      error: "Maximum concurrent sessions reached",
      max_sessions: 3,
    }, 429);
  }

  // ... rest of spawn logic
}
```

### 8. Enhanced Desktop Notifications

Improve notification with action buttons.

**File:** `cli/lib/notifications.ts` (enhance)

```typescript
import { basename } from "path";

interface NotificationOptions {
  title: string;
  message: string;
  sessionId: string;
  cwd: string;
  prompt: string;
  viewUrl?: string;
}

export async function notifySessionStarted(options: NotificationOptions): Promise<void> {
  const { title, cwd, prompt, sessionId, viewUrl } = options;

  if (process.platform === "darwin") {
    // Use terminal-notifier for better macOS notifications with actions
    // Falls back to osascript if terminal-notifier not available
    try {
      const hasTerminalNotifier = await checkCommand("terminal-notifier");

      if (hasTerminalNotifier) {
        const args = [
          "-title", title,
          "-subtitle", `Directory: ${basename(cwd)}`,
          "-message", prompt.slice(0, 100) + (prompt.length > 100 ? "..." : ""),
          "-group", `openctl-${sessionId}`,
          "-sender", "com.apple.Terminal",
        ];

        if (viewUrl) {
          args.push("-open", viewUrl);
        }

        Bun.spawn(["terminal-notifier", ...args], {
          stdout: "ignore",
          stderr: "ignore",
        });
      } else {
        // Fallback to osascript
        const script = `
          display notification "${prompt.slice(0, 100).replace(/"/g, '\\"')}" ¬
            with title "${title}" ¬
            subtitle "Directory: ${basename(cwd)}"
        `;

        Bun.spawn(["osascript", "-e", script], {
          stdout: "ignore",
          stderr: "ignore",
        });
      }
    } catch (error) {
      console.error("[notification] Failed to show notification:", error);
    }
  } else if (process.platform === "linux") {
    try {
      Bun.spawn([
        "notify-send",
        title,
        `${prompt.slice(0, 100)}\nDirectory: ${cwd}`,
        "--app-name=openctl",
        "--urgency=normal",
      ], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch (error) {
      console.error("[notification] Failed to show notification:", error);
    }
  }
}

async function checkCommand(cmd: string): Promise<boolean> {
  try {
    const result = Bun.spawnSync(["which", cmd]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
```

### 9. Add Session Recovery Information

Store recovery info for sessions that lose connection.

**File:** `src/lib/spawned-session-registry.ts` (enhance)

```typescript
export interface SpawnedSessionRecord {
  // ... existing fields
  recoveryInfo?: {
    claudeSessionId: string;
    cwd: string;
    canResume: boolean;
  };
}

// When session ends with daemon disconnect:
updateForRecovery(sessionId: string, claudeSessionId: string): void {
  const session = this.sessions.get(sessionId);
  if (session) {
    session.recoveryInfo = {
      claudeSessionId,
      cwd: session.cwd,
      canResume: true,
    };
  }
}
```

### 10. Add Health Check Endpoint

Server health check for monitoring.

**File:** `src/routes/api.ts` (add)

```typescript
// GET /api/health
getHealth(): Response {
  const daemonStatus = daemonConnections.getStatus();
  const activeSpawned = spawnedSessionRegistry.getActiveSessions().length;

  return json({
    status: "healthy",
    version: process.env.npm_package_version || "unknown",
    daemon_connected: daemonStatus.connected,
    active_spawned_sessions: activeSpawned,
    uptime_seconds: process.uptime(),
  });
}
```

## Testing

### Rate Limiter Tests

**File:** `tests/lib/rate-limiter.test.ts`

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { RateLimiter } from "../../src/lib/rate-limiter";

describe("RateLimiter", () => {
  test("allows requests under limit", () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 3 });

    expect(limiter.check("test").allowed).toBe(true);
    expect(limiter.check("test").allowed).toBe(true);
    expect(limiter.check("test").allowed).toBe(true);
  });

  test("blocks requests over limit", () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });

    limiter.check("test");
    limiter.check("test");
    const result = limiter.check("test");

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("resets after window expires", async () => {
    const limiter = new RateLimiter({ windowMs: 100, maxRequests: 1 });

    limiter.check("test");
    expect(limiter.check("test").allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 150));

    expect(limiter.check("test").allowed).toBe(true);
  });
});
```

### Audit Logger Tests

**File:** `tests/lib/audit-log.test.ts`

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AuditLogger } from "../../src/lib/audit-log";
import { readFile, unlink } from "fs/promises";

describe("AuditLogger", () => {
  const testLogPath = "/tmp/test-audit.log";
  let logger: AuditLogger;

  beforeEach(() => {
    logger = new AuditLogger(testLogPath);
  });

  afterEach(async () => {
    await logger.close();
    try {
      await unlink(testLogPath);
    } catch {}
  });

  test("logs entries to file", async () => {
    logger.log({
      session_id: "test-123",
      action: "session_started",
      actor: { type: "browser" },
      details: { cwd: "/test" },
    });

    await logger.flush();

    const content = await readFile(testLogPath, "utf-8");
    const entry = JSON.parse(content.trim());

    expect(entry.session_id).toBe("test-123");
    expect(entry.action).toBe("session_started");
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/lib/rate-limiter.ts` | Create | Rate limiting implementation |
| `src/lib/session-limits.ts` | Create | Resource limit enforcement |
| `src/lib/audit-log.ts` | Create | Audit logging system |
| `src/routes/api.ts` | Modify | Integrate rate limits, health check |
| `src/server.ts` | Modify | Integrate limits and audit logging |
| `src/lib/daemon-connections.ts` | Modify | Concurrent session limits |
| `cli/lib/notifications.ts` | Modify | Enhanced notifications |
| `src/lib/spawned-session-registry.ts` | Modify | Recovery info |
| `tests/lib/rate-limiter.test.ts` | Create | Rate limiter tests |
| `tests/lib/audit-log.test.ts` | Create | Audit logger tests |

## Acceptance Criteria

- [ ] Session spawn rate limited to 5/minute per client
- [ ] Input messages rate limited to 60/minute per session
- [ ] Sessions end after 4 hours max runtime
- [ ] Sessions end after 100MB output
- [ ] Sessions end after 30 minutes idle
- [ ] Rate limit errors return 429 with retry info
- [ ] Max 3 concurrent sessions per daemon
- [ ] All session activity logged to audit file
- [ ] Audit log entries include timestamp, actor, action, details
- [ ] Desktop notifications show on session start
- [ ] Health check endpoint returns system status
- [ ] Recovery info stored for disconnected sessions
- [ ] All tests pass
