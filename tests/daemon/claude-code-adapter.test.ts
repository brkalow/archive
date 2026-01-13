import { describe, test, expect, beforeEach } from "bun:test";
import { claudeCodeAdapter } from "../../cli/adapters/claude-code";
import type { ParseContext } from "../../cli/adapters/types";

describe("Claude Code Adapter", () => {
  describe("canHandle", () => {
    test("recognizes Claude Code session files", () => {
      expect(
        claudeCodeAdapter.canHandle(
          "/Users/me/.claude/projects/-Users-me-myproject/abc123.jsonl"
        )
      ).toBe(true);
    });

    test("rejects non-Claude paths", () => {
      expect(
        claudeCodeAdapter.canHandle("/Users/me/.cursor/conversations/abc.json")
      ).toBe(false);
    });

    test("rejects non-jsonl files in .claude directory", () => {
      expect(
        claudeCodeAdapter.canHandle("/Users/me/.claude/projects/config.json")
      ).toBe(false);
    });

    test("requires .claude/projects in path", () => {
      expect(
        claudeCodeAdapter.canHandle("/Users/me/.claude/abc123.jsonl")
      ).toBe(false);
    });
  });

  describe("getSessionInfo", () => {
    test("extracts session ID from file path", () => {
      const info = claudeCodeAdapter.getSessionInfo(
        "/Users/me/.claude/projects/-Users-me-myproject/abc123.jsonl"
      );

      expect(info.harnessSessionId).toBe("abc123");
    });

    test("extracts project path from encoded format", () => {
      const info = claudeCodeAdapter.getSessionInfo(
        "/Users/me/.claude/projects/-Users-me-myproject/abc123.jsonl"
      );

      expect(info.projectPath).toContain("Users");
      expect(info.projectPath).toContain("myproject");
    });

    test("returns local path", () => {
      const filePath = "/Users/me/.claude/projects/-Users-me-myproject/abc123.jsonl";
      const info = claudeCodeAdapter.getSessionInfo(filePath);

      expect(info.localPath).toBe(filePath);
    });
  });

  describe("parseLine", () => {
    let context: ParseContext;

    beforeEach(() => {
      context = { messages: [], pendingToolUses: new Map() };
    });

    test("handles user message with string content", () => {
      const result = claudeCodeAdapter.parseLine(
        '{"type":"user","message":{"role":"user","content":"Hello"},"timestamp":"2025-01-11T10:00:00Z"}',
        context
      );

      expect(result).toHaveLength(1);
      expect(result![0].role).toBe("user");
      expect(result![0].content_blocks[0]).toEqual({ type: "text", text: "Hello" });
    });

    test("normalizes 'human' role to 'user'", () => {
      const result = claudeCodeAdapter.parseLine(
        '{"message":{"role":"human","content":"Hello"}}',
        context
      );

      expect(result).toHaveLength(1);
      expect(result![0].role).toBe("user");
    });

    test("handles assistant message with array content", () => {
      const result = claudeCodeAdapter.parseLine(
        '{"message":{"role":"assistant","content":[{"type":"text","text":"Let me help."}]}}',
        context
      );

      expect(result).toHaveLength(1);
      expect(result![0].role).toBe("assistant");
      expect(result![0].content_blocks[0]).toEqual({ type: "text", text: "Let me help." });
    });

    test("handles tool_use block", () => {
      const result = claudeCodeAdapter.parseLine(
        '{"message":{"role":"assistant","content":[{"type":"text","text":"Let me read that."},{"type":"tool_use","id":"tu_001","name":"Read","input":{"file_path":"test.txt"}}]}}',
        context
      );

      expect(result).toHaveLength(1);
      context.messages.push(...result!);

      expect(context.pendingToolUses.has("tu_001")).toBe(true);
      expect(result![0].content_blocks).toHaveLength(2);
      expect(result![0].content_blocks[1].type).toBe("tool_use");
      expect(result![0].content_blocks[1].id).toBe("tu_001");
    });

    test("handles tool_result and attaches to pending tool_use", () => {
      // First, add a message with tool_use
      const assistantMsg = claudeCodeAdapter.parseLine(
        '{"message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_001","name":"Read","input":{}}]}}',
        context
      );
      context.messages.push(...assistantMsg!);

      // Then process tool_result
      const result = claudeCodeAdapter.parseLine(
        '{"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_001","content":"file contents"}]}}',
        context
      );

      // tool_result should not create a new message
      expect(result).toBeNull();

      // Result should be attached to the tool_use block
      const toolUseBlock = context.messages[0].content_blocks[0];
      expect(toolUseBlock.result).toBe("file contents");
    });

    test("skips malformed JSON", () => {
      const result = claudeCodeAdapter.parseLine("not valid json", context);
      expect(result).toBeNull();
    });

    test("skips empty lines", () => {
      const result = claudeCodeAdapter.parseLine("   ", context);
      expect(result).toBeNull();
    });

    test("skips unknown message types", () => {
      const result = claudeCodeAdapter.parseLine(
        '{"message":{"role":"system","content":"You are helpful."}}',
        context
      );
      expect(result).toBeNull();
    });

    test("extracts timestamp from data", () => {
      const result = claudeCodeAdapter.parseLine(
        '{"message":{"role":"user","content":"Hi"},"timestamp":"2025-01-11T10:00:00Z"}',
        context
      );

      expect(result![0].timestamp).toBe("2025-01-11T10:00:00Z");
    });
  });

  describe("deriveTitle", () => {
    test("uses first user message text", () => {
      const messages = [
        { role: "user" as const, content_blocks: [{ type: "text", text: "Please help me implement auth" }] },
        { role: "assistant" as const, content_blocks: [{ type: "text", text: "Sure!" }] },
      ];

      const title = claudeCodeAdapter.deriveTitle!(messages);
      expect(title).toBe("Please help me implement auth");
    });

    test("truncates long titles at word boundary", () => {
      const longText = "This is a very long message that should be truncated because it exceeds the maximum length allowed for titles";
      const messages = [
        { role: "user" as const, content_blocks: [{ type: "text", text: longText }] },
      ];

      const title = claudeCodeAdapter.deriveTitle!(messages);
      expect(title.length).toBeLessThanOrEqual(83); // 80 + "..."
      expect(title.endsWith("...")).toBe(true);
    });

    test("returns 'Untitled Session' when no user messages", () => {
      const messages = [
        { role: "assistant" as const, content_blocks: [{ type: "text", text: "Hello" }] },
      ];

      const title = claudeCodeAdapter.deriveTitle!(messages);
      expect(title).toBe("Untitled Session");
    });

    test("returns 'Untitled Session' when user message has no text", () => {
      const messages = [
        { role: "user" as const, content_blocks: [{ type: "tool_result", tool_use_id: "123" }] },
      ];

      const title = claudeCodeAdapter.deriveTitle!(messages);
      expect(title).toBe("Untitled Session");
    });

    test("cleans up newlines and extra whitespace", () => {
      const messages = [
        { role: "user" as const, content_blocks: [{ type: "text", text: "Hello\n\nWorld  test" }] },
      ];

      const title = claudeCodeAdapter.deriveTitle!(messages);
      expect(title).toBe("Hello World test");
    });
  });

  describe("getWatchPaths", () => {
    test("returns path based on HOME env", () => {
      const paths = claudeCodeAdapter.getWatchPaths();

      if (Bun.env.HOME) {
        expect(paths).toHaveLength(1);
        expect(paths[0]).toBe(`${Bun.env.HOME}/.claude/projects`);
      } else {
        expect(paths).toHaveLength(0);
      }
    });
  });
});
