import { SessionRepository } from "../db/repository";
import type {
  AnalyticsEventType,
  StatType,
  SessionCreatedProperties,
  SessionCompletedProperties,
  MessageSentProperties,
  DiffUpdatedProperties,
  ToolInvokedProperties,
} from "../db/schema";

/**
 * Sanitize tool name for use as a stat type.
 * Only allows alphanumeric characters and underscores.
 * Converts to lowercase for consistency.
 */
function sanitizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64); // Limit length
}

export class AnalyticsRecorder {
  constructor(private readonly repo: SessionRepository) {}

  /**
   * Record session creation event
   */
  recordSessionCreated(
    sessionId: string,
    options: {
      clientId?: string;
      model?: string;
      harness?: string;
      interactive?: boolean;
      isLive?: boolean;
      remote?: boolean;
    } = {}
  ): void {
    const { clientId, model, harness, interactive, isLive, remote } = options;

    const properties: SessionCreatedProperties = {
      model,
      harness,
      interactive,
      is_live: isLive,
      remote,
    };

    // Record event
    this.repo.recordEvent("session.created", {
      sessionId,
      clientId,
      properties,
    });

    // Update daily stats
    this.repo.incrementDailyStat("sessions_created", { clientId, model });

    if (interactive) {
      this.repo.incrementDailyStat("sessions_interactive", { clientId, model });
    }

    if (isLive) {
      this.repo.incrementDailyStat("sessions_live", { clientId, model });
    }

    if (remote) {
      this.repo.incrementDailyStat("sessions_remote", { clientId, model });
    }
  }

  /**
   * Record session completion event
   */
  recordSessionCompleted(
    sessionId: string,
    options: {
      clientId?: string;
      durationSeconds?: number;
      messageCount?: number;
    } = {}
  ): void {
    const { clientId, durationSeconds, messageCount } = options;

    const properties: SessionCompletedProperties = {
      duration_seconds: durationSeconds,
      message_count: messageCount,
    };

    this.repo.recordEvent("session.completed", {
      sessionId,
      clientId,
      properties,
    });
  }

  /**
   * Record user message sent event
   */
  recordMessageSent(
    sessionId: string,
    options: {
      clientId?: string;
      contentLength?: number;
    } = {}
  ): void {
    const { clientId, contentLength } = options;

    const properties: MessageSentProperties = {
      content_length: contentLength,
    };

    this.repo.recordEvent("message.sent", {
      sessionId,
      clientId,
      properties,
    });

    this.repo.incrementDailyStat("prompts_sent", { clientId });
    this.repo.incrementDailyStat("messages_total", { clientId });
  }

  /**
   * Record assistant message for total message count tracking
   */
  recordAssistantMessage(
    sessionId: string,
    options: {
      clientId?: string;
    } = {}
  ): void {
    const { clientId } = options;
    this.repo.incrementDailyStat("messages_total", { clientId });
  }

  /**
   * Record tool invocation event
   */
  recordToolInvoked(
    sessionId: string,
    toolName: string,
    options: {
      clientId?: string;
    } = {}
  ): void {
    const { clientId } = options;

    const properties: ToolInvokedProperties = {
      tool_name: toolName,
    };

    this.repo.recordEvent("tool.invoked", {
      sessionId,
      clientId,
      properties,
    });

    // Tool stats use dynamic stat type: tool_${name}
    // Sanitize tool name to ensure safe stat type
    const sanitizedName = sanitizeToolName(toolName);
    if (sanitizedName) {
      // Track individual tool usage
      this.repo.incrementDailyStat(`tool_${sanitizedName}` as StatType, { clientId });
      // Track total tool invocations
      this.repo.incrementDailyStat("tools_invoked", { clientId });
      // Track subagent invocations (Task tool)
      if (sanitizedName === "task") {
        this.repo.incrementDailyStat("subagents_invoked", { clientId });
      }
    }
  }

