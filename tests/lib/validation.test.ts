import { describe, test, expect } from "bun:test";
import {
  validateJson,
  validateFormData,
  validateQueryParams,
  SpawnSessionSchema,
  CreateLiveSessionSchema,
  PushMessagesSchema,
  PushToolResultsSchema,
  PatchSessionSchema,
  CompleteSessionSchema,
  TimeseriesQuerySchema,
  CreateSessionFormSchema,
  UpdateSessionFormSchema,
  ContentBlockSchema,
} from "../../src/lib/validation";

describe("Content Block Schemas", () => {
  test("TextBlock parses correctly", () => {
    const result = ContentBlockSchema.safeParse({ type: "text", text: "Hello" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ type: "text", text: "Hello" });
    }
  });

  test("ToolUseBlock parses correctly", () => {
    const result = ContentBlockSchema.safeParse({
      type: "tool_use",
      id: "tool-1",
      name: "read_file",
      input: { path: "/test.txt" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("tool_use");
    }
  });

  test("ToolResultBlock parses correctly", () => {
    const result = ContentBlockSchema.safeParse({
      type: "tool_result",
      tool_use_id: "tool-1",
      content: "File contents here",
      is_error: false,
    });
    expect(result.success).toBe(true);
  });

  test("ThinkingBlock parses correctly", () => {
    const result = ContentBlockSchema.safeParse({
      type: "thinking",
      thinking: "Let me think...",
      duration_ms: 100,
    });
    expect(result.success).toBe(true);
  });

  test("ImageBlock with base64 parses correctly", () => {
    const result = ContentBlockSchema.safeParse({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "abc123" },
    });
    expect(result.success).toBe(true);
  });

  test("ImageBlock with URL parses correctly", () => {
    const result = ContentBlockSchema.safeParse({
      type: "image",
      source: { type: "url", url: "https://example.com/img.png" },
    });
    expect(result.success).toBe(true);
  });

  test("Invalid block type fails", () => {
    const result = ContentBlockSchema.safeParse({
      type: "invalid",
      content: "test",
    });
    expect(result.success).toBe(false);
  });
});

