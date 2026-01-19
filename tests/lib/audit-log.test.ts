import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AuditLogger } from "../../src/lib/audit-log";
import { readFile, unlink } from "fs/promises";
import { join } from "path";

describe("AuditLogger", () => {
  const testLogPath = join("/tmp", `test-audit-${Date.now()}.log`);
  let logger: AuditLogger;

  beforeEach(() => {
    logger = new AuditLogger(testLogPath);
  });

  afterEach(async () => {
    await logger.close();
    try {
      await unlink(testLogPath);
    } catch {
      // File might not exist, ignore
    }
  });

  test("logs entries to file", async () => {
    logger.log({
      session_id: "test-123",
      action: "session_started",
      actor: { type: "browser" },
      details: { cwd: "/test" },
    });

    await logger.flush();

    const content = await readFile(testLogPath, "utf-8");
    const entry = JSON.parse(content.trim());

    expect(entry.session_id).toBe("test-123");
    expect(entry.action).toBe("session_started");
    expect(entry.actor.type).toBe("browser");
    expect(entry.details.cwd).toBe("/test");
    expect(entry.timestamp).toBeDefined();
  });

  test("includes timestamp in entries", async () => {
    logger.log({
      session_id: "test-456",
      action: "session_ended",
      actor: { type: "system" },
      details: {},
    });

    await logger.flush();

    const content = await readFile(testLogPath, "utf-8");
    const entry = JSON.parse(content.trim());

    expect(entry.timestamp).toBeDefined();
    // Timestamp should be ISO format
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  test("writes multiple entries in NDJSON format", async () => {
    logger.log({
      session_id: "test-1",
      action: "session_started",
      actor: { type: "browser" },
      details: {},
    });

    logger.log({
      session_id: "test-2",
      action: "session_ended",
      actor: { type: "system" },
      details: {},
    });

    await logger.flush();

    const content = await readFile(testLogPath, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(2);

    const entry1 = JSON.parse(lines[0]);
    const entry2 = JSON.parse(lines[1]);

    expect(entry1.session_id).toBe("test-1");
    expect(entry2.session_id).toBe("test-2");
  });

  test("handles different action types", async () => {
    const actions = [
      "session_started",
      "session_ended",
      "input_sent",
      "permission_granted",
      "permission_denied",
      "limit_exceeded",
    ] as const;

    for (const action of actions) {
      logger.log({
        session_id: `test-${action}`,
        action,
        actor: { type: "browser" },
        details: {},
      });
    }

    await logger.flush();

    const content = await readFile(testLogPath, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(actions.length);
  });

  test("includes actor information", async () => {
    logger.log({
      session_id: "test-actor",
      action: "session_started",
      actor: {
        type: "browser",
        ip_address: "192.168.1.1",
        user_agent: "Test Browser",
        client_id: "client-123",
      },
      details: {},
    });

    await logger.flush();

    const content = await readFile(testLogPath, "utf-8");
    const entry = JSON.parse(content.trim());

    expect(entry.actor.type).toBe("browser");
    expect(entry.actor.ip_address).toBe("192.168.1.1");
    expect(entry.actor.user_agent).toBe("Test Browser");
    expect(entry.actor.client_id).toBe("client-123");
  });

  test("returns log path", () => {
    expect(logger.getLogPath()).toBe(testLogPath);
  });

  test("flush is idempotent when buffer is empty", async () => {
    // Flush without any entries
    await logger.flush();
    await logger.flush();

    // Should not throw and file might not exist
    try {
      const content = await readFile(testLogPath, "utf-8");
      expect(content).toBe("");
    } catch (error: unknown) {
      // File doesn't exist, that's fine
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});
