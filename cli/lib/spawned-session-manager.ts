/**
 * Spawned Session Manager
 *
 * Manages Claude Code sessions spawned by the daemon in response to
 * browser-initiated requests. Handles:
 * - Spawning Claude Code in stream-json mode
 * - Streaming output to the server
 * - Sending user input via stdin
 * - Detecting AskUserQuestion tool calls
 * - Session lifecycle management
 * - Diff capture and reporting
 */

import { existsSync, statSync } from "fs";
import type {
  StartSessionMessage,
  StreamJsonMessage,
  DaemonToServerMessage,
  ContentBlock,
  PermissionResult,
} from "../types/daemon-ws";
import { notifySessionStarted } from "./notifications";
import { captureGitDiff } from "./git";

/** Debounce delay for diff capture (ms) */
const DIFF_DEBOUNCE_MS = 2000;

/** Tool names that modify files and should trigger diff capture */
const FILE_MODIFYING_TOOLS = ["Write", "Edit", "NotebookEdit"];

/**
 * Git subcommands that can modify working tree state and should trigger diff capture.
 * These commands may revert, reset, or change files in ways that affect the diff.
 */
const GIT_MODIFYING_SUBCOMMANDS = [
  "checkout",
  "reset",
  "restore",
  "stash",
  "clean",
  "revert",
  "merge",
  "rebase",
  "pull",
  "cherry-pick",
  "am",
  "apply",
];

/**
 * Permission request extracted from Claude's output when using --permission-prompt-tool stdio
 */
interface PermissionRequest {
  id: string;
  tool: string;
  description: string;
  command?: string;
  file_path?: string;
  content?: string;
}

/**
 * Control request from Claude Code SDK format (control_request message type)
 */
interface ControlRequest {
  request_id: string;
  tool_name: string;
  tool_use_id: string;
  input: Record<string, unknown>;
  permission_suggestions?: unknown[];
  blocked_path?: string;
  decision_reason?: string;
  agent_id?: string;
}

// FileSink type from Bun - stdin when using "pipe"
interface FileSink {
  write(data: string | ArrayBuffer | ArrayBufferView): number;
  flush(): void;
  end(): void;
}

interface SpawnedSession {
  id: string; // Server-assigned session ID
  claudeSessionId?: string; // Claude's internal session ID (from init message)
  proc: ReturnType<typeof Bun.spawn>;
  cwd: string;
  startedAt: Date;
  state: "starting" | "running" | "waiting" | "ending" | "ended";
  stdin: FileSink | null; // Direct FileSink reference for writing
  pendingToolUseId?: string; // For AskUserQuestion relay
  pendingPermissionId?: string; // For permission relay
  permissionRequests: Map<string, PermissionRequest>; // Track permission requests by ID
  controlRequests: Map<string, ControlRequest>; // Track SDK control requests by request_id
  outputBuffer: string; // Buffer for incomplete NDJSON lines
  outputHistory: StreamJsonMessage[]; // All messages for replay
  maxHistorySize: number;
  // Files explicitly modified by this session (for filtering untracked files in diff)
  modifiedFiles: Set<string>;
  // Timer for debounced diff capture
  diffDebounceTimer: ReturnType<typeof setTimeout> | null;
}

interface SessionInfo {
  id: string;
  claudeSessionId?: string;
  cwd: string;
  startedAt: Date;
  state: SpawnedSession["state"];
  durationSeconds: number;
}

type SendToServer = (message: DaemonToServerMessage) => void;

export class SpawnedSessionManager {
  private sessions = new Map<string, SpawnedSession>();
  private sendToServer: SendToServer;

  constructor(sendToServer: SendToServer) {
    this.sendToServer = sendToServer;
  }

