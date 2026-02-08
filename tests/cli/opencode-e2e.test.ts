/**
 * OpenCode End-to-End Event Stream Tests
 *
 * Uses the real DaemonBackend + OpenCodeAPI + SDK client to capture the
 * exact SSE event stream the TUI sees. A FakeSessionManager simulates
 * Claude's stream-json output so we can verify event ordering, message
 * ID reuse, and the full lifecycle.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createOpenCodeAPI, type OpenCodeAPI } from "../../cli/lib/opencode-api";
import { DaemonBackend } from "../../cli/lib/opencode-backend";
import type {
  StreamJsonMessage,
  DaemonToServerMessage,
  StartSessionMessage,
} from "../../cli/types/daemon-ws";
import type { OCEvent } from "../../src/lib/opencode/types";

// ============================================
// Fake SpawnedSessionManager
// ============================================

/**
 * Simulates a SpawnedSessionManager by accepting startSession/sendInput calls
 * and firing back realistic session_output messages via the sendToServer callback.
 */
class FakeSessionManager {
  private sendToServer: (msg: DaemonToServerMessage) => void;

  // Track active sessions (mimics SpawnedSession)
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

  // Expose for test assertions
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

    // Small delay to simulate process startup (real SpawnedSessionManager has ~100ms)
    await new Promise((r) => setTimeout(r, 10));

    // Simulate: echo user message (like real SpawnedSessionManager does)
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

    // Simulate: system init + metadata
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

    // Small delay to simulate Claude thinking
    await new Promise((r) => setTimeout(r, 10));

