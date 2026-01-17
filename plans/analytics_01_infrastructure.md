# Analytics Phase 1: Core Infrastructure

> **Spec reference:** [specs/analytics.md](../specs/analytics.md)

## Overview

This plan covers the foundational infrastructure for analytics: database schema, type definitions, and repository methods for event recording and stat queries.

## Dependencies

None - this is the foundational plan that instrumentation and query APIs depend on.

## Tasks

### 1. Schema Changes

Add new tables for analytics in the same `sessions.db` database.

**File:** `src/db/schema.ts`

```typescript
// Add after existing table creation

// Analytics events - raw event log (append-only)
db.run(`
  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    session_id TEXT,
    client_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
    properties TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_events_type ON analytics_events(event_type)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON analytics_events(timestamp)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_events_client ON analytics_events(client_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_events_type_timestamp ON analytics_events(event_type, timestamp)`);

// Analytics daily stats - pre-computed daily aggregates
db.run(`
  CREATE TABLE IF NOT EXISTS analytics_daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    client_id TEXT,
    model TEXT,
    stat_type TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    UNIQUE(date, client_id, model, stat_type)
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON analytics_daily_stats(date)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_daily_stats_client ON analytics_daily_stats(client_id)`);
```

### 2. Type Definitions

Add TypeScript types for analytics data structures.

**File:** `src/db/schema.ts`

```typescript
// Event types
export type AnalyticsEventType =
  | "session.created"
  | "session.completed"
  | "message.sent"
  | "diff.updated"
  | "tool.invoked";

// Stat types for daily rollups
export type StatType =
  | "sessions_created"
  | "sessions_interactive"
  | "sessions_live"
  | "prompts_sent"
  | "lines_added"
  | "lines_removed"
  | "files_changed"
  | `tool_${string}`;

// Raw event record
export type AnalyticsEvent = {
  id: number;
  event_type: AnalyticsEventType;
  session_id: string | null;
  client_id: string | null;
  timestamp: string;
  properties: Record<string, unknown>;
};

// Daily stat record
export type AnalyticsDailyStat = {
  id: number;
  date: string;           // YYYY-MM-DD
  client_id: string | null;
  model: string | null;
  stat_type: StatType;
  value: number;
};

// Event property types for type safety
export type SessionCreatedProperties = {
  model?: string;
  harness?: string;
  interactive?: boolean;
  is_live?: boolean;
};

export type SessionCompletedProperties = {
  duration_seconds?: number;
  message_count?: number;
};

export type MessageSentProperties = {
  content_length?: number;
};

export type DiffUpdatedProperties = {
  files_changed: number;
  additions: number;
  deletions: number;
};

export type ToolInvokedProperties = {
  tool_name: string;
};
```

### 3. Repository Methods - Event Recording

Add methods to `SessionRepository` for recording events and updating rollups.

**File:** `src/db/repository.ts`

```typescript
// Add to statement cache in constructor
private readonly analyticsStmts: {
  insertEvent: Statement;
  upsertDailyStat: Statement;
  getStatsByDateRange: Statement;
  getToolStats: Statement;
  getTimeseries: Statement;
};

// Initialize statements after db setup
this.analyticsStmts = {
  insertEvent: this.db.prepare(`
    INSERT INTO analytics_events (event_type, session_id, client_id, timestamp, properties)
    VALUES (?, ?, ?, datetime('now', 'utc'), ?)
  `),

  upsertDailyStat: this.db.prepare(`
    INSERT INTO analytics_daily_stats (date, client_id, model, stat_type, value)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date, client_id, model, stat_type)
    DO UPDATE SET value = value + excluded.value
  `),

  getStatsByDateRange: this.db.prepare(`
    SELECT stat_type, SUM(value) as total
    FROM analytics_daily_stats
    WHERE date >= ? AND date <= ?
      AND (? IS NULL OR client_id = ? OR client_id IS NULL)
      AND stat_type NOT LIKE 'tool_%'
    GROUP BY stat_type
  `),

  getToolStats: this.db.prepare(`
    SELECT SUBSTR(stat_type, 6) as tool, SUM(value) as count
    FROM analytics_daily_stats
    WHERE date >= ? AND date <= ?
      AND (? IS NULL OR client_id = ? OR client_id IS NULL)
      AND stat_type LIKE 'tool_%'
    GROUP BY stat_type
    ORDER BY count DESC
  `),

  getTimeseries: this.db.prepare(`
    SELECT date, SUM(value) as value
    FROM analytics_daily_stats
    WHERE date >= ? AND date <= ?
      AND (? IS NULL OR client_id = ? OR client_id IS NULL)
      AND stat_type = ?
    GROUP BY date
    ORDER BY date ASC
  `),
};
```

