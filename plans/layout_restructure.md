# Implementation Plan: Layout Restructure

Restructure the session detail view layout to be content-first with compact header/footer.

**Spec reference:** `specs/session_detail_view.md` - Layout Structure, Header, Footer sections

## Overview

**Current state:**
- Header takes significant vertical space (title, description, resume command, share URL)
- Panels use `max-h-[70vh]` instead of filling available space
- No dedicated footer

**Target state:**
- Compact single-line header with metadata inline
- Footer utility bar for resume/share commands
- Panels fill remaining viewport height with CSS grid

## Files to Modify

| File | Changes |
|------|---------|
| `src/client/views.ts` | Restructure `renderSessionDetail` |
| `src/client/index.ts` | Update event handlers if needed |

## Step 1: Update Page Structure

**File: `src/client/views.ts`**

Replace the current structure with CSS grid layout:

```typescript
export function renderSessionDetail({ session, messages, diffs, shareUrl }: SessionDetailData): string {
  const hasDiffs = diffs.length > 0;
  const date = formatDate(session.created_at);

  const resumeCommand = session.claude_session_id
    ? `claude --resume ${session.claude_session_id}`
    : session.project_path
      ? `cd ${session.project_path} && claude --continue`
      : "claude --continue";

  return `
    <div class="session-detail h-screen flex flex-col">
      <!-- Header -->
      ${renderHeader(session, date)}

      <!-- Content Panels -->
      <div class="flex-1 min-h-0 p-4">
        <div class="${hasDiffs ? 'grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-4 h-full' : 'h-full'}">
          ${renderConversationPanel(messages)}
          ${hasDiffs ? renderDiffPanel(diffs) : ''}
        </div>
      </div>

      <!-- Footer -->
      ${renderFooter(resumeCommand, shareUrl)}
    </div>
  `;
}
```

## Step 2: Implement Header

Compact single-line header with title, metadata, and actions:

```typescript
function renderHeader(session: Session, date: string): string {
  const hasDescription = !!session.description;

  return `
    <header class="shrink-0 border-b border-bg-elevated bg-bg-secondary px-4 py-3">
      <div class="flex items-center justify-between gap-4">
        <!-- Left: Title and metadata -->
        <div class="flex items-center gap-2 min-w-0">
          <h1 class="text-lg font-semibold text-text-primary truncate">
            ${escapeHtml(session.title)}
          </h1>
          ${session.project_path ? `
            <span class="text-text-muted">·</span>
            <span class="text-sm font-mono text-text-muted truncate max-w-[200px]" title="${escapeHtml(session.project_path)}">
              ${escapeHtml(truncatePath(session.project_path))}
            </span>
          ` : ''}
          <span class="text-text-muted">·</span>
          <span class="text-sm text-text-muted shrink-0">${date}</span>
        </div>

        <!-- Right: Actions -->
        <div class="flex items-center gap-2 shrink-0">
          ${session.pr_url ? `
            <a href="${escapeHtml(session.pr_url)}" target="_blank" rel="noopener noreferrer"
               class="btn btn-secondary text-sm">
              View PR
            </a>
          ` : ''}
          <button data-share-session="${escapeHtml(session.id)}" class="btn btn-secondary text-sm">
            Share
          </button>
          <a href="/api/sessions/${escapeHtml(session.id)}/export" class="btn btn-secondary text-sm">
            Export
          </a>
        </div>
      </div>

      ${hasDescription ? `
        <p class="text-sm text-text-secondary mt-1 truncate">
          ${escapeHtml(session.description)}
        </p>
      ` : ''}
    </header>
  `;
}

function truncatePath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-2).join('/');
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
```

## Step 3: Implement Footer

Utility bar for resume command and share URL:

