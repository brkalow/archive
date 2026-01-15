import type { Session, Message, Diff, Review } from "../db/schema";
import { escapeHtml, renderContentBlocks, buildToolResultMap } from "./blocks";
import { formatDuration } from "./liveSession";

export { escapeHtml };

// Strip system tags from titles (backup for sessions with tags already in titles)
function stripSystemTagsFromTitle(text: string): string {
  let cleaned = text.replace(/<system_instruction>[\s\S]*?<\/system_instruction>/gi, "");
  cleaned = cleaned.replace(/<system-instruction>[\s\S]*?<\/system-instruction>/gi, "");
  cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  cleaned = cleaned.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "");
  return cleaned.replace(/\s+/g, " ").trim();
}

// Session List View
export function renderSessionList(sessions: Session[]): string {
  const content = sessions.length === 0 ? renderEmptyState() : renderSessionGrid(sessions);

  return `
    <div class="max-w-[1800px] mx-auto px-6 lg:px-10 py-8">
      <div class="flex items-center justify-between gap-6 mb-8">
        <h1 class="text-xl font-semibold text-text-primary tracking-tight">Sessions</h1>
        <div class="w-full max-w-sm">
          <input
            type="search"
            id="search-input"
            placeholder="Search sessions..."
            class="w-full bg-bg-secondary border border-bg-elevated rounded-lg px-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-primary focus:ring-1 focus:ring-accent-primary/20 transition-all"
          />
        </div>
      </div>
      ${content}
    </div>
  `;
}

function renderEmptyState(): string {
  return `
    <div class="flex flex-col items-center justify-center py-16 text-center">
      <div class="w-16 h-16 mb-4 rounded-full bg-bg-secondary flex items-center justify-center">
        <svg class="w-8 h-8 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      </div>
      <h2 class="text-lg font-medium text-text-secondary mb-2">No sessions yet</h2>
      <p class="text-sm text-text-muted max-w-sm">
        Sessions can be uploaded via the API at <code class="bg-bg-tertiary px-1.5 py-0.5 rounded text-accent-primary">POST /api/sessions</code>
      </p>
    </div>
  `;
}

function renderSessionGrid(sessions: Session[]): string {
  return `
    <div class="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      ${sessions.map(renderSessionCard).join("")}
    </div>
  `;
}

