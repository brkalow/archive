/**
 * Message Translator for OpenCode compatibility.
 *
 * Converts DaemonToServerMessage stream (StreamJsonMessage) into
 * OpenCode-format messages and parts. Handles:
 * - Dual input paths (stream + DB replay)
 * - Tool lifecycle state machine (pending → running → completed/error)
 * - Step part flow (step-start, step-finish)
 * - Pending assistant pattern
 * - Text part delta tracking for streaming
 * - Thinking/reasoning block handling
 */

import {
  generateAscendingId,
  type IdPrefix,
} from "../../src/lib/opencode/id";
import type {
  OCAssistantMessage,
  OCUserMessage,
  OCMessage,
  OCPart,
  OCTextPart,
  OCReasoningPart,
  OCToolPart,
  OCStepStartPart,
  OCStepFinishPart,
  OCMessageWithParts,
  OCToolState,
} from "../../src/lib/opencode/types";
import type { StreamJsonMessage, ContentBlock } from "../types/daemon-ws";

/** Updated part with optional delta for streaming */
export interface PartUpdate {
  part: OCPart;
  delta?: string;
}

/** Pending tool tracked by tool_use_id */
interface PendingTool {
  partId: string;
  messageId: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  startTime: number;
}

export class OpenCodeTranslator {
  private sessionId: string;
  private cwd: string;
  private modelId: string;

  /** All messages (keyed by message ID) */
  private messages = new Map<string, OCMessage>();
  /** All parts (keyed by part ID) */
  private parts = new Map<string, OCPart>();
  /** Parts per message (messageId → partId[]) */
  private messageParts = new Map<string, string[]>();

  /** Pending tools keyed by Claude's tool_use_id */
  private pendingTools = new Map<string, PendingTool>();

  /** Pre-generated assistant message for pending pattern */
  private pendingAssistantId: string | null = null;
  /** Tracks the current assistant message being built */
  private currentAssistantId: string | null = null;
  /** Whether we've seen the first assistant chunk (for reusing pending ID) */
  private firstAssistantChunk = true;

  /** Step tracking */
  private stepNeedsStart = true;

  /** Text parts for delta tracking (messageId → OCTextPart) */
  private currentTextParts = new Map<string, OCTextPart>();
  /** Reasoning parts for delta tracking */
  private currentReasoningParts = new Map<string, OCReasoningPart>();

  /** Accumulated token usage */
  private totalTokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  private totalCost = 0;

  constructor(sessionId: string, cwd: string, modelId = "claude-sonnet-4-5-20250514") {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.modelId = modelId;
  }

  /**
   * Create a pending assistant message before spawning Claude.
   * Returns the message+parts for the HTTP response to POST /session/:id/message.
   * When the first stream assistant arrives, the translator reuses this ID.
   */
  createPendingAssistant(parentMessageId: string): OCMessageWithParts {
    const msgId = generateAscendingId("msg");
    const now = Date.now();

    const message: OCAssistantMessage = {
      id: msgId,
      sessionID: this.sessionId,
      role: "assistant",
      time: { created: now },
      parentID: parentMessageId,
      modelID: this.modelId,
      providerID: "anthropic",
      mode: "code",
      agent: "code",
      path: { cwd: this.cwd, root: this.cwd },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };

    this.messages.set(msgId, message);
    this.messageParts.set(msgId, []);
    this.pendingAssistantId = msgId;
    this.currentAssistantId = msgId;
    this.firstAssistantChunk = true;
    this.stepNeedsStart = true;

    return { info: message, parts: [] };
  }

  /**
   * Create a user message from a prompt.
   * Returns the message, parts, and updated part list for broadcasting.
   */
  createUserMessage(text: string, messageId?: string, partId?: string): {
    info: OCUserMessage;
    parts: OCPart[];
    updatedParts: PartUpdate[];
  } {
    const msgId = messageId || generateAscendingId("msg");
    const prtId = partId || generateAscendingId("prt");
    const now = Date.now();

    const message: OCUserMessage = {
      id: msgId,
      sessionID: this.sessionId,
      role: "user",
      time: { created: now },
      agent: "code",
      model: { providerID: "anthropic", modelID: this.modelId },
    };

    const textPart: OCTextPart = {
      id: prtId,
      sessionID: this.sessionId,
      messageID: msgId,
      type: "text",
      text,
    };

    this.messages.set(msgId, message);
    this.parts.set(prtId, textPart);
    this.messageParts.set(msgId, [prtId]);

    // Reset step tracking for new user message
    this.stepNeedsStart = true;
    this.firstAssistantChunk = true;

    return {
      info: message,
      parts: [textPart],
      updatedParts: [{ part: textPart, delta: text }],
    };
  }

