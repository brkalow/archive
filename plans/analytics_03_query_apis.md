# Analytics Phase 3: Query APIs

> **Spec reference:** [specs/analytics.md](../specs/analytics.md)

## Overview

This plan covers the API endpoints for querying analytics data: summary stats, timeseries data, and tool usage breakdown.

## Dependencies

- **Phase 1:** Core Infrastructure (analytics tables and repository methods)
- **Phase 2:** Event Instrumentation (data must be recorded to query)

## Tasks

### 1. Add Stats Endpoints to API Routes

Add new route handlers for stats queries.

**File:** `src/routes/api.ts`

```typescript
import { getDateRange, parsePeriod, type Period } from "../analytics/queries";

export function createApiRoutes(repo: SessionRepository) {
  const analytics = new AnalyticsRecorder(repo);

  return {
    // ... existing routes ...

    /**
     * GET /api/stats
     * Query params: period (today|week|month|all), mine (true to filter by client_id)
     */
    getStats(req: Request): Response {
      const url = new URL(req.url);
      const period = parsePeriod(url.searchParams.get("period"));
      const mine = url.searchParams.get("mine") === "true";
      const clientId = mine ? getClientId(req) : undefined;

      const { startDate, endDate } = getDateRange(period);
      const summary = repo.getStatsSummary(startDate, endDate, clientId);

      return json({
        period,
        summary: {
          sessions_created: summary.sessions_created ?? 0,
          sessions_interactive: summary.sessions_interactive ?? 0,
          sessions_live: summary.sessions_live ?? 0,
          prompts_sent: summary.prompts_sent ?? 0,
          lines_added: summary.lines_added ?? 0,
          lines_removed: summary.lines_removed ?? 0,
          files_changed: summary.files_changed ?? 0,
        },
      });
    },

    /**
     * GET /api/stats/timeseries
     * Query params: stat, period, mine
     */
    getStatsTimeseries(req: Request): Response {
      const url = new URL(req.url);
      const statType = url.searchParams.get("stat");
      const period = parsePeriod(url.searchParams.get("period"));
      const mine = url.searchParams.get("mine") === "true";
      const clientId = mine ? getClientId(req) : undefined;

      if (!statType) {
        return jsonError("stat parameter is required", 400);
      }

      // Validate stat type
      const validStats = [
        "sessions_created",
        "sessions_interactive",
        "sessions_live",
        "prompts_sent",
        "lines_added",
        "lines_removed",
        "files_changed",
      ];

      if (!validStats.includes(statType) && !statType.startsWith("tool_")) {
        return jsonError(`Invalid stat type: ${statType}`, 400);
      }

      const { startDate, endDate } = getDateRange(period);
      const data = repo.getStatTimeseries(statType as StatType, startDate, endDate, clientId);

      return json({
        stat: statType,
        period,
        data,
      });
    },

    /**
     * GET /api/stats/tools
     * Query params: period, mine
     */
    getStatsTools(req: Request): Response {
      const url = new URL(req.url);
      const period = parsePeriod(url.searchParams.get("period"));
      const mine = url.searchParams.get("mine") === "true";
      const clientId = mine ? getClientId(req) : undefined;

      const { startDate, endDate } = getDateRange(period);
      const tools = repo.getToolStats(startDate, endDate, clientId);

      return json({
        period,
        data: tools,
      });
    },
  };
}
```

### 2. Register Stats Routes in Server

Add the new routes to the server configuration.

**File:** `src/server.ts`

```typescript
routes: {
  // ... existing routes ...

  "/api/stats": {
    GET: (req) => api.getStats(req),
  },

  "/api/stats/timeseries": {
    GET: (req) => api.getStatsTimeseries(req),
  },

  "/api/stats/tools": {
    GET: (req) => api.getStatsTools(req),
  },
},
```

### 3. Enhance Date Range Helper

Add additional utilities for common query patterns.

**File:** `src/analytics/queries.ts`

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
      weekAgo.setDate(weekAgo.getDate() - 6); // Include today = 7 days
      startDate = weekAgo.toISOString().slice(0, 10);
      break;

    case "month":
      const monthAgo = new Date(now);
      monthAgo.setDate(monthAgo.getDate() - 29); // Include today = 30 days
      startDate = monthAgo.toISOString().slice(0, 10);
      break;

    case "all":
      startDate = "2020-01-01"; // Far past date to capture all data
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
  return "week"; // Default to week if invalid
}

