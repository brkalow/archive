/**
 * Session Tracker - Manages active sessions being streamed to the server.
 *
 * Handles:
 * - Starting/stopping file tailing for sessions
 * - Parsing incoming lines via adapters
 * - Pushing messages to the server
 * - Title derivation from first user message
 * - Idle timeout detection
 */

import type {
  HarnessAdapter,
  ParseContext,
  NormalizedMessage,
} from "../adapters/types";
import { debug } from "../lib/debug";
import { captureGitDiff } from "../lib/git";
import { Tail } from "../lib/tail";
import { ApiClient } from "./api-client";

/** Debounce delay for diff capture (ms) */
const DIFF_DEBOUNCE_MS = 2000;

/** Tool names that modify files and should trigger diff capture */
const FILE_MODIFYING_TOOLS = ["Write", "Edit", "NotebookEdit"];

interface ActiveSession {
  adapter: HarnessAdapter;
  localPath: string;
  projectPath: string;
  sessionId: string;
  streamToken: string;
  tail: Tail;
  lastActivity: Date;
  parseContext: ParseContext;
  titleDerived: boolean;
  // Queue for serializing line processing (prevents race conditions)
  lineQueue: string[];
  isProcessing: boolean;
  // Timer for debounced diff capture
  diffDebounceTimer: ReturnType<typeof setTimeout> | null;
}

export class SessionTracker {
  private sessions = new Map<string, ActiveSession>();
  private api: ApiClient;
  private idleTimeoutMs: number;
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(serverUrl: string, idleTimeoutSeconds: number) {
    this.api = new ApiClient(serverUrl);
    this.idleTimeoutMs = idleTimeoutSeconds * 1000;
  }

  async startSession(filePath: string, adapter: HarnessAdapter): Promise<void> {
    if (this.sessions.has(filePath)) {
      return; // Already tracking
    }

    const sessionInfo = adapter.getSessionInfo(filePath);

    console.log(`[${adapter.name}] Session detected: ${filePath}`);

    try {
      const { id, stream_token, resumed, restored, message_count } = await this.api.createLiveSession({
        title: "Live Session",
        project_path: sessionInfo.projectPath,
        harness_session_id: sessionInfo.harnessSessionId,
        harness: adapter.id,
        model: sessionInfo.model,
        repo_url: sessionInfo.repoUrl,
      });

      if (restored) {
        console.log(`  Restored completed session: ${id} (${message_count} existing messages)`);
      } else if (resumed) {
        console.log(`  Resumed live session: ${id} (${message_count} existing messages)`);
      } else {
        console.log(`  Created server session: ${id}`);
      }

      const parseContext: ParseContext = {
        messages: [],
        pendingToolUses: new Map(),
      };

      // If resuming, start from end of file to only capture new messages
      // If new session, start from beginning to capture all messages
      const tail = new Tail(filePath, { startFromEnd: resumed });
      const session: ActiveSession = {
        adapter,
        localPath: filePath,
        projectPath: sessionInfo.projectPath,
        sessionId: id,
        streamToken: stream_token,
        tail,
        lastActivity: new Date(),
        parseContext,
        // If resumed, assume title was already derived from previous run
        titleDerived: resumed,
        lineQueue: [],
        isProcessing: false,
        diffDebounceTimer: null,
      };

      this.sessions.set(filePath, session);

      // Listen for lines using EventTarget API
      // Queue lines to prevent race conditions when multiple lines arrive at once
      tail.addEventListener("line", ((event: CustomEvent<string>) => {
        this.queueLine(session, event.detail);
      }) as EventListener);

      tail.addEventListener("error", ((event: CustomEvent<Error>) => {
        console.error(`  Error tailing ${filePath}:`, event.detail);
      }) as EventListener);

      tail.start();

      // Capture initial diff state (useful when picking up in-progress sessions)
      if (session.projectPath) {
        this.captureAndPushDiff(session).catch(() => {
          // Non-critical, continue
        });
      }
    } catch (err) {
      console.error(`  Failed to create session:`, err);
    }
  }

  private queueLine(session: ActiveSession, line: string): void {
    session.lineQueue.push(line);
    this.processQueue(session);
  }

  private async processQueue(session: ActiveSession): Promise<void> {
    // Prevent concurrent processing
    if (session.isProcessing) return;
    session.isProcessing = true;

    try {
      while (session.lineQueue.length > 0) {
        const line = session.lineQueue.shift()!;
        await this.handleLine(session, line);
      }
    } finally {
      session.isProcessing = false;
    }
  }