  /**
   * Process a batch of stream messages from session_output.
   * Returns updated messages and parts for broadcasting.
   */
  processStreamMessages(messages: StreamJsonMessage[]): {
    updatedMessages: OCMessage[];
    updatedParts: PartUpdate[];
    stepParts: OCPart[];
    turnCompleted: boolean;
  } {
    const updatedMessages: OCMessage[] = [];
    const updatedParts: PartUpdate[] = [];
    const stepParts: OCPart[] = [];
    let turnCompleted = false;

    for (const msg of messages) {
      // Skip system init messages
      if (msg.type === "system") continue;
      // Skip user messages (we create those ourselves)
      if (msg.type === "user") continue;

      if (msg.type === "assistant") {
        const result = this.processAssistantMessage(msg);
        updatedMessages.push(...result.updatedMessages);
        updatedParts.push(...result.updatedParts);
        stepParts.push(...result.stepParts);
      }

      if (msg.type === "result") {
        const result = this.processResultMessage(msg);
        updatedMessages.push(...result.updatedMessages);
        updatedParts.push(...result.updatedParts);
        stepParts.push(...result.stepParts);
        turnCompleted = true;
      }
    }

    return { updatedMessages, updatedParts, stepParts, turnCompleted };
  }

  private processAssistantMessage(msg: StreamJsonMessage): {
    updatedMessages: OCMessage[];
    updatedParts: PartUpdate[];
    stepParts: OCPart[];
  } {
    const updatedMessages: OCMessage[] = [];
    const updatedParts: PartUpdate[] = [];
    const stepParts: OCPart[] = [];

    // Update model if provided
    if (msg.message?.model) {
      this.modelId = msg.message.model;
    }

    // Get or create the assistant message
    let assistantId: string;
    if (this.firstAssistantChunk && this.pendingAssistantId) {
      // Reuse pending assistant ID
      assistantId = this.pendingAssistantId;
      this.pendingAssistantId = null;
      this.firstAssistantChunk = false;
    } else if (this.currentAssistantId) {
      assistantId = this.currentAssistantId;
    } else {
      // No pending assistant — create one (shouldn't normally happen)
      assistantId = generateAscendingId("msg");
      const now = Date.now();
      const message: OCAssistantMessage = {
        id: assistantId,
        sessionID: this.sessionId,
        role: "assistant",
        time: { created: now },
        parentID: "",
        modelID: this.modelId,
        providerID: "anthropic",
        mode: "code",
        agent: "code",
        path: { cwd: this.cwd, root: this.cwd },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      };
      this.messages.set(assistantId, message);
      this.messageParts.set(assistantId, []);
      this.currentAssistantId = assistantId;
    }

    // Emit step-start if needed (first content after user message)
    if (this.stepNeedsStart) {
      this.stepNeedsStart = false;
      const stepStart = this.createStepStartPart(assistantId);
      stepParts.push(stepStart);
    }

    // Update tokens from usage
    if (msg.message?.usage) {
      this.updateTokens(assistantId, msg.message.usage);
    }

    // Process content blocks
    if (msg.message?.content) {
      for (const block of msg.message.content) {
        const result = this.processContentBlock(assistantId, block);
        updatedParts.push(...result);
      }
    }

    // Always emit the updated assistant message
    const assistant = this.messages.get(assistantId);
    if (assistant) {
      updatedMessages.push(assistant);
    }

    return { updatedMessages, updatedParts, stepParts };
  }