    // Simulate: assistant response
    const assistantMsg: StreamJsonMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5-20250514",
        content: [{ type: "text", text: "Hello! I can help with that." }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
        },
      },
    };
    this.sendToServer({
      type: "session_output",
      session_id: request.session_id,
      messages: [assistantMsg],
    });

    // Simulate: result (turn complete)
    const resultMsg: StreamJsonMessage = {
      type: "result",
      message: {
        role: "assistant",
        content: [],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
        },
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

    // Echo user message (synchronous, like real SpawnedSessionManager)
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

    // Simulate async delay for Claude's response
    setTimeout(() => {
      const assistantMsg: StreamJsonMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-5-20250514",
          content: [{ type: "text", text: "Here is the follow-up response." }],
          usage: {
            input_tokens: 200,
            output_tokens: 30,
          },
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
          usage: {
            input_tokens: 200,
            output_tokens: 30,
          },
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

  /**
   * Simulate the process exiting (fires session_ended).
   */
  simulateProcessExit(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state = "ended";
    this.sendToServer({
      type: "session_ended",
      session_id: sessionId,
      exit_code: 0,
      reason: "completed",
    });
    this.sessions.delete(sessionId);
  }
}

// ============================================
// Test Suite
// ============================================

describe("OpenCode E2E Event Stream", () => {
  let server: ReturnType<typeof Bun.serve>;
  let port: number;
  let api: OpenCodeAPI;
  let backend: DaemonBackend;
  let fakeManager: FakeSessionManager;
  let sdk: ReturnType<typeof createOpencodeClient>;

  beforeAll(() => {
    // Create FakeSessionManager with sendToServer wired through the backend
    // We need to set up the sendToServer callback so messages go to the backend
    let sendToServer: (msg: DaemonToServerMessage) => void;

    fakeManager = new FakeSessionManager((msg) => {
      sendToServer(msg);
    });

    backend = new DaemonBackend(fakeManager as any, "/tmp/test");

    api = createOpenCodeAPI(backend, { directory: "/tmp/test" });
    backend.setBroadcast(api.broadcast);

    // Wire sendToServer to the backend (simulates daemon/index.ts wiring)
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
    port = server.port;

    sdk = createOpencodeClient({
      baseUrl: `http://localhost:${port}`,
    });
  });

  afterAll(() => {
    api.close();
    server.stop();
  });

  /**
   * Helper: connect to SSE and collect events.
   * Returns a function to get collected events.
   */
  async function collectSSEEvents(): Promise<{
    events: OCEvent[];
    close: () => void;
  }> {
    const events: OCEvent[] = [];
    const response = await fetch(`http://localhost:${port}/event`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let closed = false;

    // Read events in background
    const readLoop = async () => {
      while (!closed) {
        try {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events from buffer
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.slice(6)) as OCEvent;
                events.push(event);
              } catch {
                // skip unparseable
              }
            }
          }
        } catch {
          break;
        }
      }
    };
    readLoop(); // fire and forget

    // Wait for initial server.connected event
    await new Promise((r) => setTimeout(r, 50));

    return {
      events,
      close: () => {
        closed = true;
        reader.cancel();
      },
    };
  }

  test("first message: SSE event sequence and message ID reuse", async () => {
    const sse = await collectSSEEvents();

    try {
      // Create session
      const sessionResult = await sdk.session.create({
        title: "Test Session",
      });
      const session = sessionResult.data!;
      expect(session.id).toBeTruthy();

      // Clear events so far (session.created, etc.)
      await new Promise((r) => setTimeout(r, 50));
      const preEvents = sse.events.length;

      // Send a message (this triggers the full flow)
      const promptResult = await sdk.session.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: "Hello Claude" }],
      });

      // Wait for all events to propagate
      await new Promise((r) => setTimeout(r, 200));

      // Get events after the prompt
      const events = sse.events.slice(preEvents);

      // Log the full event stream for debugging
      console.log("\n=== SSE Event Stream ===");
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        const summary = summarizeEvent(e);
        console.log(`  [${i}] ${e.type}: ${summary}`);
      }
      console.log(`=== Total: ${events.length} events ===\n`);

      // The HTTP response should contain the pending assistant
      const pendingAssistant = promptResult.data as any;
      expect(pendingAssistant).toBeTruthy();
      const pendingAssistantId = pendingAssistant?.info?.id;
      console.log(`Pending assistant ID from HTTP: ${pendingAssistantId}`);
      console.log(`Pending assistant full response: ${JSON.stringify(pendingAssistant, null, 2).slice(0, 500)}`);

      // Find all message.updated events for assistant messages
      const assistantUpdates = events.filter(
        (e) =>
          e.type === "message.updated" &&
          (e.properties as any)?.info?.role === "assistant"
      );

      console.log("\n=== Assistant message.updated events ===");
      for (const e of assistantUpdates) {
        const info = (e.properties as any)?.info;
        console.log(
          `  ID: ${info?.id}, finish: ${info?.finish}, completed: ${info?.time?.completed}`
        );
      }

      // CRITICAL: All assistant message IDs should be the SAME as the pending assistant
      const uniqueAssistantIds = new Set(
        assistantUpdates.map((e) => (e.properties as any)?.info?.id)
      );
      console.log(`\nUnique assistant IDs: ${[...uniqueAssistantIds].join(", ")}`);
      expect(uniqueAssistantIds.size).toBe(1);
      expect([...uniqueAssistantIds][0]).toBe(pendingAssistantId);

      // Verify step-start is present
      const stepStarts = events.filter(
        (e) =>
          e.type === "message.part.updated" &&
          (e.properties as any)?.part?.type === "step-start"
      );
      expect(stepStarts.length).toBeGreaterThanOrEqual(1);
      console.log(`Step-start events: ${stepStarts.length}`);

      // Verify step-finish is present
      const stepFinishes = events.filter(
        (e) =>
          e.type === "message.part.updated" &&
          (e.properties as any)?.part?.type === "step-finish"
      );
      expect(stepFinishes.length).toBeGreaterThanOrEqual(1);
      console.log(`Step-finish events: ${stepFinishes.length}`);

      // Verify text part with content
      const textParts = events.filter(
        (e) =>
          e.type === "message.part.updated" &&
          (e.properties as any)?.part?.type === "text" &&
          (e.properties as any)?.part?.messageID ===
            [...uniqueAssistantIds][0]
      );
      expect(textParts.length).toBeGreaterThanOrEqual(1);
      const firstText = (textParts[0]?.properties as any)?.part?.text;
      console.log(`Text content: "${firstText}"`);
      expect(firstText).toContain("Hello");

      // Verify session.status transitions
      const statusEvents = events.filter(
        (e) => e.type === "session.status"
      );
      console.log(
        `\nSession status events: ${statusEvents.map((e) => (e.properties as any)?.status?.type).join(" → ")}`
      );
    } finally {
      sse.close();
    }
  });

  test("multi-turn: second message uses sendInput, not startSession", async () => {
    const sse = await collectSSEEvents();

    try {
      // Create session
      const sessionResult = await sdk.session.create({
        title: "Multi-turn Test",
      });
      const session = sessionResult.data!;

      // Reset call tracking
      fakeManager.startSessionCalls = [];
      fakeManager.sendInputCalls = [];

      // First message
      await sdk.session.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: "First message" }],
      });

      await new Promise((r) => setTimeout(r, 100));

      console.log(
        `\nAfter first message: startSession calls = ${fakeManager.startSessionCalls.length}, sendInput calls = ${fakeManager.sendInputCalls.length}`
      );
      expect(fakeManager.startSessionCalls.length).toBe(1);
      expect(fakeManager.sendInputCalls.length).toBe(0);

      // Clear events and tracking
      const preEvents = sse.events.length;
      fakeManager.startSessionCalls = [];
      fakeManager.sendInputCalls = [];

      // Second message (process is still alive — should use sendInput)
      const prompt2Result = await sdk.session.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: "Second message" }],
      });

      await new Promise((r) => setTimeout(r, 200));

      console.log(
        `After second message: startSession calls = ${fakeManager.startSessionCalls.length}, sendInput calls = ${fakeManager.sendInputCalls.length}`
      );

      // CRITICAL: Second message should use sendInput, NOT startSession
      expect(fakeManager.startSessionCalls.length).toBe(0);
      expect(fakeManager.sendInputCalls.length).toBe(1);
      expect(fakeManager.sendInputCalls[0].content).toBe("Second message");

      // Verify second turn's assistant also reuses pending ID
      const events = sse.events.slice(preEvents);
      const prompt2Data = prompt2Result.data as any;
      const prompt2Assistant = prompt2Data?.info?.id;

      const assistantUpdates = events.filter(
        (e) =>
          e.type === "message.updated" &&
          (e.properties as any)?.info?.role === "assistant"
      );
      const uniqueIds = new Set(
        assistantUpdates.map((e) => (e.properties as any)?.info?.id)
      );

      console.log(
        `\nSecond turn pending assistant: ${prompt2Assistant}`
      );
      console.log(`Second turn unique assistant IDs: ${[...uniqueIds].join(", ")}`);
      expect(uniqueIds.size).toBe(1);
      expect([...uniqueIds][0]).toBe(prompt2Assistant);
    } finally {
      sse.close();
    }
  });

  test("after process exit: third message uses startSession with resume", async () => {
    const sse = await collectSSEEvents();

    try {
      // Create session
      const sessionResult = await sdk.session.create({
        title: "Resume Test",
      });
      const session = sessionResult.data!;

      // First message (starts process)
      await sdk.session.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: "Start" }],
      });
      await new Promise((r) => setTimeout(r, 100));

      // Simulate process exit
      fakeManager.simulateProcessExit(session.id);
      await new Promise((r) => setTimeout(r, 100));

      // Reset tracking
      fakeManager.startSessionCalls = [];
      fakeManager.sendInputCalls = [];

      // Next message should resume (not sendInput, since process is dead)
      await sdk.session.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: "Resume" }],
      });
      await new Promise((r) => setTimeout(r, 100));

      console.log(
        `\nAfter resume: startSession calls = ${fakeManager.startSessionCalls.length}, sendInput calls = ${fakeManager.sendInputCalls.length}`
      );
      expect(fakeManager.startSessionCalls.length).toBe(1);
      expect(fakeManager.sendInputCalls.length).toBe(0);

      // Verify it used resume_session_id
      const startReq = fakeManager.startSessionCalls[0];
      console.log(
        `resume_session_id: ${startReq.resume_session_id}`
      );
      expect(startReq.resume_session_id).toBe("claude-session-abc");
    } finally {
      sse.close();
    }
  });

  test("SDK event.subscribe() can parse SSE events", async () => {
    // Use the SDK's native SSE subscription (same as TUI)
    const sdkEvents: Array<{ type: string; properties: any }> = [];
    const sseResult = await sdk.event.subscribe();
    const stream = sseResult.stream;

    // Collect events in background
    let collecting = true;
    const collectLoop = (async () => {
      for await (const event of stream) {
        if (!collecting) break;
        sdkEvents.push(event as any);
      }
    })();

    // Wait for connection
    await new Promise((r) => setTimeout(r, 50));

    // Create session and send a message
    const sessionResult = await sdk.session.create({
      title: "SDK SSE Test",
    });
    const session = sessionResult.data!;

    const preCount = sdkEvents.length;

    await sdk.session.prompt({
      sessionID: session.id,
      parts: [{ type: "text", text: "Test SDK events" }],
    });

    await new Promise((r) => setTimeout(r, 300));

    collecting = false;

    const events = sdkEvents.slice(preCount);

    console.log("\n=== SDK event.subscribe() Events ===");
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      console.log(`  [${i}] ${e.type}: ${JSON.stringify(e.properties).slice(0, 100)}`);
    }
    console.log(`=== Total: ${events.length} SDK events ===\n`);

    // Verify we get events (not 0)
    expect(events.length).toBeGreaterThan(0);

    // Verify we get the key event types
    const eventTypes = new Set(events.map((e) => e.type));
    expect(eventTypes.has("message.updated")).toBe(true);
    expect(eventTypes.has("message.part.updated")).toBe(true);
    expect(eventTypes.has("session.status")).toBe(true);

    // Verify assistant has time.completed at the end
    const assistantUpdates = events.filter(
      (e) => e.type === "message.updated" && e.properties?.info?.role === "assistant"
    );
    const lastAssistant = assistantUpdates[assistantUpdates.length - 1];
    expect(lastAssistant?.properties?.info?.time?.completed).toBeTruthy();
    expect(lastAssistant?.properties?.info?.finish).toBe("stop");
  });

  test("no duplicate step-start when stream arrives", async () => {
    const sse = await collectSSEEvents();

    try {
      const sessionResult = await sdk.session.create({
        title: "Step-start Test",
      });
      const session = sessionResult.data!;

      await new Promise((r) => setTimeout(r, 50));
      const preEvents = sse.events.length;

      await sdk.session.prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: "Test" }],
      });

      await new Promise((r) => setTimeout(r, 200));

      const events = sse.events.slice(preEvents);

      // Count step-start parts for this session's assistant
      const stepStarts = events.filter(
        (e) =>
          e.type === "message.part.updated" &&
          (e.properties as any)?.part?.type === "step-start"
      );

      console.log(`\nStep-start count: ${stepStarts.length}`);
      // Should be exactly 1 step-start (from sendMessage, not duplicated by stream)
      expect(stepStarts.length).toBe(1);
    } finally {
      sse.close();
    }
  });
});

// ============================================
// Helpers
// ============================================

function summarizeEvent(e: OCEvent): string {
  const props = e.properties as any;
  switch (e.type) {
    case "message.updated":
      return `role=${props?.info?.role} id=${props?.info?.id?.slice(0, 20)}... finish=${props?.info?.finish || "none"}`;
    case "message.part.updated":
      return `type=${props?.part?.type} msgId=${props?.part?.messageID?.slice(0, 20)}... delta=${props?.delta ? `"${props.delta.slice(0, 30)}"` : "none"}`;
    case "session.status":
      return `${props?.status?.type}`;
    case "session.updated":
      return `title="${props?.info?.title}"`;
    case "session.created":
      return `id=${props?.info?.id?.slice(0, 20)}...`;
    case "session.diff":
      return `${props?.diff?.length || 0} files`;
    default:
      return JSON.stringify(props).slice(0, 80);
  }
}
