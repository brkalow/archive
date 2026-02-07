/**
 * OpenCode Backend interface and Daemon implementation.
 *
 * The backend decouples the OpenCode API module from specific session management
 * implementations. The daemon implements it via SpawnedSessionManager; the server
 * can implement its own later.
 */

import { generateAscendingId } from "../../src/lib/opencode/id";
import type {
  OCSession,
  OCMessageWithParts,
  OCFileDiff,
  OCSessionStatus,
  OCEvent,
  OCPermissionRequest,
  OCQuestion,
} from "../../src/lib/opencode/types";
import type { SpawnedSessionManager } from "./spawned-session-manager";
import { OpenCodeTranslator, type PartUpdate } from "./opencode-translator";
import type {
  StreamJsonMessage,
  DaemonToServerMessage,
} from "../types/daemon-ws";
import { debug } from "./debug";

// ============================================
// Backend Interface
// ============================================

export interface InputPart {
  type: "text";
  text: string;
  id?: string;
}

export interface PermissionReply {
  reply: "once" | "always" | "reject";
  message?: string;
}

export interface SessionStatusInfo {
  status: OCSessionStatus;
  claudeSessionId?: string;
}

export interface OpenCodeBackend {
  listSessions(): Promise<OCSession[]>;
  getSession(id: string): Promise<OCSession | null>;
  createSession(opts: { title?: string }): Promise<OCSession>;
  deleteSession(id: string): Promise<boolean>;
  updateSession(
    id: string,
    patch: { title?: string }
  ): Promise<OCSession | null>;
  sendMessage(
    sessionId: string,
    parts: InputPart[],
    messageId?: string
  ): Promise<OCMessageWithParts | null>;
  abortSession(sessionId: string): Promise<boolean>;
  respondToPermission(
    requestId: string,
    reply: PermissionReply
  ): Promise<boolean>;
  replyToQuestion(
    requestId: string,
    answers: string[][]
  ): Promise<boolean>;
  rejectQuestion(requestId: string): Promise<boolean>;
  getMessages(sessionId: string): Promise<OCMessageWithParts[]>;
  getSessionDiffs(sessionId: string): Promise<OCFileDiff[]>;
  getSessionStatus(sessionId: string): SessionStatusInfo | null;
  getAllSessionStatuses(): Record<string, OCSessionStatus>;
  getPermissions(): OCPermissionRequest[];
  getQuestions(): OCQuestion[];
  getCwd(): string;
  getDirectory(req: Request): string;
}

// ============================================
// Daemon Backend
// ============================================

interface DaemonSessionState {
  session: OCSession;
  translator: OpenCodeTranslator;
  status: "waiting" | "starting" | "running" | "idle";
  claudeSessionId?: string;
  diffs: OCFileDiff[];
  pendingPermissions: Map<string, OCPermissionRequest>;
  pendingQuestions: Map<string, OCQuestion>;
}

export class DaemonBackend implements OpenCodeBackend {
  private sessionManager: SpawnedSessionManager;
  private sessions = new Map<string, DaemonSessionState>();
  private cwd: string;
  private broadcast: ((event: OCEvent) => void) | null = null;

  constructor(sessionManager: SpawnedSessionManager, cwd: string) {
    this.sessionManager = sessionManager;
    this.cwd = cwd;
  }

  /**
   * Set the broadcast function for pushing SSE events.
   * Called by the API module after construction.
   */
  setBroadcast(fn: (event: OCEvent) => void): void {
    this.broadcast = fn;
  }

  /**
   * Handle a DaemonToServerMessage from the SpawnedSessionManager.
   * This is the main entry point for translating daemon events into
   * OpenCode events and broadcasting them.
   */
  handleDaemonMessage(message: DaemonToServerMessage): void {
    switch (message.type) {
      case "session_output":
        this.handleSessionOutput(message.session_id, message.messages);
        break;
      case "session_ended":
        this.handleSessionEnded(
          message.session_id,
          message.reason,
          message.exit_code
        );
        break;
      case "session_diff":
        this.handleSessionDiff(
          message.session_id,
          message.diff,
          message.modified_files
        );
        break;
      case "session_metadata":
        this.handleSessionMetadata(
          message.session_id,
          message.agent_session_id
        );
        break;
      case "permission_prompt":
        this.handlePermissionPrompt(message);
        break;
      case "control_request":
        this.handleControlRequest(message);
        break;
      case "question_prompt":
        this.handleQuestionPrompt(message);
        break;
    }
  }

