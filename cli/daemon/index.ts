/**
 * Daemon Main - Orchestrates the daemon components.
 *
 * Handles:
 * - Starting/stopping the daemon
 * - Process management (PID file)
 * - Status reporting
 * - Graceful shutdown
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, watch, type FSWatcher } from "fs";
import { dirname, join } from "path";
import { getAdapterForPath, getEnabledAdapters } from "../adapters";
import { getClientId } from "../lib/client-id";
import { getAllowedRepos } from "../lib/config";
import { DaemonWebSocket } from "../lib/daemon-ws";
import { setVerbose, debug } from "../lib/debug";
import {
  getSharedSessionsForServer,
  getSharedSessionsPath,
} from "../lib/shared-sessions";
import { SpawnedSessionManager } from "../lib/spawned-session-manager";
import type { ServerToDaemonMessage } from "../types/daemon-ws";
import { createOpenCodeAPI, type OpenCodeAPI } from "../lib/opencode-api";
import { DaemonBackend } from "../lib/opencode-backend";
import { SessionTracker } from "./session-tracker";
import { SessionWatcher } from "./watcher";

export interface DaemonOptions {
  harnesses: string[];
  watchPaths: string[];
  server: string;
  idleTimeout: number;
  verbose: boolean;
  opencodePort?: number;
}

const OPENCTL_DIR = join(Bun.env.HOME || "~", ".openctl");
const PID_FILE = join(OPENCTL_DIR, "daemon.pid");
const STATUS_FILE = join(OPENCTL_DIR, "daemon.status.json");

let tracker: SessionTracker | null = null;
let watcher: SessionWatcher | null = null;
let statusInterval: ReturnType<typeof setInterval> | null = null;
let sharedSessionsWatcher: FSWatcher | null = null;
let daemonWs: DaemonWebSocket | null = null;
let sessionManager: SpawnedSessionManager | null = null;
let opencodeApi: OpenCodeAPI | null = null;
let opencodeBackend: DaemonBackend | null = null;
let opencodeServer: ReturnType<typeof Bun.serve> | null = null;

export async function startDaemon(options: DaemonOptions): Promise<void> {
  // Enable debug logging if verbose
  setVerbose(options.verbose);

  // Check if already running
  if (await isDaemonRunning()) {
    console.error(
      "Daemon is already running. Use 'openctl daemon stop' to stop it."
    );
    process.exit(1);
  }

  // Ensure config directory exists
  if (!existsSync(OPENCTL_DIR)) {
    mkdirSync(OPENCTL_DIR, { recursive: true });
  }

  // Write PID file
  writeFileSync(PID_FILE, String(process.pid));

  // Set up adapters
  const adapters = getEnabledAdapters(
    options.harnesses.length > 0 ? options.harnesses : undefined
  );

  if (adapters.length === 0) {
    console.error("No harness adapters enabled.");
    process.exit(1);
  }

  console.log(`Enabled adapters: ${adapters.map((a) => a.name).join(", ")}`);

  // Show first-run message if allowlist is empty
  const allowedRepos = getAllowedRepos(options.server);
  if (allowedRepos.length === 0) {
    console.log(`
No repositories allowed for automatic upload.

The daemon only uploads sessions from explicitly allowed repositories.
To allow the current repository:
  openctl repo allow

To allow a specific repository:
  openctl repo allow /path/to/repo
`);
  }

  // Create tracker and watcher
  tracker = new SessionTracker(options.server, options.idleTimeout);
  await tracker.initializeAuth();
  watcher = new SessionWatcher(adapters, tracker);

  // Handle shutdown
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start watching file system for new sessions (still useful for detecting session file changes)
  watcher.start();
  tracker.startIdleCheck();

  // Start watching shared sessions allowlist
  watchSharedSessions(options.server, tracker);

  // Initialize WebSocket connection to server
  initWebSocket(options.server);

  // Start OpenCode-compatible HTTP server if port specified
  if (options.opencodePort) {
    startOpenCodeServer(options.opencodePort);
  }

  // Start status file updates
  updateStatusFile();
  statusInterval = setInterval(updateStatusFile, 5000);

  console.log("\nDaemon started. Press Ctrl+C to stop.\n");

  // Keep running
  await new Promise(() => {});
}

/**
 * Watch the shared sessions allowlist file for changes.
 * When sessions are added/removed, start/stop tracking accordingly.
 */
