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
import { getAllowedRepos } from "../lib/config";
import { setVerbose, debug } from "../lib/debug";
import {
  getSharedSessionsForServer,
  getSharedSessionsPath,
} from "../lib/shared-sessions";
import { SessionTracker } from "./session-tracker";
import { SessionWatcher } from "./watcher";

export interface DaemonOptions {
  harnesses: string[];
  watchPaths: string[];
  server: string;
  idleTimeout: number;
  verbose: boolean;
}

const OPENCTL_DIR = join(Bun.env.HOME || "~", ".openctl");
const PID_FILE = join(OPENCTL_DIR, "daemon.pid");
const STATUS_FILE = join(OPENCTL_DIR, "daemon.status.json");

let tracker: SessionTracker | null = null;
let watcher: SessionWatcher | null = null;
let statusInterval: ReturnType<typeof setInterval> | null = null;
let sharedSessionsWatcher: FSWatcher | null = null;

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
  watcher = new SessionWatcher(adapters, tracker);

  // Handle shutdown
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start watching file system for new sessions (still useful for detecting session file changes)
  watcher.start();
  tracker.startIdleCheck();

  // Start watching shared sessions allowlist
  watchSharedSessions(options.server, tracker);

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
        await tracker.startSession(session.filePath, adapter);
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
