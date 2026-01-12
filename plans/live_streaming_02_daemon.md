# Daemon Implementation

> **Spec reference:** [specs/live_streaming.md](../specs/live_streaming.md)

## Overview

This plan covers the CLI daemon that watches local AI coding session files, parses them via harness-specific adapters, and streams updates to the archive server in real-time.

## Dependencies

- [live_streaming_01_server.md](./live_streaming_01_server.md) - Server must have live session endpoints ready

## Directory Structure

```
cli/
  index.ts              # Entry point, command router
  commands/
    daemon.ts           # daemon start/stop/status commands
    upload.ts           # Existing upload command (refactored)
    serve.ts            # Local server command
    list.ts             # List sessions command
    open.ts             # Open in browser command
    config.ts           # Config management
  daemon/
    index.ts            # Daemon main loop
    watcher.ts          # File watching logic
    session-tracker.ts  # Active session management
    api-client.ts       # HTTP client for server API
  adapters/
    types.ts            # HarnessAdapter interface
    index.ts            # Adapter registry
    claude-code.ts      # Claude Code adapter
  lib/
    config.ts           # Config loading/saving
    tail.ts             # File tailing utility
```

## Tasks

### 1. CLI Scaffolding

Set up the CLI entry point with command routing.

**File:** `cli/index.ts`

```typescript
#!/usr/bin/env bun

import { parseArgs } from "util";
import { daemon } from "./commands/daemon";
import { upload } from "./commands/upload";
import { serve } from "./commands/serve";
import { list } from "./commands/list";
import { open } from "./commands/open";
import { config } from "./commands/config";

const commands: Record<string, (args: string[]) => Promise<void>> = {
  daemon,
  upload,
  serve,
  list,
  open,
  config,
};

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    console.log(`
Usage: archive <command> [options]

Commands:
  daemon    Manage the background daemon (start/stop/status)
  upload    Upload a session to the archive
  serve     Start the archive server locally
  list      List uploaded sessions
  open      Open a session in the browser
  config    Manage CLI configuration

Run 'archive <command> --help' for more information.
    `);
    process.exit(0);
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }

  await handler(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### 2. Daemon Command

Implement daemon start/stop/status subcommands.

**File:** `cli/commands/daemon.ts`

```typescript
import { parseArgs } from "util";
import { startDaemon, stopDaemon, getDaemonStatus } from "../daemon";
import { loadConfig } from "../lib/config";

export async function daemon(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "start":
      return daemonStart(args.slice(1));
    case "stop":
      return daemonStop();
    case "status":
      return daemonStatus();
    default:
      console.log(`
Usage: archive daemon <subcommand> [options]

Subcommands:
  start     Start the daemon
  stop      Stop the running daemon
  status    Show daemon status

Options for 'start':
  --harness <name>       Harness adapter(s) to enable (default: all)
                         Can specify multiple: --harness claude-code --harness cursor
  --watch <paths>        Additional directories to watch
  --server <url>         Archive server URL (default: from config)
  --idle-timeout <sec>   Seconds before marking session complete (default: 60)
      `);
  }
}

async function daemonStart(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      harness: { type: "string", multiple: true },
      watch: { type: "string", multiple: true },
      server: { type: "string" },
      "idle-timeout": { type: "string" },
    },
  });

  const config = loadConfig();

  const options = {
    harnesses: values.harness || [],
    watchPaths: values.watch || [],
    server: values.server || config.server || "http://localhost:3000",
    idleTimeout: parseInt(values["idle-timeout"] || "60", 10),
  };

  console.log("Starting archive daemon...");
  console.log(`  Server: ${options.server}`);
  console.log(`  Harnesses: ${options.harnesses.length ? options.harnesses.join(", ") : "all"}`);
  console.log(`  Idle timeout: ${options.idleTimeout}s`);
  console.log();
  console.log("⚠️  Session content will be transmitted to the server.");
  console.log("    Ensure no sensitive data (API keys, passwords) is exposed.");
  console.log();

  await startDaemon(options);
}

async function daemonStop(): Promise<void> {
  const stopped = await stopDaemon();
  if (stopped) {
    console.log("Daemon stopped.");
  } else {
    console.log("No daemon running.");
  }
}

