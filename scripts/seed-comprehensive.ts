#!/usr/bin/env bun
/**
 * Seed a comprehensive test session with all content block types.
 *
 * Usage:
 *   bun run scripts/seed-comprehensive.ts
 */

import { initializeDatabase } from "../src/db/schema";
import { SessionRepository } from "../src/db/repository";
import type {
  Session,
  Message,
  Diff,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
} from "../src/db/schema";

// Initialize database
const dbPath = process.env.DATABASE_PATH || "data/sessions.db";
const db = initializeDatabase(dbPath);
const repo = new SessionRepository(db);

// Utility functions
function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function sqliteDatetime(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// Content block generators
function textBlock(text: string): TextBlock {
  return { type: "text", text };
}

function toolUseBlock(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id: `toolu_${generateId()}`, name, input };
}

function toolResultBlock(toolUseId: string, content: string, isError = false): ToolResultBlock {
  return { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError };
}

function thinkingBlock(thinking: string, durationMs = 1500): ThinkingBlock {
  return { type: "thinking", thinking, duration_ms: durationMs };
}

// Create the comprehensive session
function createComprehensiveSession() {
  const sessionId = `comprehensive_${generateId()}`;
  const timestamp = sqliteDatetime();

  const session: Omit<Session, "created_at" | "updated_at" | "client_id"> = {
    id: sessionId,
    title: "Comprehensive UI Test Session",
    description: "A test session demonstrating all content block types",
    claude_session_id: crypto.randomUUID(),
    agent_session_id: null,
    pr_url: "https://github.com/example/test/pull/42",
    share_token: crypto.randomUUID().slice(0, 16),
    project_path: "/Users/dev/projects/test-project",
    model: "claude-opus-4-20250514",
    harness: "Claude Code",
    repo_url: "https://github.com/example/test",
    branch: null,
    status: "complete",
    last_activity_at: timestamp,
    user_id: null,
    interactive: false,
    remote: false,
  };

  const messages: Omit<Message, "id">[] = [];
  let msgIndex = 0;

  // === TURN 1: User request ===
  messages.push({
    session_id: sessionId,
    role: "user",
    content: "Help me build a complete feature: add user authentication with tests and documentation.",
    content_blocks: [
      textBlock("Help me build a complete feature: add user authentication with tests and documentation."),
    ],
    timestamp,
    message_index: msgIndex++,
  });

  // === TURN 2: Agent thinking + exploration ===
  const readTool1 = toolUseBlock("Read", { file_path: "/Users/dev/projects/test-project/src/auth/index.ts" });
  const globTool = toolUseBlock("Glob", { pattern: "**/*.ts", path: "/Users/dev/projects/test-project/src" });
  const grepTool = toolUseBlock("Grep", { pattern: "authenticate", path: "/Users/dev/projects/test-project" });

  messages.push({
    session_id: sessionId,
    role: "assistant",
    content: "",
    content_blocks: [
      thinkingBlock(
        `This is a complex task that requires multiple steps:
1. First, I need to understand the existing codebase structure
2. Then implement authentication logic
3. Write tests
4. Add documentation

Let me start by exploring the codebase to understand the current architecture.`,
        2500
      ),
      textBlock("I'll help you implement user authentication. Let me first explore the codebase to understand the current structure."),
      readTool1,
      globTool,
      grepTool,
    ],
    timestamp,
    message_index: msgIndex++,
  });

  // Tool results for exploration
  messages.push({
    session_id: sessionId,
    role: "user",
    content: "[Tool results]",
    content_blocks: [
      toolResultBlock(readTool1.id, `// src/auth/index.ts
export interface User {
  id: string;
  email: string;
  name: string;
}

export interface AuthConfig {
  secretKey: string;
  tokenExpiry: number;
}

export function createAuthService(config: AuthConfig) {
  // TODO: Implement authentication
  return {
    login: async (email: string, password: string) => {},
    logout: async () => {},
    validateToken: async (token: string) => {},
  };
}`),
      toolResultBlock(globTool.id, `src/auth/index.ts
src/auth/types.ts
src/routes/api.ts
src/routes/auth.ts
src/db/users.ts
src/middleware/auth.ts
src/utils/crypto.ts
tests/auth.test.ts`),
      toolResultBlock(grepTool.id, `src/routes/auth.ts:15: async function authenticate(req: Request) {
src/middleware/auth.ts:8: export async function authenticateMiddleware(req, res, next) {
tests/auth.test.ts:22: describe('authenticate', () => {`),
    ],
    timestamp,
    message_index: msgIndex++,
  });

  // === TURN 3: TodoWrite for planning ===
  const todoTool = toolUseBlock("TodoWrite", {
    todos: [
      { content: "Implement JWT token generation", status: "completed", activeForm: "Implementing JWT tokens" },
      { content: "Add password hashing with bcrypt", status: "completed", activeForm: "Adding password hashing" },
      { content: "Create login endpoint", status: "in_progress", activeForm: "Creating login endpoint" },
      { content: "Write authentication tests", status: "pending", activeForm: "Writing tests" },
      { content: "Add API documentation", status: "pending", activeForm: "Adding documentation" },
    ],
  });

  messages.push({
    session_id: sessionId,
    role: "assistant",
    content: "",
    content_blocks: [
      textBlock("I've analyzed the codebase. Let me create a task list to track our progress:"),
      todoTool,
    ],
    timestamp,
    message_index: msgIndex++,
  });

  messages.push({
    session_id: sessionId,
    role: "user",
    content: "[Tool result]",
    content_blocks: [toolResultBlock(todoTool.id, "Todos updated")],
    timestamp,
    message_index: msgIndex++,
  });

  // === TURN 4: Writing code ===
  const writeTool = toolUseBlock("Write", {
    file_path: "/Users/dev/projects/test-project/src/auth/jwt.ts",
    content: `import jwt from 'jsonwebtoken';

export function generateToken(userId: string, secret: string): string {
  return jwt.sign({ userId }, secret, { expiresIn: '7d' });
}`,
  });

  const editTool = toolUseBlock("Edit", {
    file_path: "/Users/dev/projects/test-project/src/auth/index.ts",
    old_string: "// TODO: Implement authentication",
    new_string: "return createAuthImplementation(config);",
  });

  messages.push({
    session_id: sessionId,
    role: "assistant",
    content: "",
    content_blocks: [
      textBlock("Now I'll implement the authentication logic:"),
      writeTool,
      editTool,
    ],
    timestamp,
    message_index: msgIndex++,
  });

  messages.push({
    session_id: sessionId,
    role: "user",
    content: "[Tool results]",
    content_blocks: [
      toolResultBlock(writeTool.id, "File written: src/auth/jwt.ts"),
      toolResultBlock(editTool.id, "Edit applied successfully"),
    ],
    timestamp,
    message_index: msgIndex++,
  });

  // === TURN 5: Running Bash commands ===
  const bashTool1 = toolUseBlock("Bash", { command: "bun test tests/auth.test.ts", description: "Run auth tests" });
  const bashTool2 = toolUseBlock("Bash", { command: "bun run build", description: "Build the project" });

  messages.push({
    session_id: sessionId,
    role: "assistant",
    content: "",
    content_blocks: [
      textBlock("Let me run the tests to verify the implementation:"),
      bashTool1,
      bashTool2,
    ],
    timestamp,
    message_index: msgIndex++,
  });

  messages.push({
    session_id: sessionId,
    role: "user",
    content: "[Tool results]",
    content_blocks: [
      toolResultBlock(bashTool1.id, `bun test v1.0.0

tests/auth.test.ts:
✓ authenticate > should return token for valid credentials (12ms)
✓ authenticate > should reject invalid credentials (8ms)
✓ authenticate > should validate token correctly (5ms)
✓ authenticate > should reject expired tokens (3ms)

 4 pass
 0 fail`),
      toolResultBlock(bashTool2.id, "Build failed: Cannot find module 'jsonwebtoken'", true),
    ],
    timestamp,
    message_index: msgIndex++,
  });

  // === TURN 6: WebSearch and WebFetch ===
  const webSearchTool = toolUseBlock("WebSearch", { query: "bun jsonwebtoken alternative jose" });
  const webFetchTool = toolUseBlock("WebFetch", {
    url: "https://www.npmjs.com/package/jose",
    prompt: "What is the latest version and how to install?"
  });

  messages.push({
    session_id: sessionId,
    role: "assistant",
    content: "",
    content_blocks: [
      textBlock("The build failed because 'jsonwebtoken' isn't compatible with Bun. Let me search for an alternative:"),
      webSearchTool,
      webFetchTool,
    ],
    timestamp,
    message_index: msgIndex++,
  });

  messages.push({
    session_id: sessionId,
    role: "user",
    content: "[Tool results]",
    content_blocks: [
      toolResultBlock(webSearchTool.id, `1. jose - Universal JavaScript module for JSON Web Tokens
2. @panva/jose - Maintained JWT library with Bun support
3. jwt-simple - Lightweight JWT library`),
      toolResultBlock(webFetchTool.id, `jose v5.2.0 - Install with: bun add jose`),
    ],
    timestamp,
    message_index: msgIndex++,
  });

  // === TURN 7: Task (subagent) ===
  const taskTool = toolUseBlock("Task", {
    description: "Research authentication best practices",
    prompt: "Research current best practices for JWT authentication in web applications",
    subagent_type: "Explore",
  });

  messages.push({
    session_id: sessionId,
    role: "assistant",
    content: "",
    content_blocks: [
      textBlock("Let me spawn an agent to research authentication best practices:"),
      taskTool,
    ],
    timestamp,
    message_index: msgIndex++,
  });

  messages.push({
    session_id: sessionId,
    role: "user",
    content: "[Tool result]",
    content_blocks: [
      toolResultBlock(taskTool.id, `Research complete. Key findings:
- Use short-lived access tokens (15 min) with refresh tokens
- Store tokens in httpOnly cookies, not localStorage
- Implement token rotation on refresh
- Use RS256 for production, HS256 acceptable for internal services`),
    ],
    timestamp,
    message_index: msgIndex++,
  });

  // === TURN 8: AskUserQuestion ===
  const questionTool = toolUseBlock("AskUserQuestion", {
    questions: [
      {
        question: "Which token storage method would you prefer?",
        options: ["httpOnly cookies (more secure)", "localStorage (easier to implement)", "Session storage"]
      },
      {
        question: "What should be the token expiry time?",
        options: ["15 minutes", "1 hour", "24 hours", "7 days"]
      },
    ],
  });

  messages.push({
    session_id: sessionId,
    role: "assistant",
    content: "",
    content_blocks: [
      textBlock("I have a question about the implementation:"),
      questionTool,
    ],
    timestamp,
    message_index: msgIndex++,
  });

  messages.push({
    session_id: sessionId,
    role: "user",
    content: "[Tool result]",
    content_blocks: [
      toolResultBlock(questionTool.id, JSON.stringify({
        answers: {
          "0": "httpOnly cookies (more secure)",
          "1": "15 minutes",
        },
      })),
    ],
    timestamp,
    message_index: msgIndex++,
  });

  // === TURN 9: Final summary ===
  const todoFinal = toolUseBlock("TodoWrite", {
    todos: [
      { content: "Implement JWT token generation", status: "completed", activeForm: "Implementing JWT tokens" },
      { content: "Add password hashing with bcrypt", status: "completed", activeForm: "Adding password hashing" },
      { content: "Create login endpoint", status: "completed", activeForm: "Creating login endpoint" },
      { content: "Write authentication tests", status: "completed", activeForm: "Writing tests" },
      { content: "Add API documentation", status: "completed", activeForm: "Adding documentation" },
    ],
  });

  messages.push({
    session_id: sessionId,
    role: "assistant",
    content: "",
    content_blocks: [
      thinkingBlock("All tasks are now complete. Let me provide a summary of what was implemented.", 800),
      textBlock(`I've completed the authentication implementation:

**What was done:**
- Implemented JWT token generation using the \`jose\` library
- Added secure password hashing with bcrypt
- Created login/logout endpoints with httpOnly cookie storage
- Token expiry set to 15 minutes with refresh token support
- All tests passing

**Files changed:**
- \`src/auth/jwt.ts\` - Token generation
- \`src/auth/index.ts\` - Auth service
- \`src/routes/auth.ts\` - Endpoints
- \`tests/auth.test.ts\` - Tests

You can test the login endpoint with:
\`\`\`bash
curl -X POST http://localhost:3000/api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email": "test@example.com", "password": "secret"}'
\`\`\``),
      todoFinal,
    ],
    timestamp,
    message_index: msgIndex++,
  });

  messages.push({
    session_id: sessionId,
    role: "user",
    content: "[Tool result]",
    content_blocks: [toolResultBlock(todoFinal.id, "Todos updated")],
    timestamp,
    message_index: msgIndex++,
  });

  // === Diffs ===
  const diffs: Omit<Diff, "id">[] = [
    {
      session_id: sessionId,
      filename: "src/auth/jwt.ts",
      diff_content: `diff --git a/src/auth/jwt.ts b/src/auth/jwt.ts
new file mode 100644
index 0000000..abcdef1
--- /dev/null
+++ b/src/auth/jwt.ts
@@ -0,0 +1,25 @@
+import { SignJWT, jwtVerify } from 'jose';
+
+const secret = new TextEncoder().encode(process.env.JWT_SECRET);
+
+export async function generateToken(userId: string): Promise<string> {
+  return new SignJWT({ userId })
+    .setProtectedHeader({ alg: 'HS256' })
+    .setExpirationTime('15m')
+    .sign(secret);
+}
+
+export async function verifyToken(token: string) {
+  const { payload } = await jwtVerify(token, secret);
+  return payload;
+}`,
      diff_index: 0,
      additions: 15,
      deletions: 0,
      is_session_relevant: true,
      status: "added",
    },
    {
      session_id: sessionId,
      filename: "src/auth/index.ts",
      diff_content: `diff --git a/src/auth/index.ts b/src/auth/index.ts
index 1234567..89abcde 100644
--- a/src/auth/index.ts
+++ b/src/auth/index.ts
@@ -10,8 +10,12 @@ export interface AuthConfig {
 }

 export function createAuthService(config: AuthConfig) {
-  // TODO: Implement authentication
-  return {
+  return createAuthImplementation(config);
+}
+
+function createAuthImplementation(config: AuthConfig) {
+  const { secretKey, tokenExpiry } = config;
+  return Object.freeze({
     login: async (email: string, password: string) => {},
     logout: async () => {},
     validateToken: async (token: string) => {},`,
      diff_index: 1,
      additions: 7,
      deletions: 2,
      is_session_relevant: true,
      status: "modified",
    },
  ];

  return { session, messages, diffs };
}

// Main
async function main() {
  console.log("Creating comprehensive test session...");

  const { session, messages, diffs } = createComprehensiveSession();

  try {
    repo.createSessionWithDataAndReview(session, messages, diffs, undefined);
    console.log(`Created session: ${session.id}`);
    console.log(`  - ${messages.length} messages`);
    console.log(`  - ${diffs.length} diffs`);
    console.log(`\nShare URL: http://localhost:3000/s/${session.share_token}`);
  } catch (error) {
    console.error("Failed to create session:", error);
  }
}

main().catch(console.error);