function watchSharedSessions(serverUrl: string, tracker: SessionTracker): void {
  const sharedSessionsPath = getSharedSessionsPath();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Ensure file and directory exist
  const dir = dirname(sharedSessionsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(sharedSessionsPath)) {
    writeFileSync(sharedSessionsPath, JSON.stringify({ version: 1, sessions: {} }));
  }

  // Initial load - start tracking any shared sessions
  handleSharedSessionsChange(serverUrl, tracker);

  // Watch for changes
  try {
    sharedSessionsWatcher = watch(sharedSessionsPath, (eventType) => {
      if (eventType === "change") {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          handleSharedSessionsChange(serverUrl, tracker);
        }, 100);
      }
    });
    debug(`Watching shared sessions file: ${sharedSessionsPath}`);
  } catch (err) {
    console.error(`Failed to watch shared sessions file:`, err);
  }
}

/**
 * Handle changes to the shared sessions allowlist.
 * Start tracking new sessions and stop tracking removed ones.
 */
async function handleSharedSessionsChange(
  serverUrl: string,
  tracker: SessionTracker
): Promise<void> {
  const sharedSessions = getSharedSessionsForServer(serverUrl);
  const sharedFilePaths = new Set(sharedSessions.map((s) => s.session.filePath));

  debug(`Shared sessions change detected: ${sharedSessions.length} sessions for ${serverUrl}`);

  // Start tracking new sessions
  for (const { uuid, session } of sharedSessions) {
    if (!tracker.isTracking(session.filePath)) {
      const adapter = getAdapterForPath(session.filePath);
      if (adapter) {
        debug(`Starting to track shared session: ${uuid}`);
        // Pass existing session ID if available (created by session share command)
        const existingSessionId = session.serverSessions?.[serverUrl]?.sessionId;
        await tracker.startSession(session.filePath, adapter, existingSessionId);
      } else {
        debug(`No adapter found for shared session: ${session.filePath}`);
      }
    }
  }

  // Stop tracking sessions no longer in allowlist
  for (const filePath of tracker.getTrackedFilePaths()) {
    if (!sharedFilePaths.has(filePath)) {
      debug(`Stopping tracking of unshared session: ${filePath}`);
      await tracker.endSession(filePath);
    }
  }
}

/**
 * Start the OpenCode-compatible HTTP server for TUI connections.
 */
function startOpenCodeServer(port: number): void {
  if (!sessionManager) {
    console.error("[daemon] Cannot start OpenCode server: session manager not initialized");
    return;
  }

  const cwd = process.cwd();
  opencodeBackend = new DaemonBackend(sessionManager, cwd);

  opencodeApi = createOpenCodeAPI(opencodeBackend, {
    directory: cwd,
  });

  // Wire up broadcast: backend → API → SSE clients
  opencodeBackend.setBroadcast(opencodeApi.broadcast);

  const api = opencodeApi;
  opencodeServer = Bun.serve({
    port,
    idleTimeout: 255, // Max value to prevent SSE timeouts
    async fetch(req) {
      const response = await api.handleRequest(req);
      if (response) return response;

      // No route matched
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    },
  });

  console.log(`[daemon] OpenCode server listening on http://localhost:${opencodeServer.port}`);
}

/**
 * Initialize WebSocket connection to server for bidirectional communication.
 * This enables browser-initiated sessions where the server can send commands to the daemon.
 */
function initWebSocket(serverUrl: string): void {
  const clientId = getClientId();

  // Create session manager with send function (bound to WebSocket)
  // Also forward messages to OpenCode backend if connected
  sessionManager = new SpawnedSessionManager((message) => {
    daemonWs?.send(message);
    opencodeBackend?.handleDaemonMessage(message);
  });

  daemonWs = new DaemonWebSocket({
    serverUrl,
    clientId,
    onMessage: handleServerMessage,
    onConnect: () => {
      console.log("[daemon] WebSocket connected to server");
    },
    onDisconnect: () => {
      console.log("[daemon] WebSocket disconnected from server");
    },
  });

  daemonWs.connect();
}