async function daemonStatus(): Promise<void> {
  const status = await getDaemonStatus();

  if (!status.running) {
    console.log("Daemon is not running.");
    return;
  }

  console.log("Daemon is running.");
  console.log(`  PID: ${status.pid}`);
  console.log(`  Started: ${status.startedAt}`);
  console.log(`  Active sessions: ${status.activeSessions}`);

  if (status.sessions.length > 0) {
    console.log("\nActive sessions:");
    for (const session of status.sessions) {
      console.log(`  ${session.id}: ${session.title} (${session.messageCount} messages)`);
    }
  }
}
```

### 3. Harness Adapter Interface

Define the interface for harness adapters.

**File:** `cli/adapters/types.ts`

```typescript
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface NormalizedMessage {
  role: "user" | "assistant";
  content_blocks: ContentBlock[];
  timestamp?: string;
}

export interface SessionInfo {
  localPath: string;
  projectPath: string;
  harnessSessionId?: string;
  model?: string;
  repoUrl?: string;
}

export interface ParseContext {
  messages: NormalizedMessage[];
  pendingToolUses: Map<string, { messageIndex: number; blockIndex: number }>;
}

export interface HarnessAdapter {
  id: string;
  name: string;

  /** Directories to watch for session files */
  getWatchPaths(): string[];

  /** Check if this adapter handles a given file */
  canHandle(filePath: string): boolean;

  /** Extract session metadata from file path */
  getSessionInfo(filePath: string): SessionInfo;

  /** Parse a line from the session file */
  parseLine(line: string, context: ParseContext): NormalizedMessage[] | null;

  /** Optional: Detect if session has ended */
  detectSessionEnd?(filePath: string): Promise<boolean>;

  /** Optional: Derive title from messages */
  deriveTitle?(messages: NormalizedMessage[]): string;
}
```

### 4. Claude Code Adapter

Implement the Claude Code harness adapter.

**File:** `cli/adapters/claude-code.ts`

```typescript
import * as path from "path";
import * as os from "os";
import type { HarnessAdapter, NormalizedMessage, SessionInfo, ParseContext, ContentBlock } from "./types";

function normalizeRole(role: string): "user" | "assistant" | null {
  if (role === "user" || role === "human") return "user";
  if (role === "assistant") return "assistant";
  return null;
}

function parseContentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === "object" && block !== null) {
        return block as ContentBlock;
      }
      return { type: "text", text: String(block) };
    });
  }

  return [];
}

export const claudeCodeAdapter: HarnessAdapter = {
  id: "claude-code",
  name: "Claude Code",

  getWatchPaths() {
    return [path.join(os.homedir(), ".claude", "projects")];
  },

  canHandle(filePath: string) {
    return filePath.includes("/.claude/projects/") && filePath.endsWith(".jsonl");
  },

  getSessionInfo(filePath: string): SessionInfo {
    const parts = filePath.split("/");
    const projectSlug = parts[parts.length - 2];
    const sessionFile = parts[parts.length - 1];

    // Decode project path from slug (replace - with /)
    // Note: This is a simplification; real decoding may need more logic
    let projectPath = projectSlug;
    if (projectSlug.startsWith("-")) {
      projectPath = projectSlug.replace(/-/g, "/");
    }

    return {
      localPath: filePath,
      projectPath,
      harnessSessionId: sessionFile.replace(".jsonl", ""),
    };
  },

  parseLine(line: string, context: ParseContext): NormalizedMessage[] | null {
    let item: Record<string, unknown>;
    try {
      item = JSON.parse(line);
    } catch {
      return null; // Skip malformed lines
    }

    // Handle tool_result - attach to pending tool_use
    if (item.type === "tool_result") {
      const toolUseId = item.tool_use_id as string;
      const pending = context.pendingToolUses.get(toolUseId);

      if (pending) {
        const msg = context.messages[pending.messageIndex];
        msg.content_blocks.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: typeof item.content === "string" ? item.content : JSON.stringify(item.content),
          is_error: item.is_error as boolean | undefined,
        });
        context.pendingToolUses.delete(toolUseId);
      }

      return null; // Don't emit as separate message
    }

    // Handle user/assistant messages
    const msgData = (item.message as Record<string, unknown>) || item;
    const role = normalizeRole((msgData.role as string) || (item.type as string));
    if (!role) return null;

    const contentBlocks = parseContentBlocks(msgData.content);
    if (contentBlocks.length === 0) return null;

    // Track pending tool_uses
    const messageIndex = context.messages.length;
    contentBlocks.forEach((block, blockIndex) => {
      if (block.type === "tool_use" && block.id) {
        context.pendingToolUses.set(block.id as string, { messageIndex, blockIndex });
      }
    });

    const message: NormalizedMessage = {
      role,
      content_blocks: contentBlocks,
      timestamp: item.timestamp as string | undefined,
    };

    return [message];
  },

  deriveTitle(messages: NormalizedMessage[]): string {
    const firstUser = messages.find((m) => m.role === "user");
    if (firstUser) {
      const text = firstUser.content_blocks
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join(" ");
      return text.slice(0, 80) + (text.length > 80 ? "..." : "");
    }
    return "Untitled Session";
  },
};
```

### 5. Adapter Registry

Register and manage available adapters.

**File:** `cli/adapters/index.ts`

```typescript
import type { HarnessAdapter } from "./types";
import { claudeCodeAdapter } from "./claude-code";