  // ============================================
  // Backend Interface Implementation
  // ============================================

  async listSessions(): Promise<OCSession[]> {
    return Array.from(this.sessions.values()).map((s) => s.session);
  }

  async getSession(id: string): Promise<OCSession | null> {
    return this.sessions.get(id)?.session || null;
  }

  async createSession(opts: { title?: string }): Promise<OCSession> {
    const id = generateAscendingId("ses");
    const now = Date.now();

    const session: OCSession = {
      id,
      slug: id,
      projectID: this.getProjectId(),
      directory: this.cwd,
      title: opts.title || "New Session",
      version: "1.0.0",
      time: { created: now, updated: now },
    };

    const translator = new OpenCodeTranslator(id, this.cwd);

    this.sessions.set(id, {
      session,
      translator,
      status: "waiting",
      diffs: [],
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
    });

    this.emit({ type: "session.created", properties: { info: session } });

    return session;
  }

  async deleteSession(id: string): Promise<boolean> {
    const state = this.sessions.get(id);
    if (!state) return false;

    // End the session if it's running
    if (state.status === "running" || state.status === "starting") {
      await this.sessionManager.endSession(id);
    }

    this.sessions.delete(id);
    this.emit({
      type: "session.deleted",
      properties: { info: state.session },
    });
    return true;
  }

  async updateSession(
    id: string,
    patch: { title?: string }
  ): Promise<OCSession | null> {
    const state = this.sessions.get(id);
    if (!state) return null;

    if (patch.title !== undefined) {
      state.session.title = patch.title;
    }
    state.session.time.updated = Date.now();

    this.emit({
      type: "session.updated",
      properties: { info: state.session },
    });
    return state.session;
  }

  async sendMessage(
    sessionId: string,
    parts: InputPart[],
    messageId?: string
  ): Promise<OCMessageWithParts | null> {
    const state = this.sessions.get(sessionId);
    if (!state) return null;

    // Extract prompt text from parts
    const promptText = parts.map((p) => p.text).join("\n");
    if (!promptText) return null;

    // Create user message
    const userMsg = state.translator.createUserMessage(
      promptText,
      messageId,
      parts[0]?.id
    );

    // Broadcast user message
    this.emit({
      type: "message.updated",
      properties: { info: userMsg.info },
    });
    for (const pu of userMsg.updatedParts) {
      this.emit({
        type: "message.part.updated",
        properties: { part: pu.part, delta: pu.delta },
      });
    }

    // Broadcast session.updated and session.diff
    state.session.time.updated = Date.now();
    this.emit({
      type: "session.updated",
      properties: { info: state.session },
    });
    this.emit({
      type: "session.diff",
      properties: { sessionID: sessionId, diff: state.diffs },
    });

    // Create pending assistant message
    const pending = state.translator.createPendingAssistant(userMsg.info.id);

    // Broadcast pending assistant
    this.emit({
      type: "message.updated",
      properties: { info: pending.info },
    });

    // Broadcast step-start part (required for TUI to transition out of "queued" state)
    const stepStart = state.translator.createStepStartForPending();
    if (stepStart) {
      this.emit({
        type: "message.part.updated",
        properties: { part: stepStart },
      });
    }

    // Determine how to send the message to Claude.
    // Key: check if a spawned process is still alive (the "waiting" status is
    // overloaded — it means both "never started" and "turn completed, process
    // still alive"). Check the SpawnedSessionManager to disambiguate.
    const spawnedSession = this.sessionManager.getSession(sessionId);
    const hasActiveProcess =
      spawnedSession != null &&
      spawnedSession.state !== "ended" &&
      spawnedSession.state !== "ending";

    if (hasActiveProcess) {
      // Process is still running — send input directly via stdin
      debug(`[opencode-backend] sendMessage: using sendInput (process alive, state=${spawnedSession!.state})`);
      state.status = "running";
      this.emit({
        type: "session.status",
        properties: { sessionID: sessionId, status: { type: "busy" } },
      });
      this.sessionManager.sendInput(sessionId, promptText);
    } else if (state.status === "idle" && state.claudeSessionId) {
      // Process exited but session can be resumed
      debug(`[opencode-backend] sendMessage: resuming session (claudeSessionId=${state.claudeSessionId})`);
      state.status = "starting";
      this.emit({
        type: "session.status",
        properties: { sessionID: sessionId, status: { type: "busy" } },
      });

      this.sessionManager
        .startSession({
          type: "start_session",
          session_id: sessionId,
          prompt: promptText,
          cwd: this.cwd,
          resume_session_id: state.claudeSessionId,
        })
        .catch((err) => {
          debug(`[opencode-backend] Failed to resume session: ${err}`);
        });
    } else {
      // No active process — start a new one
      debug(`[opencode-backend] sendMessage: starting new session (status=${state.status})`);
      state.status = "starting";
      this.emit({
        type: "session.status",
        properties: { sessionID: sessionId, status: { type: "busy" } },
      });

      this.sessionManager
        .startSession({
          type: "start_session",
          session_id: sessionId,
          prompt: promptText,
          cwd: this.cwd,
          permission_mode: "relay",
        })
        .catch((err) => {
          debug(`[opencode-backend] Failed to start session: ${err}`);
        });
    }

    return pending;
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const state = this.sessions.get(sessionId);
    if (!state) return false;

    await this.sessionManager.interruptSession(sessionId);
    return true;
  }