  /**
   * Record diff update event with line stats
   */
  recordDiffUpdated(
    sessionId: string,
    stats: {
      filesChanged: number;
      additions: number;
      deletions: number;
    },
    options: {
      clientId?: string;
    } = {}
  ): void {
    const { clientId } = options;
    const { filesChanged, additions, deletions } = stats;

    const properties: DiffUpdatedProperties = {
      files_changed: filesChanged,
      additions,
      deletions,
    };

    // Record event and multiple stats in one transaction
    this.repo.recordMultipleStats(
      [
        { statType: "files_changed", value: filesChanged },
        { statType: "lines_added", value: additions },
        { statType: "lines_removed", value: deletions },
      ],
      {
        eventType: "diff.updated",
        sessionId,
        clientId,
        properties,
      }
    );
  }

  /**
   * Record token usage for a session, segmented by model.
   */
  recordTokenUsage(
    tokens: {
      input: number;
      output: number;
      cacheCreation: number;
      cacheRead: number;
    },
    options: {
      clientId?: string;
      model?: string;
    } = {}
  ): void {
    const { clientId, model } = options;

    if (tokens.input > 0) {
      this.repo.incrementDailyStat("input_tokens", { clientId, model, value: tokens.input });
    }
    if (tokens.output > 0) {
      this.repo.incrementDailyStat("output_tokens", { clientId, model, value: tokens.output });
    }
    if (tokens.cacheCreation > 0) {
      this.repo.incrementDailyStat("cache_creation_tokens", { clientId, model, value: tokens.cacheCreation });
    }
    if (tokens.cacheRead > 0) {
      this.repo.incrementDailyStat("cache_read_tokens", { clientId, model, value: tokens.cacheRead });
    }
  }

  /**
   * Parse tool_use blocks from message content and record tool invocations
   */
  recordToolsFromMessage(
    sessionId: string,
    contentBlocks: Array<{ type: string; name?: string }>,
    options: { clientId?: string } = {}
  ): void {
    for (const block of contentBlocks) {
      if (block.type === "tool_use" && block.name) {
        this.recordToolInvoked(sessionId, block.name, options);
      }
    }
  }

  /**
   * Batch record analytics for an array of messages.
   * More efficient than recording each message individually - aggregates
   * counts first and records in a single transaction.
   */
  recordMessagesFromUpload(
    sessionId: string,
    messages: Array<{
      role: string;
      content_blocks?: Array<{ type: string; text?: string; name?: string }>;
    }>,
    options: { clientId?: string } = {}
  ): void {
    const { clientId } = options;

    // Aggregate counts
    let promptCount = 0;
    let messageCount = 0;
    let totalToolCount = 0;
    let subagentCount = 0;
    const toolCounts = new Map<string, number>();

    for (const msg of messages) {
      // Count all user and assistant messages for total
      if (msg.role === "user" || msg.role === "assistant") {
        messageCount++;
      }

      if (msg.role === "user") {
        promptCount++;
      }

      if (msg.role === "assistant" && msg.content_blocks) {
        for (const block of msg.content_blocks) {
          if (block.type === "tool_use" && block.name) {
            const sanitized = sanitizeToolName(block.name);
            if (sanitized) {
              toolCounts.set(sanitized, (toolCounts.get(sanitized) ?? 0) + 1);
              totalToolCount++;
              // Track subagent invocations (Task tool)
              if (sanitized === "task") {
                subagentCount++;
              }
            }
          }
        }
      }
    }

    // Build stats array
    const stats: Array<{ statType: StatType; value: number }> = [];

    if (messageCount > 0) {
      stats.push({ statType: "messages_total", value: messageCount });
    }

    if (promptCount > 0) {
      stats.push({ statType: "prompts_sent", value: promptCount });
    }

    if (totalToolCount > 0) {
      stats.push({ statType: "tools_invoked", value: totalToolCount });
    }

    if (subagentCount > 0) {
      stats.push({ statType: "subagents_invoked", value: subagentCount });
    }

    for (const [tool, count] of Array.from(toolCounts.entries())) {
      stats.push({ statType: `tool_${tool}` as StatType, value: count });
    }

    // Record all stats in a single transaction
    if (stats.length > 0) {
      this.repo.recordMultipleStats(stats, { clientId });
    }
  }
}
