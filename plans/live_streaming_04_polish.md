# Live Diff and Polish

> **Spec reference:** [specs/live_streaming.md](../specs/live_streaming.md)

## Overview

This plan covers the remaining features for a polished live streaming experience: real-time diff capture and updates, rate limiting, local buffering, graceful shutdown, and additional robustness features.

## Dependencies

- [live_streaming_01_server.md](./live_streaming_01_server.md) - Server live session API
- [live_streaming_02_daemon.md](./live_streaming_02_daemon.md) - Core daemon functionality
- [live_streaming_03_browser.md](./live_streaming_03_browser.md) - Live UI components

## Tasks

### 1. Diff Push Endpoint

Add the PUT endpoint for pushing diff updates.

**File:** `src/routes/api.ts`

```typescript
async pushDiff(req: Request, sessionId: string): Promise<Response> {
  // Validate stream token
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonError("Missing stream token", 401);
  }

  const token = authHeader.slice(7);
  if (!repo.validateStreamToken(sessionId, token)) {
    return jsonError("Invalid stream token", 401);
  }

  const session = repo.getSession(sessionId);
  if (!session) {
    return jsonError("Session not found", 404);
  }

  if (session.status !== "live") {
    return jsonError("Session is not live", 409);
  }

  // Read diff content
  const diffContent = await req.text();

  // Parse and store diff
  const touchedFiles = extractTouchedFilesFromSession(sessionId);
  const diffs = parseDiffData(diffContent, sessionId, touchedFiles);

  // Clear existing diffs and add new ones
  repo.clearDiffs(sessionId);
  repo.addDiffs(diffs);

  // Calculate stats
  const stats = calculateDiffStats(diffs);

  // Broadcast to WebSocket subscribers
  wsManager.broadcast(sessionId, {
    type: "diff",
    files: diffs.map(d => ({
      filename: d.filename || "unknown",
      additions: d.additions,
      deletions: d.deletions,
    })),
  });

  return json({
    files_changed: diffs.length,
    additions: stats.additions,
    deletions: stats.deletions,
  });
}

function calculateDiffStats(diffs: Diff[]): { additions: number; deletions: number } {
  return diffs.reduce(
    (acc, d) => ({
      additions: acc.additions + d.additions,
      deletions: acc.deletions + d.deletions,
    }),
    { additions: 0, deletions: 0 }
  );
}

function extractTouchedFilesFromSession(sessionId: string): Set<string> {
  const messages = repo.getMessages(sessionId);
  return extractTouchedFiles(messages);
}
```

**Add route in server.ts:**

```typescript
"/api/sessions/:id/diff": {
  PUT: (req) => api.pushDiff(req, req.params.id),
},
```

### 2. Daemon Diff Capture

Implement diff capture on file-modifying tool calls.

**File:** `cli/daemon/diff-capture.ts`

```typescript
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface DiffCaptureOptions {
  projectPath: string;
  debounceMs: number;
}

export class DiffCapture {
  private pending = false;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(private options: DiffCaptureOptions) {}

  trigger(): void {
    // Debounce rapid calls
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.capture();
    }, this.options.debounceMs);
  }

  async capture(): Promise<string | null> {
    if (this.pending) return null;
    this.pending = true;

    try {
      // Get diff against HEAD (all uncommitted changes)
      const { stdout: diff } = await execAsync("git diff HEAD", {
        cwd: this.options.projectPath,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      // Also include untracked files
      const untrackedDiff = await this.captureUntrackedFiles();

      return diff + untrackedDiff;
    } catch (err) {
      console.error("Error capturing diff:", err);
      return null;
    } finally {
      this.pending = false;
    }
  }

  private async captureUntrackedFiles(): Promise<string> {
    try {
      // Get list of untracked files
      const { stdout: untrackedList } = await execAsync(
        "git ls-files --others --exclude-standard",
        { cwd: this.options.projectPath }
      );

      const files = untrackedList.trim().split("\n").filter(Boolean);
      if (files.length === 0) return "";

      // Generate diff for each untracked file
      const diffs: string[] = [];
      for (const file of files) {
        try {
          const { stdout: content } = await execAsync(`cat "${file}"`, {
            cwd: this.options.projectPath,
          });

          const lines = content.split("\n");
          const diffLines = [
            `diff --git a/${file} b/${file}`,
            "new file mode 100644",
            "--- /dev/null",
            `+++ b/${file}`,
            `@@ -0,0 +1,${lines.length} @@`,
            ...lines.map((l) => `+${l}`),
          ];

          diffs.push(diffLines.join("\n"));
        } catch {
          // Skip files we can't read
        }
      }

      return diffs.join("\n");
    } catch {
      return "";
    }
  }
}
```

