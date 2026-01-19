import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../../src/db/schema";
import { SessionRepository } from "../../src/db/repository";
import { AnalyticsRecorder } from "../../src/analytics/events";
import { unlinkSync, existsSync } from "fs";

const TEST_DB_PATH = "data/test-analytics.db";

describe("AnalyticsRecorder", () => {
  let db: Database;
  let repo: SessionRepository;
  let analytics: AnalyticsRecorder;

  beforeEach(() => {
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
    db = initializeDatabase(TEST_DB_PATH);
    repo = new SessionRepository(db);
    analytics = new AnalyticsRecorder(repo);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  describe("recordMessagesFromUpload", () => {
    const today = new Date().toISOString().slice(0, 10);
    const getStats = () => repo.getStatsSummary(today, today);

    test("counts user messages toward both prompts_sent and messages_total", () => {
      analytics.recordMessagesFromUpload("sess_1", [
        { role: "user", content_blocks: [] },
        { role: "user", content_blocks: [] },
      ]);

      const stats = getStats();
      expect(stats.prompts_sent).toBe(2);
      expect(stats.messages_total).toBe(2);
    });

    test("counts assistant messages toward messages_total only", () => {
      analytics.recordMessagesFromUpload("sess_1", [
        { role: "assistant", content_blocks: [] },
        { role: "assistant", content_blocks: [] },
        { role: "assistant", content_blocks: [] },
      ]);

      const stats = getStats();
      expect(stats.prompts_sent).toBeUndefined();
      expect(stats.messages_total).toBe(3);
    });

    test("counts mixed user and assistant messages correctly", () => {
      analytics.recordMessagesFromUpload("sess_1", [
        { role: "user", content_blocks: [] },
        { role: "assistant", content_blocks: [] },
        { role: "user", content_blocks: [] },
        { role: "assistant", content_blocks: [] },
        { role: "assistant", content_blocks: [] },
      ]);

      const stats = getStats();
      expect(stats.prompts_sent).toBe(2);
      expect(stats.messages_total).toBe(5);
    });

    test("ignores system and other non-conversation roles", () => {
      analytics.recordMessagesFromUpload("sess_1", [
        { role: "user", content_blocks: [] },
        { role: "system", content_blocks: [] },
        { role: "assistant", content_blocks: [] },
        { role: "tool", content_blocks: [] },
      ]);

      const stats = getStats();
      expect(stats.prompts_sent).toBe(1);
      expect(stats.messages_total).toBe(2); // only user + assistant
    });

    test("records nothing when messages array is empty", () => {
      analytics.recordMessagesFromUpload("sess_1", []);

      const stats = getStats();
      expect(stats.prompts_sent).toBeUndefined();
      expect(stats.messages_total).toBeUndefined();
    });
  });
});
