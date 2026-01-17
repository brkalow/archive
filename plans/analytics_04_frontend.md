# Analytics Phase 4: Frontend (Optional)

> **Spec reference:** [specs/analytics.md](../specs/analytics.md)

## Overview

This plan covers the optional frontend stats page at `/stats`. It includes summary cards for key metrics, a time series chart for sessions over time, and a tool usage breakdown table.

## Dependencies

- **Phase 1:** Core Infrastructure
- **Phase 2:** Event Instrumentation
- **Phase 3:** Query APIs

## Tasks

### 1. Create Stats Page Route

Add the stats page route handler.

**File:** `src/routes/pages.ts`

```typescript
/**
 * GET /stats
 * Stats dashboard page
 */
statsPage(req: Request): Response {
  const url = new URL(req.url);
  const period = url.searchParams.get("period") || "week";
  const mine = url.searchParams.get("mine") === "true";
  const clientId = mine ? getClientId(req) : undefined;

  const { startDate, endDate } = getDateRange(period as Period);

  // Fetch all data for SSR
  const summary = this.repo.getStatsSummary(startDate, endDate, clientId);
  const tools = this.repo.getToolStats(startDate, endDate, clientId);
  const sessionsTimeseries = fillTimeseriesGaps(
    this.repo.getStatTimeseries("sessions_created", startDate, endDate, clientId),
    startDate,
    endDate
  );

  const html = renderStatsPage({
    period,
    mine,
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
    timeseries: sessionsTimeseries,
    dateRange: { start: startDate, end: endDate },
  });

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}
```

### 2. Register Stats Route

Add the route to the server.

**File:** `src/server.ts`

```typescript
routes: {
  // ... existing routes ...

  "/stats": {
    GET: (req) => pages.statsPage(req),
  },
},
```

### 3. Create Stats Page Template

Create the HTML template for the stats page.

**File:** `src/views/stats.ts`

