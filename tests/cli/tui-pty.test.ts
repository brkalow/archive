/**
 * PTY-based TUI Integration Test
 *
 * Spawns the real OpenCode TUI in a pseudo-terminal against our
 * FakeSessionManager + DaemonBackend + OpenCodeAPI stack, then
 * inspects the rendered terminal output for correctness.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createOpenCodeAPI, type OpenCodeAPI } from "../../cli/lib/opencode-api";
import { DaemonBackend } from "../../cli/lib/opencode-backend";
import type {
  StreamJsonMessage,
  DaemonToServerMessage,
  StartSessionMessage,
} from "../../cli/types/daemon-ws";

// ============================================
// ANSI Stripping
// ============================================

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, "") // CSI sequences (full range: \x1b[ params final)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences (BEL or ST terminator)
    .replace(/\x1b[()][A-Z0-9]/g, "") // charset sequences
    .replace(/\x1b[#%][A-Z0-9]/g, "") // other ESC sequences
    .replace(/\x1b[=>Nc]/g, "") // simple ESC commands
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); // control chars (keep \n, \r)
}

// ============================================
// Fake SpawnedSessionManager (same as E2E test)
// ============================================

class FakeSessionManager {
  private sendToServer: (msg: DaemonToServerMessage) => void;
  private sessions = new Map<
    string,
    {
      id: string;
      state: "starting" | "running" | "waiting" | "ending" | "ended";
      claudeSessionId?: string;
      controlRequests: Map<string, unknown>;
      permissionRequests: Map<string, unknown>;
    }
  >();

  startSessionCalls: StartSessionMessage[] = [];
  sendInputCalls: { sessionId: string; content: string }[] = [];

  constructor(sendToServer: (msg: DaemonToServerMessage) => void) {
    this.sendToServer = sendToServer;
  }

  async startSession(request: StartSessionMessage): Promise<void> {
    this.startSessionCalls.push(request);

    const session = {
      id: request.session_id,
      state: "starting" as const,
      claudeSessionId: undefined as string | undefined,
      controlRequests: new Map<string, unknown>(),
      permissionRequests: new Map<string, unknown>(),
    };
    this.sessions.set(request.session_id, session);

    await new Promise((r) => setTimeout(r, 10));

    // Echo user message
    const userEcho: StreamJsonMessage = {
      type: "user",
      message: {
        id: `user-${Date.now()}`,
        role: "user",
        content: [{ type: "text", text: request.prompt }],
      },
    };
    this.sendToServer({
      type: "session_output",
      session_id: request.session_id,
      messages: [userEcho],
    });

    // System init + metadata
    const initMsg: StreamJsonMessage = {
      type: "system",
      subtype: "init",
      session_id: "claude-session-abc",
    };
    session.state = "running";
    session.claudeSessionId = "claude-session-abc";
    this.sendToServer({
      type: "session_output",
      session_id: request.session_id,
      messages: [initMsg],
    });
    this.sendToServer({
      type: "session_metadata",
      session_id: request.session_id,
      agent_session_id: "claude-session-abc",
    });

    await new Promise((r) => setTimeout(r, 10));

    // Assistant response
    const assistantMsg: StreamJsonMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5-20250514",
        content: [{ type: "text", text: "Hello! I can help with that." }],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    };
    this.sendToServer({
      type: "session_output",
      session_id: request.session_id,
      messages: [assistantMsg],
    });

    // Result (turn complete)
    const resultMsg: StreamJsonMessage = {
      type: "result",
      message: {
        role: "assistant",
        content: [],
        usage: { input_tokens: 100, output_tokens: 20 },
      },
      duration_ms: 1500,
    };
    session.state = "waiting";
    this.sendToServer({
      type: "session_output",
      session_id: request.session_id,
      messages: [resultMsg],
    });
  }

  sendInput(sessionId: string, content: string): void {
    this.sendInputCalls.push({ sessionId, content });

    const session = this.sessions.get(sessionId);
    if (!session) return;

    const userEcho: StreamJsonMessage = {
      type: "user",
      message: {
        id: `user-${Date.now()}`,
        role: "user",
        content: [{ type: "text", text: content }],
      },
    };
    session.state = "running";
    this.sendToServer({
      type: "session_output",
      session_id: sessionId,
      messages: [userEcho],
    });

    setTimeout(() => {
      const assistantMsg: StreamJsonMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-5-20250514",
          content: [{ type: "text", text: "Here is the follow-up response." }],
          usage: { input_tokens: 200, output_tokens: 30 },
        },
      };
      this.sendToServer({
        type: "session_output",
        session_id: sessionId,
        messages: [assistantMsg],
      });

      const resultMsg: StreamJsonMessage = {
        type: "result",
        message: {
          role: "assistant",
          content: [],
          usage: { input_tokens: 200, output_tokens: 30 },
        },
        duration_ms: 1000,
      };
      session.state = "waiting";
      this.sendToServer({
        type: "session_output",
        session_id: sessionId,
        messages: [resultMsg],
      });
    }, 10);
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? undefined;
  }

  async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = "ended";
      this.sessions.delete(sessionId);
    }
  }

  async interruptSession(_sessionId: string): Promise<void> {}
  async respondToPermission(
    _sessionId: string,
    _requestId: string,
    _allow: boolean
  ): Promise<void> {}
  async respondToControlRequest(
    _sessionId: string,
    _requestId: string,
    _result: unknown
  ): Promise<void> {}
  async injectToolResult(
    _sessionId: string,
    _toolUseId: string,
    _result: string
  ): Promise<void> {}
  getActiveSessions() {
    return Array.from(this.sessions.values()).filter(
      (s) => s.state !== "ended"
    );
  }
}

// ============================================
// Test Suite
// ============================================

describe("OpenCode TUI PTY Integration", () => {
  let server: ReturnType<typeof Bun.serve>;
  let api: OpenCodeAPI;
  let backend: DaemonBackend;
  let fakeManager: FakeSessionManager;
  let proc: ReturnType<typeof Bun.spawn>;
  let output: string;

  /**
   * Wait for a pattern to appear in the terminal output.
   */
  async function waitFor(
    pattern: string | RegExp,
    timeoutMs = 10_000
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const stripped = stripAnsi(output);
      if (typeof pattern === "string") {
        if (stripped.includes(pattern)) return;
      } else {
        if (pattern.test(stripped)) return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const stripped = stripAnsi(output);
    throw new Error(
      `Timed out waiting for ${pattern} after ${timeoutMs}ms.\n\n--- Terminal output (last 2000 chars) ---\n${stripped.slice(-2000)}`
    );
  }

  /**
   * Get the current stripped terminal output.
   */
  function getScreen(): string {
    return stripAnsi(output);
  }

  beforeAll(() => {
    let sendToServer: (msg: DaemonToServerMessage) => void;

    fakeManager = new FakeSessionManager((msg) => {
      sendToServer(msg);
    });

    backend = new DaemonBackend(fakeManager as any, "/tmp/test");
    api = createOpenCodeAPI(backend, { directory: "/tmp/test" });
    backend.setBroadcast(api.broadcast);
    sendToServer = (msg) => backend.handleDaemonMessage(msg);

    server = Bun.serve({
      port: 0,
      idleTimeout: 255,
      async fetch(req) {
        const response = await api.handleRequest(req);
        if (response) return response;
        return new Response("Not found", { status: 404 });
      },
    });

    // Spawn the real TUI in a PTY
    output = "";
    proc = Bun.spawn(
      ["opencode", "attach", `http://localhost:${server.port}`],
      {
        terminal: {
          cols: 120,
          rows: 40,
          data(_terminal, data) {
            output += new TextDecoder().decode(data);
          },
        },
        env: {
          ...process.env,
          TERM: "xterm-256color",
          NO_COLOR: undefined,
        },
      }
    );
  });

  afterAll(() => {
    proc?.kill();
    api?.close();
    server?.stop();
  });

  test("TUI boots and shows input prompt", async () => {
    // The TUI should connect to our server and show the input area
    await waitFor(/ask anything/i, 15_000);
    // Also wait for the model to be loaded from config (shown in status bar)
    // Without this, submit() silently fails because selectedModel is null
    await waitFor(/Claude Sonnet/i, 15_000);
    const screen = getScreen();
    expect(screen.toLowerCase()).toContain("ask anything");
  }, 20_000);

  test("first message completes without stuck QUEUED", async () => {
    // Extra settle time — the TUI's async config loading (model selection)
    // must complete before submit() will work
    await new Promise((r) => setTimeout(r, 2000));

    // Type message characters first, then Enter separately after a delay
    proc.terminal!.write("Hello Claude");
    await new Promise((r) => setTimeout(r, 200));
    proc.terminal!.write("\r");

    // Wait for the completion marker (▣) to appear
    await waitFor("▣", 15_000);

    // Allow screen to fully render after completion
    await new Promise((r) => setTimeout(r, 500));

    const screen = getScreen();

    // The completion marker should have appeared
    expect(screen).toContain("▣");

    // QUEUED should NOT be stuck on screen after completion
    expect(screen.toUpperCase()).not.toContain("QUEUED");

    // The response should have been delivered (check backend received it)
    expect(fakeManager.startSessionCalls.length).toBe(1);

    // The response text should appear somewhere in the terminal output
    // (may require scrolling in the TUI, so check accumulated output)
    expect(screen).toContain("Hello! I can help with that.");
  }, 20_000);

  test("multi-turn: second message also completes cleanly", async () => {
    // Wait for input to be ready in the session view
    await new Promise((r) => setTimeout(r, 2000));

    // Type a follow-up message
    proc.terminal!.write("Follow up");
    await new Promise((r) => setTimeout(r, 200));
    proc.terminal!.write("\r");

    // Wait for the follow-up response text to appear (definitive signal)
    await waitFor("Here is the follow-up response.", 15_000);

    const screen = getScreen();

    // No QUEUED stuck on screen
    expect(screen.toUpperCase()).not.toContain("QUEUED");

    // The backend should have used sendInput (not startSession) for the second message
    expect(fakeManager.sendInputCalls.length).toBe(1);
  }, 25_000);
});
