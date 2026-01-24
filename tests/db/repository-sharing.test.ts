import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initializeDatabase } from "../../src/db/schema";
import { SessionRepository } from "../../src/db/repository";
import { Database } from "bun:sqlite";

describe("SessionRepository - Session Sharing", () => {
  let db: Database;
  let repo: SessionRepository;
  const testUserId = "user_owner_123";
  const testSessionId = "test_session_123";

  function createTestSession(
    id: string = testSessionId,
    userId: string = testUserId,
    visibility: "private" | "public" = "private"
  ) {
    // Note: createSession takes userId as a separate parameter, not in the session object
    return repo.createSession(
      {
        id,
        title: "Test Session",
        description: null,
        claude_session_id: null,
        agent_session_id: null,
        pr_url: null,
        share_token: null,
        project_path: "/tmp/test",
        model: "claude-sonnet-4",
        harness: "claude-code",
        repo_url: null,
        branch: "main",
        status: "complete",
        visibility,
        last_activity_at: new Date().toISOString(),
        interactive: false,
        remote: false,
      },
      undefined, // clientId
      userId     // userId
    );
  }

  beforeEach(() => {
    db = initializeDatabase(":memory:");
    repo = new SessionRepository(db);
  });

  afterEach(() => {
    db?.close();
  });

  describe("Session Visibility", () => {
    test("creates session with default private visibility", () => {
      const session = createTestSession();
      expect(session.visibility).toBe("private");
    });

    test("creates session with public visibility", () => {
      const session = createTestSession("public_session", testUserId, "public");
      expect(session.visibility).toBe("public");
    });

    test("updates session visibility", () => {
      const session = createTestSession();
      expect(session.visibility).toBe("private");

      repo.setSessionVisibility(session.id, "public");
      const updated = repo.getSession(session.id).unwrap();
      expect(updated.visibility).toBe("public");

      repo.setSessionVisibility(session.id, "private");
      const reverted = repo.getSession(session.id).unwrap();
      expect(reverted.visibility).toBe("private");
    });

    test("getSessionVisibility returns correct value", () => {
      const session = createTestSession();
      expect(repo.getSessionVisibility(session.id)).toBe("private");

      repo.setSessionVisibility(session.id, "public");
      expect(repo.getSessionVisibility(session.id)).toBe("public");
    });
  });

  describe("Collaborator Management", () => {
    test("adds a collaborator to a session", () => {
      createTestSession();

      const collaborator = repo.addCollaborator(
        testSessionId,
        "collab@example.com",
        "viewer",
        testUserId
      );

      expect(collaborator).toBeTruthy();
      expect(collaborator?.email).toBe("collab@example.com");
      expect(collaborator?.role).toBe("viewer");
      expect(collaborator?.user_id).toBeNull();
      expect(collaborator?.accepted_at).toBeNull();
    });

    test("normalizes email when adding collaborator", () => {
      createTestSession();

      const collaborator = repo.addCollaborator(
        testSessionId,
        "  COLLAB@EXAMPLE.COM  ",
        "viewer",
        testUserId
      );

      expect(collaborator?.email).toBe("collab@example.com");
    });

    test("throws on duplicate collaborator email", () => {
      createTestSession();

      repo.addCollaborator(testSessionId, "collab@example.com", "viewer", testUserId);

      expect(() => {
        repo.addCollaborator(testSessionId, "collab@example.com", "contributor", testUserId);
      }).toThrow();
    });

    test("gets all collaborators for a session", () => {
      createTestSession();

      repo.addCollaborator(testSessionId, "alice@example.com", "contributor", testUserId);
      repo.addCollaborator(testSessionId, "bob@example.com", "viewer", testUserId);

      const collaborators = repo.getCollaborators(testSessionId);
      expect(collaborators).toHaveLength(2);
      expect(collaborators.map((c) => c.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);
    });

    test("gets collaborator by ID", () => {
      createTestSession();

      const added = repo.addCollaborator(testSessionId, "collab@example.com", "viewer", testUserId);
      const found = repo.getCollaborator(added!.id);

      expect(found).toBeTruthy();
      expect(found?.email).toBe("collab@example.com");
    });

    test("gets collaborator by email", () => {
      createTestSession();

      repo.addCollaborator(testSessionId, "collab@example.com", "viewer", testUserId);
      const found = repo.getCollaboratorByEmail(testSessionId, "collab@example.com");

      expect(found).toBeTruthy();
      expect(found?.email).toBe("collab@example.com");
    });

    test("updates collaborator role", () => {
      createTestSession();

      const collaborator = repo.addCollaborator(testSessionId, "collab@example.com", "viewer", testUserId);
      expect(collaborator?.role).toBe("viewer");

      const updated = repo.updateCollaboratorRole(collaborator!.id, "contributor");
      expect(updated?.role).toBe("contributor");
    });

    test("removes collaborator", () => {
      createTestSession();

      const collaborator = repo.addCollaborator(testSessionId, "collab@example.com", "viewer", testUserId);
      expect(repo.getCollaborators(testSessionId)).toHaveLength(1);

      const result = repo.removeCollaborator(collaborator!.id);
      expect(result).toBe(true);
      expect(repo.getCollaborators(testSessionId)).toHaveLength(0);
    });

    test("removes collaborator by email", () => {
      createTestSession();

      repo.addCollaborator(testSessionId, "collab@example.com", "viewer", testUserId);
      expect(repo.getCollaborators(testSessionId)).toHaveLength(1);

      const result = repo.removeCollaboratorByEmail(testSessionId, "collab@example.com");
      expect(result).toBe(true);
      expect(repo.getCollaborators(testSessionId)).toHaveLength(0);
    });

    test("links collaborator to user ID", () => {
      createTestSession();

      const collaborator = repo.addCollaborator(testSessionId, "collab@example.com", "viewer", testUserId);
      expect(collaborator?.user_id).toBeNull();

      const collabUserId = "user_collab_456";
      repo.updateCollaboratorUserId(collaborator!.id, collabUserId);

      const updated = repo.getCollaborator(collaborator!.id);
      expect(updated?.user_id).toBe(collabUserId);
    });

    test("acceptInvite links collaborator and sets accepted_at", () => {
      createTestSession();

      repo.addCollaborator(testSessionId, "collab@example.com", "viewer", testUserId);

      // Accept invite
      const collabUserId = "user_collab_456";
      const accepted = repo.acceptInvite(testSessionId, "collab@example.com", collabUserId);

      expect(accepted).toBeTruthy();
      expect(accepted?.user_id).toBe(collabUserId);
      expect(accepted?.accepted_at).toBeTruthy();
    });

    test("acceptInvite returns null for non-existent invite", () => {
      createTestSession();

      const result = repo.acceptInvite(testSessionId, "nonexistent@example.com", "some_user");
      expect(result).toBeNull();
    });

    test("acceptInvite returns existing collaborator if already accepted", () => {
      createTestSession();

      const collaborator = repo.addCollaborator(testSessionId, "collab@example.com", "viewer", testUserId);
      const collabUserId = "user_collab_456";

      // First acceptance
      const first = repo.acceptInvite(testSessionId, "collab@example.com", collabUserId);
      expect(first?.user_id).toBe(collabUserId);

      // Second acceptance with same user should return existing
      const second = repo.acceptInvite(testSessionId, "collab@example.com", collabUserId);
      expect(second?.id).toBe(first?.id);
    });

    test("getCollaboratorCount returns correct count", () => {
      createTestSession();

      expect(repo.getCollaboratorCount(testSessionId)).toBe(0);

      repo.addCollaborator(testSessionId, "alice@example.com", "contributor", testUserId);
      expect(repo.getCollaboratorCount(testSessionId)).toBe(1);

      repo.addCollaborator(testSessionId, "bob@example.com", "viewer", testUserId);
      expect(repo.getCollaboratorCount(testSessionId)).toBe(2);
    });
  });

  describe("Audit Logging", () => {
    test("creates audit log entry when adding collaborator", () => {
      createTestSession();

      repo.addCollaboratorWithAudit(testSessionId, "collab@example.com", "viewer", testUserId);

      const logs = repo.getAuditLogs(testSessionId);
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe("collaborator_added");
      expect(logs[0].target_email).toBe("collab@example.com");
      expect(logs[0].new_value).toBe("viewer");
    });

    test("creates audit log entry when updating collaborator role", () => {
      createTestSession();

      const collaborator = repo.addCollaborator(testSessionId, "collab@example.com", "viewer", testUserId);
      // Note: updateCollaboratorRoleWithAudit takes (collaboratorId, newRole, actorUserId)
      repo.updateCollaboratorRoleWithAudit(collaborator!.id, "contributor", testUserId);

      const logs = repo.getAuditLogs(testSessionId);
      expect(logs).toHaveLength(1);

      expect(logs[0].action).toBe("collaborator_role_changed");
      expect(logs[0].old_value).toBe("viewer");
      expect(logs[0].new_value).toBe("contributor");
    });

    test("creates audit log entry when removing collaborator", () => {
      createTestSession();

      const collaborator = repo.addCollaborator(testSessionId, "collab@example.com", "viewer", testUserId);
      // Note: removeCollaboratorWithAudit takes (collaboratorId, actorUserId)
      repo.removeCollaboratorWithAudit(collaborator!.id, testUserId);

      const logs = repo.getAuditLogs(testSessionId);
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe("collaborator_removed");
      expect(logs[0].target_email).toBe("collab@example.com");
    });

    test("creates audit log entry when changing visibility", () => {
      createTestSession();

      repo.setSessionVisibilityWithAudit(testSessionId, "public", testUserId);

      const logs = repo.getAuditLogs(testSessionId);
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe("visibility_changed");
      expect(logs[0].old_value).toBe("private");
      expect(logs[0].new_value).toBe("public");
    });
  });

  describe("Access Control - verifySessionAccess", () => {
    test("owner has full access to private session", () => {
      createTestSession();

      const access = repo.verifySessionAccess(testSessionId, testUserId, null);
      expect(access.allowed).toBe(true);
      expect(access.isOwner).toBe(true);
      expect(access.role).toBe("owner");
      expect(access.canEdit).toBe(true);
    });

    test("non-owner cannot access private session without being collaborator", () => {
      createTestSession();

      const access = repo.verifySessionAccess(testSessionId, "other_user", null);
      expect(access.allowed).toBe(false);
      expect(access.isOwner).toBe(false);
      expect(access.role).toBeNull();
    });

    test("collaborator with viewer role can access but not edit", () => {
      createTestSession();
      repo.addCollaborator(testSessionId, "collab@example.com", "viewer", testUserId);

      const access = repo.verifySessionAccess(testSessionId, null, null, "collab@example.com");
      expect(access.allowed).toBe(true);
      expect(access.isOwner).toBe(false);
      expect(access.role).toBe("viewer");
      expect(access.canEdit).toBe(false);
    });

    test("collaborator with contributor role can access and edit", () => {
      createTestSession();
      repo.addCollaborator(testSessionId, "collab@example.com", "contributor", testUserId);

      const access = repo.verifySessionAccess(testSessionId, null, null, "collab@example.com");
      expect(access.allowed).toBe(true);
      expect(access.isOwner).toBe(false);
      expect(access.role).toBe("contributor");
      expect(access.canEdit).toBe(true);
    });

    test("anyone can access public session", () => {
      createTestSession("public_session", testUserId, "public");

      const access = repo.verifySessionAccess("public_session", null, null);
      expect(access.allowed).toBe(true);
      expect(access.isOwner).toBe(false);
      expect(access.role).toBe("viewer"); // Public sessions grant viewer role
      expect(access.canEdit).toBe(false);
    });

    test("owner still has full access to public session", () => {
      createTestSession("public_session", testUserId, "public");

      const access = repo.verifySessionAccess("public_session", testUserId, null);
      expect(access.allowed).toBe(true);
      expect(access.isOwner).toBe(true);
      expect(access.role).toBe("owner");
      expect(access.canEdit).toBe(true);
    });

    test("collaborator by user_id can access session", () => {
      createTestSession();
      const collab = repo.addCollaborator(testSessionId, "collab@example.com", "contributor", testUserId);
      repo.updateCollaboratorUserId(collab!.id, "user_collab_456");

      const access = repo.verifySessionAccess(testSessionId, "user_collab_456", null);
      expect(access.allowed).toBe(true);
      expect(access.isOwner).toBe(false);
      expect(access.role).toBe("contributor");
      expect(access.canEdit).toBe(true);
    });
  });

  describe("getSessionsSharedWithUser/Email", () => {
    test("returns sessions shared with user by email", () => {
      createTestSession("session1", testUserId);
      createTestSession("session2", testUserId);
      createTestSession("session3", "other_user");

      repo.addCollaborator("session1", "viewer@example.com", "viewer", testUserId);
      repo.addCollaborator("session2", "viewer@example.com", "contributor", testUserId);

      const sessions = repo.getSessionsSharedWithEmail("viewer@example.com");
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.id).sort()).toEqual(["session1", "session2"]);
    });

    test("returns sessions shared with user by user_id", () => {
      createTestSession("session1", testUserId);
      createTestSession("session2", testUserId);

      const collab = repo.addCollaborator("session1", "collab@example.com", "viewer", testUserId);
      repo.updateCollaboratorUserId(collab!.id, "user_collab_456");

      const sessions = repo.getSessionsSharedWithUser("user_collab_456");
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("session1");
    });
  });

  describe("checkSessionAccess", () => {
    test("returns correct access for owner", () => {
      createTestSession();

      const access = repo.checkSessionAccess(testSessionId, testUserId, null);
      expect(access.hasAccess).toBe(true);
      expect(access.isOwner).toBe(true);
      expect(access.role).toBe("owner");
    });

    test("returns correct access for public session", () => {
      createTestSession("public_session", testUserId, "public");

      const access = repo.checkSessionAccess("public_session", null, null);
      expect(access.hasAccess).toBe(true);
      expect(access.isOwner).toBe(false);
      expect(access.role).toBe("viewer");
    });

    test("returns no access for private session without permission", () => {
      createTestSession();

      const access = repo.checkSessionAccess(testSessionId, "other_user", null);
      expect(access.hasAccess).toBe(false);
      expect(access.isOwner).toBe(false);
      expect(access.role).toBeNull();
    });
  });
});
