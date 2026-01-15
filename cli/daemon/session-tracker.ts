/**
 * Session Tracker - Manages active sessions being streamed to the server.
 *
 * Handles:
 * - Starting/stopping file tailing for sessions
 * - Parsing incoming lines via adapters
 * - Pushing messages to the server
 * - Title derivation from first user message
 */

import type {
  HarnessAdapter,
  ParseContext,
  NormalizedMessage,
  ContentBlock,
} from "../adapters/types";
import { isRepoAllowed } from "../lib/config";
import { debug } from "../lib/debug";
import { captureGitDiff, getRepoIdentifier, getRepoHttpsUrl } from "../lib/git";
import { Tail } from "../lib/tail";
import { ApiClient } from "./api-client";

/** Debounce delay for diff capture (ms) */
const DIFF_DEBOUNCE_MS = 2000;

/** Tool names that modify files and should trigger diff capture */
const FILE_MODIFYING_TOOLS = ["Write", "Edit", "NotebookEdit"];

/** Pattern to detect the collaborate command in messages */
const COLLABORATE_COMMAND_PATTERN = /\/(?:openctl:)?collaborate/i;

/** Maximum messages to keep in memory after title derivation (to prevent unbounded growth) */
const MAX_RETAINED_MESSAGES = 10;

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
  // Count of messages pushed to server (for detecting empty sessions)
  messagesPushed: number;
  // Files explicitly modified by this session (for filtering untracked files in diff)
  modifiedFiles: Set<string>;
  // Whether collaboration mode has been enabled for this session
  collaborationEnabled: boolean;
  // Whether initial file read is complete (only detect commands after this)
  liveMode: boolean;
}

/**
 * Result of attempting to start a session.
 * - 'started': Session was created and is being tracked
 * - 'already_tracking': Session was already being tracked
 * - 'retry_later': File is empty/invalid, should retry on future changes
 * - 'skip': Permanently skip (e.g., repo not in allowlist)
 */
export type StartSessionResult = 'started' | 'already_tracking' | 'retry_later' | 'skip';

export class SessionTracker {
  private sessions = new Map<string, ActiveSession>();
  private api: ApiClient;
  private serverUrl: string;
  private idleTimeoutMs: number;
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(serverUrl: string, idleTimeoutSeconds: number) {
    this.api = new ApiClient(serverUrl);
    this.serverUrl = serverUrl;
    this.idleTimeoutMs = idleTimeoutSeconds * 1000;
  }

