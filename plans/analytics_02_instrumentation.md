# Analytics Phase 2: Event Instrumentation

> **Spec reference:** [specs/analytics.md](../specs/analytics.md)

## Overview

This plan covers instrumenting the existing API endpoints to record analytics events and update daily rollups. Events are recorded at write-time as data flows through the system.

## Dependencies

- **Phase 1:** Core Infrastructure (analytics tables and repository methods)

## Tasks

### 1. Create AnalyticsRecorder Class

Create a dedicated class to encapsulate analytics recording logic.

**File:** `src/analytics/events.ts` (new file)

```typescript
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
    } = {}
  ): void {
    const { clientId, model, harness, interactive, isLive } = options;

    const properties: SessionCreatedProperties = {
      model,
      harness,
      interactive,
      is_live: isLive,
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
    this.repo.incrementDailyStat(`tool_${toolName}` as StatType, { clientId });
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
}
```

### 2. Initialize AnalyticsRecorder

Create and export the analytics recorder instance.

**File:** `src/routes/api.ts`

```typescript
import { AnalyticsRecorder } from "../analytics/events";

// In createApiRoutes function:
export function createApiRoutes(repo: SessionRepository) {
  const analytics = new AnalyticsRecorder(repo);

  // ... rest of route handlers with analytics available
}
```

### 3. Instrument Session Creation

Add analytics recording to `createSession` and `createLiveSession`.

**File:** `src/routes/api.ts`

```typescript
async createSession(req: Request): Promise<Response> {
  // ... existing validation and session creation logic ...

  const session = repo.createSessionWithData(sessionData, messages, diffs);

  // Record analytics event
  analytics.recordSessionCreated(session.id, {
    clientId: getClientId(req),
    model: session.model,
    harness: session.harness,
    interactive: session.interactive ?? false,
    isLive: false,
  });

  return json({ id: session.id, ... });
}

async createLiveSession(req: Request): Promise<Response> {
  // ... existing validation and session creation logic ...

  const { id, streamToken } = repo.createLiveSession(sessionData);

  // Record analytics event
  analytics.recordSessionCreated(id, {
    clientId: getClientId(req),
    model: sessionData.model,
    harness: sessionData.harness,
    interactive: sessionData.interactive ?? false,
    isLive: true,
  });

  return json({ id, stream_token: streamToken, status: "live" }, 201);
}
```

### 4. Instrument Session Completion

Add analytics recording to `completeSession`.

**File:** `src/routes/api.ts`

```typescript
async completeSession(req: Request, sessionId: string): Promise<Response> {
  // ... existing validation and completion logic ...

  const messageCount = repo.getMessageCount(sessionId);
  const durationSeconds = calculateDuration(sessionId);

  repo.completeSession(sessionId, body.summary);

  // Record analytics event
  analytics.recordSessionCompleted(sessionId, {
    clientId: getClientId(req),
    durationSeconds,
    messageCount,
  });

  return json({ status: "complete", message_count: messageCount });
}
```

### 5. Instrument Message Push

Add analytics recording to `pushMessages` for user messages and tool invocations.

**File:** `src/routes/api.ts`

```typescript
async pushMessages(req: Request, sessionId: string): Promise<Response> {
  // ... existing validation and message pushing logic ...

  const body = await req.json();
  const clientId = getClientId(req);

  // Record analytics for each message
  for (const msg of body.messages) {
    // Track user messages (prompts)
    if (msg.role === "user") {
      const contentLength = calculateContentLength(msg.content_blocks || []);
      analytics.recordMessageSent(sessionId, {
        clientId,
        contentLength,
      });
    }

    // Track tool invocations from assistant messages
    if (msg.role === "assistant" && msg.content_blocks) {
      analytics.recordToolsFromMessage(sessionId, msg.content_blocks, {
        clientId,
      });
    }
  }

  const { appended, lastIndex } = repo.appendMessages(sessionId, body.messages);

  return json({ appended, message_count: lastIndex + 1, last_index: lastIndex });
}

// Helper to calculate content length
function calculateContentLength(contentBlocks: Array<{ type: string; text?: string }>): number {
  let length = 0;
  for (const block of contentBlocks) {
    if (block.type === "text" && block.text) {
      length += block.text.length;
    }
  }
  return length;
}
```