### 3. Integrate Diff Capture into Session Tracker

**File:** `cli/daemon/session-tracker.ts` (modifications)

```typescript
import { DiffCapture } from "./diff-capture";

interface ActiveSession {
  // ... existing fields
  diffCapture: DiffCapture;
}

// In startSession:
const diffCapture = new DiffCapture({
  projectPath: sessionInfo.projectPath,
  debounceMs: 500,
});

// In handleLine, detect file-modifying tool calls:
private async handleLine(session: ActiveSession, line: string): Promise<void> {
  // ... existing message parsing

  // Check for file-modifying tool results
  if (this.isFileModifyingToolResult(session, line)) {
    this.triggerDiffCapture(session);
  }
}

private isFileModifyingToolResult(session: ActiveSession, line: string): boolean {
  try {
    const item = JSON.parse(line);
    if (item.type !== "tool_result") return false;

    // Find the corresponding tool_use
    const toolUseId = item.tool_use_id;
    for (const msg of session.parseContext.messages) {
      for (const block of msg.content_blocks) {
        if (block.type === "tool_use" && block.id === toolUseId) {
          const name = (block as { name: string }).name;
          return ["Write", "Edit", "NotebookEdit"].includes(name);
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

private async triggerDiffCapture(session: ActiveSession): void {
  session.diffCapture.trigger();

  // Capture and push asynchronously
  setTimeout(async () => {
    const diff = await session.diffCapture.capture();
    if (diff) {
      try {
        await this.api.pushDiff(session.sessionId, session.streamToken, diff);
      } catch (err) {
        console.error("  Failed to push diff:", err);
      }
    }
  }, 600); // Slight delay after debounce to ensure files are written
}

// In endSession, capture final diff:
async endSession(filePath: string): Promise<void> {
  const session = this.sessions.get(filePath);
  if (!session) return;

  // Capture final diff
  const finalDiff = await session.diffCapture.capture();

  try {
    await this.api.completeSession(session.sessionId, session.streamToken, {
      final_diff: finalDiff || undefined,
    });
  } catch (err) {
    console.error("  Failed to complete session:", err);
  }

  // ... cleanup
}
```

### 4. Rate Limiting

Implement rate limiting for API endpoints.

**File:** `src/lib/rate-limit.ts`

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
  private entries = new Map<string, RateLimitEntry>();

  constructor(private config: RateLimitConfig) {
    // Cleanup old entries periodically
    setInterval(() => this.cleanup(), 60_000);
  }

  check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    let entry = this.entries.get(key);

    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + this.config.windowMs };
      this.entries.set(key, entry);
    }

    entry.count++;

    return {
      allowed: entry.count <= this.config.maxRequests,
      remaining: Math.max(0, this.config.maxRequests - entry.count),
      resetAt: entry.resetAt,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.resetAt < now) {
        this.entries.delete(key);
      }
    }
  }
}

// Pre-configured limiters
export const rateLimiters = {
  createSession: new RateLimiter({ windowMs: 60_000, maxRequests: 10 }),
  pushMessages: new RateLimiter({ windowMs: 60_000, maxRequests: 60 }),
};

// Middleware helper
export function checkRateLimit(
  limiter: RateLimiter,
  key: string
): Response | null {
  const result = limiter.check(key);

  if (!result.allowed) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded" }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Remaining": String(result.remaining),
          "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
          "Retry-After": String(Math.ceil((result.resetAt - Date.now()) / 1000)),
        },
      }
    );
  }

  return null;
}
```

**Apply rate limiting in api.ts:**

```typescript
import { rateLimiters, checkRateLimit } from "../lib/rate-limit";

async createLiveSession(req: Request): Promise<Response> {
  // Rate limit by IP
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  const rateLimitResponse = checkRateLimit(rateLimiters.createSession, ip);
  if (rateLimitResponse) return rateLimitResponse;

  // ... rest of implementation
}

