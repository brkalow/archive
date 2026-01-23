import type { Session, Message } from "../db/schema";
import { escapeHtml, renderContentBlocks, buildToolResultMap } from "./blocks";
import { formatDuration } from "./liveSession";

export { escapeHtml };

/** Check if a session was recently active (within the threshold) */
function isRecentlyActive(session: Session, thresholdMs: number = 5 * 60 * 1000): boolean {
  if (!session.last_activity_at) return false;
  const lastActivity = new Date(session.last_activity_at).getTime();
  return Date.now() - lastActivity < thresholdMs;
}

// Strip system tags from titles (backup for sessions with tags already in titles)
function stripSystemTagsFromTitle(text: string): string {
  let cleaned = text.replace(/<system_instruction>[\s\S]*?<\/system_instruction>/gi, "");
  cleaned = cleaned.replace(/<system-instruction>[\s\S]*?<\/system-instruction>/gi, "");
  cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  cleaned = cleaned.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "");
  return cleaned.replace(/\s+/g, " ").trim();
}

function renderSessionCard(session: Session): string {
  const date = new Date(session.created_at).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  // Show "LIVE" badge only if session is live AND has recent activity
  const isLive = session.status === "live" && isRecentlyActive(session);
  const isInteractive = session.interactive;

  return `
    <a
      href="/sessions/${escapeHtml(session.id)}"
      class="block bg-bg-secondary border border-bg-elevated rounded-md p-4 hover:bg-bg-tertiary hover:border-bg-hover transition-colors group ${isLive ? "border-l-2 border-l-green-500" : ""}"
      data-session-card
    >
      <div class="flex items-start justify-between gap-3 mb-2">
        <h3 class="text-sm font-medium text-text-primary group-hover:text-accent-primary transition-colors line-clamp-2" data-title>
          ${escapeHtml(stripSystemTagsFromTitle(session.title))}
        </h3>
        <div class="flex items-center gap-1.5 shrink-0">
          ${isLive ? `
            <span class="px-1.5 py-0.5 bg-green-500/20 text-green-400 text-xs font-medium rounded flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span>
              LIVE
            </span>
          ` : ""}
          ${isInteractive ? renderInteractiveBadge() : ""}
          ${session.pr_url ? `<span class="px-1.5 py-0.5 bg-accent-primary/10 text-accent-primary text-xs font-medium rounded">PR</span>` : ""}
        </div>
      </div>
      ${
        session.description
          ? `<p class="text-sm text-text-secondary mb-2 line-clamp-2" data-description>${escapeHtml(session.description)}</p>`
          : ""
      }
      <div class="flex items-center gap-2 text-xs text-text-muted">
        <span>${date}</span>
        ${
          session.project_path
            ? `<span class="truncate font-mono text-[11px]" data-project>${escapeHtml(session.project_path)}</span>`
            : ""
        }
      </div>
    </a>
  `;
}

function truncatePath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return ".../" + parts.slice(-2).join("/");
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

// Icons
const icons = {
  copy: `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>`,
  github: `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>`,
  anthropic: `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017L3.592 20H0l6.569-16.48zm2.327 5.14l-2.36 6.076h4.873l-2.513-6.077z"/></svg>`,
  openai: `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>`,
  terminal: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>`,
  api: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>`,
  google: `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`,
};

function getModelIcon(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("claude") || lower.includes("opus") || lower.includes("sonnet") || lower.includes("haiku")) {
    return icons.anthropic;
  }
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3")) {
    return icons.openai;
  }
  if (lower.includes("gemini") || lower.includes("palm")) {
    return icons.google;
  }
  return "";
}

function getHarnessIcon(harness: string): string {
  const lower = harness.toLowerCase();
  if (lower.includes("code") || lower.includes("cli") || lower.includes("terminal")) {
    return icons.terminal;
  }
  if (lower.includes("api")) {
    return icons.api;
  }
  return "";
}

function extractRepoName(repoUrl: string): string {
  // Extract user/repo from GitHub URL
  const match = repoUrl.match(/github\.com\/([^\/]+\/[^\/]+)/);
  return match?.[1] ?? repoUrl;
}

/**
 * Check if a repo_url is a valid GitHub-like URL (not a local path).
 * Returns true for URLs like "github.com/org/repo" or "https://github.com/org/repo"
 */
function isGitHubUrl(repoUrl: string): boolean {
  return /github\.com\/[^\/]+\/[^\/]+/.test(repoUrl);
}

/**
 * Ensure a GitHub URL has the https:// protocol prefix.
 * Handles both "github.com/org/repo" and "https://github.com/org/repo"
 */
function ensureHttpsProtocol(repoUrl: string): string {
  if (repoUrl.startsWith("https://") || repoUrl.startsWith("http://")) {
    return repoUrl;
  }
  return `https://${repoUrl}`;
}

// Live indicator component
function renderLiveIndicator(): string {
  return `
    <div class="live-indicator flex items-center gap-1.5">
      <span class="live-dot w-2 h-2 rounded-full bg-green-500"></span>
      <span class="text-xs font-bold uppercase tracking-wide text-green-500">LIVE</span>
    </div>
  `;
}

// Connection status component
function renderConnectionStatus(): string {
  return `<span id="connection-status"></span>`;
}

function renderHeader(session: Session, date: string, resumeCommand: string): string {
  const isLive = session.status === "live";
  const timeDisplay = isLive ? formatDuration(session.created_at) : date;

  // Project/repo display - prefer repo URL if it's a valid GitHub URL
  const projectPathHtml = session.repo_url && isGitHubUrl(session.repo_url)
    ? `<a href="${escapeHtml(ensureHttpsProtocol(session.repo_url))}" target="_blank" rel="noopener noreferrer"
         class="inline-flex items-center gap-1.5 font-mono text-[13px] hover:text-text-primary transition-colors">
         ${icons.github}
         <span>${escapeHtml(extractRepoName(session.repo_url))}</span>
       </a>`
    : session.project_path
      ? `<span class="font-mono text-[13px]" title="${escapeHtml(session.project_path)}">
           ${escapeHtml(truncatePath(session.project_path))}
         </span>`
      : "";

  // Model with provider icon
  const modelHtml = session.model ? `
    <span class="inline-flex items-center gap-1.5 font-mono text-[13px]">
      ${getModelIcon(session.model)}
      <span>${escapeHtml(session.model)}</span>
    </span>
  ` : "";

  // Harness with icon
  const harnessHtml = session.harness ? `
    <span class="inline-flex items-center gap-1.5 text-text-secondary">
      ${getHarnessIcon(session.harness)}
      <span>${escapeHtml(session.harness)}</span>
    </span>
  ` : "";

  return `
    <header class="border-b border-bg-elevated">
      <div class="max-w-[1400px] mx-auto px-6 lg:px-10 py-5">
        <!-- Title row -->
        <div class="flex items-center gap-3 mb-2">
          ${isLive ? renderLiveIndicator() : ""}
          <h1 class="text-2xl font-semibold text-text-primary">
            ${escapeHtml(stripSystemTagsFromTitle(session.title))}
          </h1>
        </div>

        <!-- Metadata line -->
        <div class="flex items-center gap-4 text-sm text-text-muted overflow-hidden">
          ${isLive ? `
            ${renderConnectionStatus()}
            <span class="text-text-muted/30">·</span>
          ` : ""}
          ${harnessHtml ? `
            ${harnessHtml}
            <span class="text-text-muted/30">·</span>
          ` : ""}
          ${modelHtml ? `
            ${modelHtml}
            <span class="text-text-muted/30">·</span>
          ` : ""}
          ${projectPathHtml ? `
            ${projectPathHtml}
            <span class="text-text-muted/30">·</span>
          ` : ""}
          <span>${timeDisplay}</span>
          ${session.pr_url ? `
            <span class="text-text-muted/30">·</span>
            <a href="${escapeHtml(session.pr_url)}" target="_blank" rel="noopener noreferrer"
               class="inline-flex items-center gap-1.5 text-text-muted hover:text-text-primary transition-colors">
              <span>PR</span>
            </a>
          ` : ""}
          <span class="text-text-muted/30">·</span>
          <div class="inline-flex items-center gap-1.5 min-w-0">
            <code class="text-[13px] font-mono text-accent-primary truncate" id="resume-command">${escapeHtml(resumeCommand)}</code>
            <button data-copy-target="resume-command" title="Copy command"
                    class="p-1 text-text-muted hover:text-text-primary rounded transition-colors">
              ${icons.copy}
            </button>
          </div>
          <div class="flex-1"></div>
          <button data-share-session="${escapeHtml(session.id)}"
                  class="text-text-muted hover:text-text-primary transition-colors">
            Share
          </button>
          <a href="/api/sessions/${escapeHtml(session.id)}/export"
             class="text-text-muted hover:text-text-primary transition-colors">
            Export
          </a>
        </div>
      </div>
    </header>
  `;
}