  private processResultMessage(msg: StreamJsonMessage): {
    updatedMessages: OCMessage[];
    updatedParts: PartUpdate[];
    stepParts: OCPart[];
  } {
    const updatedParts: PartUpdate[] = [];
    const stepParts: OCPart[] = [];

    // Process tool results from the result message
    if (msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const pending = this.pendingTools.get(block.tool_use_id);
          if (pending) {
            const now = Date.now();
            const isError = msg.is_error === true;

            let state: OCToolState;
            if (isError) {
              state = {
                status: "error",
                input: pending.input,
                error: block.content || "Tool execution failed",
                time: { start: pending.startTime, end: now },
              };
            } else {
              state = {
                status: "completed",
                input: pending.input,
                output: block.content || "",
                title: pending.toolName,
                metadata: {},
                time: { start: pending.startTime, end: now },
              };
            }

            const toolPart = this.parts.get(pending.partId) as OCToolPart;
            if (toolPart) {
              toolPart.state = state;
              updatedParts.push({ part: toolPart });
            }

            this.pendingTools.delete(block.tool_use_id);
          }
        }
      }
    }

    // Update token usage from result
    if (msg.message?.usage && this.currentAssistantId) {
      this.updateTokens(this.currentAssistantId, msg.message.usage);
    }

    // Create step-finish part
    if (this.currentAssistantId) {
      const stepFinish = this.createStepFinishPart(this.currentAssistantId);
      stepParts.push(stepFinish);
    }

    return {
      updatedMessages: [],
      updatedParts,
      stepParts,
    };
  }

  private processContentBlock(
    messageId: string,
    block: ContentBlock
  ): PartUpdate[] {
    const updates: PartUpdate[] = [];

    switch (block.type) {
      case "text": {
        const existing = this.currentTextParts.get(messageId);
        if (existing) {
          const oldLength = existing.text.length;
          existing.text = block.text || "";
          const delta = existing.text.slice(oldLength);
          updates.push({ part: existing, delta: delta || undefined });
        } else {
          // New text part
          const partId = generateAscendingId("prt");
          const now = Date.now();
          const textPart: OCTextPart = {
            id: partId,
            sessionID: this.sessionId,
            messageID: messageId,
            type: "text",
            text: block.text || "",
            time: { start: now },
          };
          this.parts.set(partId, textPart);
          this.addPartToMessage(messageId, partId);
          this.currentTextParts.set(messageId, textPart);
          updates.push({ part: textPart, delta: textPart.text });
        }
        break;
      }

      case "thinking": {
        const thinkingText = block.thinking || block.text || "";
        const existing = this.currentReasoningParts.get(messageId);
        if (existing) {
          const delta = thinkingText.slice(existing.text.length);
          existing.text = thinkingText;
          updates.push({ part: existing, delta: delta || undefined });
        } else {
          const partId = generateAscendingId("prt");
          const reasoningPart: OCReasoningPart = {
            id: partId,
            sessionID: this.sessionId,
            messageID: messageId,
            type: "reasoning",
            text: thinkingText,
            time: { start: Date.now() },
          };
          this.parts.set(partId, reasoningPart);
          this.addPartToMessage(messageId, partId);
          this.currentReasoningParts.set(messageId, reasoningPart);
          updates.push({ part: reasoningPart, delta: thinkingText });
        }
        break;
      }

      case "tool_use": {
        if (!block.id || !block.name) break;

        // Check if we already have this tool as pending
        const existingPending = this.pendingTools.get(block.id);
        if (existingPending) {
          // Tool seen again — transition to running
          const toolPart = this.parts.get(existingPending.partId) as OCToolPart;
          if (toolPart && toolPart.state.status === "pending") {
            toolPart.state = {
              status: "running",
              input: block.input || {},
              time: { start: Date.now() },
            };
            existingPending.startTime = Date.now();
            updates.push({ part: toolPart });
          }
        } else {
          // New tool_use — create pending tool part
          const partId = generateAscendingId("prt");
          const input = block.input || {};
          const now = Date.now();

          const toolPart: OCToolPart = {
            id: partId,
            sessionID: this.sessionId,
            messageID: messageId,
            type: "tool",
            callID: block.id,
            tool: block.name,
            state: {
              status: "pending",
              input,
              raw: JSON.stringify(input),
            },
          };

          this.parts.set(partId, toolPart);
          this.addPartToMessage(messageId, partId);
          this.pendingTools.set(block.id, {
            partId,
            messageId,
            sessionId: this.sessionId,
            toolName: block.name,
            input,
            startTime: now,
          });

          updates.push({ part: toolPart });
        }
        break;
      }
    }

    return updates;
  }

  private createStepStartPart(messageId: string): OCStepStartPart {
    const partId = generateAscendingId("prt");
    const part: OCStepStartPart = {
      id: partId,
      sessionID: this.sessionId,
      messageID: messageId,
      type: "step-start",
    };
    this.parts.set(partId, part);
    // Add to parts array but NOT latestUpdatedParts (handled by caller)
    this.addPartToMessage(messageId, partId);
    return part;
  }

  private createStepFinishPart(messageId: string): OCStepFinishPart {
    const partId = generateAscendingId("prt");
    const part: OCStepFinishPart = {
      id: partId,
      sessionID: this.sessionId,
      messageID: messageId,
      type: "step-finish",
      reason: "stop",
      cost: this.totalCost,
      tokens: { ...this.totalTokens, cache: { ...this.totalTokens.cache } },
    };
    this.parts.set(partId, part);
    this.addPartToMessage(messageId, partId);
    return part;
  }

  /**
   * Create a step-start part for the pending assistant message.
   * Called during sendMessage to transition TUI out of "queued" state.
   * Sets stepNeedsStart = false to prevent duplicate step-start when stream arrives.
   */
  createStepStartForPending(): OCStepStartPart | null {
    if (!this.currentAssistantId || !this.stepNeedsStart) return null;
    this.stepNeedsStart = false;
    return this.createStepStartPart(this.currentAssistantId);
  }

  /**
   * Complete the last assistant message on turn completion.
   * Sets time.completed, finish: "stop", and time.end on text parts.
   * Clears currentAssistantId to prevent double-completion on session end.
   */
  completeLastAssistant(): {
    message: OCAssistantMessage | null;
    updatedParts: PartUpdate[];
  } {
    if (!this.currentAssistantId) {
      return { message: null, updatedParts: [] };
    }

    const assistant = this.messages.get(this.currentAssistantId);
    if (!assistant || assistant.role !== "assistant") {
      return { message: null, updatedParts: [] };
    }

    const now = Date.now();
    const msg = assistant as OCAssistantMessage;
    msg.time.completed = now;
    msg.finish = "stop";

    const updatedParts: PartUpdate[] = [];

    // Set time.end on text parts
    const textPart = this.currentTextParts.get(this.currentAssistantId);
    if (textPart && textPart.time) {
      textPart.time.end = now;
      updatedParts.push({ part: textPart });
    }

    // Clear tracking for this assistant
    this.currentTextParts.delete(this.currentAssistantId);
    this.currentReasoningParts.delete(this.currentAssistantId);
    // Prevent double-completion (e.g., both turn completion and session end)
    this.currentAssistantId = null;

    return { message: msg, updatedParts };
  }

  /**
   * Reset state for a new turn (after idle → resume).
   */
  resetForNewTurn(): void {
    this.pendingAssistantId = null;
    this.currentAssistantId = null;
    this.firstAssistantChunk = true;
    this.stepNeedsStart = true;
    this.currentTextParts.clear();
    this.currentReasoningParts.clear();
  }

  private updateTokens(
    messageId: string,
    usage: NonNullable<StreamJsonMessage["message"]>["usage"]
  ): void {
    if (!usage) return;

    const msg = this.messages.get(messageId) as OCAssistantMessage | undefined;
    if (!msg || msg.role !== "assistant") return;

    const prevInput = msg.tokens.input;
    const prevOutput = msg.tokens.output;
    const prevCacheRead = msg.tokens.cache.read;
    const prevCacheWrite = msg.tokens.cache.write;

    msg.tokens.input = usage.input_tokens || 0;
    msg.tokens.output = usage.output_tokens || 0;
    msg.tokens.cache.read = usage.cache_read_input_tokens || 0;
    msg.tokens.cache.write = usage.cache_creation_input_tokens || 0;

    // Update totals using deltas (usage values are cumulative, not incremental)
    this.totalTokens.input += msg.tokens.input - prevInput;
    this.totalTokens.output += msg.tokens.output - prevOutput;
    this.totalTokens.cache.read += msg.tokens.cache.read - prevCacheRead;
    this.totalTokens.cache.write += msg.tokens.cache.write - prevCacheWrite;
  }

  private addPartToMessage(messageId: string, partId: string): void {
    const parts = this.messageParts.get(messageId);
    if (parts) {
      parts.push(partId);
    } else {
      this.messageParts.set(messageId, [partId]);
    }
  }

  // ============================================
  // Query methods
  // ============================================

  getMessages(): OCMessageWithParts[] {
    const result: OCMessageWithParts[] = [];
    for (const [msgId, msg] of this.messages) {
      const partIds = this.messageParts.get(msgId) || [];
      const parts = partIds
        .map((id) => this.parts.get(id))
        .filter(Boolean) as OCPart[];
      result.push({ info: msg, parts });
    }
    return result;
  }

  getMessage(messageId: string): OCMessageWithParts | null {
    const msg = this.messages.get(messageId);
    if (!msg) return null;
    const partIds = this.messageParts.get(messageId) || [];
    const parts = partIds
      .map((id) => this.parts.get(id))
      .filter(Boolean) as OCPart[];
    return { info: msg, parts };
  }

  get currentModel(): string {
    return this.modelId;
  }
}