### 6. Instrument Diff Updates

Add analytics recording to `updateDiff`.

**File:** `src/routes/api.ts`

```typescript
async updateDiff(req: Request, sessionId: string): Promise<Response> {
  // ... existing validation logic ...

  const body = await req.json();
  const { additions, deletions } = countDiffStats(body.diff_content || "");
  const filesChanged = countFilesChanged(body.diff_content || "");

  // Update diff in database
  repo.updateDiff(sessionId, body.diff_content, touchedFiles);

  // Record analytics event
  analytics.recordDiffUpdated(
    sessionId,
    { filesChanged, additions, deletions },
    { clientId: getClientId(req) }
  );

  return json({ updated: true, additions, deletions, files_changed: filesChanged });
}

// Helper to count files in diff
function countFilesChanged(diffContent: string): number {
  // Count diff headers (lines starting with "diff --git")
  const matches = diffContent.match(/^diff --git/gm);
  return matches?.length ?? 0;
}
```

### 7. Instrument Uploaded Sessions

Handle analytics for uploaded (batch) sessions which contain historical messages.

**File:** `src/routes/api.ts`

```typescript
async createSession(req: Request): Promise<Response> {
  // ... existing session creation ...

  const session = repo.createSessionWithData(sessionData, messages, diffs);
  const clientId = getClientId(req);

  // Record session created
  analytics.recordSessionCreated(session.id, {
    clientId,
    model: session.model,
    harness: session.harness,
    interactive: session.interactive ?? false,
    isLive: false,
  });

  // For uploaded sessions, also record message and tool stats from history
  for (const msg of messages) {
    if (msg.role === "user") {
      const contentLength = calculateContentLength(msg.content_blocks || []);
      analytics.recordMessageSent(session.id, { clientId, contentLength });
    }

    if (msg.role === "assistant" && msg.content_blocks) {
      analytics.recordToolsFromMessage(session.id, msg.content_blocks, { clientId });
    }
  }

  // Record diff stats if provided
  if (diffs && diffs.length > 0) {
    const totalAdditions = diffs.reduce((sum, d) => sum + (d.additions || 0), 0);
    const totalDeletions = diffs.reduce((sum, d) => sum + (d.deletions || 0), 0);
    const filesChanged = diffs.filter(d => d.is_session_relevant).length;

    if (filesChanged > 0 || totalAdditions > 0 || totalDeletions > 0) {
      analytics.recordDiffUpdated(
        session.id,
        { filesChanged, additions: totalAdditions, deletions: totalDeletions },
        { clientId }
      );
    }
  }

  return json({ id: session.id, ... });
}
```

## Testing

### Integration Tests

**File:** `tests/analytics-instrumentation.test.ts`

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../src/db/schema";
import { SessionRepository } from "../src/db/repository";
import { AnalyticsRecorder } from "../src/analytics/events";