/**
 * Handle messages received from the server over WebSocket.
 * These are commands from the browser UI (start session, send input, etc.)
 */
function handleServerMessage(message: ServerToDaemonMessage): void {
  if (!sessionManager) {
    console.error("[daemon] Session manager not initialized");
    return;
  }

  switch (message.type) {
    case "start_session":
      debug(`[daemon] Received start_session: ${message.session_id}`);
      console.log(`[daemon] Starting session ${message.session_id} in ${message.cwd}`);
      sessionManager.startSession(message).catch((error) => {
        console.error(`[daemon] Failed to start session ${message.session_id}:`, error);
      });
      break;

    case "send_input":
      debug(`[daemon] Received send_input: ${message.session_id}`);
      sessionManager.sendInput(message.session_id, message.content, message.user_id);
      break;

    case "end_session":
      debug(`[daemon] Received end_session: ${message.session_id}`);
      sessionManager.endSession(message.session_id);
      break;

    case "interrupt_session":
      debug(`[daemon] Received interrupt_session: ${message.session_id}`);
      sessionManager.interruptSession(message.session_id);
      break;

    case "permission_response":
      debug(`[daemon] Received permission_response: ${message.session_id}`);
      sessionManager.respondToPermission(
        message.session_id,
        message.request_id,
        message.allow
      );
      break;

    case "question_response":
      debug(`[daemon] Received question_response: ${message.session_id}`);
      sessionManager.injectToolResult(
        message.session_id,
        message.tool_use_id,
        message.answer
      );
      break;

    case "control_response":
      debug(`[daemon] Received control_response: ${message.session_id}`);
      sessionManager.respondToControlRequest(
        message.session_id,
        message.request_id,
        message.response.subtype === "success"
          ? message.response.response
          : { behavior: "deny", message: message.response.error }
      );
      break;

    default:
      console.warn("[daemon] Unknown message type:", (message as { type: string }).type);
  }
}

async function shutdown(): Promise<void> {
  console.log("\nShutting down...");

  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }

  if (sharedSessionsWatcher) {
    sharedSessionsWatcher.close();
    sharedSessionsWatcher = null;
  }

  // End all active spawned sessions
  if (sessionManager) {
    const activeSessions = sessionManager.getActiveSessions();
    console.log(`[daemon] Ending ${activeSessions.length} active spawned session(s)`);

    for (const session of activeSessions) {
      await sessionManager.endSession(session.id);
    }
    sessionManager = null;
  }

  // Close OpenCode server
  if (opencodeApi) {
    opencodeApi.close();
    opencodeApi = null;
  }
  if (opencodeServer) {
    opencodeServer.stop();
    opencodeServer = null;
  }
  opencodeBackend = null;

  // Disconnect WebSocket
  if (daemonWs) {
    daemonWs.disconnect();
    daemonWs = null;
  }

  if (watcher) {
    watcher.stop();
  }

  if (tracker) {
    await tracker.stopAll();
  }

  // Clean up files
  try {
    unlinkSync(PID_FILE);
  } catch {
    // Ignore
  }
  try {
    unlinkSync(STATUS_FILE);
  } catch {
    // Ignore
  }

  process.exit(0);
}

export async function stopDaemon(): Promise<boolean> {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf8"), 10);
    process.kill(pid, "SIGTERM");

    // Wait for process to exit
    await Bun.sleep(1000);

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
    const status = JSON.parse(readFileSync(STATUS_FILE, "utf8"));
    return { running: true, ...status };
  } catch {
    const pid = parseInt(readFileSync(PID_FILE, "utf8"), 10);
    return { running: true, pid };
  }
}

async function isDaemonRunning(): Promise<boolean> {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf8"), 10);
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

  writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}
