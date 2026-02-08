/**
 * OpenCode Translator Bug Fix Tests
 *
 * Tests for:
 * 1. Step-start broadcast in sendMessage (queued state fix)
 * 2. Double-completion prevention (duplication fix)
 * 3. Permission reply format validation
 */

import { describe, test, expect } from "bun:test";
import { OpenCodeTranslator } from "../../cli/lib/opencode-translator";
import type { StreamJsonMessage } from "../../cli/types/daemon-ws";

describe("OpenCodeTranslator bug fixes", () => {
  // ------------------------------------------
  // Bug 1: Step-start in sendMessage
  // ------------------------------------------

  describe("createStepStartForPending", () => {
    test("returns step-start part for pending assistant", () => {
      const translator = new OpenCodeTranslator("ses_123", "/tmp");
      const userMsg = translator.createUserMessage("hello");
      const pending = translator.createPendingAssistant(userMsg.info.id);

      const stepStart = translator.createStepStartForPending();
      expect(stepStart).not.toBeNull();
      expect(stepStart!.type).toBe("step-start");
      expect(stepStart!.messageID).toBe(pending.info.id);
      expect(stepStart!.sessionID).toBe("ses_123");
    });

    test("returns null when no pending assistant exists", () => {
      const translator = new OpenCodeTranslator("ses_123", "/tmp");
      const stepStart = translator.createStepStartForPending();
      expect(stepStart).toBeNull();
    });

    test("returns null on second call (prevents duplicate step-start)", () => {
      const translator = new OpenCodeTranslator("ses_123", "/tmp");
      const userMsg = translator.createUserMessage("hello");
      translator.createPendingAssistant(userMsg.info.id);

      const first = translator.createStepStartForPending();
      expect(first).not.toBeNull();

      const second = translator.createStepStartForPending();
      expect(second).toBeNull();
    });

    test("does not create duplicate step-start when stream arrives", () => {
      const translator = new OpenCodeTranslator("ses_123", "/tmp");
      const userMsg = translator.createUserMessage("hello");
      translator.createPendingAssistant(userMsg.info.id);

      // Simulate sendMessage creating step-start
      const stepStart = translator.createStepStartForPending();
      expect(stepStart).not.toBeNull();

      // Simulate first stream message arriving
      const messages: StreamJsonMessage[] = [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello!" }],
          },
        },
      ];

      const result = translator.processStreamMessages(messages);

      // No step parts should be created (stepNeedsStart was already false)
      expect(result.stepParts).toHaveLength(0);
    });
  });

  // ------------------------------------------
  // Bug 3: Double-completion prevention
  // ------------------------------------------

  describe("completeLastAssistant double-call prevention", () => {
    test("second call returns null after first completion", () => {
      const translator = new OpenCodeTranslator("ses_123", "/tmp");
      const userMsg = translator.createUserMessage("hello");
      translator.createPendingAssistant(userMsg.info.id);

      // Simulate stream with content
      translator.processStreamMessages([
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Response" }],
          },
        },
      ]);

      // First completion (turn completion in handleSessionOutput)
      const first = translator.completeLastAssistant();
      expect(first.message).not.toBeNull();
      expect(first.message!.finish).toBe("stop");
      expect(first.message!.time.completed).toBeDefined();

      // Second completion (handleSessionEnded)
      const second = translator.completeLastAssistant();
      expect(second.message).toBeNull();
      expect(second.updatedParts).toHaveLength(0);
    });

    test("createPendingAssistant resets after completion for next turn", () => {
      const translator = new OpenCodeTranslator("ses_123", "/tmp");

      // First turn
      const userMsg1 = translator.createUserMessage("first");
      const pending1 = translator.createPendingAssistant(userMsg1.info.id);
      translator.processStreamMessages([
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Response 1" }],
          },
        },
      ]);
      const completion1 = translator.completeLastAssistant();
      expect(completion1.message).not.toBeNull();

      // Second turn - should work fresh
      const userMsg2 = translator.createUserMessage("second");
      const pending2 = translator.createPendingAssistant(userMsg2.info.id);
      expect(pending2.info.id).not.toBe(pending1.info.id);

      translator.processStreamMessages([
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Response 2" }],
          },
        },
      ]);

      const completion2 = translator.completeLastAssistant();
      expect(completion2.message).not.toBeNull();
      expect(completion2.message!.id).toBe(pending2.info.id);
    });
  });

  // ------------------------------------------
  // Pending assistant ID reuse
  // ------------------------------------------

  describe("pending assistant ID reuse", () => {
    test("first stream message reuses pending assistant ID", () => {
      const translator = new OpenCodeTranslator("ses_123", "/tmp");
      const userMsg = translator.createUserMessage("hello");
      const pending = translator.createPendingAssistant(userMsg.info.id);

      const result = translator.processStreamMessages([
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Response" }],
          },
        },
      ]);

      // The updated message should have the same ID as the pending assistant
      expect(result.updatedMessages).toHaveLength(1);
      expect(result.updatedMessages[0].id).toBe(pending.info.id);
    });
  });
});
