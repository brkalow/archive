# Analytics System

This document describes the analytics, metrics, and event tracking system in openctl.

## Overview

The analytics system tracks usage patterns across sessions, providing insights into:
- Session creation and completion rates
- User prompts and interactions
- Code changes (lines added/removed, files changed)
- Tool invocations and usage patterns

The system uses a **dual-storage approach**:
1. **Raw events** (`analytics_events`) - Append-only log for detailed event data
2. **Daily rollups** (`analytics_daily_stats`) - Pre-aggregated statistics for fast queries

## Architecture

```
┌─────────────────┐     ┌───────────────────┐     ┌─────────────────┐
│  API Routes     │────▶│ AnalyticsRecorder │────▶│   Repository    │
│  (api.ts)       │     │   (events.ts)     │     │ (repository.ts) │
└─────────────────┘     └───────────────────┘     └────────┬────────┘
                                                           │
                                                           ▼
                                                  ┌─────────────────┐
                                                  │     SQLite      │
                                                  │ ┌─────────────┐ │
                                                  │ │   events    │ │
                                                  │ ├─────────────┤ │
                                                  │ │ daily_stats │ │
                                                  │ └─────────────┘ │
                                                  └─────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `src/analytics/events.ts` | `AnalyticsRecorder` class - high-level recording API |
| `src/analytics/queries.ts` | Query helpers (date ranges, timeseries gaps) |
| `src/db/schema.ts` | Table definitions and TypeScript types |
| `src/db/repository.ts` | Low-level database operations |
| `src/routes/api.ts` | API endpoints and instrumentation points |
| `src/routes/pages.ts` | Server-rendered `/stats` page route |
| `src/views/stats.ts` | Stats dashboard HTML rendering |

## Data Model

### Events Table (`analytics_events`)

Raw event log for detailed tracking. Events are append-only and immutable.

```sql
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  session_id TEXT,
  client_id TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
  properties TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);
```

**Indexes:**
- `idx_events_type` - Filter by event type
- `idx_events_timestamp` - Time-range queries
- `idx_events_client` - Per-client filtering
- `idx_events_type_timestamp` - Composite for common queries

### Daily Stats Table (`analytics_daily_stats`)

Pre-computed daily aggregates for fast dashboard queries.

```sql
CREATE TABLE IF NOT EXISTS analytics_daily_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,           -- YYYY-MM-DD
  client_id TEXT,               -- NULL = global aggregate
  model TEXT,                   -- NULL = all models
  stat_type TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  UNIQUE(date, client_id, model, stat_type)
);
```

The unique constraint enables atomic upserts:
```sql
INSERT INTO analytics_daily_stats (date, client_id, model, stat_type, value)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(date, client_id, model, stat_type)
DO UPDATE SET value = value + excluded.value
```

## Event Types

| Event Type | Trigger | Properties |
|------------|---------|------------|
| `session.created` | Session created (live or upload) | `model`, `harness`, `interactive`, `is_live` |
| `session.completed` | Live session ends | `duration_seconds`, `message_count` |
| `message.sent` | User prompt pushed | `content_length` |
| `diff.updated` | Code changes recorded | `files_changed`, `additions`, `deletions` |
| `tool.invoked` | Tool use detected | `tool_name` |

## Stat Types

Core stats tracked in daily rollups:

| Stat Type | Description |
|-----------|-------------|
| `sessions_created` | Total sessions created |
| `sessions_interactive` | Interactive sessions (feedback enabled) |
| `sessions_live` | Live-streamed sessions |
| `prompts_sent` | User messages sent |
| `tools_invoked` | Total tool invocations across all tools |
| `subagents_invoked` | Task tool invocations (subagent spawns) |
| `lines_added` | Lines of code added |
| `lines_removed` | Lines of code removed |
| `files_changed` | Total files changed in diffs |
| `tool_{name}` | Per-tool invocation counts |

Tool stats use a dynamic naming pattern (`tool_read`, `tool_edit`, `tool_bash`, etc.) to track usage of each tool separately. Tool names are sanitized to lowercase alphanumeric with underscores.

## Dual Rollup Pattern

When recording stats, the system updates both global and per-client aggregates:

```typescript
// Always update global rollup (client_id = NULL)
this.stmts.upsertDailyStat.run(date, null, model, statType, value);

