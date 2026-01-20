import { describe, test, expect, beforeEach, mock } from "bun:test";
import { SpawnedSessionManager } from "../../cli/lib/spawned-session-manager";
import type {
  DaemonToServerMessage,
  StartSessionMessage,
} from "../../cli/types/daemon-ws";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("SpawnedSessionManager", () => {
  let manager: SpawnedSessionManager;
  let sentMessages: DaemonToServerMessage[];
  let tempDir: string;

  beforeEach(() => {
    sentMessages = [];
    manager = new SpawnedSessionManager((msg) => {
      sentMessages.push(msg);
    });
    // Create a temp directory for testing
    tempDir = mkdtempSync(join(tmpdir(), "spawner-test-"));
  });

  describe("validateWorkingDirectory", () => {
    test("rejects invalid working directory", async () => {
      const request: StartSessionMessage = {
        type: "start_session",
        session_id: "test-123",
        prompt: "Test prompt",
        cwd: "/nonexistent/path/that/does/not/exist",
      };

      await manager.startSession(request);

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].type).toBe("session_ended");
      const msg = sentMessages[0] as {
        type: "session_ended";
        error?: string;
        exit_code: number;
      };
      expect(msg.error).toContain("Invalid working directory");
      expect(msg.exit_code).toBe(1);
    });

    test("accepts valid working directory", async () => {
      // The manager will try to spawn claude, which may fail if not installed
      // But it should not fail validation
      const request: StartSessionMessage = {
        type: "start_session",
        session_id: "test-valid-dir",
        prompt: "Test prompt",
        cwd: tempDir,
      };

      await manager.startSession(request);

      // If claude is installed, it will start; if not, we get an error
      // Either way, we should NOT get "Invalid working directory" error
      const endMsg = sentMessages.find((m) => m.type === "session_ended") as
        | { type: "session_ended"; error?: string }
        | undefined;

      if (endMsg?.error) {
        expect(endMsg.error).not.toContain("Invalid working directory");
      }
    });
  });

  describe("buildClaudeArgs", () => {
    test("builds correct args with minimal request", () => {
      const args = (manager as any).buildClaudeArgs({
        prompt: "Test prompt",
        cwd: "/tmp",
      });

      // Note: prompt is sent via stdin, not -p, when using --input-format stream-json
      expect(args).not.toContain("-p");
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--input-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--verbose");
    });

    test("builds correct args with model", () => {
      const args = (manager as any).buildClaudeArgs({
        prompt: "Test prompt",
        cwd: "/tmp",
        model: "claude-sonnet-4-20250514",
      });

      expect(args).toContain("--model");
      expect(args).toContain("claude-sonnet-4-20250514");
    });

    test("builds correct args with resume session", () => {
      const args = (manager as any).buildClaudeArgs({
        prompt: "Test prompt",
        cwd: "/tmp",
        resume_session_id: "prev-session-123",
      });

      expect(args).toContain("--resume");
      expect(args).toContain("prev-session-123");
    });

    test("builds correct args with permission_mode relay", () => {
      const args = (manager as any).buildClaudeArgs({
        prompt: "Test prompt",
        cwd: "/tmp",
        permission_mode: "relay",
      });

      expect(args).toContain("--permission-prompt-tool");
      expect(args).toContain("stdio");
    });

    test("builds correct args with permission_mode auto", () => {
      const args = (manager as any).buildClaudeArgs({
        prompt: "Test prompt",
        cwd: "/tmp",
        permission_mode: "auto",
      });

      expect(args).toContain("--dangerously-skip-permissions");
    });

    test("builds correct args with permission_mode auto-safe", () => {
      const args = (manager as any).buildClaudeArgs({
        prompt: "Test prompt",
        cwd: "/tmp",
        permission_mode: "auto-safe",
      });

      // auto-safe uses stdio permission tool like relay
      expect(args).toContain("--permission-prompt-tool");
      expect(args).toContain("stdio");
      expect(args).not.toContain("--dangerously-skip-permissions");
    });

    test("builds correct args with no permission_mode (no flag)", () => {
      const args = (manager as any).buildClaudeArgs({
        prompt: "Test prompt",
        cwd: "/tmp",
      });

      expect(args).not.toContain("--permission-prompt-tool");
      expect(args).not.toContain("--dangerously-skip-permissions");
    });
  });

  describe("session management", () => {
    test("getActiveSessions returns empty array when no sessions", () => {
      expect(manager.getActiveSessions()).toEqual([]);
    });

    test("getAllSessionInfo returns empty array when no sessions", () => {
      expect(manager.getAllSessionInfo()).toEqual([]);
    });

    test("getSession returns undefined for nonexistent session", () => {
      expect(manager.getSession("nonexistent")).toBeUndefined();
    });

    test("getSessionInfo returns undefined for nonexistent session", () => {
      expect(manager.getSessionInfo("nonexistent")).toBeUndefined();
    });

    test("getSessionHistory returns empty array for nonexistent session", () => {
      expect(manager.getSessionHistory("nonexistent")).toEqual([]);
    });
  });

  describe("sendInput", () => {
    test("sendInput logs error for nonexistent session", async () => {
      // Should not throw, just log
      await manager.sendInput("nonexistent", "test input");
      // No messages sent to server
      expect(sentMessages.length).toBe(0);
    });
  });

  describe("endSession", () => {
    test("endSession does nothing for nonexistent session", async () => {
      // Should not throw
      await manager.endSession("nonexistent");
      expect(sentMessages.length).toBe(0);
    });
  });

  describe("interruptSession", () => {
    test("interruptSession does nothing for nonexistent session", async () => {
      // Should not throw
      await manager.interruptSession("nonexistent");
      expect(sentMessages.length).toBe(0);
    });
  });

  describe("injectToolResult", () => {
    test("injectToolResult does nothing for nonexistent session", async () => {
      // Should not throw
      await manager.injectToolResult("nonexistent", "tool-123", "result");
      expect(sentMessages.length).toBe(0);
    });
  });

  describe("processStreamMessage", () => {
    test("extracts claude session ID from init message", () => {
      // Create a mock session to test message processing
      const session = {
        id: "test-session",
        claudeSessionId: undefined,
        state: "starting" as const,
        outputHistory: [] as any[],
        maxHistorySize: 1000,
      };

      // Call private method
      (manager as any).processStreamMessage(session, {
        type: "system",
        subtype: "init",
        session_id: "claude-internal-123",
      });

      expect(session.claudeSessionId).toBe("claude-internal-123");
      expect(session.state).toBe("running");
    });

    test("updates state to waiting on result message", () => {
      const session = {
        id: "test-session",
        state: "running" as const,
        outputHistory: [] as any[],
        maxHistorySize: 1000,
      };

      (manager as any).processStreamMessage(session, {
        type: "result",
        duration_ms: 1000,
      });

      expect(session.state).toBe("waiting");
    });

    test("detects AskUserQuestion tool use", () => {
      const session = {
        id: "test-session",
        state: "waiting" as const,
        pendingToolUseId: undefined,
        outputHistory: [] as any[],
        maxHistorySize: 1000,
      };

      (manager as any).processStreamMessage(session, {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-use-123",
              name: "AskUserQuestion",
              input: {
                question: "What color?",
                options: ["Red", "Blue", "Green"],
              },
            },
          ],
        },
      });

      expect(session.state).toBe("running");
      expect(session.pendingToolUseId).toBe("tool-use-123");

      // Check question_prompt message was sent
      expect(sentMessages.length).toBe(1);
      const msg = sentMessages[0] as {
        type: "question_prompt";
        session_id: string;
        tool_use_id: string;
        question: string;
        options?: string[];
      };
      expect(msg.type).toBe("question_prompt");
      expect(msg.session_id).toBe("test-session");
      expect(msg.tool_use_id).toBe("tool-use-123");
      expect(msg.question).toBe("What color?");
      expect(msg.options).toEqual(["Red", "Blue", "Green"]);
    });

    test("detects control_request message and relays to server", () => {
      const session = {
        id: "test-session",
        state: "running" as const,
        controlRequests: new Map(),
        outputHistory: [] as any[],
        maxHistorySize: 1000,
      };

      (manager as any).processStreamMessage(session, {
        type: "control_request",
        request_id: "req-123",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "ls -la" },
          tool_use_id: "toolu-456",
          decision_reason: "Bash command requires approval",
        },
      });

      // Check control_request was stored
      expect(session.controlRequests.size).toBe(1);
      expect(session.controlRequests.get("req-123")).toMatchObject({
        request_id: "req-123",
        tool_name: "Bash",
        tool_use_id: "toolu-456",
      });

      // Check control_request message was sent to server
      expect(sentMessages.length).toBe(1);
      const msg = sentMessages[0] as {
        type: "control_request";
        session_id: string;
        request_id: string;
        request: any;
      };
      expect(msg.type).toBe("control_request");
      expect(msg.session_id).toBe("test-session");
      expect(msg.request_id).toBe("req-123");
      expect(msg.request.tool_name).toBe("Bash");
      expect(msg.request.input).toEqual({ command: "ls -la" });
    });
  });

  describe("respondToControlRequest", () => {
    test("respondToControlRequest does nothing for nonexistent session", async () => {
      await manager.respondToControlRequest("nonexistent", "req-123", { behavior: "allow" });
      expect(sentMessages.length).toBe(0);
    });

    test("respondToControlRequest does nothing for nonexistent request", async () => {
      // Create a mock session
      const mockSession = {
        id: "test-session",
        stdin: { write: mock(() => {}), flush: mock(() => {}) },
        controlRequests: new Map(),
      };
      (manager as any).sessions.set("test-session", mockSession);

      await manager.respondToControlRequest("test-session", "req-123", { behavior: "allow" });

      // stdin.write should not have been called
      expect(mockSession.stdin.write).not.toHaveBeenCalled();
    });
  });

  describe("recordMessage", () => {
    test("records messages to history", () => {
      const session = {
        outputHistory: [] as any[],
        maxHistorySize: 100,
      };

      const msg = { type: "assistant", message: { role: "assistant", content: [] } };
      (manager as any).recordMessage(session, msg);

      expect(session.outputHistory.length).toBe(1);
      expect(session.outputHistory[0]).toBe(msg);
    });

    test("trims history when exceeding max size", () => {
      const session = {
        outputHistory: [] as any[],
        maxHistorySize: 3,
      };

      // Add 5 messages
      for (let i = 0; i < 5; i++) {
        (manager as any).recordMessage(session, { index: i });
      }

      // Should only keep last 3
      expect(session.outputHistory.length).toBe(3);
      expect((session.outputHistory[0] as any).index).toBe(2);
      expect((session.outputHistory[2] as any).index).toBe(4);
    });
  });

  describe("sendSessionMetadata", () => {
    test("sends session_metadata message after init", () => {
      // Clear any previous messages
      sentMessages.length = 0;

      // Create a mock session with cwd
      const session = {
        id: "test-session-metadata",
        cwd: tempDir,
        claudeSessionId: undefined,
        state: "starting" as const,
        outputHistory: [] as any[],
        maxHistorySize: 1000,
      };

      // Process an init message which triggers sendSessionMetadata
      (manager as any).processStreamMessage(session, {
        type: "system",
        subtype: "init",
        session_id: "claude-session-abc123",
      });

      // Wait a bit for the async metadata fetch
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          // Should have sent a session_metadata message
          const metadataMsg = sentMessages.find(
            (m) => m.type === "session_metadata"
          ) as {
            type: "session_metadata";
            session_id: string;
            agent_session_id?: string;
            repo_url?: string;
            branch?: string;
          } | undefined;

          expect(metadataMsg).toBeDefined();
          expect(metadataMsg!.session_id).toBe("test-session-metadata");
          expect(metadataMsg!.agent_session_id).toBe("claude-session-abc123");
          // repo_url and branch may be undefined since tempDir isn't a git repo
          resolve();
        }, 100);
      });
    });

    test("sendSessionMetadata extracts git info from git repo", async () => {
      // Create a git repo in temp dir
      const gitDir = mkdtempSync(join(tmpdir(), "git-test-"));
      try {
        // Initialize git repo
        const initResult = Bun.spawnSync(["git", "init"], { cwd: gitDir });
        expect(initResult.exitCode).toBe(0);

        // Configure git user for the test
        Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: gitDir });
        Bun.spawnSync(["git", "config", "user.name", "Test User"], { cwd: gitDir });

        // Create initial commit to establish a branch
        Bun.spawnSync(["touch", "README.md"], { cwd: gitDir });
        Bun.spawnSync(["git", "add", "."], { cwd: gitDir });
        Bun.spawnSync(["git", "commit", "-m", "Initial commit"], { cwd: gitDir });

        // Create a test branch
        Bun.spawnSync(["git", "checkout", "-b", "test-branch"], { cwd: gitDir });

        sentMessages.length = 0;

        const session = {
          id: "git-test-session",
          cwd: gitDir,
        };

        // Call sendSessionMetadata directly
        await (manager as any).sendSessionMetadata(session, "claude-xyz");

        // Check that session_metadata was sent with branch info
        const metadataMsg = sentMessages.find(
          (m) => m.type === "session_metadata"
        ) as {
          type: "session_metadata";
          session_id: string;
          agent_session_id?: string;
          repo_url?: string;
          branch?: string;
        };

        expect(metadataMsg).toBeDefined();
        expect(metadataMsg.session_id).toBe("git-test-session");
        expect(metadataMsg.agent_session_id).toBe("claude-xyz");
        expect(metadataMsg.branch).toBe("test-branch");
        // repo_url will be undefined since there's no remote
        expect(metadataMsg.repo_url).toBeUndefined();
      } finally {
        // Cleanup
        rmSync(gitDir, { recursive: true });
      }
    });
  });

  describe("isGitModifyingCommand", () => {
    test("detects simple git checkout", () => {
      expect((manager as any).isGitModifyingCommand("git checkout main")).toBe(true);
      expect((manager as any).isGitModifyingCommand("git checkout -- README.md")).toBe(true);
    });

    test("detects git reset", () => {
      expect((manager as any).isGitModifyingCommand("git reset --hard")).toBe(true);
      expect((manager as any).isGitModifyingCommand("git reset HEAD~1")).toBe(true);
    });

    test("detects git with flags before subcommand", () => {
      expect((manager as any).isGitModifyingCommand("git -C /path/to/repo checkout main")).toBe(true);
      expect((manager as any).isGitModifyingCommand("git --no-pager reset --hard")).toBe(true);
    });

    test("detects git in compound commands", () => {
      expect((manager as any).isGitModifyingCommand("cd /repo && git checkout main")).toBe(true);
      expect((manager as any).isGitModifyingCommand("git add . && git stash")).toBe(true);
    });

    test("detects various git modifying subcommands", () => {
      expect((manager as any).isGitModifyingCommand("git restore README.md")).toBe(true);
      expect((manager as any).isGitModifyingCommand("git stash pop")).toBe(true);
      expect((manager as any).isGitModifyingCommand("git clean -fd")).toBe(true);
      expect((manager as any).isGitModifyingCommand("git revert HEAD")).toBe(true);
      expect((manager as any).isGitModifyingCommand("git merge feature")).toBe(true);
      expect((manager as any).isGitModifyingCommand("git rebase main")).toBe(true);
      expect((manager as any).isGitModifyingCommand("git pull origin main")).toBe(true);
      expect((manager as any).isGitModifyingCommand("git cherry-pick abc123")).toBe(true);
    });

    test("ignores non-modifying git commands", () => {
      expect((manager as any).isGitModifyingCommand("git status")).toBe(false);
      expect((manager as any).isGitModifyingCommand("git log")).toBe(false);
      expect((manager as any).isGitModifyingCommand("git diff")).toBe(false);
      expect((manager as any).isGitModifyingCommand("git branch -a")).toBe(false);
      expect((manager as any).isGitModifyingCommand("git show HEAD")).toBe(false);
    });

    test("ignores non-git commands", () => {
      expect((manager as any).isGitModifyingCommand("ls -la")).toBe(false);
      expect((manager as any).isGitModifyingCommand("echo hello")).toBe(false);
      expect((manager as any).isGitModifyingCommand("npm install")).toBe(false);
    });

    test("does not match partial word matches", () => {
      // "checkout" appearing in a different context
      expect((manager as any).isGitModifyingCommand("echo checkout")).toBe(false);
      // "git" as part of another word
      expect((manager as any).isGitModifyingCommand("digit checkout")).toBe(false);
    });
  });
});
