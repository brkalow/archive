#!/usr/bin/env bun
/**
 * Seed fixture session data for local testing.
 *
 * Usage:
 *   bun run scripts/seed.ts          # Seed with default fixtures
 *   bun run scripts/seed.ts --clean  # Clear existing data before seeding
 *   bun run scripts/seed.ts --count 5 # Generate 5 sessions (default: 3)
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
  AnnotationType,
} from "../src/db/schema";

// Parse CLI args
const args = process.argv.slice(2);
const shouldClean = args.includes("--clean");
const countIndex = args.indexOf("--count");
const sessionCount = countIndex !== -1 ? parseInt(args[countIndex + 1], 10) || 3 : 3;

// Initialize database
const dbPath = process.env.DATABASE_PATH || "data/sessions.db";
const db = initializeDatabase(dbPath);
const repo = new SessionRepository(db);

// Utility functions
function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function sqliteDatetime(daysAgo: number = 0): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().replace("T", " ").slice(0, 19);
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

// Sample data
const projectNames = [
  "openctl",
  "boston",
  "conductor",
  "claude-code",
  "api-gateway",
  "user-service",
  "dashboard",
];

const models = ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3-5-sonnet-20241022"];

const harnesses = ["Claude Code", "Cursor", "Windsurf", "Cline"];

const userPrompts = [
  "Add a logout button to the header component",
  "Fix the bug where sessions aren't loading on refresh",
  "Refactor the database queries to use prepared statements",
  "Add unit tests for the authentication flow",
  "Implement dark mode toggle in settings",
  "Update the API to support pagination",
  "Fix the memory leak in the WebSocket handler",
  "Add TypeScript types for the session schema",
  "Implement rate limiting for the upload endpoint",
  "Create a migration script for the new diff schema",
];

const sampleDiffs = [
  {
    filename: "src/components/Header.tsx",
    content: `diff --git a/src/components/Header.tsx b/src/components/Header.tsx
index 1234567..abcdefg 100644
--- a/src/components/Header.tsx
+++ b/src/components/Header.tsx
@@ -12,6 +12,7 @@ export function Header({ user }: HeaderProps) {
   return (
     <header className="flex items-center justify-between p-4">
       <Logo />
+      <LogoutButton onClick={handleLogout} />
       <UserMenu user={user} />
     </header>
   );`,
    additions: 1,
    deletions: 0,
  },
  {
    filename: "src/db/repository.ts",
    content: `diff --git a/src/db/repository.ts b/src/db/repository.ts
index 2345678..bcdefgh 100644
--- a/src/db/repository.ts
+++ b/src/db/repository.ts
@@ -45,10 +45,12 @@ export class SessionRepository {
-  getSession(id: string): Session | null {
-    const stmt = this.db.prepare("SELECT * FROM sessions WHERE id = ?");
-    return stmt.get(id) as Session | null;
+  private readonly stmtGetSession: Statement;
+
+  constructor(private db: Database) {
+    this.stmtGetSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
   }
+
+  getSession(id: string): Session | null {
+    return this.stmtGetSession.get(id) as Session | null;
+  }`,
    additions: 7,
    deletions: 3,
  },
  {
    filename: "src/routes/api.ts",
    content: `diff --git a/src/routes/api.ts b/src/routes/api.ts
index 3456789..cdefghi 100644
--- a/src/routes/api.ts
+++ b/src/routes/api.ts
@@ -89,6 +89,15 @@ export function createApiRouter(repo: SessionRepository) {
     return new Response(JSON.stringify(sessions), { headers: { "Content-Type": "application/json" } });
   });

+  // Rate limiting middleware
+  const rateLimiter = new Map<string, number[]>();
+
+  function checkRateLimit(ip: string, limit = 100, windowMs = 60000): boolean {
+    const now = Date.now();
+    const timestamps = rateLimiter.get(ip) || [];
+    const validTimestamps = timestamps.filter(t => now - t < windowMs);
+    return validTimestamps.length < limit;
+  }
+
   return router;
 }`,
    additions: 10,
    deletions: 0,
  },
  {
    filename: "tests/auth.test.ts",
    content: `diff --git a/tests/auth.test.ts b/tests/auth.test.ts
new file mode 100644
index 0000000..ddddddd
--- /dev/null
+++ b/tests/auth.test.ts
@@ -0,0 +1,25 @@
+import { describe, test, expect } from "bun:test";
+import { authenticateUser, validateToken } from "../src/auth";
+
+describe("Authentication", () => {
+  test("authenticateUser returns token for valid credentials", async () => {
+    const result = await authenticateUser("test@example.com", "password123");
+    expect(result.token).toBeDefined();
+  });
+
+  test("validateToken returns user for valid token", async () => {
+    const { token } = await authenticateUser("test@example.com", "password123");
+    const user = await validateToken(token);
+    expect(user.email).toBe("test@example.com");
+  });
+
+  test("validateToken throws for invalid token", async () => {
+    expect(validateToken("invalid-token")).rejects.toThrow();
+  });
+});`,
    additions: 25,
    deletions: 0,
  },
];

const reviewAnnotations = [
  {
    annotation_type: "suggestion" as AnnotationType,
    content: "Consider extracting this logic into a separate utility function for reusability.",
  },
  {
    annotation_type: "issue" as AnnotationType,
    content: "This could cause a memory leak if the component unmounts before the async operation completes.",
  },
  {
    annotation_type: "praise" as AnnotationType,
    content: "Great use of prepared statements here - this will improve query performance.",
  },
  {
    annotation_type: "question" as AnnotationType,
    content: "Should we add error handling for the case where the user session has expired?",
  },
];

// Generate a realistic session with messages and diffs
function generateSession(
  index: number,
  status: "live" | "complete" | "archived" = "archived"
): {
  session: Omit<Session, "created_at" | "updated_at" | "client_id">;
  messages: Omit<Message, "id">[];
  diffs: Omit<Diff, "id">[];
  review?: {
    summary: string;
    model: string;
    annotations: Array<{
      filename: string;
      line_number: number;
      side: "additions" | "deletions";
      annotation_type: AnnotationType;
      content: string;
    }>;
  };
} {
  const sessionId = `seed_${generateId()}`;
  const project = projectNames[index % projectNames.length];
  const model = models[index % models.length];
  const harness = harnesses[index % harnesses.length];
  const userPrompt = userPrompts[index % userPrompts.length];
  const daysAgo = Math.floor(Math.random() * 14);

  const session: Omit<Session, "created_at" | "updated_at" | "client_id"> = {
    id: sessionId,
    title: userPrompt,
    description: `Session for ${project} - ${userPrompt.toLowerCase()}`,
    claude_session_id: crypto.randomUUID(),
    pr_url: index % 3 === 0 ? `https://github.com/example/${project}/pull/${100 + index}` : null,
    share_token: index % 4 === 0 ? crypto.randomUUID().slice(0, 16) : null,
    project_path: `/Users/dev/projects/${project}`,
    model,
    harness,
    repo_url: `https://github.com/example/${project}`,
    status,
    last_activity_at: status === "live" ? sqliteDatetime(0) : null,
    interactive: status === "live",
  };

  // Generate messages
  const messages: Omit<Message, "id">[] = [];
  let messageIndex = 0;

  // User message
  messages.push({
    session_id: sessionId,
    role: "user",
    content: userPrompt,
    content_blocks: [textBlock(userPrompt)],
    timestamp: sqliteDatetime(daysAgo),
    message_index: messageIndex++,
  });

  // Assistant thinking + response with tool use
  const readToolUse = toolUseBlock("Read", { file_path: `/Users/dev/projects/${project}/src/index.ts` });
  const writeToolUse = toolUseBlock("Write", {
    file_path: `/Users/dev/projects/${project}/${sampleDiffs[index % sampleDiffs.length].filename}`,
    content: "// Updated content...",
  });

  messages.push({
    session_id: sessionId,
    role: "assistant",
    content: "Let me analyze the codebase and implement the requested changes.",
    content_blocks: [
      thinkingBlock(
        `I need to understand the current implementation before making changes. Let me read the relevant files first.`
      ),
      textBlock("Let me analyze the codebase and implement the requested changes."),
      readToolUse,
    ],
    timestamp: sqliteDatetime(daysAgo),
    message_index: messageIndex++,
  });

  // Tool result (simulated as part of next assistant message in real flow)
  messages.push({
    session_id: sessionId,
    role: "user",
    content: "[Tool result]",
    content_blocks: [
      toolResultBlock(
        readToolUse.id,
        `export function main() {\n  console.log("Starting application...");\n}`
      ),
    ],
    timestamp: sqliteDatetime(daysAgo),
    message_index: messageIndex++,
  });

  // Assistant continues with write
  messages.push({
    session_id: sessionId,
    role: "assistant",
    content: "I've analyzed the code. Now I'll make the necessary changes.",
    content_blocks: [textBlock("I've analyzed the code. Now I'll make the necessary changes."), writeToolUse],
    timestamp: sqliteDatetime(daysAgo),
    message_index: messageIndex++,
  });

  // Tool result for write
  messages.push({
    session_id: sessionId,
    role: "user",
    content: "[Tool result]",
    content_blocks: [toolResultBlock(writeToolUse.id, "File written successfully.")],
    timestamp: sqliteDatetime(daysAgo),
    message_index: messageIndex++,
  });

  // Final assistant message
  messages.push({
    session_id: sessionId,
    role: "assistant",
    content: `I've completed the requested changes. The ${userPrompt.toLowerCase()} has been implemented. You can test the changes by running the application.`,
    content_blocks: [
      textBlock(
        `I've completed the requested changes. The ${userPrompt.toLowerCase()} has been implemented. You can test the changes by running the application.`
      ),
    ],
    timestamp: sqliteDatetime(daysAgo),
    message_index: messageIndex++,
  });

  // Generate diffs
  const numDiffs = 1 + (index % 3);
  const diffs: Omit<Diff, "id">[] = [];

  for (let i = 0; i < numDiffs; i++) {
    const diffData = sampleDiffs[(index + i) % sampleDiffs.length];
    diffs.push({
      session_id: sessionId,
      filename: diffData.filename,
      diff_content: diffData.content,
      diff_index: i,
      additions: diffData.additions,
      deletions: diffData.deletions,
      is_session_relevant: true,
    });
  }

  // Add review for some sessions
  let review: typeof generateSession extends (...args: unknown[]) => { review?: infer R } ? R : never;
  if (index % 2 === 0 && diffs.length > 0) {
    const annotations = [];
    for (let i = 0; i < Math.min(2, diffs.length); i++) {
      const ann = reviewAnnotations[(index + i) % reviewAnnotations.length];
      annotations.push({
        filename: diffs[i].filename!,
        line_number: 5 + i * 3,
        side: "additions" as const,
        annotation_type: ann.annotation_type,
        content: ann.content,
      });
    }

    review = {
      summary: `This change implements ${userPrompt.toLowerCase()}. Overall the implementation looks good with minor suggestions for improvement.`,
      model: "claude-sonnet-4-20250514",
      annotations,
    };
  }

  return { session, messages, diffs, review };
}

// Main seed function
async function seed() {
  console.log(`Seeding database at ${dbPath}...`);

  if (shouldClean) {
    console.log("Cleaning existing data...");
    db.run("DELETE FROM feedback_messages");
    db.run("DELETE FROM annotations");
    db.run("DELETE FROM reviews");
    db.run("DELETE FROM diffs");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM sessions");
    console.log("Cleaned.");
  }

  // Generate sessions with varied statuses
  const statuses: Array<"live" | "complete" | "archived"> = ["live", "complete", "archived"];

  for (let i = 0; i < sessionCount; i++) {
    const status = statuses[i % statuses.length];
    const { session, messages, diffs, review } = generateSession(i, status);

    try {
      repo.createSessionWithDataAndReview(session, messages, diffs, review);
      console.log(`  Created session: ${session.id} (${status}) - "${session.title.slice(0, 50)}..."`);
    } catch (error) {
      console.error(`  Failed to create session ${session.id}:`, error);
    }
  }

  console.log(`\nSeeded ${sessionCount} sessions successfully.`);
  console.log(`\nView at: http://localhost:${process.env.PORT || 3000}/`);
}

seed().catch(console.error);