  async startSession(request: StartSessionMessage): Promise<void> {
    console.log(`[spawner] startSession called for ${request.session_id}`);

    // Expand ~ in working directory path
    const cwd = this.expandPath(request.cwd);

    // Validate working directory
    if (!this.validateWorkingDirectory(cwd)) {
      console.error(`[spawner] Invalid working directory: ${request.cwd} (expanded: ${cwd})`);
      this.sendToServer({
        type: "session_ended",
        session_id: request.session_id,
        exit_code: 1,
        error: `Invalid working directory: ${request.cwd}`,
        reason: "error",
      });
      return;
    }

    // Build command arguments
    const args = this.buildClaudeArgs(request);

    console.log(
      `[spawner] Starting session ${request.session_id} in ${cwd}`
    );
    console.log(`[spawner] Command: claude ${args.join(" ")}`);

    // Check if claude command exists
    const whichResult = Bun.spawnSync(["which", "claude"]);
    if (whichResult.exitCode !== 0) {
      const error = "Claude CLI not found. Please install it with: npm install -g @anthropic-ai/claude-code";
      console.error(`[spawner] ${error}`);
      this.sendToServer({
        type: "session_ended",
        session_id: request.session_id,
        exit_code: 1,
        reason: "error",
        error,
      });
      return;
    }
    const claudePath = whichResult.stdout.toString().trim();
    console.log(`[spawner] Using claude at: ${claudePath}`);

    try {
      const proc = Bun.spawn(["claude", ...args], {
        cwd,
        env: { ...process.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      // Wait briefly for process to start and check if it's still running
      await new Promise((resolve) => setTimeout(resolve, 100));

      if (proc.exitCode !== null) {
        // Process already exited - likely an error
        const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
        throw new Error(`Claude process exited immediately (code ${proc.exitCode}): ${stderr}`);
      }

      // Verify stdin is available (FileSink from Bun.spawn with stdin: "pipe")
      if (!proc.stdin) {
        throw new Error("Failed to get stdin - process may have failed to start");
      }

      // Check if it's a FileSink (has write method) or WritableStream (has getWriter)
      const stdin = proc.stdin as unknown as FileSink;
      if (typeof stdin.write !== "function") {
        throw new Error(
          `stdin doesn't have write method (type: ${typeof proc.stdin}). Bun version incompatibility?`
        );
      }

      const session: SpawnedSession = {
        id: request.session_id,
        proc,
        cwd,
        startedAt: new Date(),
        state: "starting",
        stdin, // Store FileSink directly
        permissionRequests: new Map(),
        controlRequests: new Map(),
        outputBuffer: "",
        outputHistory: [],
        maxHistorySize: 1000,
        modifiedFiles: new Set(),
        diffDebounceTimer: null,
      };

      this.sessions.set(request.session_id, session);

      console.log(`[spawner] Session ${request.session_id} process started, pid: ${proc.pid}`);

      // Stream stdout
      if (proc.stdout) {
        console.log(`[spawner] Starting stdout stream for session ${request.session_id}`);
        this.streamOutput(session, proc.stdout);
      } else {
        console.error(`[spawner] No stdout available for session ${request.session_id}`);
      }

      // Log stderr (for debugging)
      if (proc.stderr) {
        this.streamStderr(session, proc.stderr);
      }

      // Handle process exit
      proc.exited.then((exitCode) => {
        console.log(`[spawner] Process exited for session ${request.session_id}, code: ${exitCode}`);
        this.onSessionEnded(session, exitCode);
      });

      // Send the initial prompt via stdin (required for --input-format stream-json)
      // Format matches Claude's stream-json input: {"type": "user", "message": {"role": "user", "content": "..."}}
      console.log(`[spawner] Sending initial prompt to stdin for session ${request.session_id}`);
      const initialMessage = JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: request.prompt,
        },
      });
      stdin.write(initialMessage + "\n");
      stdin.flush();
      console.log(`[spawner] Initial prompt sent to session ${request.session_id}`);

      // Echo the initial prompt to the server so it appears in the UI
      const userMessage: StreamJsonMessage = {
        type: "user",
        message: {
          id: `user-${Date.now()}`,
          role: "user",
          content: [{ type: "text", text: request.prompt }],
        },
      };
      this.recordMessage(session, userMessage);
      this.sendToServer({
        type: "session_output",
        session_id: request.session_id,
        messages: [userMessage],
      });

      // Show desktop notification
      notifySessionStarted({
        title: "Remote Session Started",
        message: "Claude session started",
        sessionId: request.session_id,
        cwd,
        prompt: request.prompt,
      });
    } catch (error) {
      console.error(`[spawner] Failed to start session:`, error);
      this.sendToServer({
        type: "session_ended",
        session_id: request.session_id,
        exit_code: 1,
        error: error instanceof Error ? error.message : String(error),
        reason: "error",
      });
    }
  }

