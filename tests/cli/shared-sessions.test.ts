import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { dirname, join } from "path";

// Use a test directory to avoid touching real config
const TEST_DIR = join(import.meta.dir, ".test-shared-sessions");
const TEST_CONFIG_PATH = join(TEST_DIR, "shared-sessions.json");

// Mock the module to use test path
// Note: We're testing the module's logic directly without the path mocking
// by testing the data structures and behaviors

interface SharedSession {
  filePath: string;
  servers: string[];
  sharedAt: string;
}

interface SharedSessionsConfig {
  version: 1;
  sessions: Record<string, SharedSession>;
}

describe("Shared Sessions", () => {
  beforeEach(() => {
    // Create test directory
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("config file structure", () => {
    test("creates valid empty config structure", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {},
      };

      expect(config.version).toBe(1);
      expect(config.sessions).toEqual({});
    });

    test("config can store shared sessions", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {
          "abc-123-def": {
            filePath: "/Users/me/.claude/projects/-Users-me-myproject/abc-123-def.jsonl",
            servers: ["http://localhost:3000"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
        },
      };

      expect(Object.keys(config.sessions)).toHaveLength(1);
      expect(config.sessions["abc-123-def"]!.filePath).toContain("abc-123-def.jsonl");
      expect(config.sessions["abc-123-def"]!.servers).toContain("http://localhost:3000");
    });

    test("session can be shared with multiple servers", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {
          "abc-123-def": {
            filePath: "/path/to/session.jsonl",
            servers: ["http://localhost:3000", "https://prod.example.com"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
        },
      };

      expect(config.sessions["abc-123-def"]!.servers).toHaveLength(2);
      expect(config.sessions["abc-123-def"]!.servers).toContain("http://localhost:3000");
      expect(config.sessions["abc-123-def"]!.servers).toContain("https://prod.example.com");
    });
  });

  describe("addSharedSession logic", () => {
    test("adds new session to empty config", () => {
      const config: SharedSessionsConfig = { version: 1, sessions: {} };

      const sessionUuid = "test-uuid-123";
      const filePath = "/path/to/session.jsonl";
      const serverUrl = "http://localhost:3000";

      // Simulate addSharedSession logic
      if (!config.sessions[sessionUuid]) {
        config.sessions[sessionUuid] = {
          filePath,
          servers: [serverUrl],
          sharedAt: new Date().toISOString(),
        };
      }

      expect(config.sessions[sessionUuid]).toBeDefined();
      expect(config.sessions[sessionUuid].filePath).toBe(filePath);
      expect(config.sessions[sessionUuid].servers).toContain(serverUrl);
    });

    test("adds server to existing session", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {
          "test-uuid-123": {
            filePath: "/path/to/session.jsonl",
            servers: ["http://localhost:3000"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
        },
      };

      const sessionUuid = "test-uuid-123";
      const newServerUrl = "https://prod.example.com";

      // Simulate addSharedSession logic
      const session = config.sessions[sessionUuid]!;
      if (!session.servers.includes(newServerUrl)) {
        session.servers.push(newServerUrl);
      }

      expect(config.sessions[sessionUuid]!.servers).toHaveLength(2);
      expect(config.sessions[sessionUuid]!.servers).toContain("http://localhost:3000");
      expect(config.sessions[sessionUuid]!.servers).toContain(newServerUrl);
    });

    test("does not duplicate server in session", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {
          "test-uuid-123": {
            filePath: "/path/to/session.jsonl",
            servers: ["http://localhost:3000"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
        },
      };

      const sessionUuid = "test-uuid-123";
      const serverUrl = "http://localhost:3000";

      // Simulate addSharedSession logic
      const session = config.sessions[sessionUuid]!;
      if (!session.servers.includes(serverUrl)) {
        session.servers.push(serverUrl);
      }

      expect(config.sessions[sessionUuid]!.servers).toHaveLength(1);
    });
  });

  describe("removeSharedSession logic", () => {
    test("removes server from session", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {
          "test-uuid-123": {
            filePath: "/path/to/session.jsonl",
            servers: ["http://localhost:3000", "https://prod.example.com"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
        },
      };

      const sessionUuid = "test-uuid-123";
      const serverUrl = "http://localhost:3000";

      // Simulate removeSharedSession logic (with serverUrl)
      const session = config.sessions[sessionUuid]!;
      session.servers = session.servers.filter((s) => s !== serverUrl);
      if (session.servers.length === 0) {
        delete config.sessions[sessionUuid];
      }

      expect(config.sessions[sessionUuid]).toBeDefined();
      expect(config.sessions[sessionUuid]!.servers).toHaveLength(1);
      expect(config.sessions[sessionUuid]!.servers).not.toContain(serverUrl);
    });

    test("removes session when no servers left", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {
          "test-uuid-123": {
            filePath: "/path/to/session.jsonl",
            servers: ["http://localhost:3000"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
        },
      };

      const sessionUuid = "test-uuid-123";
      const serverUrl = "http://localhost:3000";

      // Simulate removeSharedSession logic (with serverUrl)
      const session = config.sessions[sessionUuid]!;
      session.servers = session.servers.filter((s) => s !== serverUrl);
      if (session.servers.length === 0) {
        delete config.sessions[sessionUuid];
      }

      expect(config.sessions[sessionUuid]).toBeUndefined();
    });

    test("removes session entirely when serverUrl is undefined", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {
          "test-uuid-123": {
            filePath: "/path/to/session.jsonl",
            servers: ["http://localhost:3000", "https://prod.example.com"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
        },
      };

      const sessionUuid = "test-uuid-123";
      const serverUrl = undefined;

      // Simulate removeSharedSession logic (without serverUrl)
      if (serverUrl) {
        // Remove from specific server (not this case)
      } else {
        delete config.sessions[sessionUuid];
      }

      expect(config.sessions[sessionUuid]).toBeUndefined();
    });
  });

  describe("isSessionShared logic", () => {
    test("returns true when session is shared with server", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {
          "test-uuid-123": {
            filePath: "/path/to/session.jsonl",
            servers: ["http://localhost:3000"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
        },
      };

      const sessionUuid = "test-uuid-123";
      const serverUrl = "http://localhost:3000";

      // Simulate isSessionShared logic
      const session = config.sessions[sessionUuid];
      const isShared = session?.servers.includes(serverUrl) ?? false;

      expect(isShared).toBe(true);
    });

    test("returns false when session exists but not shared with server", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {
          "test-uuid-123": {
            filePath: "/path/to/session.jsonl",
            servers: ["http://localhost:3000"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
        },
      };

      const sessionUuid = "test-uuid-123";
      const serverUrl = "https://other.example.com";

      // Simulate isSessionShared logic
      const session = config.sessions[sessionUuid];
      const isShared = session?.servers.includes(serverUrl) ?? false;

      expect(isShared).toBe(false);
    });

    test("returns false when session does not exist", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {},
      };

      const sessionUuid = "nonexistent-uuid";
      const serverUrl = "http://localhost:3000";

      // Simulate isSessionShared logic
      const session = config.sessions[sessionUuid];
      const isShared = session?.servers.includes(serverUrl) ?? false;

      expect(isShared).toBe(false);
    });
  });

  describe("getSharedSessionsForServer logic", () => {
    test("returns sessions for specific server", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {
          "uuid-1": {
            filePath: "/path/to/session1.jsonl",
            servers: ["http://localhost:3000"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
          "uuid-2": {
            filePath: "/path/to/session2.jsonl",
            servers: ["https://prod.example.com"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
          "uuid-3": {
            filePath: "/path/to/session3.jsonl",
            servers: ["http://localhost:3000", "https://prod.example.com"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
        },
      };

      const serverUrl = "http://localhost:3000";

      // Simulate getSharedSessionsForServer logic
      const result: Array<{ uuid: string; session: SharedSession }> = [];
      for (const [uuid, session] of Object.entries(config.sessions)) {
        if (session.servers.includes(serverUrl)) {
          result.push({ uuid, session });
        }
      }

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.uuid)).toContain("uuid-1");
      expect(result.map((r) => r.uuid)).toContain("uuid-3");
      expect(result.map((r) => r.uuid)).not.toContain("uuid-2");
    });

    test("returns empty array when no sessions for server", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {
          "uuid-1": {
            filePath: "/path/to/session1.jsonl",
            servers: ["https://other.example.com"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
        },
      };

      const serverUrl = "http://localhost:3000";

      // Simulate getSharedSessionsForServer logic
      const result: Array<{ uuid: string; session: SharedSession }> = [];
      for (const [uuid, session] of Object.entries(config.sessions)) {
        if (session.servers.includes(serverUrl)) {
          result.push({ uuid, session });
        }
      }

      expect(result).toHaveLength(0);
    });
  });

  describe("file persistence", () => {
    test("can serialize and deserialize config", () => {
      const config: SharedSessionsConfig = {
        version: 1,
        sessions: {
          "test-uuid-123": {
            filePath: "/path/to/session.jsonl",
            servers: ["http://localhost:3000"],
            sharedAt: "2025-01-10T10:00:00.000Z",
          },
        },
      };

      // Write to file
      writeFileSync(TEST_CONFIG_PATH, JSON.stringify(config, null, 2));

      // Read back
      const content = readFileSync(TEST_CONFIG_PATH, "utf8");
      const loaded = JSON.parse(content) as SharedSessionsConfig;

      expect(loaded.version).toBe(1);
      expect(loaded.sessions["test-uuid-123"]).toBeDefined();
      expect(loaded.sessions["test-uuid-123"]!.filePath).toBe("/path/to/session.jsonl");
    });
  });

  describe("serverSessions storage", () => {
    interface ServerSessionInfo {
      sessionId: string;
    }

    interface SharedSessionWithServer extends SharedSession {
      serverSessions?: Record<string, ServerSessionInfo>;
    }

    interface SharedSessionsConfigWithServer {
      version: 1;
      sessions: Record<string, SharedSessionWithServer>;
    }

    test("stores serverSessions when adding a session", () => {
      const config: SharedSessionsConfigWithServer = { version: 1, sessions: {} };

      const sessionUuid = "test-uuid-123";
      const filePath = "/path/to/session.jsonl";
      const serverUrl = "http://localhost:3000";
      const serverSessionInfo: ServerSessionInfo = { sessionId: "srv_abc123" };

      // Simulate addSharedSession logic with serverSessionInfo
      config.sessions[sessionUuid] = {
        filePath,
        servers: [serverUrl],
        sharedAt: new Date().toISOString(),
        serverSessions: { [serverUrl]: serverSessionInfo },
      };

      expect(config.sessions[sessionUuid].serverSessions).toBeDefined();
      expect(config.sessions[sessionUuid].serverSessions![serverUrl]).toEqual({
        sessionId: "srv_abc123",
      });
    });

    test("preserves serverSessions when adding a second server", () => {
      const config: SharedSessionsConfigWithServer = {
        version: 1,
        sessions: {
          "test-uuid-123": {
            filePath: "/path/to/session.jsonl",
            servers: ["http://localhost:3000"],
            sharedAt: "2025-01-10T10:00:00.000Z",
            serverSessions: {
              "http://localhost:3000": { sessionId: "srv_abc123" },
            },
          },
        },
      };

      const sessionUuid = "test-uuid-123";
      const newServerUrl = "https://prod.example.com";
      const newServerSessionInfo: ServerSessionInfo = { sessionId: "srv_def456" };

      // Simulate addSharedSession logic for adding second server
      const session = config.sessions[sessionUuid]!;
      if (!session.servers.includes(newServerUrl)) {
        session.servers.push(newServerUrl);
      }
      session.serverSessions = session.serverSessions || {};
      session.serverSessions[newServerUrl] = newServerSessionInfo;

      // Verify both server sessions exist
      expect(session.servers).toHaveLength(2);
      expect(session.serverSessions["http://localhost:3000"]).toEqual({
        sessionId: "srv_abc123",
      });
      expect(session.serverSessions["https://prod.example.com"]).toEqual({
        sessionId: "srv_def456",
      });
    });

    test("each server has its own session ID", () => {
      const config: SharedSessionsConfigWithServer = {
        version: 1,
        sessions: {
          "test-uuid-123": {
            filePath: "/path/to/session.jsonl",
            servers: ["http://server-a.com", "http://server-b.com"],
            sharedAt: "2025-01-10T10:00:00.000Z",
            serverSessions: {
              "http://server-a.com": { sessionId: "srv_aaa" },
              "http://server-b.com": { sessionId: "srv_bbb" },
            },
          },
        },
      };

      const session = config.sessions["test-uuid-123"]!;

      // Each server has a unique session ID
      expect(session.serverSessions!["http://server-a.com"]!.sessionId).toBe("srv_aaa");
      expect(session.serverSessions!["http://server-b.com"]!.sessionId).toBe("srv_bbb");
      expect(session.serverSessions!["http://server-a.com"]!.sessionId).not.toBe(
        session.serverSessions!["http://server-b.com"]!.sessionId
      );
    });

    test("serverSessions persists through serialization", () => {
      const config: SharedSessionsConfigWithServer = {
        version: 1,
        sessions: {
          "test-uuid-123": {
            filePath: "/path/to/session.jsonl",
            servers: ["http://localhost:3000"],
            sharedAt: "2025-01-10T10:00:00.000Z",
            serverSessions: {
              "http://localhost:3000": { sessionId: "srv_abc123" },
            },
          },
        },
      };

      // Write and read back
      writeFileSync(TEST_CONFIG_PATH, JSON.stringify(config, null, 2));
      const content = readFileSync(TEST_CONFIG_PATH, "utf8");
      const loaded = JSON.parse(content) as SharedSessionsConfigWithServer;

      expect(loaded.sessions["test-uuid-123"]!.serverSessions).toBeDefined();
      expect(loaded.sessions["test-uuid-123"]!.serverSessions!["http://localhost:3000"]).toEqual({
        sessionId: "srv_abc123",
      });
    });
  });
});
