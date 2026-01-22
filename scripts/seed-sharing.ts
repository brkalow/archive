/**
 * Seed script for testing session sharing functionality.
 * Creates test sessions with collaborators and visibility settings.
 */

import { initializeDatabase } from "../src/db/schema";
import { SessionRepository } from "../src/db/repository";
import { randomUUID } from "crypto";

const db = initializeDatabase();
const repo = new SessionRepository(db);

// Test user IDs (simulating Clerk user IDs)
const OWNER_USER_ID = "user_owner_123";
const COLLABORATOR_USER_ID = "user_collab_456";

// Create test sessions
const sessions = [
  {
    id: randomUUID(),
    title: "Feature: Add user authentication",
    description: "Implementing OAuth 2.0 with Google and GitHub providers",
    visibility: "private" as const,
    collaborators: [
      { email: "alice@example.com", role: "contributor" as const },
      { email: "bob@example.com", role: "viewer" as const },
    ],
  },
  {
    id: randomUUID(),
    title: "Bug fix: Memory leak in WebSocket handler",
    description: "Investigating and fixing memory leak causing server crashes",
    visibility: "public" as const,
    collaborators: [],
  },
  {
    id: randomUUID(),
    title: "Refactor: Database schema migration",
    description: "Moving from SQLite to PostgreSQL for production",
    visibility: "private" as const,
    collaborators: [
      { email: "charlie@example.com", role: "viewer" as const },
    ],
  },
];

console.log("Seeding session sharing test data...\n");

for (const session of sessions) {
  // Create session
  const createdSession = repo.createSession({
    id: session.id,
    title: session.title,
    description: session.description,
    claude_session_id: randomUUID(),
    agent_session_id: null,
    pr_url: null,
    share_token: null,
    project_path: "/Users/test/projects/my-app",
    model: "claude-sonnet-4-20250514",
    harness: "claude-code",
    repo_url: "https://github.com/test/my-app",
    branch: "main",
    status: "complete",
    visibility: session.visibility,
    last_activity_at: new Date().toISOString(),
    user_id: OWNER_USER_ID,
    client_id: null,
    interactive: false,
    remote: false,
  });

  console.log(`Created session: ${createdSession.title}`);
  console.log(`  ID: ${createdSession.id}`);
  console.log(`  Visibility: ${session.visibility}`);

  // Add some messages
  const messages = [
    {
      session_id: session.id,
      role: "user",
      content: `Help me with: ${session.title}`,
      content_blocks: [{ type: "text", text: `Help me with: ${session.title}` }],
      timestamp: new Date().toISOString(),
    },
    {
      session_id: session.id,
      role: "assistant",
      content: "I'll help you with that. Let me analyze the codebase first...",
      content_blocks: [{ type: "text", text: "I'll help you with that. Let me analyze the codebase first..." }],
      timestamp: new Date().toISOString(),
    },
  ];

  repo.addMessagesWithIndices(session.id, messages);
  console.log(`  Added ${messages.length} messages`);

  // Add collaborators
  for (const collab of session.collaborators) {
    try {
      repo.addCollaboratorWithAudit(
        session.id,
        collab.email,
        collab.role,
        OWNER_USER_ID
      );
      console.log(`  Added collaborator: ${collab.email} (${collab.role})`);
    } catch (e) {
      console.log(`  Collaborator already exists: ${collab.email}`);
    }
  }

  console.log("");
}

console.log("Seed complete!");
console.log("\nTest these sessions:");
sessions.forEach((s) => {
  console.log(`  http://localhost:53766/sessions/${s.id}`);
});

db.close();