### 4. Repository Methods - Core Analytics Operations

**File:** `src/db/repository.ts`

```typescript
/**
 * Record an analytics event and update daily rollups atomically
 */
recordEvent(
  eventType: AnalyticsEventType,
  options: {
    sessionId?: string;
    clientId?: string;
    properties?: Record<string, unknown>;
  } = {}
): void {
  const { sessionId, clientId, properties = {} } = options;

  // Insert raw event
  this.analyticsStmts.insertEvent.run(
    eventType,
    sessionId ?? null,
    clientId ?? null,
    JSON.stringify(properties)
  );
}

/**
 * Increment a daily stat (atomic upsert)
 * Automatically updates both global (client_id=null) and per-client rollups
 */
incrementDailyStat(
  statType: StatType,
  options: {
    clientId?: string;
    model?: string;
    value?: number;
    date?: string;  // YYYY-MM-DD, defaults to today
  } = {}
): void {
  const {
    clientId,
    model,
    value = 1,
    date = new Date().toISOString().slice(0, 10)
  } = options;

  // Always update global rollup (client_id = null)
  this.analyticsStmts.upsertDailyStat.run(date, null, model ?? null, statType, value);

  // Also update per-client rollup if client_id provided
  if (clientId) {
    this.analyticsStmts.upsertDailyStat.run(date, clientId, model ?? null, statType, value);
  }
}

/**
 * Record event and increment stat in a single transaction
 */
recordEventWithStat(
  eventType: AnalyticsEventType,
  statType: StatType,
  options: {
    sessionId?: string;
    clientId?: string;
    model?: string;
    properties?: Record<string, unknown>;
    statValue?: number;
  } = {}
): void {
  const { sessionId, clientId, model, properties, statValue = 1 } = options;

  const transaction = this.db.transaction(() => {
    this.recordEvent(eventType, { sessionId, clientId, properties });
    this.incrementDailyStat(statType, { clientId, model, value: statValue });
  });

  transaction();
}

/**
 * Record multiple stats in a single transaction (for diff updates)
 */
recordMultipleStats(
  stats: Array<{
    statType: StatType;
    value: number;
    model?: string;
  }>,
  options: {
    eventType?: AnalyticsEventType;
    sessionId?: string;
    clientId?: string;
    properties?: Record<string, unknown>;
  } = {}
): void {
  const { eventType, sessionId, clientId, properties } = options;

  const transaction = this.db.transaction(() => {
    if (eventType) {
      this.recordEvent(eventType, { sessionId, clientId, properties });
    }

    for (const stat of stats) {
      this.incrementDailyStat(stat.statType, {
        clientId,
        model: stat.model,
        value: stat.value,
      });
    }
  });

  transaction();
}
```

### 5. Repository Methods - Query Operations

**File:** `src/db/repository.ts`