// Message role icons
const messageIcons = {
  user: `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>`,
  assistant: `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017L3.592 20H0l6.569-16.48zm2.327 5.14l-2.36 6.076h4.873l-2.513-6.077z"/></svg>`,
  system: `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>`,
};

function renderMessageBlock(message: Message, allMessages: Message[], index: number, prevRenderedRole: string | null): string {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const roleLabel = isUser ? "You" : isSystem ? "System" : "Claude";
  const roleColor = isUser ? "text-role-user" : isSystem ? "text-text-muted" : "text-role-assistant";
  const borderColor = isUser ? "border-role-user" : isSystem ? "border-text-muted" : "border-role-assistant";
  const icon = isUser ? messageIcons.user : isSystem ? messageIcons.system : messageIcons.assistant;

  // Build tool result map from this and next messages
  const toolResults = buildToolResultMapFromMessages(message, allMessages, index);

  // Render content blocks if available, otherwise fall back to legacy content
  const hasBlocks = message.content_blocks && message.content_blocks.length > 0;
  const content = hasBlocks
    ? renderContentBlocks(message.content_blocks, toolResults)
    : formatMessageContent(message.content);

  // Skip rendering if content is empty (e.g., all system tags stripped)
  if (!content.trim()) return "";

  // Add gap and show actor when role changes (based on previous *rendered* message)
  const actorChanged = prevRenderedRole === null || prevRenderedRole !== message.role;
  const gapClass = prevRenderedRole !== null && actorChanged ? "mt-2" : "";

  // Only show actor header when role changes
  const actorHeader = actorChanged ? `
      <div class="flex items-center justify-between mb-0.5">
        <div class="flex items-center gap-1.5">
          <span class="${roleColor}">${icon}</span>
          <span class="text-[13px] font-semibold uppercase tracking-wide ${roleColor}">
            ${roleLabel}
          </span>
        </div>
        <button class="copy-message p-0.5 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                title="Copy message">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
      </div>` : "";

  return `
    <div class="message py-1 pl-4 pr-3 border-l-2 ${borderColor} ${gapClass} group relative" data-message-index="${message.message_index}">${actorHeader}
      <div class="text-sm text-text-primary leading-snug flex flex-col gap-0.5">
        ${content}
      </div>
    </div>
  `;
}

function buildToolResultMapFromMessages(
  message: Message,
  allMessages: Message[],
  currentIndex: number
): Map<string, import("../db/schema").ToolResultBlock> {
  const map = buildToolResultMap(message.content_blocks || []);

  // Scan forward through subsequent messages to find tool results
  // Tool results are in user messages, but they may be spread across multiple messages
  for (let i = currentIndex + 1; i < allMessages.length && i <= currentIndex + 10; i++) {
    const nextMsg = allMessages[i];
    if (!nextMsg?.content_blocks) continue;

    // Only user messages contain tool_result blocks
    if (nextMsg.role !== "user") continue;

    const nextResults = buildToolResultMap(nextMsg.content_blocks);
    for (const [id, result] of nextResults) {
      if (!map.has(id)) {
        map.set(id, result);
      }
    }
    // Don't break early - tool results may be spread across multiple user messages
  }

  return map;
}