/**
 * Generate array of dates between start and end (inclusive)
 * Useful for filling gaps in timeseries data
 */
export function getDatesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = new Date(startDate);
  const end = new Date(endDate);

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

/**
 * Fill gaps in timeseries data with zero values
 */
export function fillTimeseriesGaps(
  data: Array<{ date: string; value: number }>,
  startDate: string,
  endDate: string
): Array<{ date: string; value: number }> {
  const dataMap = new Map(data.map(d => [d.date, d.value]));
  const allDates = getDatesBetween(startDate, endDate);

  return allDates.map(date => ({
    date,
    value: dataMap.get(date) ?? 0,
  }));
}
```

### 4. Add Filled Timeseries Endpoint (Optional Enhancement)

Provide an option to fill gaps with zeros for charting.

**File:** `src/routes/api.ts`

```typescript
getStatsTimeseries(req: Request): Response {
  const url = new URL(req.url);
  const statType = url.searchParams.get("stat");
  const period = parsePeriod(url.searchParams.get("period"));
  const mine = url.searchParams.get("mine") === "true";
  const fill = url.searchParams.get("fill") === "true"; // Fill gaps with zeros
  const clientId = mine ? getClientId(req) : undefined;

  // ... validation ...

  const { startDate, endDate } = getDateRange(period);
  let data = repo.getStatTimeseries(statType as StatType, startDate, endDate, clientId);

  // Optionally fill gaps for charting
  if (fill) {
    data = fillTimeseriesGaps(data, startDate, endDate);
  }

  return json({
    stat: statType,
    period,
    data,
  });
}
```

### 5. Add Combined Stats Endpoint (Convenience)

Single endpoint to fetch all stats needed for a dashboard.

**File:** `src/routes/api.ts`

```typescript
/**
 * GET /api/stats/dashboard
 * Returns summary, tool breakdown, and sessions timeseries in one call
 */
getDashboardStats(req: Request): Response {
  const url = new URL(req.url);
  const period = parsePeriod(url.searchParams.get("period"));
  const mine = url.searchParams.get("mine") === "true";
  const clientId = mine ? getClientId(req) : undefined;

  const { startDate, endDate } = getDateRange(period);

  // Fetch all data
  const summary = repo.getStatsSummary(startDate, endDate, clientId);
  const tools = repo.getToolStats(startDate, endDate, clientId);
  const sessionsTimeseries = fillTimeseriesGaps(
    repo.getStatTimeseries("sessions_created", startDate, endDate, clientId),
    startDate,
    endDate
  );

  return json({
    period,
    date_range: { start: startDate, end: endDate },
    summary: {
      sessions_created: summary.sessions_created ?? 0,
      sessions_interactive: summary.sessions_interactive ?? 0,
      sessions_live: summary.sessions_live ?? 0,
      prompts_sent: summary.prompts_sent ?? 0,
      lines_added: summary.lines_added ?? 0,
      lines_removed: summary.lines_removed ?? 0,
      files_changed: summary.files_changed ?? 0,
    },
    tools,
    timeseries: {
      sessions: sessionsTimeseries,
    },
  });
}
```

**File:** `src/server.ts`

```typescript
routes: {
  // ... other stats routes ...

  "/api/stats/dashboard": {
    GET: (req) => api.getDashboardStats(req),
  },
},
```

## API Response Examples

### GET /api/stats?period=week

```json
{
  "period": "week",
  "summary": {
    "sessions_created": 42,
    "sessions_interactive": 5,
    "sessions_live": 12,
    "prompts_sent": 318,
    "lines_added": 4521,
    "lines_removed": 1203,
    "files_changed": 87
  }
}
```

### GET /api/stats/timeseries?stat=sessions_created&period=week&fill=true

```json
{
  "stat": "sessions_created",
  "period": "week",
  "data": [
    { "date": "2025-01-11", "value": 5 },
    { "date": "2025-01-12", "value": 8 },
    { "date": "2025-01-13", "value": 0 },
    { "date": "2025-01-14", "value": 12 },
    { "date": "2025-01-15", "value": 6 },
    { "date": "2025-01-16", "value": 7 },
    { "date": "2025-01-17", "value": 4 }
  ]
}
```

### GET /api/stats/tools?period=month

```json
{
  "period": "month",
  "data": [
    { "tool": "Edit", "count": 245 },
    { "tool": "Write", "count": 123 },
    { "tool": "Bash", "count": 89 },
    { "tool": "Read", "count": 456 },
    { "tool": "Glob", "count": 78 }
  ]
}
```

### GET /api/stats/dashboard?period=week

```json
{
  "period": "week",
  "date_range": {
    "start": "2025-01-11",
    "end": "2025-01-17"
  },
  "summary": {
    "sessions_created": 42,
    "sessions_interactive": 5,
    "sessions_live": 12,
    "prompts_sent": 318,
    "lines_added": 4521,
    "lines_removed": 1203,
    "files_changed": 87
  },
  "tools": [
    { "tool": "Edit", "count": 245 },
    { "tool": "Read", "count": 189 }
  ],
  "timeseries": {
    "sessions": [
      { "date": "2025-01-11", "value": 5 },
      { "date": "2025-01-12", "value": 8 }
    ]
  }
}
```

## Testing

### API Tests

**File:** `tests/analytics-queries.test.ts`

```typescript
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";

