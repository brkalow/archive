/**
 * Session Watcher - Watches directories for new session files.
 *
 * Monitors watch paths defined by harness adapters and starts/stops
 * session tracking when files are created or deleted.
 */

import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "fs";
import { join } from "path";
import type { HarnessAdapter } from "../adapters/types";
import { SessionTracker } from "./session-tracker";

export class SessionWatcher {
  private watchers: FSWatcher[] = [];
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
    if (!existsSync(dirPath)) {
      console.log(`Watch path does not exist (yet): ${dirPath}`);
      return;
    }

    console.log(`Watching: ${dirPath}`);

    // Scan for existing files (in case daemon starts mid-session)
    this.scanExistingFiles(dirPath, adapter);

    // Watch for new files and changes
    const watcher = watch(
      dirPath,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return;

        const fullPath = join(dirPath, filename);

        if (!adapter.canHandle(fullPath)) return;

        if (eventType === "rename") {
          // File created or deleted
          if (existsSync(fullPath) && !this.knownFiles.has(fullPath)) {
            this.knownFiles.add(fullPath);
            this.tracker.startSession(fullPath, adapter);
          } else if (!existsSync(fullPath) && this.knownFiles.has(fullPath)) {
            this.knownFiles.delete(fullPath);
            this.tracker.endSession(fullPath);
          }
        }
      }
    );

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
    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        this.scanDirectory(fullPath, adapter);
      } else if (entry.isFile() && adapter.canHandle(fullPath)) {
        // Check if file was recently modified (active session)
        const stats = statSync(fullPath);
        const ageMs = Date.now() - stats.mtimeMs;

        // Consider files modified in the last 5 minutes as potentially active
        if (ageMs < 5 * 60 * 1000) {
          this.knownFiles.add(fullPath);
          // Auto-start tracking for recent sessions
          console.log(`  Found recent session, starting: ${fullPath}`);
          this.tracker.startSession(fullPath, adapter);
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