export const adapters: HarnessAdapter[] = [
  claudeCodeAdapter,
  // Add more adapters here
];

export function getAdapterForPath(filePath: string): HarnessAdapter | null {
  return adapters.find((a) => a.canHandle(filePath)) || null;
}

export function getAdapterById(id: string): HarnessAdapter | null {
  return adapters.find((a) => a.id === id) || null;
}

export function getEnabledAdapters(enabledIds?: string[]): HarnessAdapter[] {
  if (!enabledIds || enabledIds.length === 0) {
    return adapters;
  }
  return adapters.filter((a) => enabledIds.includes(a.id));
}
```

### 6. File Tailing Utility

Implement file tailing for incremental reading.

**File:** `cli/lib/tail.ts`

```typescript
import * as fs from "fs";
import { EventEmitter } from "events";

export class Tail extends EventEmitter {
  private filePath: string;
  private position: number = 0;
  private watcher: fs.FSWatcher | null = null;
  private buffer: string = "";

  constructor(filePath: string, startFromEnd: boolean = false) {
    super();
    this.filePath = filePath;

    if (startFromEnd) {
      try {
        const stats = fs.statSync(filePath);
        this.position = stats.size;
      } catch {
        this.position = 0;
      }
    }
  }

  start(): void {
    // Initial read
    this.readNewContent();

    // Watch for changes
    this.watcher = fs.watch(this.filePath, (eventType) => {
      if (eventType === "change") {
        this.readNewContent();
      }
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private readNewContent(): void {
    try {
      const stats = fs.statSync(this.filePath);

      if (stats.size < this.position) {
        // File was truncated, start from beginning
        this.position = 0;
        this.buffer = "";
      }

      if (stats.size > this.position) {
        const fd = fs.openSync(this.filePath, "r");
        const bytesToRead = stats.size - this.position;
        const buffer = Buffer.alloc(bytesToRead);

        fs.readSync(fd, buffer, 0, bytesToRead, this.position);
        fs.closeSync(fd);

        this.position = stats.size;

        const content = buffer.toString("utf8");
        this.buffer += content;

        // Emit complete lines
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || ""; // Keep incomplete last line

        for (const line of lines) {
          if (line.trim()) {
            this.emit("line", line);
          }
        }
      }
    } catch (err) {
      this.emit("error", err);
    }
  }

  getPosition(): number {
    return this.position;
  }
}
```

### 7. API Client

HTTP client for communicating with the archive server.

**File:** `cli/daemon/api-client.ts`

```typescript
interface CreateLiveSessionRequest {
  title?: string;
  project_path: string;
  harness_session_id?: string;
  harness: string;
  model?: string;
  repo_url?: string;
}

interface CreateLiveSessionResponse {
  id: string;
  stream_token: string;
  status: string;
}

interface PushMessagesResponse {
  appended: number;
  message_count: number;
  last_index: number;
}

export class ApiClient {
  constructor(private serverUrl: string) {}

  async createLiveSession(data: CreateLiveSessionRequest): Promise<CreateLiveSessionResponse> {
    const res = await fetch(`${this.serverUrl}/api/sessions/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to create live session: ${res.status} ${error}`);
    }

    return res.json();
  }

  async pushMessages(
    sessionId: string,
    streamToken: string,
    messages: unknown[]
  ): Promise<PushMessagesResponse> {
    const res = await fetch(`${this.serverUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${streamToken}`,
      },
      body: JSON.stringify({ messages }),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to push messages: ${res.status} ${error}`);
    }

    return res.json();
  }

  async pushDiff(sessionId: string, streamToken: string, diff: string): Promise<void> {
    const res = await fetch(`${this.serverUrl}/api/sessions/${sessionId}/diff`, {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain",
        Authorization: `Bearer ${streamToken}`,
      },
      body: diff,
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to push diff: ${res.status} ${error}`);
    }
  }

