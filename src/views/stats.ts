import { layout } from "./layout";

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
    <div class="max-w-[1400px] mx-auto px-6 lg:px-10 py-8">
      <!-- Header with period selector -->
      <div class="flex items-center justify-between gap-6 mb-8">
        <h1 class="text-xl font-semibold text-text-primary tracking-tight">Analytics</h1>
        <div class="flex items-center gap-3">
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
      <div class="grid md:grid-cols-2 gap-6">
        <!-- Sessions Chart -->
        <div class="bg-bg-secondary border border-bg-elevated rounded-md p-5">
          <h2 class="text-sm font-medium text-text-primary mb-4">Sessions Over Time</h2>
          <div id="sessions-chart" class="h-48">
            ${renderSimpleChart(data.timeseries)}
          </div>
        </div>

        <!-- Tool Usage -->
        <div class="bg-bg-secondary border border-bg-elevated rounded-md p-5">
          <h2 class="text-sm font-medium text-text-primary mb-4">Tool Usage</h2>
          ${renderToolTable(data.tools)}
        </div>
      </div>

      <!-- Date Range Footer -->
      <p class="text-xs text-text-muted mt-8 text-center">
        Showing data from ${formatDate(data.dateRange.start)} to ${formatDate(data.dateRange.end)}
      </p>
    </div>

    ${renderChartScript(data.timeseries)}
  `;

  return layout("Analytics", content);
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
    <div class="flex rounded-md border border-bg-elevated overflow-hidden">
      ${periods
        .map(
          (p) => `
        <a
          href="/stats?period=${p.value}${mineParam}"
          class="px-3 py-1.5 text-xs font-medium transition-colors ${
            current === p.value
              ? "bg-accent-primary text-bg-primary"
              : "bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
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
  const label = mine ? "My Stats" : "All Stats";

  return `
    <a
      href="${href}"
      class="px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
        mine
          ? "border-accent-primary/50 bg-accent-primary/10 text-accent-primary"
          : "border-bg-elevated bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
      }"
    >
      ${label}
    </a>
  `;
}

function renderStatCard(label: string, value: number, icon: string): string {
  return `
    <div class="bg-bg-secondary border border-bg-elevated rounded-md p-4">
      <div class="flex items-center gap-3">
        <div class="p-2 bg-bg-tertiary rounded-md text-text-secondary">
          ${getIcon(icon)}
        </div>
        <div>
          <p class="text-2xl font-semibold text-text-primary tabular-nums">${formatNumber(value)}</p>
          <p class="text-xs text-text-muted">${label}</p>
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
  // Use the app's diff colors - soft mint green and soft rose
  const colorClasses =
    color === "green"
      ? "bg-[#86efac]/10 text-[#86efac]"
      : "bg-[#fda4af]/10 text-[#fda4af]";

  const textColor = color === "green" ? "text-[#86efac]" : "text-[#fda4af]";

  return `
    <div class="bg-bg-secondary border border-bg-elevated rounded-md p-4">
      <div class="flex items-center gap-3">
        <div class="p-2 ${colorClasses} rounded-md">
          ${getIcon(icon)}
        </div>
        <div>
          <p class="text-2xl font-semibold ${textColor} tabular-nums">
            ${color === "green" ? "+" : "-"}${formatNumber(value)}
          </p>
          <p class="text-xs text-text-muted">${label}</p>
        </div>
      </div>
    </div>
  `;
}

function renderToolTable(tools: Array<{ tool: string; count: number }>): string {
  if (tools.length === 0) {
    return `<p class="text-text-muted text-xs">No tool usage data</p>`;
  }

  const maxCount = Math.max(...tools.map((t) => t.count));

  return `
    <div class="space-y-2.5">
      ${tools
        .slice(0, 10) // Show top 10
        .map(
          (tool) => `
        <div class="flex items-center gap-3">
          <div class="w-16 text-xs font-mono text-text-secondary">${escapeHtml(tool.tool)}</div>
          <div class="flex-1">
            <div class="h-5 bg-bg-tertiary rounded overflow-hidden">
              <div
                class="h-full bg-accent-primary/60 rounded"
                style="width: ${(tool.count / maxCount) * 100}%"
              ></div>
            </div>
          </div>
          <div class="w-12 text-xs text-text-muted text-right tabular-nums">${formatNumber(tool.count)}</div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderSimpleChart(data: Array<{ date: string; value: number }>): string {
  if (data.length === 0) {
    return `<p class="text-text-muted text-xs">No data for this period</p>`;
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
          fill="#67e8f9"
          fill-opacity="0.7"
          rx="0.5"
        />
      `
        )
        .join("")}
    </svg>
    <div class="flex justify-between text-xs text-text-muted mt-2">
      <span>${formatDateShort(data[0].date)}</span>
      <span>${formatDateShort(data[data.length - 1].date)}</span>
    </div>
  `;
}

function renderChartScript(data: Array<{ date: string; value: number }>): string {
  // Optional: Enhanced interactive chart with JavaScript
  // Escape </script> sequences to prevent XSS
  const safeJson = JSON.stringify(data).replace(/<\/script/gi, "<\\/script");
  return `
    <script>
      // Chart data available for client-side enhancement
      window.chartData = ${safeJson};
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
