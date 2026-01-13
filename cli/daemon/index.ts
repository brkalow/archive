/**
 * Daemon Main - Orchestrates the daemon components.
 *
 * Handles:
 * - Starting/stopping the daemon
 * - Process management (PID file)
 * - Status reporting
 * - Graceful shutdown
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { getEnabledAdapters } from "../adapters";
import { setVerbose } from "../lib/debug";
import { SessionTracker } from "./session-tracker";
import { SessionWatcher } from "./watcher";

export interface DaemonOptions {
  harnesses: string[];
  watchPaths: string[];
  server: string;
  idleTimeout: number;
  verbose: boolean;
}

const ARCHIVE_DIR = join(Bun.env.HOME || "~", ".archive");
const PID_FILE = join(ARCHIVE_DIR, "daemon.pid");
const STATUS_FILE = join(ARCHIVE_DIR, "daemon.status.json");

let tracker: SessionTracker | null = null;
let watcher: SessionWatcher | null = null;
let statusInterval: ReturnType<typeof setInterval> | null = null;

export async function startDaemon(options: DaemonOptions): Promise<void> {
  // Enable debug logging if verbose
  setVerbose(options.verbose);

  // Check if already running
  if (await isDaemonRunning()) {
    console.error(
      "Daemon is already running. Use 'archive daemon stop' to stop it."
    );
    process.exit(1);
  }

  // Ensure config directory exists
  if (!existsSync(ARCHIVE_DIR)) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
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

  // Create tracker and watcher
  tracker = new SessionTracker(options.server, options.idleTimeout);
  watcher = new SessionWatcher(adapters, tracker);

  // Handle shutdown
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start watching
  watcher.start();
  tracker.startIdleCheck();

  // Start status file updates
  updateStatusFile();
  statusInterval = setInterval(updateStatusFile, 5000);

  console.log("\nDaemon started. Press Ctrl+C to stop.\n");

  // Keep running
  await new Promise(() => {});
}

async function shutdown(): Promise<void> {
  console.log("\nShutting down...");

  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
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
