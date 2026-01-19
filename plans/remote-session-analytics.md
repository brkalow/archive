# Remote Session Analytics Implementation Plan

## Overview

The remote sessions feature (browser-initiated sessions via daemon relay) introduced in commit `cdc04d6` lacks analytics instrumentation. This plan adds proper event tracking to match the existing analytics patterns.

## Current State Analysis

### Existing Analytics Infrastructure
- `AnalyticsRecorder` class in `src/analytics/events.ts`
- Event types: `session.created`, `session.completed`, `message.sent`, `diff.updated`, `tool.invoked`
- Stat types: `sessions_created`, `sessions_interactive`, `sessions_live`, `prompts_sent`, etc.
- Instrumentation in `src/routes/api.ts` for upload and live streaming endpoints

### What's Missing for Remote Sessions
1. **Session spawn** - No `session.created` event when spawning via `/api/sessions/spawn`
2. **Session resume** - No event tracking for `/api/sessions/:id/resume`
3. **Session ended** - No `session.completed` event in `session_ended` WebSocket handler
4. **Message relay** - No `message.sent` or `tool.invoked` in daemon message relay
5. **Remote stat type** - No `sessions_remote` stat to count spawned sessions

## Implementation Steps

### Step 1: Add `sessions_remote` Stat Type

**File:** `src/db/schema.ts`

Add `sessions_remote` to the `StatType` union:

```typescript
export type StatType =
  | "sessions_created"
  | "sessions_interactive"
  | "sessions_live"
  | "sessions_remote"  // NEW
  | "prompts_sent"
  // ...
```

### Step 2: Update `SessionCreatedProperties`

**File:** `src/db/schema.ts`

Add `remote` property to event properties:

```typescript
export type SessionCreatedProperties = {
  model?: string;
  harness?: string;
  interactive?: boolean;
  is_live?: boolean;
  remote?: boolean;  // NEW
};
```

### Step 3: Update `recordSessionCreated` Method

**File:** `src/analytics/events.ts`

Add support for `remote` option:

```typescript
recordSessionCreated(
  sessionId: string,
  options: {
    clientId?: string;
    model?: string;
    harness?: string;
    interactive?: boolean;
    isLive?: boolean;
    remote?: boolean;  // NEW
  } = {}
): void {
  const { clientId, model, harness, interactive, isLive, remote } = options;

  const properties: SessionCreatedProperties = {
    model,
    harness,
    interactive,
    is_live: isLive,
    remote,  // NEW
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

  // NEW: Track remote sessions
  if (remote) {
    this.repo.incrementDailyStat("sessions_remote", { clientId, model });
  }
}
```

### Step 4: Instrument `spawnSession` Endpoint

**File:** `src/routes/api.ts`

Add analytics recording after successful session creation in `spawnSession()`:

```typescript
async spawnSession(req: Request): Promise<Response> {
  // ... existing code ...

  // After: repo.createSession({...})

  // NEW: Record analytics for spawned session creation
  analytics.recordSessionCreated(sessionId, {
    clientId: clientId || undefined,
    model: body.model,
    harness,
    interactive: true,
    isLive: true,
    remote: true,
  });

  // ... rest of existing code ...
}
```

### Step 5: Instrument `session_ended` WebSocket Handler

**File:** `src/server.ts`

Add analytics recording in the `session_ended` case. This requires:
1. Import `AnalyticsRecorder` in server.ts
2. Calculate session duration and message count
3. Record completion event

```typescript
case "session_ended": {
  // Get session for duration calculation
  const spawnedSession = spawnedSessionRegistry.getSession(message.session_id);

  // Calculate duration
  let durationSeconds: number | undefined;
  if (spawnedSession?.createdAt) {
    durationSeconds = Math.floor((Date.now() - spawnedSession.createdAt.getTime()) / 1000);
  }

  // Get message count from DB
  const messageCount = repo.getSessionMessageCount(message.session_id);

  // Record analytics
  analytics.recordSessionCompleted(message.session_id, {
    clientId: ws.data.clientId,
    durationSeconds,
    messageCount,
  });

  // ... existing code ...
}
```

### Step 6: Instrument Message Relay Handler

**File:** `src/server.ts`

In the `message` case handler for daemon WebSocket messages, add analytics:

```typescript
case "message": {
  // ... existing message storage code ...

  // NEW: Record analytics for relayed messages
  for (const msg of message.messages) {
    if (msg.role === "user") {
      const content = msg.content_blocks?.find(b => b.type === "text")?.text || "";
      analytics.recordMessageSent(message.session_id, {
        clientId: ws.data.clientId,
        contentLength: content.length,
      });
    }
    if (msg.role === "assistant" && msg.content_blocks) {
      analytics.recordToolsFromMessage(
        message.session_id,
        msg.content_blocks as Array<{ type: string; name?: string }>,
        { clientId: ws.data.clientId }
      );
    }
  }

  // ... existing broadcast code ...
}
```

### Step 7: Add `getSessionMessageCount` to Repository (if needed)

**File:** `src/db/repository.ts`

If not already present, add helper method:

```typescript
getSessionMessageCount(sessionId: string): number {
  const result = this.db.query(
    "SELECT COUNT(*) as count FROM messages WHERE session_id = ?"
  ).get(sessionId) as { count: number } | null;
  return result?.count ?? 0;
}
```

### Step 8: Update Analytics Spec Documentation

**File:** `specs/analytics.md`

Add `sessions_remote` to the stat types table and document remote session tracking.

## Testing Plan

1. **Unit tests** - Add tests for new analytics methods
2. **Integration tests** - Verify spawn → message → complete flow records correct events
3. **Manual verification**:
   - Spawn a remote session via UI
   - Send messages
   - End session
   - Check `/api/stats` includes remote session counts
   - Verify `analytics_events` has correct entries
   - Verify `analytics_daily_stats` increments `sessions_remote`

## Files Changed

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `sessions_remote` stat type, add `remote` to SessionCreatedProperties |
| `src/analytics/events.ts` | Add `remote` option to `recordSessionCreated` |
| `src/routes/api.ts` | Instrument `spawnSession` endpoint |
| `src/server.ts` | Instrument `session_ended` and `message` handlers |
| `src/db/repository.ts` | Add `getSessionMessageCount` if needed |
| `specs/analytics.md` | Document new metrics |
| `tests/analytics/*` | Add test coverage |

## Migration Notes

No database migration required - uses existing tables with new stat type values.
