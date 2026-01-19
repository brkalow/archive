import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { daemonConnections } from "../../src/lib/daemon-connections";

describe("DaemonConnectionManager", () => {
  beforeEach(() => {
    // Clear connections between tests
    daemonConnections.clear();
  });

  afterEach(() => {
    daemonConnections.clear();
  });

  test("tracks daemon connection", () => {
    const mockWs = {
      send: () => {},
      close: () => {},
      data: { type: "daemon" as const, clientId: "client-123" },
    } as unknown as import("bun").ServerWebSocket<{
      type: "daemon";
      clientId?: string;
    }>;

    daemonConnections.addDaemon("client-123", mockWs, {
      can_spawn_sessions: true,
      spawnable_harnesses: [
        {
          id: "claude-code",
          name: "Claude Code",
          available: true,
          supports_permission_relay: true,
          supports_streaming: true,
        },
      ],
    });

    const status = daemonConnections.getStatus();
    expect(status.connected).toBe(true);
    expect(status.client_id).toBe("client-123");
    expect(status.capabilities?.can_spawn_sessions).toBe(true);
  });

  test("returns disconnected status when no daemon", () => {
    const status = daemonConnections.getStatus();
    expect(status.connected).toBe(false);
    expect(status.client_id).toBeUndefined();
  });

  test("replaces existing connection with same clientId", () => {
    let ws1Closed = false;
    const mockWs1 = {
      send: () => {},
      close: () => {
        ws1Closed = true;
      },
      data: { type: "daemon" as const, clientId: "client-123" },
    } as unknown as import("bun").ServerWebSocket<{
      type: "daemon";
      clientId?: string;
    }>;
    const mockWs2 = {
      send: () => {},
      close: () => {},
      data: { type: "daemon" as const, clientId: "client-123" },
    } as unknown as import("bun").ServerWebSocket<{
      type: "daemon";
      clientId?: string;
    }>;

    daemonConnections.addDaemon("client-123", mockWs1, {
      can_spawn_sessions: true,
      spawnable_harnesses: [],
    });
    daemonConnections.addDaemon("client-123", mockWs2, {
      can_spawn_sessions: true,
      spawnable_harnesses: [],
    });

    expect(ws1Closed).toBe(true);
    expect(daemonConnections.getAllConnected().length).toBe(1);
  });

  test("removes daemon on disconnect", () => {
    const mockWs = {
      send: () => {},
      close: () => {},
      data: { type: "daemon" as const, clientId: "client-123" },
    } as unknown as import("bun").ServerWebSocket<{
      type: "daemon";
      clientId?: string;
    }>;

    daemonConnections.addDaemon("client-123", mockWs, {
      can_spawn_sessions: true,
      spawnable_harnesses: [],
    });

    expect(daemonConnections.getStatus().connected).toBe(true);

    daemonConnections.removeDaemon("client-123");

    expect(daemonConnections.getStatus().connected).toBe(false);
  });

  test("getDaemon returns correct daemon", () => {
    const mockWs = {
      send: () => {},
      close: () => {},
      data: { type: "daemon" as const, clientId: "client-123" },
    } as unknown as import("bun").ServerWebSocket<{
      type: "daemon";
      clientId?: string;
    }>;

    daemonConnections.addDaemon("client-123", mockWs, {
      can_spawn_sessions: true,
      spawnable_harnesses: [],
    });

    const daemon = daemonConnections.getDaemon("client-123");
    expect(daemon).toBeDefined();
    expect(daemon?.clientId).toBe("client-123");

    const notFound = daemonConnections.getDaemon("nonexistent");
    expect(notFound).toBeUndefined();
  });

  test("sendToDaemon sends message to correct daemon", () => {
    let sentMessage: string | null = null;
    const mockWs = {
      send: (msg: string) => {
        sentMessage = msg;
      },
      close: () => {},
      data: { type: "daemon" as const, clientId: "client-123" },
    } as unknown as import("bun").ServerWebSocket<{
      type: "daemon";
      clientId?: string;
    }>;

    daemonConnections.addDaemon("client-123", mockWs, {
      can_spawn_sessions: true,
      spawnable_harnesses: [],
    });

    const success = daemonConnections.sendToDaemon("client-123", {
      type: "start_session",
      session_id: "sess_123",
      prompt: "Hello",
      cwd: "/tmp",
    });

    expect(success).toBe(true);
    expect(sentMessage).toBeDefined();
    const parsed = JSON.parse(sentMessage!);
    expect(parsed.type).toBe("start_session");
    expect(parsed.session_id).toBe("sess_123");
  });

  test("sendToDaemon returns false for nonexistent daemon", () => {
    const success = daemonConnections.sendToDaemon("nonexistent", {
      type: "start_session",
      session_id: "sess_123",
      prompt: "Hello",
      cwd: "/tmp",
    });

    expect(success).toBe(false);
  });

  test("tracks spawned sessions for daemon", () => {
    const mockWs = {
      send: () => {},
      close: () => {},
      data: { type: "daemon" as const, clientId: "client-123" },
    } as unknown as import("bun").ServerWebSocket<{
      type: "daemon";
      clientId?: string;
    }>;

    daemonConnections.addDaemon("client-123", mockWs, {
      can_spawn_sessions: true,
      spawnable_harnesses: [],
    });

    daemonConnections.registerSpawnedSession("client-123", "sess_1");
    daemonConnections.registerSpawnedSession("client-123", "sess_2");

    const daemon = daemonConnections.getDaemon("client-123");
    expect(daemon?.activeSpawnedSessions.size).toBe(2);
    expect(daemon?.activeSpawnedSessions.has("sess_1")).toBe(true);
    expect(daemon?.activeSpawnedSessions.has("sess_2")).toBe(true);

    daemonConnections.unregisterSpawnedSession("client-123", "sess_1");
    expect(daemon?.activeSpawnedSessions.size).toBe(1);
    expect(daemon?.activeSpawnedSessions.has("sess_1")).toBe(false);
  });

  test("listConnectedDaemons returns all connected daemons", () => {
    const mockWs1 = {
      send: () => {},
      close: () => {},
      data: { type: "daemon" as const, clientId: "client-1" },
    } as unknown as import("bun").ServerWebSocket<{
      type: "daemon";
      clientId?: string;
    }>;
    const mockWs2 = {
      send: () => {},
      close: () => {},
      data: { type: "daemon" as const, clientId: "client-2" },
    } as unknown as import("bun").ServerWebSocket<{
      type: "daemon";
      clientId?: string;
    }>;

    daemonConnections.addDaemon("client-1", mockWs1, {
      can_spawn_sessions: true,
      spawnable_harnesses: [],
    });
    daemonConnections.addDaemon("client-2", mockWs2, {
      can_spawn_sessions: false,
      spawnable_harnesses: [],
    });

    const all = daemonConnections.getAllConnected();
    expect(all.length).toBe(2);

    const clientIds = all.map((d) => d.clientId);
    expect(clientIds).toContain("client-1");
    expect(clientIds).toContain("client-2");
  });
});