// Also update per-client rollup if client_id provided
if (clientId) {
  this.stmts.upsertDailyStat.run(date, clientId, model, statType, value);
}
```

This enables O(1) queries for both "all stats" and "my stats" views without scanning raw events.

## API Endpoints

### GET `/api/stats`

Summary statistics for a period.

**Query Parameters:**
| Param | Values | Default | Description |
|-------|--------|---------|-------------|
| `period` | `today`, `week`, `month`, `all` | `week` | Time period |
| `mine` | `true` | - | Filter by client ID |

**Response:**
```json
{
  "period": "week",
  "summary": {
    "sessions_created": 42,
    "sessions_interactive": 15,
    "sessions_live": 28,
    "prompts_sent": 350,
    "tools_invoked": 2450,
    "subagents_invoked": 120,
    "lines_added": 5420,
    "lines_removed": 1230,
    "files_changed": 89
  }
}
```

### GET `/api/stats/timeseries`

Time-series data for a specific stat.

**Query Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| `stat` | Yes | Stat type to query |
| `period` | No | Time period (default: `week`) |
| `mine` | No | Filter by client |
| `fill` | No | Fill gaps with zeros |

**Response:**
```json
{
  "stat": "sessions_created",
  "period": "week",
  "data": [
    { "date": "2025-01-10", "value": 5 },
    { "date": "2025-01-11", "value": 8 }
  ]
}
```

### GET `/api/stats/tools`

Tool usage breakdown.

**Response:**
```json
{
  "period": "week",
  "data": [
    { "tool": "read", "count": 1250 },
    { "tool": "edit", "count": 890 },
    { "tool": "bash", "count": 445 }
  ]
}
```

### GET `/api/stats/dashboard`

Combined endpoint for dashboard (single request for all data).

**Response:**
```json
{
  "period": "week",
  "date_range": { "start": "2025-01-10", "end": "2025-01-17" },
  "summary": {
    "sessions_created": 42,
    "sessions_interactive": 15,
    "sessions_live": 28,
    "prompts_sent": 350,
    "tools_invoked": 2450,
    "subagents_invoked": 120,
    "lines_added": 5420,
    "lines_removed": 1230,
    "files_changed": 89
  },
  "tools": [ ... ],
  "timeseries": {
    "sessions": [ ... ]
  }
}
```

## Instrumentation Points

Analytics are recorded at these integration points in `src/routes/api.ts`:

### Session Creation

```typescript
// POST /api/sessions (batch upload)
analytics.recordSessionCreated(session.id, {
  clientId, model, harness, interactive: false, isLive: false
});

// POST /api/sessions/live (live streaming)
analytics.recordSessionCreated(id, {
  clientId, model, harness, interactive, isLive: true
});
```

### Message Tracking

```typescript
// POST /api/sessions/:id/messages
for (const msg of parsedMessages) {
  if (msg.role === "user") {
    analytics.recordMessageSent(sessionId, { clientId, contentLength });
  }
  if (msg.role === "assistant" && msg.content_blocks) {
    analytics.recordToolsFromMessage(sessionId, msg.content_blocks, { clientId });
  }
}
```

### Diff Updates

```typescript
// PUT /api/sessions/:id/diff
analytics.recordDiffUpdated(sessionId, {
  filesChanged,
  additions,
  deletions
}, { clientId });
```

### Session Completion

```typescript
// POST /api/sessions/:id/complete
analytics.recordSessionCompleted(sessionId, {
  clientId, durationSeconds, messageCount
});
```

## Query Helpers

The `src/analytics/queries.ts` module provides:

### `getDateRange(period: Period)`

Returns `{ startDate, endDate }` for a period:
- `today` - Current day only
- `week` - Today minus 7 days
- `month` - Today minus 30 days
- `all` - Since 2020-01-01

### `parsePeriod(value: string | null)`

Validates and normalizes period parameter, defaults to `"week"`.

### `fillTimeseriesGaps(data, startDate, endDate)`

Fills missing dates in timeseries with zero values for smooth charting.

## Client Identification

Clients are identified via the `X-Openctl-Client-ID` header. This is typically a stable identifier from the CLI installation, enabling:
- Per-user filtering ("my stats" view)
- Multi-tenant deployments
- Privacy-preserving analytics (no PII stored)

## Stats Dashboard

The `/stats` route renders a server-side dashboard showing:
- **Summary cards** - Sessions, prompts, tool calls, subagents
- **File stats** - Files changed
- **Code stats** - Lines added (green) / removed (red)
- **Sessions chart** - SVG bar chart of sessions over time
- **Tool breakdown** - Horizontal bar chart of tool usage

The page supports period selection (`today`, `week`, `month`, `all`) and "My Stats" / "All Stats" filtering via query parameters.

## Performance Considerations

1. **Pre-aggregation**: Daily rollups avoid scanning raw events for common queries
2. **Prepared statements**: All analytics queries use cached prepared statements
3. **Batch writes**: Multiple stats recorded in single transactions
4. **Indexed lookups**: Composite indexes on frequently-queried columns
5. **Atomic upserts**: `ON CONFLICT DO UPDATE` for thread-safe stat updates

## Adding New Metrics

To add a new metric:

### 1. Add stat type to schema

```typescript
// src/db/schema.ts
export type StatType =
  | "sessions_created"
  | ...
  | "new_metric";  // Add here
```

### 2. Add recording method

```typescript
// src/analytics/events.ts
recordNewMetric(
  sessionId: string,
  value: number,
  options: { clientId?: string } = {}
): void {
  this.repo.recordEventWithStat("new.event", "new_metric", {
    sessionId,
    clientId: options.clientId,
    statValue: value,
  });
}
```

### 3. Instrument API route

```typescript
// src/routes/api.ts
analytics.recordNewMetric(sessionId, value, { clientId });
```

### 4. Update dashboard (optional)

Add card or chart in `src/views/stats.ts`.

## Testing

### Seed Mock Data

```bash
bun run scripts/seed-analytics.ts
```

This creates 14 days of realistic mock data for testing the dashboard.

### Verify Rollups

```sql
-- Check that rollups match expectations
SELECT stat_type, SUM(value) as total
FROM analytics_daily_stats
WHERE client_id IS NULL
GROUP BY stat_type;
```

### Manual Verification

1. Create a session via the API
2. Check `analytics_events` for the raw event
3. Check `analytics_daily_stats` for the incremented rollup
4. Verify `/api/stats` returns updated counts
