import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnedSessionRegistry } from "../src/lib/spawned-session-registry";

describe("SpawnedSessionRegistry", () => {
  beforeEach(() => {
    // Clear registry between tests
    spawnedSessionRegistry.clear();
  });

  afterEach(() => {
    spawnedSessionRegistry.clear();
  });

  test("creates and retrieves session", () => {
    spawnedSessionRegistry.createSession({
      id: "test-123",
      daemonClientId: "daemon-1",
      cwd: "/test/path",
      harness: "claude-code",
      status: "starting",
      createdAt: new Date(),
    });

    const session = spawnedSessionRegistry.getSession("test-123");
    expect(session).toBeDefined();
    expect(session?.status).toBe("starting");
    expect(session?.cwd).toBe("/test/path");
    expect(session?.harness).toBe("claude-code");
    expect(session?.daemonClientId).toBe("daemon-1");
  });

  test("returns undefined for non-existent session", () => {
    const session = spawnedSessionRegistry.getSession("non-existent");
    expect(session).toBeUndefined();
  });

  test("updates session status", () => {
    spawnedSessionRegistry.createSession({
      id: "test-456",
      daemonClientId: "daemon-1",
      cwd: "/test",
      harness: "claude-code",
      status: "starting",
      createdAt: new Date(),
    });

    spawnedSessionRegistry.updateSession("test-456", { status: "running" });

    const session = spawnedSessionRegistry.getSession("test-456");
    expect(session?.status).toBe("running");
    expect(session?.lastActivityAt).toBeDefined();
  });

  test("updates session with multiple fields", () => {
    spawnedSessionRegistry.createSession({
      id: "test-multi",
      daemonClientId: "daemon-1",
      cwd: "/test",
      harness: "claude-code",
      status: "starting",
      createdAt: new Date(),
    });

    spawnedSessionRegistry.updateSession("test-multi", {
      status: "running",
      claudeSessionId: "claude-abc123",
    });

    const session = spawnedSessionRegistry.getSession("test-multi");
    expect(session?.status).toBe("running");
    expect(session?.claudeSessionId).toBe("claude-abc123");
  });

  test("deletes session", () => {
    spawnedSessionRegistry.createSession({
      id: "test-delete",
      daemonClientId: "daemon-1",
      cwd: "/test",
      harness: "claude-code",
      status: "starting",
      createdAt: new Date(),
    });

    expect(spawnedSessionRegistry.getSession("test-delete")).toBeDefined();

    spawnedSessionRegistry.deleteSession("test-delete");

    expect(spawnedSessionRegistry.getSession("test-delete")).toBeUndefined();
  });

  test("filters active sessions", () => {
    // Create an active session
    spawnedSessionRegistry.createSession({
      id: "active-1",
      daemonClientId: "daemon-1",
      cwd: "/test",
      harness: "claude-code",
      status: "running",
      createdAt: new Date(),
    });

    // Create another active session
    spawnedSessionRegistry.createSession({
      id: "active-2",
      daemonClientId: "daemon-1",
      cwd: "/test2",
      harness: "claude-code",
      status: "waiting",
      createdAt: new Date(),
    });

    // Create an ended session
    spawnedSessionRegistry.createSession({
      id: "ended-1",
      daemonClientId: "daemon-1",
      cwd: "/test3",
      harness: "claude-code",
      status: "ended",
      createdAt: new Date(),
    });

    // Create a failed session
    spawnedSessionRegistry.createSession({
      id: "failed-1",
      daemonClientId: "daemon-1",
      cwd: "/test4",
      harness: "claude-code",
      status: "failed",
      createdAt: new Date(),
    });

    const active = spawnedSessionRegistry.getActiveSessions();
    expect(active.length).toBe(2);
    expect(active.map((s) => s.id).sort()).toEqual(["active-1", "active-2"]);
  });

  test("gets sessions by daemon", () => {
    spawnedSessionRegistry.createSession({
      id: "daemon1-session1",
      daemonClientId: "daemon-1",
      cwd: "/test",
      harness: "claude-code",
      status: "running",
      createdAt: new Date(),
    });

    spawnedSessionRegistry.createSession({
      id: "daemon2-session1",
      daemonClientId: "daemon-2",
      cwd: "/test2",
      harness: "claude-code",
      status: "running",
      createdAt: new Date(),
    });

    spawnedSessionRegistry.createSession({
      id: "daemon1-session2",
      daemonClientId: "daemon-1",
      cwd: "/test3",
      harness: "claude-code",
      status: "running",
      createdAt: new Date(),
    });

    const daemon1Sessions = spawnedSessionRegistry.getSessionsByDaemon("daemon-1");
    expect(daemon1Sessions.length).toBe(2);
    expect(daemon1Sessions.map((s) => s.id).sort()).toEqual([
      "daemon1-session1",
      "daemon1-session2",
    ]);

    const daemon2Sessions = spawnedSessionRegistry.getSessionsByDaemon("daemon-2");
    expect(daemon2Sessions.length).toBe(1);
    expect(daemon2Sessions[0].id).toBe("daemon2-session1");
  });

  test("checks if session is spawned", () => {
    spawnedSessionRegistry.createSession({
      id: "spawned-session",
      daemonClientId: "daemon-1",
      cwd: "/test",
      harness: "claude-code",
      status: "running",
      createdAt: new Date(),
    });

    expect(spawnedSessionRegistry.isSpawnedSession("spawned-session")).toBe(true);
    expect(spawnedSessionRegistry.isSpawnedSession("not-spawned")).toBe(false);
  });

  test("getAllSessions returns all sessions", () => {
    spawnedSessionRegistry.createSession({
      id: "session-1",
      daemonClientId: "daemon-1",
      cwd: "/test",
      harness: "claude-code",
      status: "running",
      createdAt: new Date(),
    });

    spawnedSessionRegistry.createSession({
      id: "session-2",
      daemonClientId: "daemon-1",
      cwd: "/test",
      harness: "claude-code",
      status: "ended",
      createdAt: new Date(),
    });

    const all = spawnedSessionRegistry.getAllSessions();
    expect(all.length).toBe(2);
  });

  test("clear removes all sessions", () => {
    spawnedSessionRegistry.createSession({
      id: "session-1",
      daemonClientId: "daemon-1",
      cwd: "/test",
      harness: "claude-code",
      status: "running",
      createdAt: new Date(),
    });

    spawnedSessionRegistry.createSession({
      id: "session-2",
      daemonClientId: "daemon-1",
      cwd: "/test",
      harness: "claude-code",
      status: "running",
      createdAt: new Date(),
    });

    expect(spawnedSessionRegistry.getAllSessions().length).toBe(2);

    spawnedSessionRegistry.clear();

    expect(spawnedSessionRegistry.getAllSessions().length).toBe(0);
  });
});

describe("Session ID generation format", () => {
  test("spawned session IDs start with spawn_", () => {
    // Test the ID format matches our specification
    const timestamp = Date.now();
    const randomPart = Math.random().toString(36).slice(2, 10);
    const sessionId = `spawn_${timestamp}_${randomPart}`;

    expect(sessionId).toMatch(/^spawn_\d+_[a-z0-9]+$/);
    expect(sessionId.startsWith("spawn_")).toBe(true);
  });
});