function formatMessageContent(content: string): string {
  let formatted = escapeHtml(content);

  // Code blocks - strip line numbers and render
  formatted = formatted.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, _lang, code) => {
      const cleanedCode = stripLineNumbersFromCode(code);
      return `<pre class="my-2 p-3 bg-bg-primary rounded-md overflow-x-auto"><code class="text-[13px]">${cleanedCode}</code></pre>`;
    }
  );

  // Inline code
  formatted = formatted.replace(
    /`([^`]+)`/g,
    '<code class="px-1.5 py-0.5 bg-bg-elevated rounded text-accent-primary text-[13px]">$1</code>'
  );

  // Bold
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Line breaks
  formatted = formatted.replace(/\n/g, "<br>");

  return formatted;
}

// Strip line number prefixes from code blocks (for code that may contain line-numbered output)
function stripLineNumbersFromCode(code: string): string {
  const lines = code.split("\n");
  const firstNonEmpty = lines.find(l => l.trim().length > 0);
  if (!firstNonEmpty) return code;

  // Match line number formats: "  1→", "  1:", "  1|", "  1\t"
  const lineNumberPattern = /^\s*\d+[→:\|\t]/;
  if (!lineNumberPattern.test(firstNonEmpty)) {
    return code;
  }
  return lines.map((line) => line.replace(/^\s*\d+[→:\|\t]\s?/, "")).join("\n");
}

// Not Found View
export function renderNotFound(): string {
  return `
    <div class="flex flex-col items-center justify-center py-16 text-center">
      <h1 class="text-2xl font-semibold mb-2">Not Found</h1>
      <p class="text-text-muted mb-4">The page or session you're looking for doesn't exist.</p>
      <a href="/" class="btn btn-primary">Go Home</a>
    </div>
  `;
}

// Connection status rendering
export function renderConnectionStatusHtml(connected: boolean): string {
  if (connected) {
    return `
      <span class="flex items-center gap-1 text-xs text-text-muted">
        <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span>
        <span>Connected</span>
      </span>
    `;
  }

  return `
    <span class="flex items-center gap-1 text-xs text-yellow-500">
      <span class="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse"></span>
      <span>Reconnecting...</span>
    </span>
  `;
}

// Render interactive badge for session cards
export function renderInteractiveBadge(): string {
  return `<span class="shrink-0 px-1.5 py-0.5 bg-accent-secondary/20 text-accent-secondary text-xs font-medium rounded flex items-center gap-1">
    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/>
    </svg>
    Interactive
  </span>`;
}

// Components Showcase
export function renderComponentsShowcase(): string {
  return `
    <div class="max-w-[1400px] mx-auto px-6 lg:px-10 py-8">
      <div class="mb-10">
        <h1 class="text-2xl font-semibold text-text-primary mb-2">Component Library</h1>
        <p class="text-text-secondary">Design tokens and UI primitives for the Claude Session Archive.</p>
        <p class="text-text-muted text-sm mt-2">
          For comprehensive UI guidelines, see <code class="px-1.5 py-0.5 bg-bg-elevated rounded text-accent-primary text-xs">specs/ui_overview.md</code>
        </p>
      </div>

      <!-- Table of Contents -->
      <nav class="mb-12 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
        <h2 class="text-sm font-semibold text-text-primary mb-3">Contents</h2>
        <div class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <a href="#colors" class="text-accent-primary hover:underline">Colors</a>
          <a href="#typography" class="text-accent-primary hover:underline">Typography</a>
          <a href="#primitives" class="text-accent-primary hover:underline">Primitives</a>
          <a href="#chat-layout" class="text-accent-primary hover:underline">Chat Layout</a>
          <a href="#activity-lines" class="text-accent-primary hover:underline">Activity Lines</a>
          <a href="#activity-feed" class="text-accent-primary hover:underline">Activity Feed</a>
          <a href="#components" class="text-accent-primary hover:underline">Components</a>
          <a href="#icons" class="text-accent-primary hover:underline">Icons</a>
          <a href="#session-header" class="text-accent-primary hover:underline">Session Header</a>
        </div>
      </nav>

      ${renderColorsSection()}
      ${renderTypographySection()}
      ${renderPrimitivesSection()}
      ${renderChatLayoutSection()}
      ${renderActivityLinesSection()}
      ${renderActivityFeedSection()}
      ${renderComponentsSection()}
      ${renderIconsSection()}
    </div>
  `;
}

function renderColorsSection(): string {
  const backgroundColors = [
    { name: "bg-primary", value: "#0c0c0c", class: "bg-bg-primary" },
    { name: "bg-secondary", value: "#141414", class: "bg-bg-secondary" },
    { name: "bg-tertiary", value: "#1a1a1a", class: "bg-bg-tertiary" },
    { name: "bg-elevated", value: "#222222", class: "bg-bg-elevated" },
    { name: "bg-hover", value: "#2a2a2a", class: "bg-bg-hover" },
  ];

  const textColors = [
    { name: "text-primary", value: "#e4e4e7", class: "bg-text-primary" },
    { name: "text-secondary", value: "#a1a1aa", class: "bg-text-secondary" },
    { name: "text-muted", value: "#52525b", class: "bg-text-muted" },
  ];

  const accentColors = [
    { name: "accent-primary", value: "#67e8f9", class: "bg-accent-primary" },
    { name: "accent-secondary", value: "#c4b5fd", class: "bg-accent-secondary" },
  ];

  const semanticColors = [
    { name: "diff-add", value: "#86efac", class: "bg-diff-add" },
    { name: "diff-del", value: "#fda4af", class: "bg-diff-del" },
    { name: "diff-hunk", value: "#93c5fd", class: "bg-diff-hunk" },
    { name: "role-user", value: "#93c5fd", class: "bg-role-user" },
    { name: "role-assistant", value: "#86efac", class: "bg-role-assistant" },
  ];

  const renderSwatch = (color: { name: string; value: string; class: string }) => `
    <div class="flex flex-col">
      <div class="${color.class} w-full h-16 rounded-md border border-bg-elevated"></div>
      <div class="mt-2">
        <div class="text-sm font-medium text-text-primary">${color.name}</div>
        <div class="text-xs font-mono text-text-muted">${color.value}</div>
      </div>
    </div>
  `;

  return `
    <section id="colors" class="mb-16">
      <h2 class="text-xl font-semibold text-text-primary mb-6 pb-2 border-b border-bg-elevated">Colors</h2>

      <div class="space-y-8">
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Background</h3>
          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
            ${backgroundColors.map(renderSwatch).join("")}
          </div>
        </div>

        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Text</h3>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
            ${textColors.map(renderSwatch).join("")}
          </div>
        </div>

        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Accent</h3>
          <div class="grid grid-cols-2 gap-4">
            ${accentColors.map(renderSwatch).join("")}
          </div>
        </div>

        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Semantic</h3>
          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
            ${semanticColors.map(renderSwatch).join("")}
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderTypographySection(): string {
  return `
    <section id="typography" class="mb-16">
      <h2 class="text-xl font-semibold text-text-primary mb-6 pb-2 border-b border-bg-elevated">Typography</h2>

      <div class="space-y-8">
        <!-- Font Families -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Font Families</h3>
          <div class="grid gap-4">
            <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md">
              <div class="text-xs text-text-muted uppercase tracking-wide mb-2">Sans (Default)</div>
              <div class="text-2xl text-text-primary font-sans">The quick brown fox jumps over the lazy dog</div>
              <div class="text-xs font-mono text-text-muted mt-2">system-ui, -apple-system, "Segoe UI", Roboto...</div>
            </div>
            <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md">
              <div class="text-xs text-text-muted uppercase tracking-wide mb-2">Mono (Code)</div>
              <div class="text-2xl text-text-primary font-mono">The quick brown fox jumps over the lazy dog</div>
              <div class="text-xs font-mono text-text-muted mt-2">"Berkeley Mono", "JetBrains Mono", "Fira Code"...</div>
            </div>
          </div>
        </div>

        <!-- Heading Scale -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Heading Scale</h3>
          <div class="space-y-4 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="flex items-baseline gap-4">
              <span class="text-xs text-text-muted w-16 shrink-0">2xl</span>
              <span class="text-2xl font-semibold text-text-primary">Session Archive</span>
            </div>
            <div class="flex items-baseline gap-4">
              <span class="text-xs text-text-muted w-16 shrink-0">xl</span>
              <span class="text-xl font-semibold text-text-primary">Session Archive</span>
            </div>
            <div class="flex items-baseline gap-4">
              <span class="text-xs text-text-muted w-16 shrink-0">lg</span>
              <span class="text-lg font-medium text-text-primary">Session Archive</span>
            </div>
            <div class="flex items-baseline gap-4">
              <span class="text-xs text-text-muted w-16 shrink-0">base</span>
              <span class="text-base text-text-primary">Session Archive</span>
            </div>
            <div class="flex items-baseline gap-4">
              <span class="text-xs text-text-muted w-16 shrink-0">sm</span>
              <span class="text-sm text-text-primary">Session Archive</span>
            </div>
            <div class="flex items-baseline gap-4">
              <span class="text-xs text-text-muted w-16 shrink-0">xs</span>
              <span class="text-xs text-text-primary">Session Archive</span>
            </div>
          </div>
        </div>

        <!-- Font Weights -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Font Weights</h3>
          <div class="space-y-3 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="flex items-baseline gap-4">
              <span class="text-xs text-text-muted w-20 shrink-0">normal</span>
              <span class="text-lg font-normal text-text-primary">The quick brown fox</span>
            </div>
            <div class="flex items-baseline gap-4">
              <span class="text-xs text-text-muted w-20 shrink-0">medium</span>
              <span class="text-lg font-medium text-text-primary">The quick brown fox</span>
            </div>
            <div class="flex items-baseline gap-4">
              <span class="text-xs text-text-muted w-20 shrink-0">semibold</span>
              <span class="text-lg font-semibold text-text-primary">The quick brown fox</span>
            </div>
            <div class="flex items-baseline gap-4">
              <span class="text-xs text-text-muted w-20 shrink-0">bold</span>
              <span class="text-lg font-bold text-text-primary">The quick brown fox</span>
            </div>
          </div>
        </div>

        <!-- Text Colors -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Text Colors</h3>
          <div class="space-y-3 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="text-text-primary">Primary text for main content</div>
            <div class="text-text-secondary">Secondary text for supporting content</div>
            <div class="text-text-muted">Muted text for less important info</div>
            <div class="text-accent-primary">Accent text for links and highlights</div>
            <div class="text-accent-secondary">Secondary accent for special elements</div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderPrimitivesSection(): string {
  return `
    <section id="primitives" class="mb-16">
      <h2 class="text-xl font-semibold text-text-primary mb-6 pb-2 border-b border-bg-elevated">Primitives</h2>

      <div class="space-y-8">
        <!-- Badges -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Badges</h3>
          <div class="flex flex-wrap gap-3 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <span class="px-1.5 py-0.5 bg-green-500/20 text-green-400 text-xs font-medium rounded flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span>
              LIVE
            </span>
            <span class="px-1.5 py-0.5 bg-accent-primary/10 text-accent-primary text-xs font-medium rounded">PR</span>
            ${renderInteractiveBadge()}
            <span class="px-2 py-0.5 rounded text-xs font-medium bg-accent-primary/20 text-accent-primary">suggestion</span>
            <span class="px-2 py-0.5 rounded text-xs font-medium bg-diff-del/20 text-diff-del">issue</span>
            <span class="px-2 py-0.5 rounded text-xs font-medium bg-diff-add/20 text-diff-add">good</span>
            <span class="px-2 py-0.5 rounded text-xs font-medium bg-accent-secondary/20 text-accent-secondary">question</span>
          </div>
        </div>

        <!-- Buttons -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Buttons</h3>
          <div class="flex flex-wrap gap-4 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <button class="px-4 py-2 bg-accent-primary text-bg-primary text-sm font-medium rounded-md hover:bg-accent-primary/90 transition-colors">
              Primary Button
            </button>
            <button class="px-4 py-2 bg-bg-tertiary text-text-primary text-sm font-medium rounded-md border border-bg-elevated hover:bg-bg-elevated transition-colors">
              Secondary Button
            </button>
            <button class="px-4 py-2 text-text-muted hover:text-text-primary text-sm transition-colors">
              Text Button
            </button>
            <button class="p-2 text-text-muted hover:text-text-primary hover:bg-bg-tertiary rounded transition-colors">
              ${icons.copy}
            </button>
          </div>
        </div>

        <!-- Inputs -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Inputs</h3>
          <div class="space-y-4 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div>
              <input
                type="search"
                placeholder="Search sessions..."
                class="w-full max-w-sm bg-bg-secondary border border-bg-elevated rounded-md px-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline focus:outline-2 focus:outline-accent-primary focus:outline-offset-2 transition-all"
              />
            </div>
            <div class="flex items-center w-full max-w-md bg-bg-secondary border border-bg-elevated rounded-md px-4 py-2 transition-all duration-200 focus-within:outline focus-within:outline-2 focus-within:outline-accent-primary focus-within:outline-offset-2">
              <textarea
                class="flex-1 bg-transparent text-text-primary text-[15px] leading-relaxed placeholder:text-text-muted resize-none border-none outline-none focus-visible:outline-none py-1 min-h-[24px]"
                placeholder="Ask a question..."
                rows="1"
              ></textarea>
              <button class="w-7 h-7 flex items-center justify-center rounded bg-text-muted text-bg-primary ml-3">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7"/>
                </svg>
              </button>
            </div>
          </div>
        </div>

        <!-- Segmented Controls -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Segmented Controls</h3>
          <div class="space-y-4 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div>
              <div class="text-xs text-text-muted mb-2">Text only (Activity feed)</div>
              <div class="flex items-center bg-bg-secondary rounded-lg p-0.5 border border-bg-elevated w-fit">
                <button class="px-3 py-1 text-xs font-medium rounded-md transition-colors bg-bg-tertiary text-text-primary">
                  Project
                </button>
                <button class="px-3 py-1 text-xs font-medium rounded-md transition-colors text-text-muted hover:text-text-secondary">
                  Timeline
                </button>
              </div>
            </div>
            <div>
              <div class="text-xs text-text-muted mb-2">With icons (Session view)</div>
              <div class="flex items-center bg-bg-secondary rounded-lg p-0.5 border border-bg-elevated w-fit">
                <button class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors bg-bg-tertiary text-text-primary">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" /></svg>
                  <span>Split</span>
                </button>
                <button class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors text-text-muted hover:text-text-secondary">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                  <span>Conversation</span>
                </button>
                <button class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors text-text-muted hover:text-text-secondary">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7" /></svg>
                  <span>Diff</span>
                </button>
              </div>
            </div>
          </div>
          <div class="mt-2 text-xs text-text-muted font-mono">
            Container: bg-bg-secondary rounded-lg p-0.5 border border-bg-elevated<br/>
            Active: bg-bg-tertiary text-text-primary<br/>
            Inactive: text-text-muted hover:text-text-secondary
          </div>
        </div>

        <!-- Border Radius -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Border Radius</h3>
          <div class="flex flex-wrap gap-6 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="text-center">
              <div class="w-16 h-16 bg-bg-elevated rounded-sm border border-bg-hover"></div>
              <div class="text-xs text-text-muted mt-2">sm (2px)</div>
            </div>
            <div class="text-center">
              <div class="w-16 h-16 bg-bg-elevated rounded-md border border-bg-hover"></div>
              <div class="text-xs text-text-muted mt-2">md (4px)</div>
            </div>
            <div class="text-center">
              <div class="w-16 h-16 bg-bg-elevated rounded-lg border border-bg-hover"></div>
              <div class="text-xs text-text-muted mt-2">lg (6px)</div>
            </div>
            <div class="text-center">
              <div class="w-16 h-16 bg-bg-elevated rounded border border-bg-hover"></div>
              <div class="text-xs text-text-muted mt-2">default (4px)</div>
            </div>
          </div>
        </div>

        <!-- Code -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Code</h3>
          <div class="space-y-4 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div>
              <div class="text-xs text-text-muted mb-2">Inline code</div>
              <p class="text-text-primary">
                Run <code class="px-1.5 py-0.5 bg-bg-elevated rounded text-accent-primary text-[13px]">claude --resume abc123</code> to continue.
              </p>
            </div>
            <div>
              <div class="text-xs text-text-muted mb-2">Code block</div>
              <pre class="p-3 bg-bg-primary rounded-md overflow-x-auto"><code class="text-[13px] font-mono text-text-primary">function greet(name: string) {
  return \`Hello, \${name}!\`;
}</code></pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderChatLayoutSection(): string {
  return `
    <section id="chat-layout" class="mb-16">
      <h2 class="text-xl font-semibold text-text-primary mb-6 pb-2 border-b border-bg-elevated">Chat Layout</h2>
      <p class="text-text-secondary text-sm mb-6">
        Conversation messages are grouped into turns. User messages appear as right-aligned bubbles.
        Agent turns are separated by a header showing activity summary.
        <br/><span class="text-text-muted">Components: <code class="text-xs">UserBubble</code>, <code class="text-xs">AgentTurn</code>, <code class="text-xs">MessageList</code></span>
      </p>

      <div class="space-y-8">
        <!-- User Bubble -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">User Bubble</h3>
          <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="flex justify-end w-full">
              <div class="group relative max-w-[70%] bg-bg-tertiary rounded-2xl rounded-br-sm px-4 py-3">
                <div class="text-sm text-text-primary leading-relaxed">
                  Can you help me fix the build error?
                </div>
              </div>
            </div>
          </div>
          <div class="mt-2 text-xs text-text-muted font-mono">
            Classes: max-w-[70%] bg-bg-tertiary rounded-2xl rounded-br-sm px-4 py-3
          </div>
        </div>

        <!-- Turn Header -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Turn Header</h3>
          <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="flex items-center gap-3 text-text-muted text-xs py-1">
              <div class="flex-1 h-px bg-bg-elevated"></div>
              <span>3 tool calls, 1 message</span>
              <div class="flex-1 h-px bg-bg-elevated"></div>
            </div>
          </div>
          <div class="mt-2 text-xs text-text-muted font-mono">
            Pattern: flex-1 h-px bg-bg-elevated dividers with centered text
          </div>
        </div>

        <!-- Full Conversation Example -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Conversation Flow</h3>
          <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="flex flex-col gap-4">
              <!-- User message -->
              <div class="flex justify-end w-full">
                <div class="max-w-[70%] bg-bg-tertiary rounded-2xl rounded-br-sm px-4 py-3">
                  <div class="text-sm text-text-primary leading-relaxed">
                    Can you help me fix the build error?
                  </div>
                </div>
              </div>

              <!-- Agent turn -->
              <div class="agent-turn">
                <div class="flex items-center gap-3 text-text-muted text-xs py-1">
                  <div class="flex-1 h-px bg-bg-elevated"></div>
                  <span>2 tool calls, 1 message</span>
                  <div class="flex-1 h-px bg-bg-elevated"></div>
                </div>
                <div class="flex flex-col gap-0.5 py-1">
                  <div class="flex items-center gap-1.5 text-text-muted text-[13px] py-0.5">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M4 2h5l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" />
                      <path d="M9 2v4h4" />
                    </svg>
                    <span class="font-medium">Read</span>
                    <span class="font-mono truncate">src/server.ts</span>
                    <span class="text-diff-add">✓</span>
                  </div>
                  <div class="flex items-center gap-1.5 text-text-muted text-[13px] py-0.5">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" />
                      <path d="M10 4l2 2" />
                    </svg>
                    <span class="font-medium">Edit</span>
                    <span class="font-mono truncate">src/server.ts</span>
                    <span class="text-diff-add">✓</span>
                  </div>
                  <div class="text-sm text-text-primary leading-relaxed py-0.5">
                    I found and fixed the type error. The issue was a missing return type annotation.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Typing Indicator -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Typing Indicator</h3>
          <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="agent-turn">
              <div class="flex items-center gap-3 text-text-muted text-xs py-1">
                <div class="flex-1 h-px bg-bg-elevated"></div>
                <span>working</span>
                <div class="flex-1 h-px bg-bg-elevated"></div>
              </div>
              <div class="flex items-center gap-2 py-2 text-text-muted">
                <div class="flex gap-1">
                  <span class="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style="animation-delay: 0ms"></span>
                  <span class="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style="animation-delay: 150ms"></span>
                  <span class="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style="animation-delay: 300ms"></span>
                </div>
                <span class="text-sm">Claude is working...</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderActivityLinesSection(): string {
  // Icon definitions for activity lines
  const activityIcons = {
    document: `<svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 2h5l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" /><path d="M9 2v4h4" /></svg>`,
    pencil: `<svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" /><path d="M10 4l2 2" /></svg>`,
    terminal: `<svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 5l3 3-3 3" /><path d="M9 11h4" /></svg>`,
    search: `<svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4" /><path d="M10 10l3 3" /></svg>`,
    thinking: `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 4.5c-2 0-3.5.8-4.5 2-.8 0-2 .5-2.5 1.5s-.5 2 0 3c-.5.5-1 1.5-1 2.5 0 2 1.5 3.5 3.5 3.5.5.8 1.5 1.5 3 1.5h3c1.5 0 2.5-.7 3-1.5 2 0 3.5-1.5 3.5-3.5 0-1-.5-2-1-2.5.5-1 .5-2 0-3s-1.7-1.5-2.5-1.5c-1-1.2-2.5-2-4.5-2z" /><path d="M12 4.5v14" /></svg>`,
    list: `<svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 4h8M5 8h8M5 12h8" /><circle cx="2" cy="4" r="1" fill="currentColor" stroke="none" /><circle cx="2" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="2" cy="12" r="1" fill="currentColor" stroke="none" /></svg>`,
    question: `<svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6" /><path d="M6 6a2 2 0 012-2 2 2 0 012 2c0 1-1 1.5-1.5 2-.25.25-.5.5-.5 1" /><circle cx="8" cy="11.5" r="0.75" fill="currentColor" stroke="none" /></svg>`,
    robot: `<svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="10" height="8" rx="1" /><circle cx="6" cy="9" r="1" fill="currentColor" stroke="none" /><circle cx="10" cy="9" r="1" fill="currentColor" stroke="none" /><path d="M8 2v3M6 2h4" /><path d="M1 8h2M13 8h2" /></svg>`,
    globe: `<svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6" /><path d="M2 8h12" /><path d="M8 2c2 2 2 10 0 12" /><path d="M8 2c-2 2-2 10 0 12" /></svg>`,
    gear: `<svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3" /></svg>`,
  };

  return `
    <section id="activity-lines" class="mb-16">
      <h2 class="text-xl font-semibold text-text-primary mb-6 pb-2 border-b border-bg-elevated">Activity Lines</h2>
      <p class="text-text-secondary text-sm mb-6">
        Compact displays for agent activities. Each line shows an icon, tool name, summary, and status indicator.
        Lines are expandable to show full content.
        <br/><span class="text-text-muted">Components: <code class="text-xs">ToolLine</code>, <code class="text-xs">ThinkingLine</code>, <code class="text-xs">TaskLine</code>, <code class="text-xs">QuestionLine</code>, <code class="text-xs">TodoWriteLine</code></span>
      </p>

      <div class="space-y-8">
        <!-- Tool Lines -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Tool Lines</h3>
          <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md space-y-1">
            <div class="flex items-center gap-1.5 text-text-muted text-[13px] py-0.5">
              ${activityIcons.document}
              <span class="font-medium">Read</span>
              <span class="font-mono truncate">src/client/App.tsx</span>
              <span class="text-diff-add">✓</span>
            </div>
            <div class="flex items-center gap-1.5 text-text-muted text-[13px] py-0.5">
              ${activityIcons.pencil}
              <span class="font-medium">Edit</span>
              <span class="font-mono truncate">src/server.ts</span>
              <span class="text-diff-add">✓</span>
            </div>
            <div class="flex items-center gap-1.5 text-text-muted text-[13px] py-0.5">
              ${activityIcons.terminal}
              <span class="font-medium">Bash</span>
              <span class="font-mono truncate">bun test</span>
              <span class="text-diff-del">✗</span>
            </div>
            <div class="flex items-center gap-1.5 text-text-muted text-[13px] py-0.5">
              ${activityIcons.search}
              <span class="font-medium">Grep</span>
              <span class="font-mono truncate">"handleSubmit"</span>
              <span class="text-diff-add">✓</span>
            </div>
            <div class="flex items-center gap-1.5 text-text-muted text-[13px] py-0.5">
              ${activityIcons.globe}
              <span class="font-medium">WebFetch</span>
              <span class="font-mono truncate">docs.example.com/api</span>
              <span class="text-text-muted">...</span>
            </div>
          </div>
          <div class="mt-2 text-xs text-text-muted">
            Status indicators: <span class="text-diff-add">✓</span> success, <span class="text-diff-del">✗</span> error, <span class="text-text-muted">...</span> pending
          </div>
        </div>

        <!-- Thinking Line -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Thinking Line</h3>
          <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="flex items-center gap-1.5 text-text-muted text-[13px] py-0.5">
              ${activityIcons.thinking}
              <span class="font-medium">Thinking</span>
              <span class="truncate max-w-[400px] opacity-70">Let me analyze this error message...</span>
            </div>
          </div>
        </div>

        <!-- Task Line (subagent) -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Task Line (Subagent)</h3>
          <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md space-y-1">
            <div class="flex items-center gap-1.5 text-text-muted text-[13px] py-0.5">
              ${activityIcons.robot}
              <span class="font-medium">Explorer</span>
              <span class="truncate max-w-[300px]">Find authentication handlers</span>
              <span class="text-diff-add">✓</span>
            </div>
            <div class="flex items-center gap-1.5 text-text-muted text-[13px] py-0.5">
              ${activityIcons.robot}
              <span class="font-medium">Bash</span>
              <span class="truncate max-w-[300px]">Run test suite</span>
              <span class="text-text-muted">...</span>
            </div>
          </div>
        </div>

        <!-- Todo Line -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Todo Line</h3>
          <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="py-1">
              <div class="flex items-center gap-1.5 text-text-muted text-[13px]">
                ${activityIcons.list}
                <span class="font-medium">Tasks</span>
              </div>
              <div class="ml-5 mt-1 space-y-0.5">
                <div class="flex items-center gap-1.5 text-[13px]">
                  <span class="text-diff-add">✓</span>
                  <span class="text-text-muted line-through">Read the error logs</span>
                </div>
                <div class="flex items-center gap-1.5 text-[13px]">
                  <span class="text-accent-primary">●</span>
                  <span class="text-text-primary">Fix type mismatch</span>
                </div>
                <div class="flex items-center gap-1.5 text-[13px]">
                  <span class="text-text-muted">○</span>
                  <span class="text-text-primary">Run tests</span>
                </div>
              </div>
            </div>
          </div>
          <div class="mt-2 text-xs text-text-muted">
            Status icons: <span class="text-diff-add">✓</span> completed, <span class="text-accent-primary">●</span> in_progress, <span class="text-text-muted">○</span> pending
          </div>
        </div>

        <!-- Question Line -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Question Line</h3>
          <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="py-1">
              <div class="flex items-center gap-1.5 text-text-muted text-[13px]">
                ${activityIcons.question}
                <span class="font-medium">Question</span>
              </div>
              <div class="ml-5 mt-1 space-y-1">
                <div>
                  <div class="text-[13px] text-text-primary">Which testing framework do you prefer?</div>
                  <div class="flex items-center gap-1 mt-0.5">
                    <span class="text-accent-primary text-xs">&rarr;</span>
                    <span class="text-[13px] font-medium text-text-primary">Jest</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Tool Icons Reference -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Activity Icons</h3>
          <div class="flex flex-wrap gap-6 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-muted">${activityIcons.document}</div>
              <span class="text-xs text-text-muted">Read</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-muted">${activityIcons.pencil}</div>
              <span class="text-xs text-text-muted">Edit/Write</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-muted">${activityIcons.terminal}</div>
              <span class="text-xs text-text-muted">Bash</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-muted">${activityIcons.search}</div>
              <span class="text-xs text-text-muted">Glob/Grep</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-muted">${activityIcons.globe}</div>
              <span class="text-xs text-text-muted">WebFetch</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-muted">${activityIcons.thinking}</div>
              <span class="text-xs text-text-muted">Thinking</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-muted">${activityIcons.robot}</div>
              <span class="text-xs text-text-muted">Task</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-muted">${activityIcons.list}</div>
              <span class="text-xs text-text-muted">TodoWrite</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-muted">${activityIcons.question}</div>
              <span class="text-xs text-text-muted">Question</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-muted">${activityIcons.gear}</div>
              <span class="text-xs text-text-muted">Other</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderActivityFeedSection(): string {
  return `
    <section id="activity-feed" class="mb-16">
      <h2 class="text-xl font-semibold text-text-primary mb-6 pb-2 border-b border-bg-elevated">Activity Feed</h2>
      <p class="text-text-secondary text-sm mb-6">
        Components for the activity feed homepage. Sessions are grouped by project/repository with collapsible sections.
        <br/><span class="text-text-muted">Components: <code class="text-xs">HomePage</code>, <code class="text-xs">ProjectGroup</code>, <code class="text-xs">SessionRow</code>, <code class="text-xs">ViewModeToggle</code>, <code class="text-xs">NewSessionPrompt</code></span>
      </p>

      <div class="space-y-8">
        <!-- View Mode Toggle -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">View Mode Toggle</h3>
          <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="flex items-center bg-bg-secondary rounded-lg p-0.5 border border-bg-elevated w-fit">
              <button class="px-3 py-1 text-xs font-medium rounded-md transition-colors bg-bg-tertiary text-text-primary">
                Project
              </button>
              <button class="px-3 py-1 text-xs font-medium rounded-md transition-colors text-text-muted hover:text-text-secondary">
                Timeline
              </button>
            </div>
          </div>
          <div class="mt-2 text-xs text-text-muted font-mono">
            Pattern: Segmented control with bg-bg-tertiary for active state
          </div>
        </div>

        <!-- Session Row -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Session Row</h3>
          <div class="bg-bg-secondary border border-bg-elevated rounded-md overflow-hidden">
            <div class="border-l border-bg-elevated ml-2.5">
              <!-- Live session -->
              <div class="flex items-center gap-3 py-2.5 px-4 hover:bg-bg-tertiary transition-colors border-b border-bg-elevated/50">
                <span class="w-2 h-2 rounded-full shrink-0 bg-status-live animate-pulse"></span>
                <span class="flex-1 min-w-0 text-sm text-text-primary truncate">Implement user authentication flow</span>
                <span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-diff-add/15 text-diff-add">
                  <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
                  </svg>
                  #42
                </span>
                <span class="text-xs text-text-muted shrink-0">5m ago</span>
              </div>
              <!-- Completed session with interactive badge -->
              <div class="flex items-center gap-3 py-2.5 px-4 hover:bg-bg-tertiary transition-colors border-b border-bg-elevated/50">
                <span class="w-2 h-2 rounded-full shrink-0 bg-diff-add"></span>
                <span class="flex-1 min-w-0 text-sm text-text-primary truncate">Refactor database schema</span>
                <span class="shrink-0 px-1.5 py-0.5 bg-accent-secondary/20 text-accent-secondary text-[10px] font-medium rounded">Interactive</span>
                <span class="text-xs text-text-muted shrink-0">2h ago</span>
              </div>
              <!-- Archived session -->
              <div class="flex items-center gap-3 py-2.5 px-4 hover:bg-bg-tertiary transition-colors">
                <span class="w-2 h-2 rounded-full shrink-0 bg-text-muted"></span>
                <span class="flex-1 min-w-0 text-sm text-text-primary truncate">Debug performance issues</span>
                <span class="text-xs text-text-muted shrink-0">3d ago</span>
              </div>
            </div>
          </div>
          <div class="mt-2 text-xs text-text-muted">
            Status dots: <span class="inline-block w-2 h-2 rounded-full bg-status-live animate-pulse align-middle"></span> live,
            <span class="inline-block w-2 h-2 rounded-full bg-diff-add align-middle ml-2"></span> complete,
            <span class="inline-block w-2 h-2 rounded-full bg-text-muted align-middle ml-2"></span> archived
          </div>
        </div>

        <!-- Project Group Header -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Project Group Header</h3>
          <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md space-y-3">
            <!-- Repository group (expanded) -->
            <button class="w-full flex items-center gap-2 py-2 text-left group">
              <svg class="w-3 h-3 text-text-muted rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
              <span class="flex items-center gap-1.5 text-xs text-text-secondary group-hover:text-text-primary transition-colors">
                <svg class="w-3.5 h-3.5 text-text-muted" fill="currentColor" viewBox="0 0 16 16">
                  <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
                </svg>
                <span class="font-medium">anthropic/claude-code</span>
              </span>
              <span class="text-xs text-text-muted">5 sessions</span>
              <span class="flex items-center gap-1 text-xs text-status-live">
                <span class="w-1.5 h-1.5 rounded-full bg-status-live animate-pulse"></span>
                1 live
              </span>
            </button>
            <!-- Path-based group (collapsed) -->
            <button class="w-full flex items-center gap-2 py-2 text-left group">
              <svg class="w-3 h-3 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
              <span class="font-mono text-xs text-text-secondary group-hover:text-text-primary transition-colors">~/projects/api</span>
              <span class="text-xs text-text-muted">3 sessions</span>
            </button>
          </div>
        </div>

        <!-- Keyboard Hints -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Keyboard Hints</h3>
          <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="flex items-center justify-center gap-6 text-xs text-text-muted">
              <span class="flex items-center gap-1.5">
                <kbd class="px-1.5 py-0.5 bg-bg-tertiary border border-bg-elevated rounded text-[10px]">N</kbd>
                <span>New session</span>
              </span>
              <span class="flex items-center gap-1.5">
                <kbd class="px-1.5 py-0.5 bg-bg-tertiary border border-bg-elevated rounded text-[10px]">Enter</kbd>
                <span>Submit</span>
              </span>
              <span class="flex items-center gap-1.5">
                <kbd class="px-1.5 py-0.5 bg-bg-tertiary border border-bg-elevated rounded text-[10px]">Esc</kbd>
                <span>Cancel</span>
              </span>
            </div>
          </div>
          <div class="mt-2 text-xs text-text-muted font-mono">
            &lt;kbd&gt; styling: px-1.5 py-0.5 bg-bg-tertiary border border-bg-elevated rounded text-[10px]
          </div>
        </div>

        <!-- New Session Prompt -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">New Session Prompt</h3>
          <div class="space-y-4">
            <!-- Unfocused state -->
            <div class="rounded-lg border bg-bg-secondary/50 border-bg-elevated hover:border-bg-hover hover:bg-bg-secondary transition-all">
              <div class="flex items-center gap-3 px-4 py-3">
                <div class="w-6 h-6 rounded-md flex items-center justify-center bg-bg-tertiary text-text-muted shrink-0">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                  </svg>
                </div>
                <span class="flex-1 text-sm text-text-muted">Start a new session...</span>
                <kbd class="px-1.5 py-0.5 text-[10px] text-text-muted bg-bg-tertiary border border-bg-elevated rounded">N</kbd>
              </div>
            </div>
            <!-- Focused state -->
            <div class="rounded-lg border bg-bg-secondary border-accent-primary/50 shadow-lg shadow-accent-primary/5 transition-all">
              <div class="flex items-center gap-3 px-4 py-3">
                <div class="w-6 h-6 rounded-md flex items-center justify-center bg-accent-primary/20 text-accent-primary shrink-0">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                  </svg>
                </div>
                <span class="flex-1 text-sm text-text-primary">Implement user authentication...</span>
                <button class="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-bg-elevated bg-bg-tertiary text-text-primary">
                  <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span>my-project</span>
                </button>
                <button class="px-3 py-1 bg-accent-primary text-bg-primary text-xs font-medium rounded-md hover:bg-accent-primary/90">
                  Start
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Empty State -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Empty State</h3>
          <div class="p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="py-12 text-center">
              <div class="w-12 h-12 mx-auto mb-4 rounded-md bg-bg-tertiary flex items-center justify-center">
                <svg class="w-6 h-6 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <h2 class="text-base font-medium text-text-secondary mb-2">No sessions yet</h2>
              <p class="text-sm text-text-muted max-w-xs mx-auto">
                Start a new session above to begin tracking your conversations.
              </p>
            </div>
          </div>
        </div>

        <!-- PR Indicator Badge -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">PR Indicator Badge</h3>
          <div class="flex flex-wrap gap-4 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <span class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-diff-add/15 text-diff-add">
              <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
                <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
              </svg>
              #42
            </span>
            <span class="shrink-0 px-1.5 py-0.5 bg-diff-hunk/20 text-diff-hunk text-[10px] font-medium rounded">Remote</span>
            <span class="shrink-0 px-1.5 py-0.5 bg-accent-secondary/20 text-accent-secondary text-[10px] font-medium rounded">Interactive</span>
          </div>
        </div>
      </div>
    </section>
  `;
}

// Mock data for component library - reuses actual render functions
function getMockSessions(): Session[] {
  const now = new Date().toISOString();
  return [
    {
      id: "mock-1",
      title: "Implement user authentication flow",
      description: "Added OAuth2 integration with Google and GitHub providers",
      claude_session_id: "abc123",
      agent_session_id: "abc123",
      pr_url: "https://github.com/example/repo/pull/42",
      share_token: null,
      project_path: "~/projects/auth",
      model: "claude-sonnet-4-20250514",
      harness: "Claude Code",
      repo_url: "github.com/example/repo",
      branch: null,
      status: "archived",
      last_activity_at: null,
      client_id: null,
      user_id: null,
      interactive: false,
      remote: false,
      created_at: now,
      updated_at: now,
    },
    {
      id: "mock-2",
      title: "Debug performance issues",
      description: null,
      claude_session_id: "def456",
      agent_session_id: "def456",
      pr_url: null,
      share_token: null,
      project_path: null,
      model: "claude-sonnet-4-20250514",
      harness: "Claude Code",
      repo_url: null,
      branch: null,
      status: "live",
      last_activity_at: now, // Recent activity for LIVE badge
      client_id: null,
      user_id: null,
      interactive: false,
      remote: false,
      created_at: now,
      updated_at: now,
    },
    {
      id: "mock-3",
      title: "Refactor database schema",
      description: "Migrating from SQLite to PostgreSQL",
      claude_session_id: "ghi789",
      agent_session_id: "ghi789",
      pr_url: null,
      share_token: null,
      project_path: "~/projects/api",
      model: "claude-sonnet-4-20250514",
      harness: "Claude Code",
      repo_url: "github.com/example/api",
      branch: null,
      status: "live",
      last_activity_at: now,
      client_id: null,
      user_id: null,
      interactive: true,
      remote: false,
      created_at: now,
      updated_at: now,
    },
  ];
}

function getMockHeaderSession(): Session {
  const now = new Date().toISOString();
  return {
    id: "mock-header",
    title: "Implement user authentication with OAuth2",
    description: "Adding secure authentication flow",
    claude_session_id: "abc123",
    agent_session_id: "abc123",
    pr_url: "https://github.com/anthropics/claude-code/pull/42",
    share_token: null,
    project_path: "~/projects/auth",
    model: "claude-sonnet-4-20250514",
    harness: "Claude Code",
    repo_url: "github.com/anthropics/claude-code",
    branch: null,
    status: "live",
    last_activity_at: now,
    client_id: null,
    user_id: null,
    interactive: true,
    remote: false,
    created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
    updated_at: now,
  };
}

function renderComponentsSection(): string {
  const mockSessions = getMockSessions();

  return `
    <section id="components" class="mb-16">
      <h2 class="text-xl font-semibold text-text-primary mb-6 pb-2 border-b border-bg-elevated">Components</h2>

      <div class="space-y-8">
        <!-- Session Card -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Session Card</h3>
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            ${mockSessions.map(renderSessionCard).join("")}
          </div>
        </div>

        <!-- Status Indicators -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Status Indicators</h3>
          <div class="flex flex-wrap gap-6 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <!-- Live indicator -->
            ${renderLiveIndicator()}
            <!-- Connected -->
            ${renderConnectionStatusHtml(true)}
            <!-- Reconnecting -->
            ${renderConnectionStatusHtml(false)}
          </div>
        </div>

        <!-- Diff Stats -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Diff Stats</h3>
          <div class="flex flex-wrap gap-4 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="flex items-center gap-2 text-xs font-mono tabular-nums">
              <span class="text-diff-del">-42</span>
              <span class="text-diff-add">+128</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="w-3 h-3 rounded bg-diff-add-bg border border-diff-add/30"></span>
              <span class="text-xs text-text-muted">Addition background</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="w-3 h-3 rounded bg-diff-del-bg border border-diff-del/30"></span>
              <span class="text-xs text-text-muted">Deletion background</span>
            </div>
          </div>
        </div>

        <!-- Toast -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Toast Notifications</h3>
          <div class="flex flex-wrap gap-4 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="px-4 py-2 bg-bg-tertiary border border-bg-elevated text-text-primary text-sm rounded shadow-lg">
              Copied to clipboard
            </div>
            <div class="px-4 py-2 bg-diff-add/20 border border-diff-add/30 text-diff-add text-sm rounded shadow-lg">
              Message sent to session
            </div>
            <div class="px-4 py-2 bg-diff-del/20 border border-diff-del/30 text-diff-del text-sm rounded shadow-lg">
              Message was declined
            </div>
          </div>
        </div>

        <!-- Session Detail Header -->
        <div id="session-header">
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Session Detail Header</h3>
          <div class="border border-bg-elevated rounded-md overflow-hidden">
            ${renderHeader(
              getMockHeaderSession(),
              formatDate(getMockHeaderSession().created_at),
              "claude --resume abc123"
            )}
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderIconsSection(): string {
  return `
    <section id="icons" class="mb-16">
      <h2 class="text-xl font-semibold text-text-primary mb-6 pb-2 border-b border-bg-elevated">Icons</h2>

      <div class="space-y-8">
        <!-- Provider Icons -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Provider Icons</h3>
          <div class="flex flex-wrap gap-6 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-primary">
                ${icons.anthropic}
              </div>
              <span class="text-xs text-text-muted">Anthropic</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-primary">
                ${icons.openai}
              </div>
              <span class="text-xs text-text-muted">OpenAI</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-primary">
                ${icons.google}
              </div>
              <span class="text-xs text-text-muted">Google</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-primary">
                ${icons.github}
              </div>
              <span class="text-xs text-text-muted">GitHub</span>
            </div>
          </div>
        </div>

        <!-- UI Icons -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">UI Icons</h3>
          <div class="flex flex-wrap gap-6 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-primary">
                ${icons.copy}
              </div>
              <span class="text-xs text-text-muted">Copy</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-primary">
                ${icons.terminal}
              </div>
              <span class="text-xs text-text-muted">Terminal</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-primary">
                ${icons.api}
              </div>
              <span class="text-xs text-text-muted">API</span>
            </div>
          </div>
        </div>

        <!-- Message Role Icons -->
        <div>
          <h3 class="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4">Message Role Icons</h3>
          <div class="flex flex-wrap gap-6 p-4 bg-bg-secondary border border-bg-elevated rounded-md">
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-role-user">
                ${messageIcons.user}
              </div>
              <span class="text-xs text-text-muted">User</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-role-assistant">
                ${messageIcons.assistant}
              </div>
              <span class="text-xs text-text-muted">Assistant</span>
            </div>
            <div class="flex flex-col items-center gap-2">
              <div class="w-10 h-10 flex items-center justify-center bg-bg-tertiary rounded-md text-text-muted">
                ${messageIcons.system}
              </div>
              <span class="text-xs text-text-muted">System</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

// Getting Started Page
export function renderGettingStarted(): string {
  return `
    <div class="min-h-[calc(100vh-3.5rem)] flex flex-col items-center justify-start pt-16 pb-24 px-6">
      <!-- Hero: Two column layout -->
      <div class="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-8 items-center mb-20">
        <!-- Left: Animated brackets -->
        <div class="flex items-center justify-center font-mono text-[clamp(6rem,15vw,12rem)] font-light text-white/20">
          <div class="flex items-center justify-center animate-brackets">
            <span class="inline-block">[</span>
            <span class="inline-block w-[0.08em] animate-gap-pulse"></span>
            <span class="inline-block">]</span>
          </div>
        </div>

        <!-- Right: Logo + description -->
        <div class="flex flex-col items-center md:items-start">
          <h1 class="text-3xl font-mono font-medium text-text-primary hover:text-accent-primary transition-colors mb-4">
            <span class="text-[18px] inline-flex gap-[3px] -translate-y-[2.5px]"><span>[</span><span>]</span></span>penctl
          </h1>
          <p class="text-text-secondary text-center md:text-left font-mono text-sm leading-relaxed">
            Share, collaborate, and review your agent sessions.
          </p>
        </div>
      </div>

      <!-- Install command -->
      <div class="flex items-center gap-3 px-6 py-4 border border-bg-elevated rounded bg-bg-secondary/50 backdrop-blur mb-20 max-w-xl w-full">
        <span class="text-text-muted font-mono">$</span>
        <code id="install-command" class="flex-1 font-mono text-text-primary text-sm">curl -fsSL https://openctl.dev/setup/install.sh | bash</code>
        <button
          data-copy-target="install-command"
          class="text-text-muted hover:text-text-primary transition-colors"
          title="Copy to clipboard"
        >
          ${icons.copy}
        </button>
      </div>

      <!-- Commands section -->
      <div class="w-full max-w-xl">
        <div class="text-xs uppercase tracking-[0.2em] text-text-muted text-center mb-6 font-mono">Commands</div>
        <div class="border border-bg-elevated rounded bg-bg-secondary/30 backdrop-blur divide-y divide-bg-elevated font-mono text-sm">
          <div class="flex items-center justify-between px-5 py-3">
            <span><span class="text-text-primary">openctl</span> <span class="text-accent-primary">upload</span></span>
            <span class="text-text-muted">upload a session</span>
          </div>
          <div class="flex items-center justify-between px-5 py-3">
            <span><span class="text-text-primary">openctl</span> <span class="text-accent-primary">daemon start</span></span>
            <span class="text-text-muted">live stream sessions</span>
          </div>
          <div class="flex items-center justify-between px-5 py-3">
            <span><span class="text-text-primary">openctl</span> <span class="text-accent-primary">list</span></span>
            <span class="text-text-muted">view all sessions</span>
          </div>
        </div>
      </div>

      <!-- Browse link -->
      <a href="/sessions" class="mt-16 text-accent-primary hover:text-accent-primary/80 transition-colors font-mono text-sm flex items-center gap-2">
        <span>browse sessions</span>
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3" />
        </svg>
      </a>
    </div>
  `;
}