async pushMessages(req: Request, sessionId: string): Promise<Response> {
  // Rate limit by session
  const rateLimitResponse = checkRateLimit(rateLimiters.pushMessages, sessionId);
  if (rateLimitResponse) return rateLimitResponse;

  // ... rest of implementation
}
```

### 5. WebSocket Connection Limits

Add connection limits to the WebSocket manager.

**File:** `src/lib/websocket.ts` (modifications)

```typescript
const MAX_TOTAL_CONNECTIONS = 100;
const MAX_CONNECTIONS_PER_IP = 10;
const CONNECTION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface ConnectionInfo {
  ws: ServerWebSocket;
  ip: string;
  connectedAt: number;
  lastActivity: number;
}

class WebSocketManager {
  private connections = new Map<string, Map<ServerWebSocket, ConnectionInfo>>();
  private totalConnections = 0;
  private connectionsByIp = new Map<string, number>();

  canAcceptConnection(ip: string): { allowed: boolean; reason?: string } {
    if (this.totalConnections >= MAX_TOTAL_CONNECTIONS) {
      return { allowed: false, reason: "Max connections reached" };
    }

    const ipCount = this.connectionsByIp.get(ip) || 0;
    if (ipCount >= MAX_CONNECTIONS_PER_IP) {
      return { allowed: false, reason: "Max connections per IP reached" };
    }

    return { allowed: true };
  }

  addConnection(sessionId: string, ws: ServerWebSocket, ip: string): boolean {
    const check = this.canAcceptConnection(ip);
    if (!check.allowed) {
      return false;
    }

    if (!this.connections.has(sessionId)) {
      this.connections.set(sessionId, new Map());
    }

    const info: ConnectionInfo = {
      ws,
      ip,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.connections.get(sessionId)!.set(ws, info);
    this.totalConnections++;
    this.connectionsByIp.set(ip, (this.connectionsByIp.get(ip) || 0) + 1);

    return true;
  }

  removeConnection(sessionId: string, ws: ServerWebSocket): void {
    const sessionConns = this.connections.get(sessionId);
    if (!sessionConns) return;

    const info = sessionConns.get(ws);
    if (info) {
      sessionConns.delete(ws);
      this.totalConnections--;

      const ipCount = (this.connectionsByIp.get(info.ip) || 1) - 1;
      if (ipCount <= 0) {
        this.connectionsByIp.delete(info.ip);
      } else {
        this.connectionsByIp.set(info.ip, ipCount);
      }
    }

    if (sessionConns.size === 0) {
      this.connections.delete(sessionId);
    }
  }

  touchConnection(sessionId: string, ws: ServerWebSocket): void {
    const info = this.connections.get(sessionId)?.get(ws);
    if (info) {
      info.lastActivity = Date.now();
    }
  }

  // Cleanup stale connections
  startCleanup(): void {
    setInterval(() => {
      const now = Date.now();

      for (const [sessionId, sessionConns] of this.connections) {
        for (const [ws, info] of sessionConns) {
          // Close connections that exceeded timeout
          if (now - info.connectedAt > CONNECTION_TIMEOUT_MS) {
            ws.close(1000, "Connection timeout");
            this.removeConnection(sessionId, ws);
            continue;
          }

          // Close idle connections
          if (now - info.lastActivity > IDLE_TIMEOUT_MS) {
            ws.close(1000, "Idle timeout");
            this.removeConnection(sessionId, ws);
          }
        }
      }
    }, 30_000);
  }

  // ... existing broadcast method
}
```

### 6. Local Message Buffering in Daemon

Buffer messages when server is unreachable.

**File:** `cli/daemon/message-buffer.ts`

```typescript
interface BufferedItem {
  sessionId: string;
  streamToken: string;
  type: "message" | "tool_result" | "diff";
  data: unknown;
  timestamp: number;
  retries: number;
}

const MAX_BUFFER_SIZE = 1000;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000;

export class MessageBuffer {
  private buffer: BufferedItem[] = [];
  private flushing = false;
  private api: ApiClient;

  constructor(api: ApiClient) {
    this.api = api;
  }

  add(item: Omit<BufferedItem, "timestamp" | "retries">): void {
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      // Drop oldest item
      this.buffer.shift();
      console.warn("Message buffer full, dropping oldest item");
    }

    this.buffer.push({
      ...item,
      timestamp: Date.now(),
      retries: 0,
    });

    // Trigger flush
    this.scheduleFlush();
  }

  private flushTimer: NodeJS.Timeout | null = null;

  private scheduleFlush(): void {
    if (this.flushTimer || this.flushing) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 100);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    const toProcess = [...this.buffer];
    this.buffer = [];