function renderSessionCard(session: Session): string {
  const date = new Date(session.created_at).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const isLive = session.status === "live";
  const isInteractive = session.interactive;

  return `
    <a
      href="/sessions/${escapeHtml(session.id)}"
      class="block bg-bg-secondary border border-bg-elevated rounded-lg p-4 hover:bg-bg-tertiary hover:border-bg-hover transition-colors group ${isLive ? "border-l-2 border-l-green-500" : ""}"
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

// Session Detail View
interface ReviewWithCount extends Review {
  annotation_count: number;
}

interface SessionDetailData {
  session: Session;
  messages: Message[];
  diffs: Diff[];
  shareUrl: string | null;
  review?: ReviewWithCount | null;
}

export function renderSessionDetail({ session, messages, diffs, shareUrl, review }: SessionDetailData): string {
  const hasDiffs = diffs.length > 0;
  const isLive = session.status === "live";
  const isInteractive = session.interactive ?? false;
  const date = formatDate(session.created_at);

  const resumeCommand = session.claude_session_id
    ? `claude --resume ${session.claude_session_id}`
    : session.project_path
      ? `cd ${session.project_path} && claude --continue`
      : "claude --continue";

  // Determine layout classes
  // - For sessions with diffs: two-column layout, diff panel visible
  // - For live sessions without diffs: single-column layout, diff panel hidden (will animate in when diffs arrive)
  // - For non-live sessions without diffs: single-column centered, no diff panel
  const gridClass = hasDiffs ? "session-content-grid two-column" : (isLive ? "session-content-grid single-column" : "");
  const conversationClass = !hasDiffs && !isLive ? "" : "conversation-panel-container";
  const diffPanelClass = hasDiffs ? "diff-panel-container visible" : "diff-panel-container hidden";

  return `
    <div class="session-detail" data-session-is-live="${isLive}" data-session-has-diffs="${hasDiffs}" data-session-is-interactive="${isInteractive}">
      <!-- Header -->
      ${renderHeader(session, date, resumeCommand)}

      <!-- Content -->
      <div class="max-w-[1800px] mx-auto px-6 lg:px-10 py-6">
        <div class="${gridClass || ""}" data-content-grid>
          <!-- Conversation: main content, scrolls with page -->
          <div class="${conversationClass}" data-conversation-panel>
            ${renderConversationPanel(messages, isInteractive && isLive)}
          </div>

          ${isLive || hasDiffs ? `
            <!-- Diffs: sticky sidebar on right -->
            <div class="${diffPanelClass}" data-diff-panel>
              ${hasDiffs ? renderDiffPanel(diffs, review) : renderEmptyDiffPlaceholder()}
            </div>
          ` : ""}
        </div>
      </div>
    </div>
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

// Typing indicator component
function renderTypingIndicator(): string {
  return `
    <div id="typing-indicator" class="hidden flex items-center gap-2 py-3 px-4 text-text-muted border-l-2 border-role-assistant">
      <div class="flex gap-1">
        <span class="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style="animation-delay: 0ms"></span>
        <span class="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style="animation-delay: 150ms"></span>
        <span class="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style="animation-delay: 300ms"></span>
      </div>
      <span class="text-sm">Claude is working...</span>
    </div>
  `;
}

// New messages button component
function renderNewMessagesButton(): string {
  return `
    <button
      id="new-messages-btn"
      class="hidden fixed bottom-8 left-1/2 -translate-x-1/2
             px-4 py-2 bg-accent-primary text-bg-primary text-sm font-medium rounded-full
             shadow-lg hover:bg-accent-primary/90 transition-all z-50"
    >
      New messages
    </button>
  `;
}

function renderHeader(session: Session, date: string, resumeCommand: string): string {
  const isLive = session.status === "live";
  const timeDisplay = isLive ? formatDuration(session.created_at) : date;

  // Project/repo display - prefer repo name if available
  const projectPathHtml = session.repo_url
    ? `<a href="${escapeHtml(session.repo_url)}" target="_blank" rel="noopener noreferrer"
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
      <div class="max-w-[1800px] mx-auto px-6 lg:px-10 py-5">
        <!-- Title row -->
        <div class="flex items-center gap-3 mb-2">
          ${isLive ? renderLiveIndicator() : ""}
          <h1 class="text-2xl font-semibold text-text-primary">
            ${escapeHtml(stripSystemTagsFromTitle(session.title))}
          </h1>
        </div>

        <!-- Metadata line -->
        <div class="flex items-center gap-4 text-sm text-text-muted">
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
          <div class="inline-flex items-center gap-1.5">
            <code class="text-[13px] font-mono text-accent-primary" id="resume-command">${escapeHtml(resumeCommand)}</code>
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

function renderFooter(resumeCommand: string, shareUrl: string | null): string {
  return `
    <footer class="shrink-0 border-t border-bg-elevated bg-bg-secondary">
      <div class="max-w-[1800px] mx-auto px-6 lg:px-10 py-3">
        <div class="flex items-center gap-8">
          <!-- Resume command -->
          <div class="flex items-center gap-3 min-w-0">
            <span class="text-[11px] uppercase tracking-wider text-text-muted shrink-0 font-medium">Resume</span>
            <code class="text-sm font-mono text-accent-primary truncate" id="resume-command">
              ${escapeHtml(resumeCommand)}
            </code>
            <button data-copy-target="resume-command" title="Copy command"
                    class="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-tertiary rounded transition-colors shrink-0">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>

          ${shareUrl ? `
            <div class="flex items-center gap-3 min-w-0">
              <span class="text-[11px] uppercase tracking-wider text-text-muted shrink-0 font-medium">Share</span>
              <code class="text-sm font-mono text-diff-add truncate" id="share-url">
                ${escapeHtml(shareUrl)}
              </code>
              <button data-copy-target="share-url" title="Copy URL"
                      class="p-1.5 text-text-muted hover:text-text-primary hover:bg-bg-tertiary rounded transition-colors shrink-0">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
          ` : ""}
        </div>
      </div>
    </footer>
  `;
}

function renderConversationPanel(messages: Message[], isInteractive: boolean = false): string {
  // Conversation panel: sticky sidebar on left, fixed height with internal scroll
  // Render messages with gap tracking based on actually rendered messages
  let prevRenderedRole: string | null = null;
  const renderedMessages: string[] = [];

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    if (!msg) continue;
    const result = renderMessageBlock(msg, messages, idx, prevRenderedRole);
    if (result) {
      renderedMessages.push(result);
      prevRenderedRole = msg.role;
    }
  }

  // Adjust height based on whether feedback input will be shown
  const conversationHeight = isInteractive ? "calc(100% - 2rem - 120px)" : "calc(100% - 2rem)";

  return `
    <div class="min-w-0 lg:sticky lg:top-[calc(3.5rem+1.5rem)] lg:self-start" style="height: calc(100vh - 10rem);">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold text-text-primary">Conversation</h2>
        <span id="message-count" class="text-xs text-text-muted tabular-nums">${messages.length} messages</span>
      </div>
      <div id="conversation-list" class="conversation-panel flex-1 overflow-y-auto flex flex-col" style="height: ${conversationHeight};">
        ${renderedMessages.join("")}
        ${renderTypingIndicator()}
      </div>
      <!-- Placeholder for feedback input (rendered dynamically for interactive sessions) -->
      <div id="feedback-input-placeholder"></div>
    </div>
    ${renderNewMessagesButton()}
  `;
}

export function renderDiffPanel(diffs: Diff[], review?: ReviewWithCount | null): string {
  // Separate diffs by relevance
  const sessionDiffs = diffs.filter((d) => d.is_session_relevant);
  const otherDiffs = diffs.filter((d) => !d.is_session_relevant);

  const sessionCount = sessionDiffs.length;
  const otherCount = otherDiffs.length;
  const totalCount = diffs.length;

  return `
    <div class="min-w-0">
      ${review ? renderReviewSummary(review) : ""}
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold text-text-primary">Code Changes</h2>
        <span class="text-xs text-text-muted tabular-nums">${totalCount} file${totalCount !== 1 ? "s" : ""}</span>
      </div>
      <div id="diffs-container" class="bg-bg-secondary border border-bg-elevated rounded-lg">
        ${
          sessionCount > 0
            ? `
          <div class="diff-group">
            <div class="px-3 py-2 text-xs font-medium text-text-secondary bg-bg-tertiary border-b border-bg-elevated">
              Changed in this session (${sessionCount})
            </div>
            ${sessionDiffs.map((d) => renderDiffBlock(d)).join("")}
          </div>
        `
            : ""
        }

        ${
          otherCount > 0
            ? `
          <div class="diff-group">
            <button class="w-full px-3 py-2 text-xs font-medium text-text-muted bg-bg-tertiary border-b border-bg-elevated flex items-center gap-2 hover:bg-bg-elevated transition-colors"
                    data-toggle-other-diffs>
              <span class="toggle-icon transition-transform">▶</span>
              <span>Other branch changes (${otherCount})</span>
              <span class="text-text-muted/60 ml-auto truncate max-w-[200px]">
                ${summarizeOtherFiles(otherDiffs)}
              </span>
            </button>
            <div id="other-diffs-content" class="hidden">
              ${otherDiffs.map((d) => renderDiffBlock(d)).join("")}
            </div>
          </div>
        `
            : ""
        }

        ${
          totalCount === 0
            ? `
          <div class="flex items-center justify-center h-full text-text-muted text-sm py-8">
            No code changes
          </div>
        `
            : ""
        }
      </div>
    </div>
  `;
}

function renderEmptyDiffPlaceholder(): string {
  return `
    <div class="min-w-0">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-sm font-semibold text-text-primary">Code Changes</h2>
        <span class="text-xs text-text-muted tabular-nums">0 files</span>
      </div>
      <div id="diffs-container" class="bg-bg-secondary border border-bg-elevated rounded-lg">
        <div class="flex items-center justify-center h-full text-text-muted text-sm py-8">
          No code changes yet
        </div>
      </div>
    </div>
  `;
}

function renderReviewSummary(review: ReviewWithCount): string {
  return `
    <div class="bg-bg-secondary border border-bg-elevated rounded-lg overflow-hidden mb-4">
      <div class="flex items-center justify-between px-4 py-2.5 bg-bg-tertiary border-b border-bg-elevated">
        <span class="text-sm font-medium text-text-primary flex items-center gap-2">
          <svg class="w-4 h-4 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          Code Review
        </span>
        ${review.model ? `<span class="text-xs text-text-muted font-mono">${escapeHtml(review.model)}</span>` : ""}
      </div>
      <div class="px-4 py-3 text-sm text-text-secondary leading-relaxed">
        ${formatMessageContent(review.summary)}
      </div>
      ${review.annotation_count > 0 ? `
        <div class="px-4 py-2 border-t border-bg-elevated text-xs text-text-muted">
          ${review.annotation_count} annotation${review.annotation_count !== 1 ? "s" : ""}
        </div>
      ` : ""}
    </div>
  `;
}

function summarizeOtherFiles(diffs: Diff[]): string {
  const names = diffs
    .map((d) => d.filename?.split("/").pop() || "unknown")
    .slice(0, 3);

  if (diffs.length > 3) {
    return names.join(", ") + "...";
  }
  return names.join(", ");
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

function renderDiffBlock(diff: Diff): string {
  const filename = diff.filename || "Unknown file";
  // Use pre-computed stats from database
  const additions = diff.additions || 0;
  const deletions = diff.deletions || 0;
  const totalChanges = additions + deletions;

  // Large diff threshold - collapse by default if >300 lines changed
  const isLarge = totalChanges > 300;
  const isCollapsed = isLarge;
  const blockId = `diff-${diff.diff_index}`;

  return `
    <div class="diff-file border-b border-bg-elevated last:border-b-0"
         data-filename="${escapeHtml(filename)}">
      <button class="diff-file-header flex items-center justify-between w-full px-3 py-2 bg-bg-tertiary border-b border-bg-elevated hover:bg-bg-elevated transition-colors text-left sticky top-14 z-10"
              data-toggle-diff="${blockId}"
              data-collapsed="${isCollapsed}">
        <div class="flex items-center gap-2 min-w-0">
          <span class="toggle-icon text-text-muted text-xs transition-transform">${isCollapsed ? "▶" : "▼"}</span>
          <span class="text-[13px] font-mono text-text-primary truncate">${escapeHtml(filename)}</span>
        </div>
        <div class="flex items-center gap-2 text-xs font-mono shrink-0 tabular-nums">
          ${deletions > 0 ? `<span class="text-diff-del">-${deletions}</span>` : ""}
          ${additions > 0 ? `<span class="text-diff-add">+${additions}</span>` : ""}
          ${isLarge ? `<span class="collapse-label text-text-muted ml-2">${isCollapsed ? "Show" : "Hide"}</span>` : ""}
        </div>
      </button>
      <div id="${blockId}" class="diff-content ${isCollapsed ? "hidden" : ""}"
           data-diff-content="${escapeHtml(diff.diff_content)}"
           data-diff-id="${diff.id}"
           data-filename="${escapeHtml(filename)}"
           data-needs-render="${isCollapsed ? "true" : "false"}">
        ${isCollapsed ? "" : '<div class="px-4 py-3 text-text-muted text-sm">Loading diff...</div>'}
      </div>
    </div>
  `;
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

// Export function to render a single message for live appending
export function renderSingleMessage(message: Message, prevRole: string | null): string {
  return renderMessageBlock(message, [message], 0, prevRole);
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

// Feedback input state for interactive sessions
export interface FeedbackInputState {
  isInteractive: boolean;
  claudeState: "running" | "waiting" | "unknown";
  sessionComplete: boolean;
  pendingFeedback: Array<{ id: string; status: "pending" | "approved" | "rejected" }>;
}

// Render feedback input panel for interactive sessions
export function renderFeedbackInput(state: FeedbackInputState): string {
  const { isInteractive, claudeState, sessionComplete, pendingFeedback } = state;

  // Non-interactive or complete sessions don't show input
  if (!isInteractive || sessionComplete) {
    return "";
  }

  // For pull-based feedback, can always send when session is interactive
  // Feedback gets queued and pulled when Claude is ready
  const statusText = getFeedbackStatusText(claudeState);
  const pendingCount = pendingFeedback.filter(f => f.status === "pending").length;

  return `
    <div id="feedback-input-container" class="feedback-input-container">
      ${renderFeedbackStatus(statusText, pendingCount)}
      <div class="feedback-input-wrapper">
        <textarea
          id="feedback-input"
          class="feedback-input"
          placeholder="Send a follow-up message..."
          rows="2"
        ></textarea>
        <button
          id="feedback-submit"
          class="feedback-submit"
          title="Send feedback (Ctrl+Enter)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
          </svg>
        </button>
      </div>
      <div class="feedback-help">
        <span class="feedback-shortcut">${navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}+Enter</span> to send
      </div>
      ${renderPendingFeedback(pendingFeedback)}
    </div>
  `;
}

function getFeedbackStatusText(claudeState: "running" | "waiting" | "unknown"): string {
  switch (claudeState) {
    case "running":
      return "Claude is working...";
    case "waiting":
      return "Claude is waiting for input";
    default:
      // For pull-based sessions, we don't track state in real-time
      return "Feedback will be queued";
  }
}

function renderFeedbackStatus(text: string, pendingCount: number): string {
  if (!text && pendingCount === 0) return "";

  return `
    <div class="feedback-status">
      <span class="feedback-status-text">${text}</span>
      ${pendingCount > 0 ? `
        <span class="feedback-pending-badge">
          ${pendingCount} pending approval
        </span>
      ` : ""}
    </div>
  `;
}

function renderPendingFeedback(pending: Array<{ id: string; status: "pending" | "approved" | "rejected" }>): string {
  const pendingItems = pending.filter(f => f.status === "pending");
  if (pendingItems.length === 0) return "";

  return `
    <div class="feedback-pending-list">
      ${pendingItems.map(_f => `
        <div class="feedback-pending-item">
          <span class="feedback-pending-icon">&#9203;</span>
          <span>Waiting for approval...</span>
        </div>
      `).join("")}
    </div>
  `;
}

// Render session status indicator for interactive sessions
export function renderSessionStatus(claudeState: "running" | "waiting" | "unknown"): string {
  if (claudeState === "waiting") {
    return `
      <span class="flex items-center gap-1 text-xs text-accent-primary">
        <span class="w-1.5 h-1.5 rounded-full bg-accent-primary animate-pulse"></span>
        <span>Waiting for input</span>
      </span>
    `;
  }

  return `
    <span class="flex items-center gap-1 text-xs text-green-400">
      <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span>
      <span>Interactive</span>
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