  /**
   * Check if a session file has any parseable content.
   * Returns false for empty files or files with no valid JSON lines.
   */
  private async sessionFileHasContent(filePath: string): Promise<boolean> {
    try {
      const content = await Bun.file(filePath).text();
      if (!content.trim()) {
        return false;
      }

      // Check if there's at least one valid JSON line
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed);
          // Check if it looks like a message (has role or message.role)
          if (parsed && typeof parsed === "object") {
            const data = parsed as Record<string, unknown>;
            const messageData = data.message ?? data;
            if (
              messageData &&
              typeof messageData === "object" &&
              "role" in (messageData as object)
            ) {
              return true;
            }
          }
        } catch {
          // Invalid JSON line, continue checking
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  async startSession(filePath: string, adapter: HarnessAdapter): Promise<StartSessionResult> {
    if (this.sessions.has(filePath)) {
      return 'already_tracking';
    }

    const sessionInfo = adapter.getSessionInfo(filePath);

    // Check if repository is in allowlist for automatic uploads
    const repoId = await getRepoIdentifier(sessionInfo.projectPath);
    if (!repoId || !isRepoAllowed(this.serverUrl, repoId)) {
      console.log(`Session skipped: Repository not in allowlist`);
      console.log(`  Path: ${sessionInfo.projectPath}`);
      console.log(`  Repo: ${repoId || "(not a git repo)"}`);
      console.log();
      console.log(`To allow this repository, run:`);
      console.log(`  archive repo allow ${sessionInfo.projectPath}`);
      console.log();
      return 'skip';
    }

    // Check if the session file has any parseable content
    // Skip empty files to avoid creating empty server sessions
    if (!(await this.sessionFileHasContent(filePath))) {
      debug(`Skipping empty session file: ${filePath}`);
      return 'retry_later';
    }

    console.log(`[${adapter.name}] Session detected: ${filePath}`);

    // Get the repo HTTPS URL for display in the UI
    const repoUrl = await getRepoHttpsUrl(sessionInfo.projectPath);

    try {
      const { id, stream_token, resumed, restored, message_count } = await this.api.createLiveSession({
        title: "Live Session",
        project_path: sessionInfo.projectPath,
        harness_session_id: sessionInfo.harnessSessionId,
        harness: adapter.id,
        model: sessionInfo.model,
        repo_url: repoUrl,
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
        messagesPushed: 0,
        modifiedFiles: new Set(),
        collaborationEnabled: false,
        liveMode: false,
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

      // Enable live mode after initial file read completes
      // This ensures we only detect collaborate commands on NEW messages, not historical ones
      setTimeout(() => {
        session.liveMode = true;
        debug(`Session ${session.sessionId} now in live mode`);
      }, 2000);

      // Capture initial diff state (useful when picking up in-progress sessions)
      if (session.projectPath) {
        // First, scan existing session content for files already modified
        // (handles case where we pick up a session mid-way)
        await this.scanExistingSessionForModifiedFiles(session);

        this.captureAndPushDiff(session).catch(() => {
          // Non-critical, continue
        });
      }

      return 'started';
    } catch (err) {
      console.error(`  Failed to create session:`, err);
      return 'retry_later'; // Server error, may succeed later
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
      session.messagesPushed += result.appended;
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

    // Cap message retention to prevent unbounded memory growth
    // Once title is derived, we only need recent messages for tool_use pairing
    if (session.titleDerived && session.parseContext.messages.length > MAX_RETAINED_MESSAGES) {
      session.parseContext.messages = session.parseContext.messages.slice(-MAX_RETAINED_MESSAGES);
    }

    // Check for file-modifying tool calls and schedule diff capture
    this.checkForFileModifications(session, messages);

    // Check for collaborate command and enable collaboration mode
    this.checkForCollaborateCommand(session, messages);
  }

  /**
   * Check if any messages contain file-modifying tool calls.
   * If so, track the modified file and schedule a debounced diff capture.
   */
  private checkForFileModifications(
    session: ActiveSession,
    messages: NormalizedMessage[]
  ): void {
    let shouldCaptureDiff = false;

    for (const msg of messages) {
      for (const block of msg.content_blocks) {
        if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          FILE_MODIFYING_TOOLS.includes(block.name)
        ) {
          debug(`File-modifying tool detected: ${block.name}`);
          shouldCaptureDiff = true;

          // Extract file path from tool input
          const filePath = this.extractFilePathFromToolUse(block);
          if (filePath) {
            session.modifiedFiles.add(filePath);
            debug(`Tracked modified file: ${filePath}`);
          }
        }
      }
    }

    if (shouldCaptureDiff) {
      this.scheduleDiffCapture(session);
    }
  }

  /**
   * Check if any messages contain the collaborate command.
   * If so, mark the session as interactive on the server.
   * Only runs in live mode (after initial file read) to avoid retroactive detection.
   */
  private checkForCollaborateCommand(
    session: ActiveSession,
    messages: NormalizedMessage[]
  ): void {
    // Skip if not in live mode (still processing historical messages)
    if (!session.liveMode) return;

    // Skip if collaboration already enabled
    if (session.collaborationEnabled) return;

    for (const msg of messages) {
      for (const block of msg.content_blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          if (COLLABORATE_COMMAND_PATTERN.test(block.text)) {
            debug(`Collaborate command detected in message`);
            this.enableCollaboration(session);
            return;
          }
        }
      }
    }
  }

  /**
   * Enable collaboration mode for a session by marking it interactive on the server.
   */
  private async enableCollaboration(session: ActiveSession): Promise<void> {
    if (session.collaborationEnabled) return;

    try {
      await this.api.markInteractive(session.sessionId, session.streamToken);
      session.collaborationEnabled = true;
      console.log(`  Collaboration enabled for session: ${session.sessionId}`);
    } catch (err) {
      console.error(`  Failed to enable collaboration:`, err);
    }
  }

  /**
   * Extract file path from a file-modifying tool_use block.
   */
  private extractFilePathFromToolUse(block: ContentBlock): string | null {
    const input = block.input as Record<string, unknown> | undefined;
    if (!input || typeof input !== "object") {
      return null;
    }

    // Write and Edit use file_path
    if (typeof input.file_path === "string") {
      return input.file_path;
    }

    // NotebookEdit uses notebook_path
    if (typeof input.notebook_path === "string") {
      return input.notebook_path;
    }

    return null;
  }

  /**
   * Scan existing session file content for file-modifying tool calls.
   * This is used when picking up a session mid-way to capture files
   * that were already modified before we started watching.
   */
  private async scanExistingSessionForModifiedFiles(
    session: ActiveSession
  ): Promise<void> {
    try {
      const content = await Bun.file(session.localPath).text();
      const lines = content.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (!parsed || typeof parsed !== "object") continue;

        const data = parsed as Record<string, unknown>;
        const messageData = data.message
          ? (data.message as Record<string, unknown>)
          : data;

        // Look for content blocks with file-modifying tool calls
        const rawContent = messageData.content;
        if (!Array.isArray(rawContent)) continue;

        for (const block of rawContent) {
          if (
            block &&
            typeof block === "object" &&
            block.type === "tool_use" &&
            typeof block.name === "string" &&
            FILE_MODIFYING_TOOLS.includes(block.name)
          ) {
            const filePath = this.extractFilePathFromToolUse(
              block as ContentBlock
            );
            if (filePath) {
              session.modifiedFiles.add(filePath);
            }
          }
        }
      }

      if (session.modifiedFiles.size > 0) {
        debug(
          `Scanned existing session: found ${session.modifiedFiles.size} modified files`
        );
      }
    } catch (err) {
      debug(`Failed to scan existing session file: ${err}`);
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
   * Only includes untracked files that the session has explicitly modified.
   */
  private async captureAndPushDiff(session: ActiveSession): Promise<void> {
    if (!session.projectPath) {
      debug("No project path, skipping diff capture");
      return;
    }

    try {
      const diff = await captureGitDiff(session.projectPath, {
        allowedUntrackedFiles: session.modifiedFiles,
      });
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

    // Disable collaboration mode if it was enabled
    if (session.collaborationEnabled) {
      try {
        await this.api.disableInteractive(session.sessionId, session.streamToken);
        console.log(`  Collaboration disabled for session: ${session.sessionId}`);
      } catch (err) {
        // Non-critical, continue with session cleanup
        debug(`Failed to disable collaboration: ${err}`);
      }
    }

    // If no messages were pushed, delete the empty session instead of completing it
    if (session.messagesPushed === 0) {
      console.log(`  No messages captured, deleting empty session: ${session.sessionId}`);
      try {
        await this.api.deleteSession(session.sessionId, session.streamToken);
        console.log(`  Deleted: ${session.sessionId}`);
      } catch (err) {
        // Non-critical - empty session will just remain on server
        debug(`Failed to delete empty session: ${err}`);
      }
      return;
    }

    // Capture final diff (only tracked files + untracked files modified by session)
    let finalDiff: string | undefined;
    if (session.projectPath) {
      try {
        const diff = await captureGitDiff(session.projectPath, {
          allowedUntrackedFiles: session.modifiedFiles,
        });
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
    // No-op: sessions are no longer auto-completed on idle.
    // Sessions remain live until explicitly ended (e.g., daemon shutdown, file deletion).
    // The list view shows "LIVE" based on recent activity (last_activity_at).
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