```typescript
function renderFooter(resumeCommand: string, shareUrl: string | null): string {
  return `
    <footer class="shrink-0 border-t border-bg-elevated bg-bg-secondary px-4 py-2">
      <div class="flex items-center gap-6">
        <!-- Resume command -->
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-xs uppercase tracking-wide text-text-muted shrink-0">Resume</span>
          <code class="text-sm font-mono text-accent-primary truncate" id="resume-command">
            ${escapeHtml(resumeCommand)}
          </code>
          <button data-copy-target="resume-command" title="Copy command"
                  class="p-1 text-text-muted hover:text-text-primary transition-colors shrink-0">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
        </div>

        ${shareUrl ? `
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-xs uppercase tracking-wide text-text-muted shrink-0">Share</span>
            <code class="text-sm font-mono text-diff-add truncate" id="share-url">
              ${escapeHtml(shareUrl)}
            </code>
            <button data-copy-target="share-url" title="Copy URL"
                    class="p-1 text-text-muted hover:text-text-primary transition-colors shrink-0">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
        ` : ''}
      </div>
    </footer>
  `;
}
```

## Step 4: Update Panel Containers

Panels should fill available height:

```typescript
function renderConversationPanel(messages: Message[]): string {
  return `
    <div class="flex flex-col bg-bg-secondary border border-bg-elevated rounded-lg overflow-hidden h-full">
      <div class="flex items-center justify-between px-3 py-2 bg-bg-tertiary border-b border-bg-elevated shrink-0">
        <h2 class="text-sm font-medium text-text-primary">Conversation</h2>
        <span class="text-xs text-text-muted">${messages.length} messages</span>
      </div>
      <div class="flex-1 overflow-y-auto divide-y divide-bg-elevated">
        ${messages.map(renderMessageBlock).join('')}
      </div>
    </div>
  `;
}

function renderDiffPanel(diffs: Diff[]): string {
  return `
    <div class="flex flex-col bg-bg-secondary border border-bg-elevated rounded-lg overflow-hidden h-full">
      <div class="flex items-center justify-between px-3 py-2 bg-bg-tertiary border-b border-bg-elevated shrink-0">
        <h2 class="text-sm font-medium text-text-primary">Code Changes</h2>
        <span class="text-xs text-text-muted">${diffs.length} file${diffs.length !== 1 ? 's' : ''}</span>
      </div>
      <div id="diffs-container" class="flex-1 overflow-y-auto">
        ${diffs.map(renderDiffBlock).join('')}
      </div>
    </div>
  `;
}
```

## Step 5: Add Button Styles

Ensure button classes are defined (may already exist):

```css
/* In tailwind config or inline styles */
.btn {
  @apply inline-flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors;
}

.btn-secondary {
  @apply text-text-primary bg-bg-tertiary hover:bg-bg-elevated border border-bg-elevated;
}

.btn-primary {
  @apply text-white bg-accent-primary hover:bg-accent-primary/90;
}
```

## Step 6: Update Copy Handler

**File: `src/client/index.ts`**

Update copy button handler to work with new `data-copy-target` pattern:

```typescript
// Update existing copy handler or add if missing
document.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  const copyBtn = target.closest('[data-copy-target]') as HTMLElement;

  if (copyBtn) {
    const targetId = copyBtn.dataset.copyTarget;
    const targetEl = document.getElementById(targetId!);

    if (targetEl) {
      const text = targetEl.textContent?.trim() || '';
      await navigator.clipboard.writeText(text);

      // Show feedback (optional: add toast)
      copyBtn.classList.add('text-diff-add');
      setTimeout(() => copyBtn.classList.remove('text-diff-add'), 1000);
    }
  }
});
```

## Testing

1. Start dev server: `bun run dev`
2. Navigate to a session detail page
3. Verify:
   - Header is single-line with metadata
   - Footer shows resume command (and share URL if shared)
   - Panels fill available height (no `max-h-[70vh]`)
   - Both panels scroll independently
   - Copy buttons work
   - Responsive: panels stack on mobile

## Mobile Considerations

The `lg:grid-cols-[1fr_2fr]` breakpoint handles responsive layout. On mobile:
- Panels stack vertically
- Each panel gets roughly half the viewport
- Footer may need smaller text or stacked layout

## Dependencies

- None (pure frontend changes)
- Can be implemented independently of schema migration