  async completeSession(
    sessionId: string,
    streamToken: string,
    data: { final_diff?: string; summary?: string } = {}
  ): Promise<void> {
    const res = await fetch(`${this.serverUrl}/api/sessions/${sessionId}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${streamToken}`,
      },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to complete session: ${res.status} ${error}`);
    }
  }

  async updateTitle(sessionId: string, streamToken: string, title: string): Promise<void> {
    const res = await fetch(`${this.serverUrl}/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${streamToken}`,
      },
      body: JSON.stringify({ title }),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Failed to update title: ${res.status} ${error}`);
    }
  }
}
```

### 8. Session Tracker

Manage active sessions being streamed.

**File:** `cli/daemon/session-tracker.ts`

```typescript
import type { HarnessAdapter, ParseContext, NormalizedMessage } from "../adapters/types";
import { Tail } from "../lib/tail";
import { ApiClient } from "./api-client";

interface ActiveSession {
  adapter: HarnessAdapter;
  localPath: string;
  sessionId: string;
  streamToken: string;
  tail: Tail;
  lastActivity: Date;
  parseContext: ParseContext;
  titleDerived: boolean;
}

export class SessionTracker {
  private sessions = new Map<string, ActiveSession>();
  private api: ApiClient;
  private idleTimeoutMs: number;
  private idleCheckInterval: NodeJS.Timeout | null = null;

  constructor(serverUrl: string, idleTimeoutSeconds: number) {
    this.api = new ApiClient(serverUrl);
    this.idleTimeoutMs = idleTimeoutSeconds * 1000;
  }

  async startSession(filePath: string, adapter: HarnessAdapter): Promise<void> {
    if (this.sessions.has(filePath)) {
      return; // Already tracking
    }

    const sessionInfo = adapter.getSessionInfo(filePath);

    console.log(`[${adapter.name}] New session detected: ${filePath}`);

    try {
      const { id, stream_token } = await this.api.createLiveSession({
        title: "Live Session",
        project_path: sessionInfo.projectPath,
        harness_session_id: sessionInfo.harnessSessionId,
        harness: adapter.id,
        model: sessionInfo.model,
        repo_url: sessionInfo.repoUrl,
      });

      console.log(`  Created server session: ${id}`);

      const parseContext: ParseContext = {
        messages: [],
        pendingToolUses: new Map(),
      };

      const tail = new Tail(filePath);
      const session: ActiveSession = {
        adapter,
        localPath: filePath,
        sessionId: id,
        streamToken: stream_token,
        tail,
        lastActivity: new Date(),
        parseContext,
        titleDerived: false,
      };

      this.sessions.set(filePath, session);

      tail.on("line", (line: string) => this.handleLine(session, line));
      tail.on("error", (err: Error) => {
        console.error(`  Error tailing ${filePath}:`, err);
      });

      tail.start();
    } catch (err) {
      console.error(`  Failed to create session:`, err);
    }
  }

  private async handleLine(session: ActiveSession, line: string): Promise<void> {
    session.lastActivity = new Date();

    const messages = session.adapter.parseLine(line, session.parseContext);
    if (!messages || messages.length === 0) return;

    // Add to context
    session.parseContext.messages.push(...messages);

    // Push to server
    try {
      await this.api.pushMessages(session.sessionId, session.streamToken, messages);
    } catch (err) {
      console.error(`  Failed to push messages:`, err);
      // TODO: Buffer for retry
    }

    // Derive title after first few messages
    if (!session.titleDerived && session.parseContext.messages.length >= 2) {
      const firstUserMessage = session.parseContext.messages.find((m) => m.role === "user");
      if (firstUserMessage && session.adapter.deriveTitle) {
        const title = session.adapter.deriveTitle(session.parseContext.messages);
        try {
          await this.api.updateTitle(session.sessionId, session.streamToken, title);
          session.titleDerived = true;
          console.log(`  Title: ${title}`);
        } catch {
          // Non-critical, continue
        }
      }
    }
  }