  private async handleLine(
    session: ActiveSession,
    line: string
  ): Promise<void> {
    session.lastActivity = new Date();

    // Debug: Log line receipt
    const preview = line.length > 100 ? line.slice(0, 100) + "..." : line;
    debug(`Line received (${line.length} chars): ${preview}`);

    const messages = session.adapter.parseLine(line, session.parseContext);

    // Debug: Log parse result
    debug(`Parsed ${messages?.length ?? 0} messages`);

    if (!messages || messages.length === 0) return;

    // Add to context
    session.parseContext.messages.push(...messages);

    // Push to server
    try {
      debug(`Pushing ${messages.length} messages to server...`);
      const result = await this.api.pushMessages(
        session.sessionId,
        session.streamToken,
        messages
      );
      debug(`Push result: appended=${result.appended}, total=${result.message_count}`);
    } catch (err) {
      console.error(`  Failed to push messages:`, err);
      // Messages will be lost if server is unreachable - retry logic is in ApiClient
    }

    // Derive title after first few messages
    if (!session.titleDerived && session.parseContext.messages.length >= 2) {
      const firstUserMessage = session.parseContext.messages.find(
        (m) => m.role === "user"
      );
      if (firstUserMessage && session.adapter.deriveTitle) {
        const title = session.adapter.deriveTitle(session.parseContext.messages);
        try {
          await this.api.updateTitle(
            session.sessionId,
            session.streamToken,
            title
          );
          session.titleDerived = true;
          console.log(`  Title: ${title}`);
        } catch {
          // Non-critical, continue
        }
      }
    }

    // Check for file-modifying tool calls and schedule diff capture
    this.checkForFileModifications(session, messages);
  }

  /**
   * Check if any messages contain file-modifying tool calls.
   * If so, schedule a debounced diff capture.
   */
  private checkForFileModifications(
    session: ActiveSession,
    messages: NormalizedMessage[]
  ): void {
    for (const msg of messages) {
      for (const block of msg.content_blocks) {
        if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          FILE_MODIFYING_TOOLS.includes(block.name)
        ) {
          debug(`File-modifying tool detected: ${block.name}`);
          this.scheduleDiffCapture(session);
          return; // Only need to schedule once per batch
        }
      }
    }
  }

  /**
   * Schedule a debounced diff capture.
   * Cancels any pending capture and schedules a new one.
   */
  private scheduleDiffCapture(session: ActiveSession): void {
    // Cancel any pending capture
    if (session.diffDebounceTimer) {
      clearTimeout(session.diffDebounceTimer);
    }

    // Schedule new capture
    session.diffDebounceTimer = setTimeout(async () => {
      session.diffDebounceTimer = null;
      await this.captureAndPushDiff(session);
    }, DIFF_DEBOUNCE_MS);
  }

  /**
   * Capture the current git diff and push it to the server.
   */
  private async captureAndPushDiff(session: ActiveSession): Promise<void> {
    if (!session.projectPath) {
      debug("No project path, skipping diff capture");
      return;
    }

    try {
      const diff = await captureGitDiff(session.projectPath);
      if (!diff) {
        debug("No diff to capture (not a git repo or no changes)");
        return;
      }

      debug(`Capturing diff (${diff.length} chars)`);
      const result = await this.api.pushDiff(
        session.sessionId,
        session.streamToken,
        diff
      );
      debug(`Diff pushed: ${result.diff_size} bytes`);
    } catch (err) {
      console.error(`  Failed to push diff:`, err);
    }
  }

  async endSession(filePath: string): Promise<void> {
    const session = this.sessions.get(filePath);
    if (!session) return;

    // Remove from map first to prevent double completion (race condition with idle check)
    this.sessions.delete(filePath);

    console.log(`[${session.adapter.name}] Session ending: ${filePath}`);

    // Cancel any pending diff capture
    if (session.diffDebounceTimer) {
      clearTimeout(session.diffDebounceTimer);
      session.diffDebounceTimer = null;
    }

    session.tail.stop();

    // Capture final diff
    let finalDiff: string | undefined;
    if (session.projectPath) {
      try {
        const diff = await captureGitDiff(session.projectPath);
        if (diff) {
          finalDiff = diff;
          debug(`Final diff captured (${diff.length} chars)`);
        }
      } catch (err) {
        debug(`Failed to capture final diff: ${err}`);
      }
    }

    try {
      await this.api.completeSession(session.sessionId, session.streamToken, {
        final_diff: finalDiff,
      });
      console.log(`  Completed: ${session.sessionId}`);
    } catch (err) {
      // 401/404 errors are expected if session was already completed or never created
      const errMsg = String(err);
      if (errMsg.includes("401") || errMsg.includes("404")) {
        console.log(`  Session already completed or not found: ${session.sessionId}`);
      } else {
        console.error(`  Failed to complete session:`, err);
      }
    }
  }

  startIdleCheck(): void {
    this.idleCheckInterval = setInterval(async () => {
      const now = Date.now();

      // Collect sessions to end first, then end them (avoid modifying map while iterating)
      const toEnd: string[] = [];
      for (const [filePath, session] of this.sessions) {
        const idleMs = now - session.lastActivity.getTime();
        if (idleMs > this.idleTimeoutMs) {
          console.log(
            `  Session idle for ${Math.round(idleMs / 1000)}s, completing...`
          );
          toEnd.push(filePath);
        }
      }

      for (const filePath of toEnd) {
        await this.endSession(filePath);
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

  getActiveSessions(): Array<{
    id: string;
    title: string;
    messageCount: number;
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.sessionId,
      title: s.titleDerived
        ? s.adapter.deriveTitle?.(s.parseContext.messages) || "Live Session"
        : "Live Session",
      messageCount: s.parseContext.messages.length,
    }));
  }
}