    for (const item of toProcess) {
      try {
        await this.sendItem(item);
      } catch (err) {
        if (this.isNetworkError(err)) {
          item.retries++;
          if (item.retries < MAX_RETRIES) {
            this.buffer.push(item);
          } else {
            console.error(`Dropping item after ${MAX_RETRIES} retries`);
          }
        } else {
          console.error("Error sending buffered item:", err);
        }
      }
    }

    this.flushing = false;

    // Schedule next flush if items remain
    if (this.buffer.length > 0) {
      setTimeout(() => this.scheduleFlush(), RETRY_DELAY_MS);
    }
  }

  private async sendItem(item: BufferedItem): Promise<void> {
    switch (item.type) {
      case "message":
        await this.api.pushMessages(
          item.sessionId,
          item.streamToken,
          item.data as unknown[]
        );
        break;

      case "diff":
        await this.api.pushDiff(
          item.sessionId,
          item.streamToken,
          item.data as string
        );
        break;
    }
  }

  private isNetworkError(err: unknown): boolean {
    if (err instanceof Error) {
      return (
        err.message.includes("ECONNREFUSED") ||
        err.message.includes("ETIMEDOUT") ||
        err.message.includes("ENOTFOUND") ||
        err.message.includes("fetch failed")
      );
    }
    return false;
  }

  getBufferSize(): number {
    return this.buffer.length;
  }
}
```

### 7. Graceful Daemon Shutdown

Ensure all sessions are properly completed on shutdown.

**File:** `cli/daemon/index.ts` (modifications)

```typescript
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  // Stop accepting new sessions
  if (watcher) {
    console.log("Stopping file watchers...");
    watcher.stop();
  }

  // Complete all active sessions
  if (tracker) {
    const activeSessions = tracker.getActiveSessions();
    if (activeSessions.length > 0) {
      console.log(`Completing ${activeSessions.length} active session(s)...`);
    }
    await tracker.stopAll();
  }

  // Flush any buffered messages
  // (MessageBuffer would need to be accessible here)

  // Clean up files
  try {
    fs.unlinkSync(PID_FILE);
    fs.unlinkSync(STATUS_FILE);
  } catch {
    // Ignore
  }

  console.log("Shutdown complete.");
  process.exit(0);
}

// Handle multiple signals
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// Handle uncaught errors
process.on("uncaughtException", async (err) => {
  console.error("Uncaught exception:", err);
  await shutdown("uncaughtException");
});

process.on("unhandledRejection", async (reason) => {
  console.error("Unhandled rejection:", reason);
  await shutdown("unhandledRejection");
});
```

### 8. Browser Diff Panel Updates

Update the diff panel to handle live diff updates smoothly.

**File:** `src/components/DiffPanel.ts` (modifications)

```typescript
interface DiffUpdate {
  files: Array<{ filename: string; additions: number; deletions: number }>;
}

// Re-fetch full diff data when we receive an update notification
async function handleDiffUpdate(sessionId: string, update: DiffUpdate): void {
  // Show loading indicator
  const panel = document.querySelector(".diff-panel");
  if (!panel) return;

  panel.classList.add("diff-loading");

  try {
    // Fetch updated session data
    const res = await fetch(`/api/sessions/${sessionId}`);
    const data = await res.json();

    // Re-render diff panel
    const diffHtml = renderDiffPanel(data.diffs, data.session);
    panel.outerHTML = diffHtml;

    // Flash to indicate update
    const newPanel = document.querySelector(".diff-panel");
    if (newPanel) {
      newPanel.classList.add("diff-updated");
      setTimeout(() => newPanel.classList.remove("diff-updated"), 500);
    }
  } catch (err) {
    console.error("Error updating diff panel:", err);
  }
}