describe("Analytics Query APIs", () => {
  let baseUrl: string;
  let server: any;
  let db: Database;

  beforeAll(async () => {
    // Start test server with in-memory database
    // ...
  });

  afterAll(() => {
    server?.stop();
    db?.close();
  });

  beforeEach(() => {
    // Seed test data
    seedAnalyticsData(db);
  });

  describe("GET /api/stats", () => {
    test("returns summary for default period (week)", async () => {
      const res = await fetch(`${baseUrl}/api/stats`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.period).toBe("week");
      expect(data.summary).toHaveProperty("sessions_created");
      expect(data.summary).toHaveProperty("prompts_sent");
      expect(data.summary).toHaveProperty("lines_added");
    });

    test("accepts period parameter", async () => {
      const res = await fetch(`${baseUrl}/api/stats?period=today`);
      const data = await res.json();
      expect(data.period).toBe("today");
    });

    test("filters by client when mine=true", async () => {
      // Create session with specific client
      await createTestSession({ clientId: "my_client" });

      const allRes = await fetch(`${baseUrl}/api/stats?period=today`);
      const allData = await allRes.json();

      const mineRes = await fetch(`${baseUrl}/api/stats?period=today&mine=true`, {
        headers: { "X-Openctl-Client-ID": "my_client" },
      });
      const mineData = await mineRes.json();

      // Client-specific should be <= global
      expect(mineData.summary.sessions_created).toBeLessThanOrEqual(
        allData.summary.sessions_created
      );
    });

    test("returns zeros for empty periods", async () => {
      const res = await fetch(`${baseUrl}/api/stats?period=today`, {
        headers: { "X-Openctl-Client-ID": "nonexistent_client" },
      });
      const data = await res.json();

      expect(data.summary.sessions_created).toBe(0);
      expect(data.summary.prompts_sent).toBe(0);
    });
  });

  describe("GET /api/stats/timeseries", () => {
    test("returns timeseries data for valid stat", async () => {
      const res = await fetch(`${baseUrl}/api/stats/timeseries?stat=sessions_created&period=week`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.stat).toBe("sessions_created");
      expect(Array.isArray(data.data)).toBe(true);

      if (data.data.length > 0) {
        expect(data.data[0]).toHaveProperty("date");
        expect(data.data[0]).toHaveProperty("value");
      }
    });

    test("requires stat parameter", async () => {
      const res = await fetch(`${baseUrl}/api/stats/timeseries?period=week`);
      expect(res.status).toBe(400);
    });

    test("rejects invalid stat types", async () => {
      const res = await fetch(`${baseUrl}/api/stats/timeseries?stat=invalid_stat`);
      expect(res.status).toBe(400);
    });

    test("accepts tool_ prefixed stats", async () => {
      const res = await fetch(`${baseUrl}/api/stats/timeseries?stat=tool_Edit&period=week`);
      expect(res.status).toBe(200);
    });

    test("fills gaps when fill=true", async () => {
      const res = await fetch(
        `${baseUrl}/api/stats/timeseries?stat=sessions_created&period=week&fill=true`
      );
      const data = await res.json();

      // Should have entry for each day in the period
      expect(data.data.length).toBe(7);

      // All dates should be present and sequential
      const dates = data.data.map((d: any) => d.date);
      for (let i = 1; i < dates.length; i++) {
        const prev = new Date(dates[i - 1]);
        const curr = new Date(dates[i]);
        const diffDays = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);
        expect(diffDays).toBe(1);
      }
    });
  });

  describe("GET /api/stats/tools", () => {
    test("returns tool breakdown", async () => {
      const res = await fetch(`${baseUrl}/api/stats/tools?period=week`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(Array.isArray(data.data)).toBe(true);

      if (data.data.length > 0) {
        expect(data.data[0]).toHaveProperty("tool");
        expect(data.data[0]).toHaveProperty("count");
      }
    });

    test("returns tools sorted by count descending", async () => {
      const res = await fetch(`${baseUrl}/api/stats/tools?period=month`);
      const data = await res.json();

      for (let i = 1; i < data.data.length; i++) {
        expect(data.data[i - 1].count).toBeGreaterThanOrEqual(data.data[i].count);
      }
    });
  });

  describe("GET /api/stats/dashboard", () => {
    test("returns combined dashboard data", async () => {
      const res = await fetch(`${baseUrl}/api/stats/dashboard?period=week`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty("summary");
      expect(data).toHaveProperty("tools");
      expect(data).toHaveProperty("timeseries");
      expect(data).toHaveProperty("date_range");
    });
  });
});
```

### Unit Tests for Date Helpers

**File:** `tests/analytics-date-helpers.test.ts`

```typescript
import { describe, test, expect } from "bun:test";
import {
  getDateRange,
  parsePeriod,
  getDatesBetween,
  fillTimeseriesGaps,
} from "../src/analytics/queries";

describe("Date Range Helpers", () => {
  test("getDateRange returns today for 'today' period", () => {
    const { startDate, endDate } = getDateRange("today");
    expect(startDate).toBe(endDate);
  });

  test("getDateRange returns 7 days for 'week' period", () => {
    const { startDate, endDate } = getDateRange("week");
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(6); // 7 days inclusive
  });

  test("parsePeriod defaults to week for invalid input", () => {
    expect(parsePeriod(null)).toBe("week");
    expect(parsePeriod("invalid")).toBe("week");
    expect(parsePeriod("today")).toBe("today");
  });

  test("getDatesBetween generates inclusive date range", () => {
    const dates = getDatesBetween("2025-01-15", "2025-01-17");
    expect(dates).toEqual(["2025-01-15", "2025-01-16", "2025-01-17"]);
  });

  test("fillTimeseriesGaps fills missing dates with zeros", () => {
    const data = [
      { date: "2025-01-15", value: 5 },
      { date: "2025-01-17", value: 8 },
    ];

    const filled = fillTimeseriesGaps(data, "2025-01-15", "2025-01-17");

    expect(filled).toEqual([
      { date: "2025-01-15", value: 5 },
      { date: "2025-01-16", value: 0 },
      { date: "2025-01-17", value: 8 },
    ]);
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/routes/api.ts` | Modify | Add getStats, getStatsTimeseries, getStatsTools, getDashboardStats handlers |
| `src/server.ts` | Modify | Register /api/stats/* routes |
| `src/analytics/queries.ts` | Modify | Add fillTimeseriesGaps and getDatesBetween helpers |
| `tests/analytics-queries.test.ts` | Create | API integration tests |
| `tests/analytics-date-helpers.test.ts` | Create | Unit tests for date helpers |

## Acceptance Criteria

- [ ] `GET /api/stats` returns summary stats with period filtering
- [ ] `GET /api/stats?mine=true` filters by client_id from header
- [ ] `GET /api/stats/timeseries` returns date-value pairs for specified stat
- [ ] `GET /api/stats/timeseries?fill=true` fills gaps with zero values
- [ ] `GET /api/stats/tools` returns tool usage breakdown sorted by count
- [ ] `GET /api/stats/dashboard` returns combined summary, tools, and timeseries
- [ ] All endpoints validate and default period parameter
- [ ] Invalid stat types return 400 error
- [ ] Missing required parameters return 400 error
- [ ] Empty results return zeros, not errors
- [ ] All tests pass