  private buildClaudeArgs(request: StartSessionMessage): string[] {
    // Note: We don't use -p with --input-format stream-json
    // Instead, the prompt is sent via stdin as a JSON message
    const args = [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
    ];

    if (request.model) {
      args.push("--model", request.model);
    }

    if (request.resume_session_id) {
      args.push("--resume", request.resume_session_id);
    }

    // Permission handling
    if (request.permission_mode === "relay" || request.permission_mode === "auto-safe") {
      // Both "relay" and "auto-safe" use the stdio permission tool
      // The difference is handled in the permission response logic
      args.push("--permission-prompt-tool", "stdio");
    } else if (request.permission_mode === "auto") {
      args.push("--dangerously-skip-permissions");
    }
    // No flag = default Claude behavior

    return args;
  }

  /**
   * Expand ~ to home directory in path
   */
  private expandPath(path: string): string {
    if (path.startsWith("~/")) {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      return path.replace("~", home);
    }
    if (path === "~") {
      return process.env.HOME || process.env.USERPROFILE || path;
    }
    return path;
  }

  private validateWorkingDirectory(cwd: string): boolean {
    try {
      const expanded = this.expandPath(cwd);
      return existsSync(expanded) && statSync(expanded).isDirectory();
    } catch {
      return false;
    }
  }

  private async streamOutput(
    session: SpawnedSession,
    stdout: ReadableStream<Uint8Array>
  ): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let chunkCount = 0;
    let totalBytes = 0;

    console.log(`[spawner] streamOutput started for session ${session.id}`);

    // Set up a timeout to detect if we're not getting any output
    let receivedFirstChunk = false;
    const timeoutCheck = setTimeout(() => {
      if (!receivedFirstChunk) {
        console.warn(`[spawner] WARNING: No stdout received after 5s for session ${session.id}`);
        console.warn(`[spawner] Process exit code: ${session.proc.exitCode}, killed: ${session.proc.killed}`);
      }
    }, 5000);

    try {
      while (true) {
        console.log(`[spawner] Waiting for stdout chunk for session ${session.id}...`);
        const { done, value } = await reader.read();
        if (done) {
          console.log(`[spawner] stdout stream ended for session ${session.id} (${chunkCount} chunks, ${totalBytes} bytes)`);
          break;
        }

        chunkCount++;
        totalBytes += value.length;

        if (chunkCount === 1) {
          receivedFirstChunk = true;
          clearTimeout(timeoutCheck);
          console.log(`[spawner] First stdout chunk received for session ${session.id} (${value.length} bytes)`);
        }

        session.outputBuffer += decoder.decode(value, { stream: true });
        const lines = session.outputBuffer.split("\n");
        session.outputBuffer = lines.pop() || "";

        const messages: StreamJsonMessage[] = [];

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const msg = JSON.parse(line) as StreamJsonMessage;
            messages.push(msg);

            // Log the first few messages for debugging
            if (session.outputHistory.length < 5) {
              console.log(`[spawner] Parsed message for ${session.id}:`, msg.type, msg.subtype || "");
            }

            // Record message for history
            this.recordMessage(session, msg);

            // Process special messages
            this.processStreamMessage(session, msg);
          } catch (parseError) {
            console.error(`[spawner] Failed to parse line:`, line.substring(0, 200), parseError);
          }
        }