// CSS for loading state
const diffStyles = `
  .diff-loading {
    opacity: 0.7;
    pointer-events: none;
  }

  .diff-updated {
    animation: highlight 0.5s ease;
  }

  @keyframes highlight {
    0% { background-color: rgba(34, 197, 94, 0.1); }
    100% { background-color: transparent; }
  }
`;
```

### 9. Sensitive Data Scrubbing

Implement basic sensitive data scrubbing in the daemon.

**File:** `cli/daemon/scrubber.ts`

```typescript
// Common secret patterns
const SECRET_PATTERNS: RegExp[] = [
  // AWS
  /AKIA[0-9A-Z]{16}/g,
  /[a-zA-Z0-9+/]{40}(?![a-zA-Z0-9+/])/g, // AWS secret key

  // GitHub
  /ghp_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/g,

  // Generic patterns
  /(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|auth)[\s]*[=:]\s*['"]?[a-zA-Z0-9+/=]{8,}['"]?/gi,

  // Bearer tokens
  /Bearer\s+[a-zA-Z0-9._-]+/gi,

  // Private keys
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,

  // Base64-encoded credentials (heuristic)
  /(?:Basic|Bearer)\s+[A-Za-z0-9+/=]{20,}/gi,
];

// Environment variable names to always redact
const SENSITIVE_ENV_VARS = [
  "API_KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "CREDENTIALS",
  "PRIVATE_KEY",
  "AWS_SECRET",
  "GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
];

export interface ScrubberConfig {
  additionalPatterns?: RegExp[];
  additionalEnvVars?: string[];
}

export class Scrubber {
  private patterns: RegExp[];
  private envVarPattern: RegExp;

  constructor(config: ScrubberConfig = {}) {
    this.patterns = [...SECRET_PATTERNS, ...(config.additionalPatterns || [])];

    const envVars = [...SENSITIVE_ENV_VARS, ...(config.additionalEnvVars || [])];
    // Match env var assignments like: FOO_KEY=value or FOO_KEY="value"
    const envPattern = envVars
      .map((v) => `(?:${v})[\\s]*[=:][\\s]*['"]?[^\\s'"]+['"]?`)
      .join("|");
    this.envVarPattern = new RegExp(envPattern, "gi");
  }

  scrub(content: string): string {
    let result = content;

    // Scrub known patterns
    for (const pattern of this.patterns) {
      result = result.replace(pattern, "[REDACTED]");
    }

    // Scrub env vars
    result = result.replace(this.envVarPattern, "[REDACTED]");

    return result;
  }

  scrubMessage(message: NormalizedMessage): NormalizedMessage {
    return {
      ...message,
      content_blocks: message.content_blocks.map((block) => {
        if (block.type === "text") {
          return { ...block, text: this.scrub((block as { text: string }).text) };
        }
        if (block.type === "tool_result") {
          return {
            ...block,
            content: this.scrub((block as { content: string }).content),
          };
        }
        return block;
      }),
    };
  }
}
```

**Integrate into session tracker:**

```typescript
import { Scrubber } from "./scrubber";

// In SessionTracker constructor:
private scrubber = new Scrubber();

// In handleLine, before pushing messages:
const scrubbedMessages = messages.map((m) => this.scrubber.scrubMessage(m));
await this.api.pushMessages(session.sessionId, session.streamToken, scrubbedMessages);
```

### 10. Daemon Status Command Improvements

Enhance the status command with more details.

**File:** `cli/commands/daemon.ts` (modifications)

```typescript
async function daemonStatus(): Promise<void> {
  const status = await getDaemonStatus();

  if (!status.running) {
    console.log("Daemon is not running.");
    console.log("\nTo start: archive daemon start");
    return;
  }

  console.log("╭──────────────────────────────────────────╮");
  console.log("│  Archive Daemon                          │");
  console.log("╰──────────────────────────────────────────╯");
  console.log();
  console.log(`  Status:   🟢 Running`);
  console.log(`  PID:      ${status.pid}`);
  console.log(`  Started:  ${formatRelativeTime(status.startedAt)}`);
  console.log(`  Uptime:   ${formatUptime(status.startedAt)}`);
  console.log();

  if (status.sessions.length === 0) {
    console.log("  No active sessions");
  } else {
    console.log(`  Active Sessions (${status.sessions.length}):`);
    console.log("  ─────────────────────────────────────────");

    for (const session of status.sessions) {
      console.log(`    ${session.title}`);
      console.log(`      ID: ${session.id}`);
      console.log(`      Messages: ${session.messageCount}`);
      console.log();
    }
  }

  if (status.bufferSize && status.bufferSize > 0) {
    console.log(`  ⚠️  ${status.bufferSize} messages buffered (server may be down)`);
  }
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString();
}

function formatUptime(isoString: string): string {
  const started = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - started.getTime();

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
```

## Testing

### Integration Tests

```typescript
// tests/integration/live-diff.test.ts

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

describe("Live Diff Updates", () => {
  let sessionId: string;
  let streamToken: string;

  beforeAll(async () => {
    // Create a live session
    const res = await fetch("http://localhost:3000/api/sessions/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: "/test/project",
        harness: "claude-code",
      }),
    });
    const data = await res.json();
    sessionId = data.id;
    streamToken = data.stream_token;
  });

  test("pushes and retrieves diff", async () => {
    const diff = `diff --git a/test.txt b/test.txt
new file mode 100644
--- /dev/null
+++ b/test.txt
@@ -0,0 +1 @@
+Hello world`;

    const pushRes = await fetch(
      `http://localhost:3000/api/sessions/${sessionId}/diff`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          Authorization: `Bearer ${streamToken}`,
        },
        body: diff,
      }
    );

    expect(pushRes.status).toBe(200);
    const pushData = await pushRes.json();
    expect(pushData.files_changed).toBe(1);
    expect(pushData.additions).toBe(1);

    // Verify diff is stored
    const getRes = await fetch(
      `http://localhost:3000/api/sessions/${sessionId}`
    );
    const getData = await getRes.json();
    expect(getData.diffs.length).toBe(1);
    expect(getData.diffs[0].filename).toBe("test.txt");
  });

  afterAll(async () => {
    // Complete session
    await fetch(`http://localhost:3000/api/sessions/${sessionId}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${streamToken}`,
      },
      body: JSON.stringify({}),
    });
  });
});
```

### Scrubber Tests

```typescript
// tests/daemon/scrubber.test.ts