describe("SpawnSessionSchema", () => {
  test("valid minimal payload", () => {
    const result = SpawnSessionSchema.safeParse({
      prompt: "Hello",
      cwd: "/home/user/project",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.harness).toBe("claude-code"); // default
      expect(result.data.permission_mode).toBe("relay"); // default
    }
  });

  test("valid full payload", () => {
    const result = SpawnSessionSchema.safeParse({
      prompt: "Hello",
      cwd: "/home/user/project",
      harness: "custom-harness",
      model: "claude-3-opus",
      permission_mode: "auto-safe",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.harness).toBe("custom-harness");
      expect(result.data.permission_mode).toBe("auto-safe");
    }
  });

  test("missing prompt fails", () => {
    const result = SpawnSessionSchema.safeParse({
      cwd: "/home/user/project",
    });
    expect(result.success).toBe(false);
  });

  test("missing cwd fails", () => {
    const result = SpawnSessionSchema.safeParse({
      prompt: "Hello",
    });
    expect(result.success).toBe(false);
  });

  test("empty prompt fails", () => {
    const result = SpawnSessionSchema.safeParse({
      prompt: "",
      cwd: "/path",
    });
    expect(result.success).toBe(false);
  });

  test("invalid permission_mode fails", () => {
    const result = SpawnSessionSchema.safeParse({
      prompt: "Hello",
      cwd: "/path",
      permission_mode: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("CreateLiveSessionSchema", () => {
  test("valid minimal payload", () => {
    const result = CreateLiveSessionSchema.safeParse({
      title: "My Session",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.interactive).toBe(false); // default
    }
  });

  test("valid full payload", () => {
    const result = CreateLiveSessionSchema.safeParse({
      title: "My Session",
      project_path: "/path/to/project",
      harness_session_id: "sess-123",
      harness: "claude-code",
      model: "claude-3-opus",
      repo_url: "https://github.com/user/repo",
      interactive: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.interactive).toBe(true);
    }
  });

  test("missing title fails", () => {
    const result = CreateLiveSessionSchema.safeParse({
      project_path: "/path",
    });
    expect(result.success).toBe(false);
  });

  test("empty title fails", () => {
    const result = CreateLiveSessionSchema.safeParse({
      title: "",
    });
    expect(result.success).toBe(false);
  });

  test("empty repo_url is allowed", () => {
    const result = CreateLiveSessionSchema.safeParse({
      title: "Test",
      repo_url: "",
    });
    expect(result.success).toBe(true);
  });

  test("invalid repo_url fails", () => {
    const result = CreateLiveSessionSchema.safeParse({
      title: "Test",
      repo_url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });
});

describe("PushMessagesSchema", () => {
  test("valid message array", () => {
    const result = PushMessagesSchema.safeParse({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("human role transforms to user", () => {
    const result = PushMessagesSchema.safeParse({
      messages: [{ role: "human", content: "Hello" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages[0].role).toBe("user");
    }
  });

  test("empty messages array fails", () => {
    const result = PushMessagesSchema.safeParse({
      messages: [],
    });
    expect(result.success).toBe(false);
  });

  test("missing messages fails", () => {
    const result = PushMessagesSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("messages with content_blocks", () => {
    const result = PushMessagesSchema.safeParse({
      messages: [
        {
          role: "assistant",
          content_blocks: [
            { type: "text", text: "Hello" },
            { type: "tool_use", id: "t1", name: "read", input: {} },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("PushToolResultsSchema", () => {
  test("valid results array", () => {
    const result = PushToolResultsSchema.safeParse({
      results: [
        { tool_use_id: "tool-1", content: "Result content" },
        { tool_use_id: "tool-2", content: { key: "value" }, is_error: false },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("empty results array fails", () => {
    const result = PushToolResultsSchema.safeParse({
      results: [],
    });
    expect(result.success).toBe(false);
  });

  test("missing tool_use_id fails", () => {
    const result = PushToolResultsSchema.safeParse({
      results: [{ content: "test" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("PatchSessionSchema", () => {
  test("title only", () => {
    const result = PatchSessionSchema.safeParse({ title: "New Title" });
    expect(result.success).toBe(true);
  });

  test("description only", () => {
    const result = PatchSessionSchema.safeParse({ description: "New description" });
    expect(result.success).toBe(true);
  });

  test("both title and description", () => {
    const result = PatchSessionSchema.safeParse({
      title: "New Title",
      description: "New description",
    });
    expect(result.success).toBe(true);
  });

  test("empty object fails", () => {
    const result = PatchSessionSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("CompleteSessionSchema", () => {
  test("empty object is valid", () => {
    const result = CompleteSessionSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("with summary", () => {
    const result = CompleteSessionSchema.safeParse({ summary: "Session summary" });
    expect(result.success).toBe(true);
  });

  test("with final_diff", () => {
    const result = CompleteSessionSchema.safeParse({ final_diff: "diff content" });
    expect(result.success).toBe(true);
  });

  test("with both fields", () => {
    const result = CompleteSessionSchema.safeParse({
      summary: "Summary",
      final_diff: "diff",
    });
    expect(result.success).toBe(true);
  });
});

describe("TimeseriesQuerySchema", () => {
  test("minimal valid params", () => {
    const result = TimeseriesQuerySchema.safeParse({ stat: "sessions_created" });
    expect(result.success).toBe(true);
  });

  test("with period", () => {
    const result = TimeseriesQuerySchema.safeParse({
      stat: "prompts_sent",
      period: "week",
    });
    expect(result.success).toBe(true);
  });

  test("fill transforms to boolean", () => {
    const result = TimeseriesQuerySchema.safeParse({
      stat: "tools_invoked",
      fill: "true",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fill).toBe(true);
    }
  });

  test("missing stat fails", () => {
    const result = TimeseriesQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("invalid period fails", () => {
    const result = TimeseriesQuerySchema.safeParse({
      stat: "test",
      period: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("validateJson helper", () => {
  test("parses valid JSON", async () => {
    const req = new Request("http://test.com", {
      method: "POST",
      body: JSON.stringify({ prompt: "test", cwd: "/path" }),
      headers: { "Content-Type": "application/json" },
    });

    const result = await validateJson(req, SpawnSessionSchema);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.unwrap().prompt).toBe("test");
    }
  });

  test("returns error for invalid JSON", async () => {
    const req = new Request("http://test.com", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });

    const result = await validateJson(req, SpawnSessionSchema);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("Invalid JSON");
    }
  });

  test("returns validation error for invalid data", async () => {
    const req = new Request("http://test.com", {
      method: "POST",
      body: JSON.stringify({ prompt: "" }), // empty prompt + missing cwd
      headers: { "Content-Type": "application/json" },
    });

    const result = await validateJson(req, SpawnSessionSchema);
    expect(result.isErr()).toBe(true);
  });
});

describe("validateQueryParams helper", () => {
  test("parses valid query params", () => {
    const url = new URL("http://test.com?stat=sessions_created&period=week");
    const result = validateQueryParams(url, TimeseriesQuerySchema);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.unwrap().stat).toBe("sessions_created");
      expect(result.unwrap().period).toBe("week");
    }
  });

  test("returns error for missing required params", () => {
    const url = new URL("http://test.com?period=week");
    const result = validateQueryParams(url, TimeseriesQuerySchema);
    expect(result.isErr()).toBe(true);
  });
});

describe("CreateSessionFormSchema", () => {
  test("valid minimal form", () => {
    const result = CreateSessionFormSchema.safeParse({ title: "My Session" });
    expect(result.success).toBe(true);
  });

  test("valid full form", () => {
    const result = CreateSessionFormSchema.safeParse({
      title: "My Session",
      description: "A description",
      claude_session_id: "sess-123",
      pr_url: "https://github.com/user/repo/pull/1",
      project_path: "/path/to/project",
      model: "claude-3-opus",
      harness: "claude-code",
      repo_url: "https://github.com/user/repo",
    });
    expect(result.success).toBe(true);
  });

  test("missing title fails", () => {
    const result = CreateSessionFormSchema.safeParse({ description: "desc" });
    expect(result.success).toBe(false);
  });

  test("empty title fails", () => {
    const result = CreateSessionFormSchema.safeParse({ title: "" });
    expect(result.success).toBe(false);
  });

  test("invalid pr_url fails", () => {
    const result = CreateSessionFormSchema.safeParse({
      title: "Test",
      pr_url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  test("empty pr_url is allowed", () => {
    const result = CreateSessionFormSchema.safeParse({
      title: "Test",
      pr_url: "",
    });
    expect(result.success).toBe(true);
  });

  test("http pr_url is valid", () => {
    const result = CreateSessionFormSchema.safeParse({
      title: "Test",
      pr_url: "http://localhost:3000/pr/1",
    });
    expect(result.success).toBe(true);
  });
});

describe("UpdateSessionFormSchema", () => {
  test("valid form", () => {
    const result = UpdateSessionFormSchema.safeParse({
      title: "Updated Title",
      description: "Updated description",
    });
    expect(result.success).toBe(true);
  });

  test("missing title fails", () => {
    const result = UpdateSessionFormSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("invalid pr_url fails", () => {
    const result = UpdateSessionFormSchema.safeParse({
      title: "Test",
      pr_url: "ftp://invalid.com",
    });
    expect(result.success).toBe(false);
  });
});

describe("validateFormData helper", () => {
  test("parses valid form data", () => {
    const formData = new FormData();
    formData.set("title", "My Session");
    formData.set("description", "A description");

    const result = validateFormData(formData, CreateSessionFormSchema);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.unwrap().title).toBe("My Session");
      expect(result.unwrap().description).toBe("A description");
    }
  });

  test("returns error for missing required fields", () => {
    const formData = new FormData();
    formData.set("description", "A description");

    const result = validateFormData(formData, CreateSessionFormSchema);
    expect(result.isErr()).toBe(true);
  });

  test("returns error for invalid URL", () => {
    const formData = new FormData();
    formData.set("title", "Test");
    formData.set("pr_url", "not-a-url");

    const result = validateFormData(formData, CreateSessionFormSchema);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.field).toBe("pr_url");
    }
  });
});