  async respondToPermission(
    requestId: string,
    reply: PermissionReply
  ): Promise<boolean> {
    // Search all sessions for the permission request
    for (const [sessionId, state] of this.sessions) {
      if (state.pendingPermissions.has(requestId)) {
        state.pendingPermissions.delete(requestId);

        const allow = reply.reply !== "reject";
        debug(`[opencode-backend] respondToPermission: requestId=${requestId} sessionId=${sessionId} allow=${allow}`);

        // Check if it's a control request or legacy permission
        const spawnedSession = this.sessionManager.getSession(sessionId);
        if (spawnedSession?.controlRequests.has(requestId)) {
          // SDK control_request format — PermissionResult requires message for deny
          const result = allow
            ? { behavior: "allow" as const }
            : { behavior: "deny" as const, message: reply.message || "Denied by user" };
          debug(`[opencode-backend] Sending control response: ${JSON.stringify(result)}`);
          this.sessionManager.respondToControlRequest(sessionId, requestId, result as any);
        } else {
          // Legacy permission_prompt format
          debug(`[opencode-backend] Sending legacy permission response: allow=${allow}`);
          this.sessionManager.respondToPermission(
            sessionId,
            requestId,
            allow
          );
        }

        this.emit({
          type: "permission.replied",
          properties: { sessionID: sessionId, requestID: requestId },
        });
        return true;
      }
    }
    debug(`[opencode-backend] respondToPermission: request ${requestId} not found in any session`);
    return false;
  }

  async replyToQuestion(
    requestId: string,
    answers: string[][]
  ): Promise<boolean> {
    for (const [sessionId, state] of this.sessions) {
      if (state.pendingQuestions.has(requestId)) {
        state.pendingQuestions.delete(requestId);

        // Flatten answers and inject as tool result
        const answerText = answers
          .map((a) => a.join(", "))
          .join("\n");
        this.sessionManager.injectToolResult(sessionId, requestId, answerText);

        this.emit({
          type: "question.replied",
          properties: { sessionID: sessionId, requestID: requestId },
        });
        return true;
      }
    }
    return false;
  }

  async rejectQuestion(requestId: string): Promise<boolean> {
    for (const [sessionId, state] of this.sessions) {
      if (state.pendingQuestions.has(requestId)) {
        state.pendingQuestions.delete(requestId);

        // Inject rejection as tool result
        this.sessionManager.injectToolResult(
          sessionId,
          requestId,
          "Question rejected by user"
        );

        this.emit({
          type: "question.rejected",
          properties: { sessionID: sessionId, requestID: requestId },
        });
        return true;
      }
    }
    return false;
  }

  async getMessages(sessionId: string): Promise<OCMessageWithParts[]> {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    return state.translator.getMessages();
  }

  async getSessionDiffs(sessionId: string): Promise<OCFileDiff[]> {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    return state.diffs;
  }