  async endSession(filePath: string): Promise<void> {
    const session = this.sessions.get(filePath);
    if (!session) return;

    console.log(`[${session.adapter.name}] Session ending: ${filePath}`);

    session.tail.stop();

    try {
      await this.api.completeSession(session.sessionId, session.streamToken);
      console.log(`  Completed: ${session.sessionId}`);
    } catch (err) {
      console.error(`  Failed to complete session:`, err);
    }

    this.sessions.delete(filePath);
  }

  startIdleCheck(): void {
    this.idleCheckInterval = setInterval(() => {
      const now = Date.now();

      for (const [filePath, session] of this.sessions) {
        const idleMs = now - session.lastActivity.getTime();
        if (idleMs > this.idleTimeoutMs) {
          console.log(`  Session idle for ${Math.round(idleMs / 1000)}s, completing...`);
          this.endSession(filePath);
        }
      }
    }, 10_000);
  }

  stopIdleCheck(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
  }

  async stopAll(): Promise<void> {
    this.stopIdleCheck();

    for (const filePath of this.sessions.keys()) {
      await this.endSession(filePath);
    }
  }

  getActiveSessions(): Array<{ id: string; title: string; messageCount: number }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.sessionId,
      title: s.titleDerived
        ? s.adapter.deriveTitle?.(s.parseContext.messages) || "Live Session"
        : "Live Session",
      messageCount: s.parseContext.messages.length,
    }));
  }
}
```

### 9. File Watcher

Watch directories for new session files.

**File:** `cli/daemon/watcher.ts`

```typescript
import * as fs from "fs";
import * as path from "path";
import type { HarnessAdapter } from "../adapters/types";
import { getAdapterForPath } from "../adapters";
import { SessionTracker } from "./session-tracker";

export class SessionWatcher {
  private watchers: fs.FSWatcher[] = [];
  private knownFiles = new Set<string>();

  constructor(
    private adapters: HarnessAdapter[],
    private tracker: SessionTracker
  ) {}

  start(): void {
    for (const adapter of this.adapters) {
      const paths = adapter.getWatchPaths();

      for (const watchPath of paths) {
        this.watchDirectory(watchPath, adapter);
      }
    }
  }

  private watchDirectory(dirPath: string, adapter: HarnessAdapter): void {
    // Ensure directory exists
    if (!fs.existsSync(dirPath)) {
      console.log(`Watch path does not exist (yet): ${dirPath}`);
      return;
    }

    console.log(`Watching: ${dirPath}`);

    // Scan for existing files (in case daemon starts mid-session)
    this.scanExistingFiles(dirPath, adapter);

    // Watch for new files and changes
    const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      const fullPath = path.join(dirPath, filename);

      if (!adapter.canHandle(fullPath)) return;

      if (eventType === "rename") {
        // File created or deleted
        if (fs.existsSync(fullPath) && !this.knownFiles.has(fullPath)) {
          this.knownFiles.add(fullPath);
          this.tracker.startSession(fullPath, adapter);
        } else if (!fs.existsSync(fullPath) && this.knownFiles.has(fullPath)) {
          this.knownFiles.delete(fullPath);
          this.tracker.endSession(fullPath);
        }
      }
    });

    this.watchers.push(watcher);
  }

  private scanExistingFiles(dirPath: string, adapter: HarnessAdapter): void {
    try {
      this.scanDirectory(dirPath, adapter);
    } catch (err) {
      console.error(`Error scanning ${dirPath}:`, err);
    }
  }

  private scanDirectory(dirPath: string, adapter: HarnessAdapter): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        this.scanDirectory(fullPath, adapter);
      } else if (entry.isFile() && adapter.canHandle(fullPath)) {
        // Check if file was recently modified (active session)
        const stats = fs.statSync(fullPath);
        const ageMs = Date.now() - stats.mtimeMs;

        // Consider files modified in the last 5 minutes as potentially active
        if (ageMs < 5 * 60 * 1000) {
          this.knownFiles.add(fullPath);
          // Note: Don't auto-start these to avoid duplicate sessions
          // Could add a flag to enable this behavior
          console.log(`  Found recent session file: ${fullPath}`);
        }
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}
```

### 10. Daemon Main

Orchestrate the daemon components.

**File:** `cli/daemon/index.ts`

```typescript
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getEnabledAdapters } from "../adapters";
import { SessionTracker } from "./session-tracker";
import { SessionWatcher } from "./watcher";