import { describe, test, expect } from "bun:test";
import { Scrubber } from "../../cli/daemon/scrubber";

describe("Scrubber", () => {
  const scrubber = new Scrubber();

  test("scrubs AWS access keys", () => {
    const input = "AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE";
    const result = scrubber.scrub(input);
    expect(result).toBe("[REDACTED]");
  });

  test("scrubs GitHub tokens", () => {
    const input = "token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const result = scrubber.scrub(input);
    expect(result).toContain("[REDACTED]");
  });

  test("scrubs private keys", () => {
    const input = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBg...
-----END PRIVATE KEY-----`;
    const result = scrubber.scrub(input);
    expect(result).toBe("[REDACTED]");
  });

  test("preserves non-sensitive content", () => {
    const input = "The quick brown fox jumps over the lazy dog";
    const result = scrubber.scrub(input);
    expect(result).toBe(input);
  });

  test("scrubs API keys in tool results", () => {
    const message = {
      role: "assistant" as const,
      content_blocks: [
        {
          type: "tool_result",
          tool_use_id: "123",
          content: "ANTHROPIC_API_KEY=sk-ant-xxxxx",
        },
      ],
    };

    const result = scrubber.scrubMessage(message);
    expect(result.content_blocks[0].content).toBe("[REDACTED]");
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/routes/api.ts` | Modify | Add diff push endpoint |
| `src/server.ts` | Modify | Register diff route |
| `src/lib/rate-limit.ts` | Create | Rate limiting utilities |
| `src/lib/websocket.ts` | Modify | Add connection limits |
| `cli/daemon/diff-capture.ts` | Create | Git diff capture |
| `cli/daemon/message-buffer.ts` | Create | Local message buffering |
| `cli/daemon/scrubber.ts` | Create | Sensitive data scrubbing |
| `cli/daemon/session-tracker.ts` | Modify | Integrate diff and scrubbing |
| `cli/daemon/index.ts` | Modify | Graceful shutdown |
| `cli/commands/daemon.ts` | Modify | Enhanced status output |
| `src/components/DiffPanel.ts` | Modify | Handle live updates |

## Acceptance Criteria

- [ ] `PUT /api/sessions/:id/diff` accepts and stores diff updates
- [ ] Diff updates are broadcast to WebSocket subscribers
- [ ] Browser diff panel updates when diff changes
- [ ] Rate limiting is enforced on API endpoints
- [ ] WebSocket connections are limited (total and per-IP)
- [ ] Stale WebSocket connections are cleaned up
- [ ] Daemon buffers messages when server is unreachable
- [ ] Buffered messages are sent when server becomes available
- [ ] Daemon completes all sessions on graceful shutdown
- [ ] Daemon handles SIGINT, SIGTERM, and SIGHUP
- [ ] Sensitive data is scrubbed before pushing
- [ ] Common secret patterns are detected and redacted
- [ ] `archive daemon status` shows detailed information
- [ ] Diff is captured after file-modifying tool calls
- [ ] Final diff is captured on session complete
