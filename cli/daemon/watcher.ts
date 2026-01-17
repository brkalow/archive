/**
 * Session Watcher - Watches directories for session file deletions.
 *
 * Monitors watch paths defined by harness adapters and ends session tracking
 * when files are deleted. Session starts are now handled by the shared sessions
 * allowlist watcher in the daemon index.
 */

import { existsSync, watch, type FSWatcher } from "fs";
import { join } from "path";
import type { HarnessAdapter } from "../adapters/types";
import { SessionTracker } from "./session-tracker";

export class SessionWatcher {
  private watchers: FSWatcher[] = [];

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

    // Watch for file deletions only
    // Session starts are now handled by the shared sessions allowlist watcher
    const watcher = watch(
      dirPath,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return;

        const fullPath = join(dirPath, filename);

        if (!adapter.canHandle(fullPath)) return;

        if (eventType === "rename") {
          // Check if file was deleted
          if (!existsSync(fullPath)) {
            // File was deleted - end session if we were tracking it
            if (this.tracker.isTracking(fullPath)) {
              this.tracker.endSession(fullPath);
            }
          }
        }
        // Content changes are handled by the Tail in session-tracker
        // No need to do anything here for "change" events
      }
    );

    this.watchers.push(watcher);
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}