```typescript
import { baseLayout } from "./layout";

interface StatsPageData {
  period: string;
  mine: boolean;
  summary: {
    sessions_created: number;
    sessions_interactive: number;
    sessions_live: number;
    prompts_sent: number;
    lines_added: number;
    lines_removed: number;
    files_changed: number;
  };
  tools: Array<{ tool: string; count: number }>;
  timeseries: Array<{ date: string; value: number }>;
  dateRange: { start: string; end: string };
}

export function renderStatsPage(data: StatsPageData): string {
  const content = `
    <div class="max-w-6xl mx-auto px-4 py-8">
      <!-- Header with period selector -->
      <div class="flex items-center justify-between mb-8">
        <h1 class="text-2xl font-semibold text-gray-900">Analytics</h1>
        <div class="flex items-center gap-4">
          ${renderPeriodSelector(data.period, data.mine)}
          ${renderMineToggle(data.mine, data.period)}
        </div>
      </div>

      <!-- Summary Cards -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        ${renderStatCard("Sessions", data.summary.sessions_created, "chart-bar")}
        ${renderStatCard("Interactive", data.summary.sessions_interactive, "chat-bubble-left-right")}
        ${renderStatCard("Prompts", data.summary.prompts_sent, "command-line")}
        ${renderStatCard("Files Changed", data.summary.files_changed, "document-text")}
      </div>

      <!-- Code Stats Cards -->
      <div class="grid grid-cols-2 gap-4 mb-8">
        ${renderCodeStatCard("Lines Added", data.summary.lines_added, "plus", "green")}
        ${renderCodeStatCard("Lines Removed", data.summary.lines_removed, "minus", "red")}
      </div>

      <!-- Chart and Tools Grid -->
      <div class="grid md:grid-cols-2 gap-8">
        <!-- Sessions Chart -->
        <div class="bg-white rounded-lg border border-gray-200 p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Sessions Over Time</h2>
          <div id="sessions-chart" class="h-64">
            ${renderSimpleChart(data.timeseries)}
          </div>
        </div>

        <!-- Tool Usage -->
        <div class="bg-white rounded-lg border border-gray-200 p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Tool Usage</h2>
          ${renderToolTable(data.tools)}
        </div>
      </div>

      <!-- Date Range Footer -->
      <p class="text-sm text-gray-500 mt-8 text-center">
        Showing data from ${formatDate(data.dateRange.start)} to ${formatDate(data.dateRange.end)}
      </p>
    </div>

    ${renderChartScript(data.timeseries)}
  `;

  return baseLayout({
    title: "Analytics | openctl",
    content,
  });
}

function renderPeriodSelector(current: string, mine: boolean): string {
  const periods = [
    { value: "today", label: "Today" },
    { value: "week", label: "Week" },
    { value: "month", label: "Month" },
    { value: "all", label: "All Time" },
  ];

  const mineParam = mine ? "&mine=true" : "";

  return `
    <div class="flex rounded-lg border border-gray-200 overflow-hidden">
      ${periods
        .map(
          (p) => `
        <a
          href="/stats?period=${p.value}${mineParam}"
          class="px-3 py-1.5 text-sm ${
            current === p.value
              ? "bg-gray-900 text-white"
              : "bg-white text-gray-700 hover:bg-gray-50"
          }"
        >
          ${p.label}
        </a>
      `
        )
        .join("")}
    </div>
  `;
}

function renderMineToggle(mine: boolean, period: string): string {
  const href = mine ? `/stats?period=${period}` : `/stats?period=${period}&mine=true`;
  const label = mine ? "Showing: My Stats" : "Showing: All Stats";

  return `
    <a
      href="${href}"
      class="px-3 py-1.5 text-sm rounded-lg border ${
        mine
          ? "border-blue-500 bg-blue-50 text-blue-700"
          : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
      }"
    >
      ${label}
    </a>
  `;
}

function renderStatCard(label: string, value: number, icon: string): string {
  return `
    <div class="bg-white rounded-lg border border-gray-200 p-4">
      <div class="flex items-center gap-3">
        <div class="p-2 bg-gray-100 rounded-lg">
          ${getIcon(icon)}
        </div>
        <div>
          <p class="text-2xl font-semibold text-gray-900">${formatNumber(value)}</p>
          <p class="text-sm text-gray-500">${label}</p>
        </div>
      </div>
    </div>
  `;
}

function renderCodeStatCard(
  label: string,
  value: number,
  icon: string,
  color: "green" | "red"
): string {
  const colorClasses =
    color === "green"
      ? "bg-green-50 text-green-700"
      : "bg-red-50 text-red-700";

  return `
    <div class="bg-white rounded-lg border border-gray-200 p-4">
      <div class="flex items-center gap-3">
        <div class="p-2 ${colorClasses} rounded-lg">
          ${getIcon(icon)}
        </div>
        <div>
          <p class="text-2xl font-semibold ${color === "green" ? "text-green-700" : "text-red-700"}">
            ${color === "green" ? "+" : "-"}${formatNumber(value)}
          </p>
          <p class="text-sm text-gray-500">${label}</p>
        </div>
      </div>
    </div>
  `;
}

function renderToolTable(tools: Array<{ tool: string; count: number }>): string {
  if (tools.length === 0) {
    return `<p class="text-gray-500 text-sm">No tool usage data</p>`;
  }

  const maxCount = Math.max(...tools.map((t) => t.count));

  return `
    <div class="space-y-3">
      ${tools
        .slice(0, 10) // Show top 10
        .map(
          (tool) => `
        <div class="flex items-center gap-3">
          <div class="w-20 text-sm font-medium text-gray-700">${tool.tool}</div>
          <div class="flex-1">
            <div class="h-6 bg-gray-100 rounded-full overflow-hidden">
              <div
                class="h-full bg-blue-500 rounded-full"
                style="width: ${(tool.count / maxCount) * 100}%"
              ></div>
            </div>
          </div>
          <div class="w-16 text-sm text-gray-600 text-right">${formatNumber(tool.count)}</div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderSimpleChart(data: Array<{ date: string; value: number }>): string {
  if (data.length === 0) {
    return `<p class="text-gray-500 text-sm">No data for this period</p>`;
  }

  // SVG-based simple bar chart (no JS required for initial render)
  const maxValue = Math.max(...data.map((d) => d.value), 1);
  const barWidth = 100 / data.length;

  return `
    <svg viewBox="0 0 100 50" class="w-full h-full" preserveAspectRatio="none">
      ${data
        .map(
          (d, i) => `
        <rect
          x="${i * barWidth + barWidth * 0.1}"
          y="${50 - (d.value / maxValue) * 45}"
          width="${barWidth * 0.8}"
          height="${(d.value / maxValue) * 45}"
          fill="#3b82f6"
          rx="0.5"
        />
      `
        )
        .join("")}
    </svg>
    <div class="flex justify-between text-xs text-gray-500 mt-2">
      <span>${formatDateShort(data[0].date)}</span>
      <span>${formatDateShort(data[data.length - 1].date)}</span>
    </div>
  `;
}

function renderChartScript(data: Array<{ date: string; value: number }>): string {
  // Optional: Enhanced interactive chart with JavaScript
  return `
    <script>
      // Chart data available for client-side enhancement
      window.chartData = ${JSON.stringify(data)};
    </script>
  `;
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateShort(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function getIcon(name: string): string {
  // Heroicons SVG paths
  const icons: Record<string, string> = {
    "chart-bar": `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
    </svg>`,
    "chat-bubble-left-right": `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12.5a7.5 7.5 0 01-7.5 7.5h-5.25L3 21.75V12.5a7.5 7.5 0 017.5-7.5h2.25a7.5 7.5 0 017.5 7.5v0z"/>
    </svg>`,
    "command-line": `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z"/>
    </svg>`,
    "document-text": `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
    </svg>`,
    "plus": `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.5v15m7.5-7.5h-15"/>
    </svg>`,
    "minus": `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.5 12h-15"/>
    </svg>`,
  };

  return icons[name] || "";
}
```

### 4. Add Navigation Link (Optional)

Add a link to the stats page in the navigation.

**File:** `src/views/layout.ts`

```typescript
// Add to nav items if desired
const navItems = [
  { href: "/", label: "Sessions" },
  { href: "/stats", label: "Stats" },
];
```

### 5. Add Client-Side Interactivity (Optional Enhancement)

Add JavaScript for enhanced chart interactivity and live updates.

**File:** `src/public/stats.js`

```javascript
// Enhanced chart with tooltips
document.addEventListener("DOMContentLoaded", () => {
  const chartContainer = document.getElementById("sessions-chart");
  if (!chartContainer || !window.chartData) return;

  // Add hover tooltips to SVG bars
  const bars = chartContainer.querySelectorAll("rect");
  const data = window.chartData;

  bars.forEach((bar, index) => {
    const point = data[index];
    if (!point) return;

    bar.style.cursor = "pointer";

    bar.addEventListener("mouseenter", (e) => {
      showTooltip(e, `${point.date}: ${point.value} sessions`);
    });

    bar.addEventListener("mouseleave", () => {
      hideTooltip();
    });
  });
});

function showTooltip(event, text) {
  let tooltip = document.getElementById("chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "chart-tooltip";
    tooltip.className =
      "fixed z-50 px-2 py-1 text-xs text-white bg-gray-900 rounded shadow-lg pointer-events-none";
    document.body.appendChild(tooltip);
  }

  tooltip.textContent = text;
  tooltip.style.left = `${event.clientX + 10}px`;
  tooltip.style.top = `${event.clientY - 25}px`;
  tooltip.style.display = "block";
}

function hideTooltip() {
  const tooltip = document.getElementById("chart-tooltip");
  if (tooltip) {
    tooltip.style.display = "none";
  }
}

// Period selector - preserve scroll position
document.querySelectorAll('a[href^="/stats"]').forEach((link) => {
  link.addEventListener("click", () => {
    sessionStorage.setItem("stats-scroll", window.scrollY);
  });
});

const savedScroll = sessionStorage.getItem("stats-scroll");
if (savedScroll) {
  window.scrollTo(0, parseInt(savedScroll, 10));
  sessionStorage.removeItem("stats-scroll");
}
```

## Testing

### Visual Tests

Create a component preview for the stats page.

**File:** `tests/stats-visual.test.ts`

```typescript
import { describe, test, expect } from "bun:test";
import { renderStatsPage } from "../src/views/stats";

describe("Stats Page Rendering", () => {
  const mockData = {
    period: "week",
    mine: false,
    summary: {
      sessions_created: 42,
      sessions_interactive: 5,
      sessions_live: 12,
      prompts_sent: 318,
      lines_added: 4521,
      lines_removed: 1203,
      files_changed: 87,
    },
    tools: [
      { tool: "Edit", count: 245 },
      { tool: "Read", count: 189 },
      { tool: "Bash", count: 89 },
    ],
    timeseries: [
      { date: "2025-01-11", value: 5 },
      { date: "2025-01-12", value: 8 },
      { date: "2025-01-13", value: 3 },
      { date: "2025-01-14", value: 12 },
      { date: "2025-01-15", value: 6 },
      { date: "2025-01-16", value: 7 },
      { date: "2025-01-17", value: 4 },
    ],
    dateRange: { start: "2025-01-11", end: "2025-01-17" },
  };

  test("renders page with all sections", () => {
    const html = renderStatsPage(mockData);

    expect(html).toContain("Analytics");
    expect(html).toContain("Sessions");
    expect(html).toContain("42");
    expect(html).toContain("Edit");
    expect(html).toContain("245");
  });

  test("renders period selector with current selection", () => {
    const html = renderStatsPage({ ...mockData, period: "month" });

    expect(html).toContain('href="/stats?period=today"');
    expect(html).toContain('href="/stats?period=week"');
    expect(html).toContain('bg-gray-900 text-white">Month'); // Active state
  });

  test("renders mine toggle correctly", () => {
    const mineHtml = renderStatsPage({ ...mockData, mine: true });
    expect(mineHtml).toContain("My Stats");
    expect(mineHtml).toContain("border-blue-500"); // Active state

    const allHtml = renderStatsPage({ ...mockData, mine: false });
    expect(allHtml).toContain("All Stats");
  });

  test("renders empty state gracefully", () => {
    const emptyData = {
      ...mockData,
      summary: {
        sessions_created: 0,
        sessions_interactive: 0,
        sessions_live: 0,
        prompts_sent: 0,
        lines_added: 0,
        lines_removed: 0,
        files_changed: 0,
      },
      tools: [],
      timeseries: [],
    };

    const html = renderStatsPage(emptyData);

    expect(html).toContain("No tool usage data");
    expect(html).toContain("No data for this period");
  });

  test("formats large numbers", () => {
    const largeData = {
      ...mockData,
      summary: {
        ...mockData.summary,
        prompts_sent: 1500000,
        lines_added: 45000,
      },
    };

    const html = renderStatsPage(largeData);

    expect(html).toContain("1.5M");
    expect(html).toContain("45.0K");
  });
});
```

### E2E Tests

**File:** `tests/stats-e2e.test.ts`

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

describe("Stats Page E2E", () => {
  let baseUrl: string;
  let server: any;

  beforeAll(async () => {
    // Start test server
    // Seed test data
  });

  afterAll(() => {
    server?.stop();
  });

  test("loads stats page", async () => {
    const res = await fetch(`${baseUrl}/stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("period parameter changes displayed data", async () => {
    const weekRes = await fetch(`${baseUrl}/stats?period=week`);
    const weekHtml = await weekRes.text();

    const monthRes = await fetch(`${baseUrl}/stats?period=month`);
    const monthHtml = await monthRes.text();

    // Both should render, potentially with different data
    expect(weekHtml).toContain("Analytics");
    expect(monthHtml).toContain("Analytics");
  });

  test("mine parameter filters by client", async () => {
    const allRes = await fetch(`${baseUrl}/stats`);
    const allHtml = await allRes.text();
    expect(allHtml).toContain("All Stats");

    const mineRes = await fetch(`${baseUrl}/stats?mine=true`, {
      headers: { "X-Openctl-Client-ID": "test_client" },
    });
    const mineHtml = await mineRes.text();
    expect(mineHtml).toContain("My Stats");
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/routes/pages.ts` | Modify | Add statsPage route handler |
| `src/server.ts` | Modify | Register /stats route |
| `src/views/stats.ts` | Create | Stats page template with charts |
| `src/views/layout.ts` | Modify | (Optional) Add nav link to stats |
| `src/public/stats.js` | Create | (Optional) Client-side chart interactivity |
| `tests/stats-visual.test.ts` | Create | Template rendering tests |
| `tests/stats-e2e.test.ts` | Create | E2E page tests |

## Design Considerations

### Responsive Layout
- Summary cards: 2 columns on mobile, 4 on desktop
- Chart and tools: Stacked on mobile, side-by-side on desktop
- Period selector: Horizontal scrollable on small screens

### Accessibility
- Semantic HTML structure with headings
- Color-blind friendly chart colors
- Keyboard navigable period/mine toggles
- Screen reader friendly stat labels

### Performance
- Server-side rendered for fast initial load
- SVG chart requires no JavaScript
- Optional JS enhancement for tooltips
- Minimal CSS (Tailwind classes)

## Acceptance Criteria

- [ ] `/stats` page loads and displays summary cards
- [ ] Period selector switches between today/week/month/all
- [ ] Mine toggle filters data by client_id
- [ ] Sessions timeseries chart renders correctly
- [ ] Tool usage table shows breakdown sorted by count
- [ ] Empty states display gracefully
- [ ] Large numbers are formatted (K, M)
- [ ] Page is responsive on mobile
- [ ] All tests pass