  getSessionStatus(sessionId: string): SessionStatusInfo | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;

    const ocStatus: OCSessionStatus =
      state.status === "idle" || state.status === "waiting"
        ? { type: "idle" }
        : { type: "busy" };

    return {
      status: ocStatus,
      claudeSessionId: state.claudeSessionId,
    };
  }

  getAllSessionStatuses(): Record<string, OCSessionStatus> {
    const result: Record<string, OCSessionStatus> = {};
    for (const [id, state] of this.sessions) {
      result[id] =
        state.status === "idle" || state.status === "waiting"
          ? { type: "idle" }
          : { type: "busy" };
    }
    return result;
  }

  getPermissions(): OCPermissionRequest[] {
    const result: OCPermissionRequest[] = [];
    for (const state of this.sessions.values()) {
      result.push(...state.pendingPermissions.values());
    }
    return result;
  }

  getQuestions(): OCQuestion[] {
    const result: OCQuestion[] = [];
    for (const state of this.sessions.values()) {
      result.push(...state.pendingQuestions.values());
    }
    return result;
  }

  getCwd(): string {
    return this.cwd;
  }

  getDirectory(_req: Request): string {
    return this.cwd;
  }

  // ============================================
  // Event handlers
  // ============================================

  private handleSessionOutput(
    sessionId: string,
    messages: StreamJsonMessage[]
  ): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    // Update status
    if (state.status === "starting") {
      state.status = "running";
    }

    const result = state.translator.processStreamMessages(messages);

    // Broadcast updated messages
    for (const msg of result.updatedMessages) {
      this.emit({ type: "message.updated", properties: { info: msg } });
    }

    // Broadcast updated parts (NOT step parts — those go separately)
    for (const pu of result.updatedParts) {
      this.emit({
        type: "message.part.updated",
        properties: { part: pu.part, delta: pu.delta },
      });
    }

    // Broadcast step parts separately
    for (const stepPart of result.stepParts) {
      this.emit({
        type: "message.part.updated",
        properties: { part: stepPart },
      });
    }

    // Handle turn completion
    if (result.turnCompleted) {
      const completion = state.translator.completeLastAssistant();

      // Broadcast text parts with time.end
      for (const pu of completion.updatedParts) {
        this.emit({
          type: "message.part.updated",
          properties: { part: pu.part },
        });
      }

      // Broadcast completed assistant message
      if (completion.message) {
        this.emit({
          type: "message.updated",
          properties: { info: completion.message },
        });
      }

      // Don't set idle here — wait for session_ended
      // The session is "waiting" (Claude is still running, waiting for next turn)
      state.status = "waiting" as DaemonSessionState["status"];

      // Broadcast status
      this.emit({
        type: "session.status",
        properties: { sessionID: sessionId, status: { type: "idle" } },
      });

      // Session updated
      state.session.time.updated = Date.now();
      this.emit({
        type: "session.updated",
        properties: { info: state.session },
      });

      // Session diff
      this.emit({
        type: "session.diff",
        properties: { sessionID: sessionId, diff: state.diffs },
      });
    }
  }

  private handleSessionEnded(
    sessionId: string,
    reason?: string,
    _exitCode?: number
  ): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    // Determine if session can idle (for resume) vs truly ended
    const canIdle = (reason === "completed" || !reason) && !!state.claudeSessionId;

    if (canIdle) {
      state.status = "idle";
    } else {
      state.status = "waiting";
    }

    // Complete the assistant if there's a pending one
    const completion = state.translator.completeLastAssistant();
    if (completion.message) {
      this.emit({
        type: "message.updated",
        properties: { info: completion.message },
      });
    }

    // Broadcast idle status
    this.emit({
      type: "session.status",
      properties: { sessionID: sessionId, status: { type: "idle" } },
    });

    // Session updated
    state.session.time.updated = Date.now();
    this.emit({
      type: "session.updated",
      properties: { info: state.session },
    });

    // Reset translator for potential resume
    state.translator.resetForNewTurn();
  }

  private handleSessionDiff(
    sessionId: string,
    rawDiff: string,
    _modifiedFiles: string[]
  ): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    // Parse the raw diff into FileDiff entries
    const diffs = this.parseRawDiff(rawDiff);
    state.diffs = diffs;

    // Update session summary
    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const d of diffs) {
      totalAdditions += d.additions;
      totalDeletions += d.deletions;
    }
    state.session.summary = {
      additions: totalAdditions,
      deletions: totalDeletions,
      files: diffs.length,
    };

    this.emit({
      type: "session.diff",
      properties: { sessionID: sessionId, diff: diffs },
    });

    state.session.time.updated = Date.now();
    this.emit({
      type: "session.updated",
      properties: { info: state.session },
    });
  }

  private handleSessionMetadata(
    sessionId: string,
    agentSessionId?: string
  ): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    if (agentSessionId) {
      state.claudeSessionId = agentSessionId;
      state.status = "running";
    }
  }

  private handlePermissionPrompt(message: DaemonToServerMessage & { type: "permission_prompt" }): void {
    const state = this.sessions.get(message.session_id);
    if (!state) return;

    const permission: OCPermissionRequest = {
      id: message.request_id,
      sessionID: message.session_id,
      permission: message.tool,
      patterns: [],
      metadata: message.details || {},
      always: false,
    };

    state.pendingPermissions.set(message.request_id, permission);

    this.emit({
      type: "permission.asked",
      properties: {
        id: message.request_id,
        sessionID: message.session_id,
        permission: message.tool,
        patterns: [],
        metadata: message.details || {},
        always: false,
      },
    });
  }

  private handleControlRequest(message: DaemonToServerMessage & { type: "control_request" }): void {
    const state = this.sessions.get(message.session_id);
    if (!state) return;

    const permission: OCPermissionRequest = {
      id: message.request_id,
      sessionID: message.session_id,
      permission: message.request.tool_name,
      patterns: [],
      metadata: {
        input: message.request.input,
        tool_use_id: message.request.tool_use_id,
        blocked_path: message.request.blocked_path,
        decision_reason: message.request.decision_reason,
      },
      always: false,
    };

    state.pendingPermissions.set(message.request_id, permission);

    this.emit({
      type: "permission.asked",
      properties: {
        id: message.request_id,
        sessionID: message.session_id,
        permission: message.request.tool_name,
        patterns: [],
        metadata: {
          input: message.request.input,
          tool_use_id: message.request.tool_use_id,
          blocked_path: message.request.blocked_path,
          decision_reason: message.request.decision_reason,
        },
        always: false,
      },
    });
  }

  private handleQuestionPrompt(message: DaemonToServerMessage & { type: "question_prompt" }): void {
    const state = this.sessions.get(message.session_id);
    if (!state) return;

    const question: OCQuestion = {
      id: message.tool_use_id,
      sessionID: message.session_id,
      questions: [
        {
          question: message.question,
          options: message.options,
          custom: true,
        },
      ],
    };

    state.pendingQuestions.set(message.tool_use_id, question);

    this.emit({
      type: "question.asked",
      properties: {
        id: message.tool_use_id,
        sessionID: message.session_id,
        questions: question.questions,
      },
    });
  }

  // ============================================
  // Helpers
  // ============================================

  private emit(event: OCEvent): void {
    this.broadcast?.(event);
  }

  private getProjectId(): string {
    // Derive project ID from directory path (matching OpenCode convention)
    return this.cwd.replace(/\//g, "-").replace(/^-/, "");
  }

  /**
   * Parse raw git diff string into FileDiff entries.
   */
  private parseRawDiff(rawDiff: string): OCFileDiff[] {
    if (!rawDiff.trim()) return [];

    const diffs: OCFileDiff[] = [];
    const fileParts = rawDiff.split(/^diff --git /m).filter(Boolean);

    for (const part of fileParts) {
      const headerMatch = part.match(/^a\/(.+?) b\/(.+)/m);
      if (!headerMatch) continue;

      const file = headerMatch[2];
      let additions = 0;
      let deletions = 0;

      const lines = part.split("\n");
      for (const line of lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      }

      let status: "added" | "deleted" | "modified" | undefined;
      if (deletions === 0 && additions > 0) status = "added";
      else if (additions === 0 && deletions > 0) status = "deleted";
      else status = "modified";

      diffs.push({
        file,
        before: "",
        after: `diff --git ${part}`,
        additions,
        deletions,
        status,
      });
    }

    return diffs;
  }
}
