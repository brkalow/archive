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
 */

import { existsSync, statSync } from "fs";
import type {
  StartSessionMessage,
  StreamJsonMessage,
  DaemonToServerMessage,
} from "../types/daemon-ws";
import { notifySessionStarted } from "./notifications";

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

interface SpawnedSession {
  id: string; // Server-assigned session ID
  claudeSessionId?: string; // Claude's internal session ID (from init message)
  proc: ReturnType<typeof Bun.spawn>;
  cwd: string;
  startedAt: Date;
  state: "starting" | "running" | "waiting" | "ending" | "ended";
  stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  pendingToolUseId?: string; // For AskUserQuestion relay
  pendingPermissionId?: string; // For permission relay
  permissionRequests: Map<string, PermissionRequest>; // Track permission requests by ID
  outputBuffer: string; // Buffer for incomplete NDJSON lines
  outputHistory: StreamJsonMessage[]; // All messages for replay
  maxHistorySize: number;
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
    // Validate working directory
    if (!this.validateWorkingDirectory(request.cwd)) {
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
      `[spawner] Starting session ${request.session_id} in ${request.cwd}`
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
        cwd: request.cwd,
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

      const session: SpawnedSession = {
        id: request.session_id,
        proc,
        cwd: request.cwd,
        startedAt: new Date(),
        state: "starting",
        stdinWriter: null,
        permissionRequests: new Map(),
        outputBuffer: "",
        outputHistory: [],
        maxHistorySize: 1000,
      };

      this.sessions.set(request.session_id, session);

      // Get stdin writer - verify stdin is a WritableStream
      if (!proc.stdin || typeof proc.stdin.getWriter !== "function") {
        // This shouldn't happen if the process started successfully
        const stdinType = proc.stdin ? typeof proc.stdin : "null";
        throw new Error(
          `Failed to get stdin writer (stdin type: ${stdinType}). Process may have failed to start.`
        );
      }
      session.stdinWriter = proc.stdin.getWriter();

      // Stream stdout
      if (proc.stdout) {
        this.streamOutput(session, proc.stdout);
      }

      // Log stderr (for debugging)
      if (proc.stderr) {
        this.streamStderr(session, proc.stderr);
      }

      // Handle process exit
      proc.exited.then((exitCode) => {
        this.onSessionEnded(session, exitCode);
      });

      // Show desktop notification
      notifySessionStarted({
        title: "Remote Session Started",
        message: "Claude session started",
        sessionId: request.session_id,
        cwd: request.cwd,
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
    const args = [
      "-p",
      request.prompt,
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

  private validateWorkingDirectory(cwd: string): boolean {
    try {
      return existsSync(cwd) && statSync(cwd).isDirectory();
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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        session.outputBuffer += decoder.decode(value, { stream: true });
        const lines = session.outputBuffer.split("\n");
        session.outputBuffer = lines.pop() || "";

        const messages: StreamJsonMessage[] = [];

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const msg = JSON.parse(line) as StreamJsonMessage;
            messages.push(msg);

            // Record message for history
            this.recordMessage(session, msg);

            // Process special messages
            this.processStreamMessage(session, msg);
          } catch (parseError) {
            console.error(`[spawner] Failed to parse line:`, line, parseError);
          }
        }

        if (messages.length > 0) {
          this.sendToServer({
            type: "session_output",
            session_id: session.id,
            messages,
          });
        }
      }
    } catch (error) {
      console.error(`[spawner] Error reading stdout:`, error);
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

    if (!session.stdinWriter) {
      console.error(`[spawner] No stdin writer for session: ${sessionId}`);
      return;
    }

    const message =
      JSON.stringify({
        type: "user",
        message: { role: "user", content },
      }) + "\n";

    try {
      await session.stdinWriter.write(new TextEncoder().encode(message));
      session.state = "running";
      console.log(`[spawner] Sent input to session ${sessionId}`);
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
      session.stdinWriter?.close();

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
    if (!session || !session.stdinWriter) return;

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
      await session.stdinWriter.write(new TextEncoder().encode(message));
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
    if (!session || !session.stdinWriter) {
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
      await session.stdinWriter.write(new TextEncoder().encode(response));
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
}