```typescript
/**
 * Get summary stats for a date range
 */
getStatsSummary(
  startDate: string,
  endDate: string,
  clientId?: string
): Record<string, number> {
  const rows = this.analyticsStmts.getStatsByDateRange.all(
    startDate,
    endDate,
    clientId ?? null,
    clientId ?? null
  ) as Array<{ stat_type: string; total: number }>;

  const summary: Record<string, number> = {};
  for (const row of rows) {
    summary[row.stat_type] = row.total;
  }
  return summary;
}

/**
 * Get tool usage breakdown for a date range
 */
getToolStats(
  startDate: string,
  endDate: string,
  clientId?: string
): Array<{ tool: string; count: number }> {
  return this.analyticsStmts.getToolStats.all(
    startDate,
    endDate,
    clientId ?? null,
    clientId ?? null
  ) as Array<{ tool: string; count: number }>;
}

/**
 * Get timeseries data for a specific stat
 */
getStatTimeseries(
  statType: StatType,
  startDate: string,
  endDate: string,
  clientId?: string
): Array<{ date: string; value: number }> {
  return this.analyticsStmts.getTimeseries.all(
    startDate,
    endDate,
    clientId ?? null,
    clientId ?? null,
    statType
  ) as Array<{ date: string; value: number }>;
}
```

### 6. Date Range Helper

Add helper for calculating date ranges from period strings.

**File:** `src/analytics/queries.ts` (new file)

```typescript
export type Period = "today" | "week" | "month" | "all";

export interface DateRange {
  startDate: string;
  endDate: string;
}

/**
 * Calculate date range for a given period
 */
export function getDateRange(period: Period): DateRange {
  const now = new Date();
  const endDate = now.toISOString().slice(0, 10);

  let startDate: string;

  switch (period) {
    case "today":
      startDate = endDate;
      break;

    case "week":
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      startDate = weekAgo.toISOString().slice(0, 10);
      break;

    case "month":
      const monthAgo = new Date(now);
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      startDate = monthAgo.toISOString().slice(0, 10);
      break;

    case "all":
      startDate = "2020-01-01";  // Far past date to capture all data
      break;

    default:
      startDate = endDate;
  }

  return { startDate, endDate };
}

/**
 * Parse period from query param with validation
 */
export function parsePeriod(value: string | null): Period {
  if (value === "today" || value === "week" || value === "month" || value === "all") {
    return value;
  }
  return "week";  // Default to week if invalid
}
```

## Testing

### Unit Tests

**File:** `tests/analytics-infrastructure.test.ts`

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDatabase } from "../src/db/schema";
import { SessionRepository } from "../src/db/repository";