        if (messages.length > 0) {
          console.log(`[spawner] Sending ${messages.length} messages to server for session ${session.id}`);
          this.sendToServer({
            type: "session_output",
            session_id: session.id,
            messages,
          });
        }
      }
    } catch (error) {
      console.error(`[spawner] Error reading stdout for session ${session.id}:`, error);
    } finally {
      clearTimeout(timeoutCheck);
    }
  }

  private async streamStderr(
    session: SpawnedSession,
    stderr: ReadableStream<Uint8Array>
  ): Promise<void> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        // Log stderr for debugging, but don't send to server
        console.error(`[spawner ${session.id}] stderr:`, text);
      }
    } catch {
      // Ignore stderr read errors
    }
  }

  private processStreamMessage(
    session: SpawnedSession,
    msg: StreamJsonMessage
  ): void {
    // Update session state based on message type
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      session.claudeSessionId = msg.session_id;
      session.state = "running";
      console.log(
        `[spawner] Session ${session.id} initialized, Claude session: ${msg.session_id}`
      );
    }

    // Detect SDK control_request messages (from --permission-prompt-tool stdio)
    // These are top-level messages with type: "control_request"
    if ((msg as Record<string, unknown>).type === "control_request") {
      this.handleControlRequest(session, msg as unknown as {
        type: "control_request";
        request_id: string;
        request: ControlRequest;
      });
      return;
    }

    // Detect permission requests (from --permission-prompt-tool stdio)
    // Permission requests come as a special message type
    if (
      msg.type === "system" &&
      (msg.subtype === "permission_request" ||
        (msg as Record<string, unknown>).permission_request)
    ) {
      this.handlePermissionRequest(session, msg as Record<string, unknown>);
      return;
    }

    // Detect result message (session completing turn)
    if (msg.type === "result") {
      session.state = "waiting";
    }

    // Detect when Claude starts generating (assistant message)
    if (msg.type === "assistant") {
      session.state = "running";

      // Check for AskUserQuestion tool use
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use" && block.name === "AskUserQuestion") {
            session.pendingToolUseId = block.id;

            // Extract question data from input
            const input = block.input as
              | { question?: string; options?: string[] }
              | undefined;

            this.sendToServer({
              type: "question_prompt",
              session_id: session.id,
              tool_use_id: block.id!,
              question: input?.question || "",
              options: input?.options,
            });
          }
        }
      }
    }

    // Check for file-modifying tool calls and schedule diff capture
    this.checkForFileModifications(session, msg);
  }

  /**
   * Handle permission request messages from Claude.
   * Permission requests are sent when using --permission-prompt-tool stdio.
   */
  private handlePermissionRequest(
    session: SpawnedSession,
    msg: Record<string, unknown>
  ): void {
    // Extract permission request data
    // The format may vary - try different possible structures
    const permissionData =
      (msg.permission_request as Record<string, unknown>) || msg;

    const requestId =
      (permissionData.request_id as string) ||
      (permissionData.id as string) ||
      crypto.randomUUID();
    const tool = (permissionData.tool as string) || "unknown";

    const request: PermissionRequest = {
      id: requestId,
      tool,
      description: this.formatPermissionDescription(permissionData),
      command: permissionData.command as string | undefined,
      file_path: permissionData.file_path as string | undefined,
      content: permissionData.content as string | undefined,
    };

    session.permissionRequests.set(requestId, request);
    session.pendingPermissionId = requestId;

    console.log(
      `[spawner] Permission request ${requestId} for tool ${tool}: ${request.description}`
    );

    this.sendToServer({
      type: "permission_prompt",
      session_id: session.id,
      request_id: requestId,
      tool: request.tool,
      description: request.description,
      details: {
        command: request.command,
        file_path: request.file_path,
        content: request.content ? request.content.slice(0, 500) : undefined, // Preview only
      },
    });
  }

  /**
   * Format a human-readable description of the permission request.
   */
  private formatPermissionDescription(msg: Record<string, unknown>): string {
    const tool = (msg.tool as string) || "unknown";
    const description = msg.description as string | undefined;

    // If there's already a description, use it
    if (description) {
      return description;
    }

    // Generate description based on tool type
    switch (tool.toLowerCase()) {
      case "bash":
        return `Run bash command: ${(msg.command as string) || "unknown"}`;
      case "write":
        return `Write to file: ${(msg.file_path as string) || "unknown"}`;
      case "edit":
        return `Edit file: ${(msg.file_path as string) || "unknown"}`;
      case "mcp":
        return `Use MCP tool: ${(msg.tool_name as string) || "unknown"}`;
      default:
        return `Use ${tool} tool`;
    }
  }

  private recordMessage(
    session: SpawnedSession,
    msg: StreamJsonMessage
  ): void {
    session.outputHistory.push(msg);

    // Trim history if too large
    if (session.outputHistory.length > session.maxHistorySize) {
      session.outputHistory = session.outputHistory.slice(
        -session.maxHistorySize
      );
    }
  }

  async sendInput(sessionId: string, content: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[spawner] Session not found: ${sessionId}`);
      return;
    }

    if (!session.stdin) {
      console.error(`[spawner] No stdin for session: ${sessionId}`);
      return;
    }

    const message =
      JSON.stringify({
        type: "user",
        message: { role: "user", content },
      }) + "\n";

    try {
      session.stdin.write(message);
      session.stdin.flush();
      session.state = "running";
      console.log(`[spawner] Sent input to session ${sessionId}`);

      // Echo the user message back to the server so it appears in the UI
      const userMessage: StreamJsonMessage = {
        type: "user",
        message: {
          id: `user-${Date.now()}`,
          role: "user",
          content: [{ type: "text", text: content }],
        },
      };
      this.recordMessage(session, userMessage);
      this.sendToServer({
        type: "session_output",
        session_id: sessionId,
        messages: [userMessage],
      });
    } catch (error) {
      console.error(`[spawner] Failed to send input:`, error);
    }
  }

  async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.state = "ending";

    try {
      // Close stdin to signal EOF
      session.stdin?.end();

      // Give Claude a moment to finish, then force kill
      setTimeout(() => {
        if (session.proc.exitCode === null) {
          console.log(`[spawner] Force killing session ${sessionId}`);
          session.proc.kill();
        }
      }, 5000);
    } catch (error) {
      console.error(`[spawner] Error ending session:`, error);
      session.proc.kill();
    }
  }

  async interruptSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    console.log(`[spawner] Interrupting session ${sessionId}`);

    try {
      session.proc.kill("SIGINT");
    } catch (error) {
      console.error(`[spawner] Error interrupting session:`, error);
    }
  }

  private onSessionEnded(session: SpawnedSession, exitCode: number): void {
    session.state = "ended";

    console.log(`[spawner] Session ${session.id} ended with code ${exitCode}`);

    // Cancel any pending diff capture
    if (session.diffDebounceTimer) {
      clearTimeout(session.diffDebounceTimer);
      session.diffDebounceTimer = null;
    }

    this.sendToServer({
      type: "session_ended",
      session_id: session.id,
      exit_code: exitCode,
      reason: exitCode === 0 ? "completed" : "error",
    });

    // Clean up
    this.sessions.delete(session.id);
  }

  /**
   * Inject a tool result for AskUserQuestion responses.
   */
  async injectToolResult(
    sessionId: string,
    toolUseId: string,
    result: string
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.stdin) return;

    const message =
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: result,
            },
          ],
        },
      }) + "\n";

    try {
      session.stdin.write(message);
      session.stdin.flush();
      session.pendingToolUseId = undefined;
      console.log(`[spawner] Injected tool result for ${toolUseId}`);
    } catch (error) {
      console.error(`[spawner] Failed to inject tool result:`, error);
    }
  }

  /**
   * Respond to a permission request.
   * Sends the response to Claude's stdin in the expected format.
   */
  async respondToPermission(
    sessionId: string,
    requestId: string,
    allow: boolean
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.stdin) {
      console.error(
        `[spawner] Session not found for permission response: ${sessionId}`
      );
      return;
    }

    const request = session.permissionRequests.get(requestId);
    if (!request) {
      console.error(`[spawner] Permission request not found: ${requestId}`);
      return;
    }

    // Format the permission response for Claude's stdin
    // The format depends on how Claude's --permission-prompt-tool stdio expects responses
    const response =
      JSON.stringify({
        type: "permission_response",
        request_id: requestId,
        allow,
      }) + "\n";

    try {
      session.stdin.write(response);
      session.stdin.flush();
      session.permissionRequests.delete(requestId);
      session.pendingPermissionId = undefined;
      console.log(
        `[spawner] Sent permission response for ${requestId}: ${allow ? "allow" : "deny"}`
      );
    } catch (error) {
      console.error(`[spawner] Failed to send permission response:`, error);
    }
  }

  /**
   * Handle control_request messages from Claude Code SDK.
   * These are the new format for permission requests.
   */
  private handleControlRequest(
    session: SpawnedSession,
    msg: { type: "control_request"; request_id: string; request: ControlRequest }
  ): void {
    const { request_id, request } = msg;

    const controlRequest: ControlRequest = {
      request_id,
      tool_name: request.tool_name,
      tool_use_id: request.tool_use_id,
      input: request.input,
      permission_suggestions: request.permission_suggestions,
      blocked_path: request.blocked_path,
      decision_reason: request.decision_reason,
      agent_id: request.agent_id,
    };

    session.controlRequests.set(request_id, controlRequest);

    console.log(
      `[spawner] Control request ${request_id} for tool ${request.tool_name}: ${request.decision_reason || "requires approval"}`
    );

    // Relay to server
    this.sendToServer({
      type: "control_request",
      session_id: session.id,
      request_id,
      request: {
        subtype: "can_use_tool",
        tool_name: request.tool_name,
        input: request.input,
        tool_use_id: request.tool_use_id,
        permission_suggestions: request.permission_suggestions,
        blocked_path: request.blocked_path,
        decision_reason: request.decision_reason,
        agent_id: request.agent_id,
      },
    });
  }

  /**
   * Respond to a control request.
   * Sends the response to Claude's stdin in the SDK format.
   */
  async respondToControlRequest(
    sessionId: string,
    requestId: string,
    result: PermissionResult
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.stdin) {
      console.error(
        `[spawner] Session not found for control response: ${sessionId}`
      );
      return;
    }

    const request = session.controlRequests.get(requestId);
    if (!request) {
      console.error(`[spawner] Control request not found: ${requestId}`);
      return;
    }

    // Format the control response for Claude's stdin (exact SDK format)
    const response = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: result,
      },
    }) + "\n";

    try {
      session.stdin.write(response);
      session.stdin.flush();
      session.controlRequests.delete(requestId);
      console.log(
        `[spawner] Sent control response for ${requestId}: ${result.behavior}`
      );
    } catch (error) {
      console.error(`[spawner] Failed to send control response:`, error);
    }
  }

  /**
   * Get a specific session by ID.
   */
  getSession(sessionId: string): SpawnedSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active (non-ended) sessions.
   */
  getActiveSessions(): SpawnedSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.state !== "ended"
    );
  }

  /**
   * Get session info for a specific session.
   */
  getSessionInfo(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    return {
      id: session.id,
      claudeSessionId: session.claudeSessionId,
      cwd: session.cwd,
      startedAt: session.startedAt,
      state: session.state,
      durationSeconds: Math.floor(
        (Date.now() - session.startedAt.getTime()) / 1000
      ),
    };
  }

  /**
   * Get info for all sessions.
   */
  getAllSessionInfo(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      claudeSessionId: session.claudeSessionId,
      cwd: session.cwd,
      startedAt: session.startedAt,
      state: session.state,
      durationSeconds: Math.floor(
        (Date.now() - session.startedAt.getTime()) / 1000
      ),
    }));
  }

  /**
   * Get session output history for replay on reconnection.
   */
  getSessionHistory(
    sessionId: string,
    fromIndex: number = 0
  ): StreamJsonMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    return session.outputHistory.slice(fromIndex);
  }

  /**
   * Check if a message contains file-modifying tool calls and track them.
   * Schedules a debounced diff capture if modifications are detected.
   */
  private checkForFileModifications(
    session: SpawnedSession,
    msg: StreamJsonMessage
  ): void {
    if (msg.type !== "assistant" || !msg.message?.content) {
      return;
    }

    let shouldCaptureDiff = false;

    for (const block of msg.message.content) {
      if (block.type !== "tool_use" || typeof block.name !== "string") {
        continue;
      }

      // Check for file-modifying tools (Write, Edit, NotebookEdit)
      if (FILE_MODIFYING_TOOLS.includes(block.name)) {
        console.log(`[spawner] File-modifying tool detected: ${block.name}`);
        shouldCaptureDiff = true;

        // Extract file path from tool input
        const filePath = this.extractFilePathFromToolUse(block);
        if (filePath) {
          session.modifiedFiles.add(filePath);
          console.log(`[spawner] Tracked modified file: ${filePath}`);
        }
      }

      // Check for Bash commands that might modify git working tree
      if (block.name === "Bash") {
        const input = block.input as Record<string, unknown> | undefined;
        const command = input?.command;
        if (typeof command === "string" && this.isGitModifyingCommand(command)) {
          console.log(`[spawner] Git-modifying Bash command detected: ${command.slice(0, 100)}`);
          shouldCaptureDiff = true;
        }
      }
    }

    if (shouldCaptureDiff) {
      this.scheduleDiffCapture(session);
    }
  }

  /**
   * Check if a Bash command contains git subcommands that can modify working tree state.
   */
  private isGitModifyingCommand(command: string): boolean {
    // Match git commands with modifying subcommands
    // Handles: git checkout, git reset, etc.
    // Also handles: git -C /path checkout, git --no-pager reset, etc.
    for (const subcommand of GIT_MODIFYING_SUBCOMMANDS) {
      // Look for "git" followed by optional flags/options, then the subcommand
      // This regex handles:
      // - git checkout
      // - git -C /path checkout
      // - git --no-pager checkout
      // - command && git checkout
      const pattern = new RegExp(`\\bgit\\b[^|;&]*\\b${subcommand}\\b`, "i");
      if (pattern.test(command)) {
        return true;
      }
    }
    return false;
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
   * Schedule a debounced diff capture.
   * Cancels any pending capture and schedules a new one.
   */
  private scheduleDiffCapture(session: SpawnedSession): void {
    // Cancel any pending capture
    if (session.diffDebounceTimer) {
      clearTimeout(session.diffDebounceTimer);
    }

    // Schedule new capture
    session.diffDebounceTimer = setTimeout(async () => {
      session.diffDebounceTimer = null;
      await this.captureAndSendDiff(session);
    }, DIFF_DEBOUNCE_MS);
  }

  /**
   * Capture the current git diff and send it to the server.
   * Only includes untracked files that the session has explicitly modified.
   */
  private async captureAndSendDiff(session: SpawnedSession): Promise<void> {
    if (!session.cwd) {
      console.log("[spawner] No cwd, skipping diff capture");
      return;
    }

    try {
      const diff = await captureGitDiff(session.cwd, {
        allowedUntrackedFiles: session.modifiedFiles,
      });

      if (!diff) {
        console.log("[spawner] No diff to capture (not a git repo or no changes)");
        return;
      }

      console.log(`[spawner] Capturing diff (${diff.length} chars) for session ${session.id}`);

      // Send diff to server
      this.sendToServer({
        type: "session_diff",
        session_id: session.id,
        diff,
        modified_files: Array.from(session.modifiedFiles),
      });
    } catch (error) {
      console.error(`[spawner] Failed to capture diff:`, error);
    }
  }
}