interface DaemonOptions {
  harnesses: string[];
  watchPaths: string[];
  server: string;
  idleTimeout: number;
}

const PID_FILE = path.join(os.homedir(), ".archive", "daemon.pid");
const STATUS_FILE = path.join(os.homedir(), ".archive", "daemon.status.json");

let tracker: SessionTracker | null = null;
let watcher: SessionWatcher | null = null;

export async function startDaemon(options: DaemonOptions): Promise<void> {
  // Check if already running
  if (await isDaemonRunning()) {
    console.error("Daemon is already running. Use 'archive daemon stop' to stop it.");
    process.exit(1);
  }

  // Ensure config directory exists
  const configDir = path.dirname(PID_FILE);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Write PID file
  fs.writeFileSync(PID_FILE, String(process.pid));

  // Set up adapters
  const adapters = getEnabledAdapters(options.harnesses.length > 0 ? options.harnesses : undefined);

  if (adapters.length === 0) {
    console.error("No harness adapters enabled.");
    process.exit(1);
  }

  console.log(`Enabled adapters: ${adapters.map((a) => a.name).join(", ")}`);

  // Create tracker and watcher
  tracker = new SessionTracker(options.server, options.idleTimeout);
  watcher = new SessionWatcher(adapters, tracker);

  // Handle shutdown
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start watching
  watcher.start();
  tracker.startIdleCheck();

  // Update status file
  updateStatusFile();

  console.log("\nDaemon started. Press Ctrl+C to stop.\n");

  // Keep running
  await new Promise(() => {});
}

async function shutdown(): Promise<void> {
  console.log("\nShutting down...");

  if (watcher) {
    watcher.stop();
  }

  if (tracker) {
    await tracker.stopAll();
  }

  // Clean up files
  try {
    fs.unlinkSync(PID_FILE);
    fs.unlinkSync(STATUS_FILE);
  } catch {
    // Ignore
  }

  process.exit(0);
}

export async function stopDaemon(): Promise<boolean> {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
    process.kill(pid, "SIGTERM");

    // Wait for process to exit
    await new Promise((resolve) => setTimeout(resolve, 1000));

    return true;
  } catch {
    return false;
  }
}

export async function getDaemonStatus(): Promise<{
  running: boolean;
  pid?: number;
  startedAt?: string;
  activeSessions?: number;
  sessions?: Array<{ id: string; title: string; messageCount: number }>;
}> {
  if (!(await isDaemonRunning())) {
    return { running: false };
  }

  try {
    const status = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
    return { running: true, ...status };
  } catch {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
    return { running: true, pid };
  }
}

async function isDaemonRunning(): Promise<boolean> {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
    process.kill(pid, 0); // Check if process exists
    return true;
  } catch {
    return false;
  }
}

function updateStatusFile(): void {
  const status = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    activeSessions: tracker?.getActiveSessions().length ?? 0,
    sessions: tracker?.getActiveSessions() ?? [],
  };

  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

// Periodically update status file
setInterval(updateStatusFile, 5000);
```

### 11. Config Management

**File:** `cli/lib/config.ts`

```typescript
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".archive", "config.json");

interface Config {
  server?: string;
  db?: string;
  autoOpen?: boolean;
}