describe("Analytics Instrumentation", () => {
  let db: Database;
  let repo: SessionRepository;
  let analytics: AnalyticsRecorder;

  beforeEach(() => {
    db = initializeDatabase(":memory:");
    repo = new SessionRepository(db);
    analytics = new AnalyticsRecorder(repo);
  });

  afterEach(() => {
    db.close();
  });

  describe("Session Events", () => {
    test("records session.created event with stats", () => {
      analytics.recordSessionCreated("sess_123", {
        clientId: "client_abc",
        model: "claude-3",
        harness: "claude-code",
        interactive: true,
        isLive: true,
      });

      // Check event was recorded
      const events = db.query("SELECT * FROM analytics_events").all();
      expect(events.length).toBe(1);
      expect(events[0].event_type).toBe("session.created");

      // Check stats were updated
      const stats = db.query(
        "SELECT stat_type, SUM(value) as total FROM analytics_daily_stats GROUP BY stat_type"
      ).all();

      const statMap = new Map(stats.map(s => [s.stat_type, s.total]));
      expect(statMap.get("sessions_created")).toBe(2); // global + client
      expect(statMap.get("sessions_interactive")).toBe(2);
      expect(statMap.get("sessions_live")).toBe(2);
    });

    test("records session.completed event", () => {
      analytics.recordSessionCompleted("sess_123", {
        clientId: "client_abc",
        durationSeconds: 120,
        messageCount: 15,
      });

      const events = db.query("SELECT * FROM analytics_events").all();
      expect(events.length).toBe(1);

      const props = JSON.parse(events[0].properties);
      expect(props.duration_seconds).toBe(120);
      expect(props.message_count).toBe(15);
    });
  });

  describe("Message Events", () => {
    test("records message.sent event and prompts_sent stat", () => {
      analytics.recordMessageSent("sess_123", {
        clientId: "client_abc",
        contentLength: 500,
      });

      const events = db.query("SELECT * FROM analytics_events").all();
      expect(events[0].event_type).toBe("message.sent");
      expect(JSON.parse(events[0].properties).content_length).toBe(500);

      const stats = db.query(
        "SELECT SUM(value) as total FROM analytics_daily_stats WHERE stat_type = 'prompts_sent'"
      ).get();
      expect(stats.total).toBeGreaterThan(0);
    });
  });

  describe("Tool Events", () => {
    test("records tool.invoked event with tool-specific stat", () => {
      analytics.recordToolInvoked("sess_123", "Edit", { clientId: "client_abc" });

      const events = db.query("SELECT * FROM analytics_events").all();
      expect(events[0].event_type).toBe("tool.invoked");
      expect(JSON.parse(events[0].properties).tool_name).toBe("Edit");

      const stats = db.query(
        "SELECT SUM(value) as total FROM analytics_daily_stats WHERE stat_type = 'tool_Edit'"
      ).get();
      expect(stats.total).toBeGreaterThan(0);
    });

    test("parses and records tools from message content blocks", () => {
      const contentBlocks = [
        { type: "text", text: "Let me edit that file" },
        { type: "tool_use", name: "Read", id: "123", input: {} },
        { type: "tool_use", name: "Edit", id: "456", input: {} },
        { type: "tool_use", name: "Bash", id: "789", input: {} },
      ];

      analytics.recordToolsFromMessage("sess_123", contentBlocks, {
        clientId: "client_abc",
      });

      const events = db.query(
        "SELECT * FROM analytics_events WHERE event_type = 'tool.invoked'"
      ).all();
      expect(events.length).toBe(3);

      const toolNames = events.map(e => JSON.parse(e.properties).tool_name);
      expect(toolNames).toContain("Read");
      expect(toolNames).toContain("Edit");
      expect(toolNames).toContain("Bash");
    });
  });

  describe("Diff Events", () => {
    test("records diff.updated event with file stats", () => {
      analytics.recordDiffUpdated(
        "sess_123",
        { filesChanged: 5, additions: 100, deletions: 30 },
        { clientId: "client_abc" }
      );

      const events = db.query("SELECT * FROM analytics_events").all();
      expect(events[0].event_type).toBe("diff.updated");

      const props = JSON.parse(events[0].properties);
      expect(props.files_changed).toBe(5);
      expect(props.additions).toBe(100);
      expect(props.deletions).toBe(30);

      // Check all stats were recorded
      const stats = db.query(
        "SELECT stat_type, SUM(value) as total FROM analytics_daily_stats WHERE client_id IS NULL GROUP BY stat_type"
      ).all();

      const statMap = new Map(stats.map(s => [s.stat_type, s.total]));
      expect(statMap.get("files_changed")).toBe(5);
      expect(statMap.get("lines_added")).toBe(100);
      expect(statMap.get("lines_removed")).toBe(30);
    });
  });
});
```

### API Integration Tests

**File:** `tests/analytics-api.test.ts`

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

describe("Analytics API Integration", () => {
  let baseUrl: string;
  let server: any;

  beforeAll(async () => {
    // Start test server
    // ...
  });

  afterAll(() => {
    server?.stop();
  });

  test("session creation records analytics", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Openctl-Client-ID": "test_client",
      },
      body: JSON.stringify({
        title: "Test Session",
        project_path: "/test",
        model: "claude-3",
        messages: [
          { role: "user", content_blocks: [{ type: "text", text: "Hello" }] },
          {
            role: "assistant",
            content_blocks: [
              { type: "text", text: "Hi" },
              { type: "tool_use", name: "Read", id: "1", input: {} },
            ],
          },
        ],
      }),
    });

    expect(res.status).toBe(201);

    // Verify analytics were recorded by checking stats endpoint
    const statsRes = await fetch(`${baseUrl}/api/stats?period=today&mine=true`, {
      headers: { "X-Openctl-Client-ID": "test_client" },
    });

    const stats = await statsRes.json();
    expect(stats.summary.sessions_created).toBeGreaterThan(0);
    expect(stats.summary.prompts_sent).toBeGreaterThan(0);
  });

  test("live session flow records all events", async () => {
    // Create live session
    const createRes = await fetch(`${baseUrl}/api/sessions/live`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Openctl-Client-ID": "test_client",
      },
      body: JSON.stringify({
        title: "Live Session",
        project_path: "/test",
        model: "claude-4",
      }),
    });

    const { id, stream_token } = await createRes.json();

    // Push messages
    await fetch(`${baseUrl}/api/sessions/${id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${stream_token}`,
        "X-Openctl-Client-ID": "test_client",
      },
      body: JSON.stringify({
        messages: [
          { role: "user", content_blocks: [{ type: "text", text: "Test prompt" }] },
        ],
      }),
    });

    // Update diff
    await fetch(`${baseUrl}/api/sessions/${id}/diff`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${stream_token}`,
        "X-Openctl-Client-ID": "test_client",
      },
      body: JSON.stringify({
        diff_content: "diff --git a/file.ts b/file.ts\n+new line\n-old line\n",
      }),
    });

    // Complete session
    await fetch(`${baseUrl}/api/sessions/${id}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${stream_token}`,
        "X-Openctl-Client-ID": "test_client",
      },
      body: JSON.stringify({}),
    });

    // Verify all stats recorded
    const statsRes = await fetch(`${baseUrl}/api/stats?period=today`);
    const stats = await statsRes.json();

    expect(stats.summary.sessions_created).toBeGreaterThan(0);
    expect(stats.summary.sessions_live).toBeGreaterThan(0);
    expect(stats.summary.prompts_sent).toBeGreaterThan(0);
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/analytics/events.ts` | Create | AnalyticsRecorder class with all event methods |
| `src/routes/api.ts` | Modify | Add instrumentation at all trigger points |
| `tests/analytics-instrumentation.test.ts` | Create | Unit tests for AnalyticsRecorder |
| `tests/analytics-api.test.ts` | Create | Integration tests for API instrumentation |

## Instrumentation Points Summary

| API Endpoint | Event(s) | Stats Updated |
|--------------|----------|---------------|
| `POST /api/sessions` | `session.created`, `message.sent` (per user msg), `tool.invoked` (per tool), `diff.updated` | `sessions_created`, `sessions_interactive`, `prompts_sent`, `tool_*`, `lines_added/removed`, `files_changed` |
| `POST /api/sessions/live` | `session.created` | `sessions_created`, `sessions_live`, `sessions_interactive` |
| `POST /api/sessions/:id/messages` | `message.sent` (per user msg), `tool.invoked` (per tool) | `prompts_sent`, `tool_*` |
| `PUT /api/sessions/:id/diff` | `diff.updated` | `lines_added`, `lines_removed`, `files_changed` |
| `POST /api/sessions/:id/complete` | `session.completed` | (no stats, event only) |

## Acceptance Criteria

- [ ] AnalyticsRecorder class is created with all event recording methods
- [ ] Session creation (both upload and live) records `session.created` event
- [ ] Session completion records `session.completed` event
- [ ] User messages record `message.sent` event and increment `prompts_sent`
- [ ] Tool uses are parsed from content blocks and recorded as `tool.invoked`
- [ ] Diff updates record `diff.updated` with file/line stats
- [ ] Both global and per-client rollups are maintained
- [ ] Analytics recording is atomic with database operations
- [ ] All tests pass