describe("Analytics Infrastructure", () => {
  let db: Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = initializeDatabase(":memory:");
    repo = new SessionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("Event Recording", () => {
    test("records event with properties", () => {
      repo.recordEvent("session.created", {
        sessionId: "sess_123",
        clientId: "client_abc",
        properties: { model: "claude-3", is_live: true },
      });

      const events = db.query("SELECT * FROM analytics_events").all();
      expect(events.length).toBe(1);
      expect(events[0].event_type).toBe("session.created");
      expect(events[0].session_id).toBe("sess_123");
      expect(JSON.parse(events[0].properties)).toEqual({
        model: "claude-3",
        is_live: true,
      });
    });

    test("records event without optional fields", () => {
      repo.recordEvent("tool.invoked", {
        properties: { tool_name: "Edit" },
      });

      const events = db.query("SELECT * FROM analytics_events").all();
      expect(events[0].session_id).toBeNull();
      expect(events[0].client_id).toBeNull();
    });
  });

  describe("Daily Stats", () => {
    test("increments stat for first occurrence", () => {
      repo.incrementDailyStat("sessions_created", {
        clientId: "client_123",
        model: "claude-3",
      });

      const stats = db.query("SELECT * FROM analytics_daily_stats").all();
      // Should have both global (null client) and per-client entry
      expect(stats.length).toBe(2);

      const global = stats.find(s => s.client_id === null);
      expect(global.value).toBe(1);

      const perClient = stats.find(s => s.client_id === "client_123");
      expect(perClient.value).toBe(1);
    });

    test("accumulates stats on upsert", () => {
      repo.incrementDailyStat("prompts_sent", { value: 5 });
      repo.incrementDailyStat("prompts_sent", { value: 3 });

      const stats = db.query(
        "SELECT value FROM analytics_daily_stats WHERE stat_type = 'prompts_sent'"
      ).all();
      expect(stats[0].value).toBe(8);
    });

    test("separates stats by date", () => {
      repo.incrementDailyStat("sessions_created", { date: "2025-01-15" });
      repo.incrementDailyStat("sessions_created", { date: "2025-01-16" });

      const stats = db.query(
        "SELECT date, value FROM analytics_daily_stats ORDER BY date"
      ).all();
      expect(stats.length).toBe(2);
      expect(stats[0].date).toBe("2025-01-15");
      expect(stats[1].date).toBe("2025-01-16");
    });

    test("separates stats by model", () => {
      repo.incrementDailyStat("sessions_created", { model: "claude-3" });
      repo.incrementDailyStat("sessions_created", { model: "claude-4" });

      const stats = db.query(
        "SELECT model, value FROM analytics_daily_stats WHERE model IS NOT NULL"
      ).all();
      expect(stats.length).toBe(2);
    });
  });

  describe("Stat Queries", () => {
    beforeEach(() => {
      // Seed test data
      repo.incrementDailyStat("sessions_created", { date: "2025-01-15", value: 5 });
      repo.incrementDailyStat("sessions_created", { date: "2025-01-16", value: 8 });
      repo.incrementDailyStat("prompts_sent", { date: "2025-01-15", value: 100 });
      repo.incrementDailyStat("prompts_sent", { date: "2025-01-16", value: 150 });
      repo.incrementDailyStat("tool_Edit", { date: "2025-01-15", value: 50 });
      repo.incrementDailyStat("tool_Write", { date: "2025-01-15", value: 30 });
    });

    test("gets summary stats for date range", () => {
      const summary = repo.getStatsSummary("2025-01-15", "2025-01-16");

      expect(summary.sessions_created).toBe(13);
      expect(summary.prompts_sent).toBe(250);
    });

    test("gets tool stats breakdown", () => {
      const tools = repo.getToolStats("2025-01-15", "2025-01-16");

      expect(tools.length).toBe(2);
      expect(tools.find(t => t.tool === "Edit")?.count).toBe(50);
      expect(tools.find(t => t.tool === "Write")?.count).toBe(30);
    });

    test("gets timeseries data", () => {
      const series = repo.getStatTimeseries(
        "sessions_created",
        "2025-01-15",
        "2025-01-16"
      );

      expect(series.length).toBe(2);
      expect(series[0]).toEqual({ date: "2025-01-15", value: 5 });
      expect(series[1]).toEqual({ date: "2025-01-16", value: 8 });
    });

    test("filters by client_id when provided", () => {
      repo.incrementDailyStat("sessions_created", {
        date: "2025-01-15",
        clientId: "my_client",
        value: 3,
      });

      const allSummary = repo.getStatsSummary("2025-01-15", "2025-01-15");
      const mySummary = repo.getStatsSummary("2025-01-15", "2025-01-15", "my_client");

      expect(allSummary.sessions_created).toBe(5);  // Global only
      expect(mySummary.sessions_created).toBe(3);   // Client-specific
    });
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/db/schema.ts` | Modify | Add analytics_events and analytics_daily_stats tables |
| `src/db/repository.ts` | Modify | Add event recording and stat query methods |
| `src/analytics/queries.ts` | Create | Date range helpers and query utilities |
| `tests/analytics-infrastructure.test.ts` | Create | Unit tests for analytics infrastructure |

## Acceptance Criteria

- [ ] `analytics_events` table is created with appropriate indexes
- [ ] `analytics_daily_stats` table is created with unique constraint
- [ ] Events can be recorded with session_id, client_id, and properties
- [ ] Daily stats are atomically upserted (increment on conflict)
- [ ] Both global and per-client rollups are maintained
- [ ] Summary stats can be queried by date range
- [ ] Tool stats can be queried separately with breakdown
- [ ] Timeseries data can be retrieved for any stat type
- [ ] Client filtering works correctly
- [ ] All tests pass