export function loadConfig(): Config {
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function getConfigValue(key: keyof Config): string | undefined {
  const config = loadConfig();
  const value = config[key];
  return value !== undefined ? String(value) : undefined;
}

export function setConfigValue(key: keyof Config, value: string): void {
  const config = loadConfig();
  (config as Record<string, unknown>)[key] = value;
  saveConfig(config);
}
```

### 12. Package Configuration

Update package.json for CLI.

**File:** `package.json` (additions)

```json
{
  "bin": {
    "archive": "./cli/index.ts"
  },
  "scripts": {
    "cli": "bun run ./cli/index.ts"
  }
}
```

## Testing

### Manual Testing

1. Start the daemon:
```sh
bun run cli daemon start --server http://localhost:3000
```

2. Start a Claude Code session in another terminal

3. Verify the daemon detects the session and streams messages

4. Check the web UI shows the live session

5. End the Claude Code session and verify completion

### Unit Tests

```typescript
// tests/daemon/claude-code-adapter.test.ts

import { describe, test, expect } from "bun:test";
import { claudeCodeAdapter } from "../../cli/adapters/claude-code";
import type { ParseContext } from "../../cli/adapters/types";

describe("Claude Code Adapter", () => {
  test("canHandle recognizes Claude Code session files", () => {
    expect(claudeCodeAdapter.canHandle("/Users/me/.claude/projects/-Users-me-myproject/abc123.jsonl")).toBe(true);
    expect(claudeCodeAdapter.canHandle("/Users/me/.cursor/conversations/abc.json")).toBe(false);
  });

  test("getSessionInfo extracts metadata", () => {
    const info = claudeCodeAdapter.getSessionInfo(
      "/Users/me/.claude/projects/-Users-me-myproject/abc123.jsonl"
    );

    expect(info.harnessSessionId).toBe("abc123");
    expect(info.projectPath).toContain("Users");
  });

  test("parseLine handles user message", () => {
    const context: ParseContext = { messages: [], pendingToolUses: new Map() };

    const result = claudeCodeAdapter.parseLine(
      '{"type":"user","message":{"role":"user","content":"Hello"},"timestamp":"2025-01-11T10:00:00Z"}',
      context
    );

    expect(result).toHaveLength(1);
    expect(result![0].role).toBe("user");
    expect(result![0].content_blocks[0]).toEqual({ type: "text", text: "Hello" });
  });

  test("parseLine handles tool_use and tool_result", () => {
    const context: ParseContext = { messages: [], pendingToolUses: new Map() };

    // Parse assistant message with tool_use
    const msg = claudeCodeAdapter.parseLine(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me read that."},{"type":"tool_use","id":"tu_001","name":"Read","input":{"file_path":"test.txt"}}]}}',
      context
    );

    expect(msg).toHaveLength(1);
    context.messages.push(...msg!);

    expect(context.pendingToolUses.has("tu_001")).toBe(true);

    // Parse tool_result
    const result = claudeCodeAdapter.parseLine(
      '{"type":"tool_result","tool_use_id":"tu_001","content":"file contents"}',
      context
    );

    expect(result).toBeNull(); // tool_result doesn't emit new message

    // Result should be attached to the assistant message
    const toolResult = context.messages[0].content_blocks.find((b) => b.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect((toolResult as any).content).toBe("file contents");
  });

  test("deriveTitle uses first user message", () => {
    const messages = [
      { role: "user" as const, content_blocks: [{ type: "text", text: "Please help me implement auth" }] },
      { role: "assistant" as const, content_blocks: [{ type: "text", text: "Sure!" }] },
    ];

    const title = claudeCodeAdapter.deriveTitle!(messages);
    expect(title).toBe("Please help me implement auth");
  });
});
```

## Files to Create

| File | Description |
|------|-------------|
| `cli/index.ts` | CLI entry point |
| `cli/commands/daemon.ts` | Daemon command |
| `cli/commands/config.ts` | Config command |
| `cli/adapters/types.ts` | Adapter interface |
| `cli/adapters/index.ts` | Adapter registry |
| `cli/adapters/claude-code.ts` | Claude Code adapter |
| `cli/daemon/index.ts` | Daemon orchestration |
| `cli/daemon/watcher.ts` | File watcher |
| `cli/daemon/session-tracker.ts` | Session management |
| `cli/daemon/api-client.ts` | Server API client |
| `cli/lib/tail.ts` | File tailing utility |
| `cli/lib/config.ts` | Config management |

## Acceptance Criteria

- [ ] `archive daemon start` starts the daemon and watches for sessions
- [ ] `archive daemon stop` gracefully stops the daemon
- [ ] `archive daemon status` shows running state and active sessions
- [ ] Claude Code sessions are automatically detected when created
- [ ] Messages are streamed to the server as they appear
- [ ] Session title is derived from first user message
- [ ] Idle sessions are marked complete after timeout
- [ ] Daemon gracefully handles server disconnection
- [ ] Warning displayed about sensitive data on start
- [ ] All tests pass
