# Implementation Plan: States & Polish

Implement loading, error, and empty states plus shared session handling.

**Spec reference:** `specs/session_detail_view.md` - Loading/Error/Empty States, Shared Sessions

## Overview

**Current state:**
- No loading skeleton (blank page while fetching)
- Basic "Not Found" page
- Shared sessions look identical to regular sessions

**Target state:**
- Skeleton loading UI that matches final layout
- Proper error states with helpful messaging
- Empty states for edge cases
- Shared session differences (no Share/Delete buttons)

## Files to Modify

| File | Changes |
|------|---------|
| `src/client/views.ts` | Add loading skeleton, error views |
| `src/client/index.ts` | Loading state management |
| `src/routes/api.ts` | Return `isShared` flag in response |

## Step 1: Loading Skeleton

**File: `src/client/views.ts`**

Add skeleton rendering function:

```typescript
export function renderSessionDetailSkeleton(): string {
  return `
    <div class="session-detail h-screen flex flex-col animate-pulse">
      <!-- Header skeleton -->
      <header class="shrink-0 border-b border-bg-elevated bg-bg-secondary px-4 py-3">
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-2">
            <div class="h-6 w-48 bg-bg-elevated rounded"></div>
            <div class="h-4 w-4 bg-bg-elevated rounded-full"></div>
            <div class="h-4 w-32 bg-bg-elevated rounded"></div>
            <div class="h-4 w-4 bg-bg-elevated rounded-full"></div>
            <div class="h-4 w-24 bg-bg-elevated rounded"></div>
          </div>
          <div class="flex items-center gap-2">
            <div class="h-8 w-20 bg-bg-elevated rounded-lg"></div>
            <div class="h-8 w-16 bg-bg-elevated rounded-lg"></div>
            <div class="h-8 w-16 bg-bg-elevated rounded-lg"></div>
          </div>
        </div>
      </header>

      <!-- Content skeleton -->
      <div class="flex-1 min-h-0 p-4">
        <div class="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-4 h-full">
          <!-- Conversation panel skeleton -->
          <div class="flex flex-col bg-bg-secondary border border-bg-elevated rounded-lg overflow-hidden">
            <div class="flex items-center justify-between px-3 py-2 bg-bg-tertiary border-b border-bg-elevated">
              <div class="h-4 w-24 bg-bg-elevated rounded"></div>
              <div class="h-3 w-16 bg-bg-elevated rounded"></div>
            </div>
            <div class="flex-1 p-3 space-y-4">
              ${renderMessageSkeletons(5)}
            </div>
          </div>

          <!-- Diff panel skeleton -->
          <div class="flex flex-col bg-bg-secondary border border-bg-elevated rounded-lg overflow-hidden">
            <div class="flex items-center justify-between px-3 py-2 bg-bg-tertiary border-b border-bg-elevated">
              <div class="h-4 w-28 bg-bg-elevated rounded"></div>
              <div class="h-3 w-12 bg-bg-elevated rounded"></div>
            </div>
            <div class="flex-1 p-3 space-y-3">
              ${renderDiffSkeletons(3)}
            </div>
          </div>
        </div>
      </div>

      <!-- Footer skeleton -->
      <footer class="shrink-0 border-t border-bg-elevated bg-bg-secondary px-4 py-2">
        <div class="flex items-center gap-6">
          <div class="flex items-center gap-2">
            <div class="h-3 w-12 bg-bg-elevated rounded"></div>
            <div class="h-4 w-48 bg-bg-elevated rounded"></div>
          </div>
        </div>
      </footer>
    </div>
  `;
}

function renderMessageSkeletons(count: number): string {
  return Array(count).fill(0).map((_, i) => `
    <div class="space-y-2 ${i % 2 === 0 ? '' : 'bg-bg-tertiary rounded p-2'}">
      <div class="h-3 w-12 bg-bg-elevated rounded"></div>
      <div class="h-4 w-full bg-bg-elevated rounded"></div>
      <div class="h-4 w-3/4 bg-bg-elevated rounded"></div>
      ${i % 2 === 1 ? '<div class="h-4 w-1/2 bg-bg-elevated rounded"></div>' : ''}
    </div>
  `).join('');
}

function renderDiffSkeletons(count: number): string {
  return Array(count).fill(0).map(() => `
    <div class="border border-bg-elevated rounded-lg overflow-hidden">
      <div class="flex items-center justify-between px-3 py-2 bg-bg-tertiary">
        <div class="h-4 w-48 bg-bg-elevated rounded"></div>
        <div class="flex gap-2">
          <div class="h-3 w-8 bg-bg-elevated rounded"></div>
          <div class="h-3 w-8 bg-bg-elevated rounded"></div>
        </div>
      </div>
      <div class="p-3 space-y-1">
        <div class="h-3 w-full bg-bg-elevated rounded"></div>
        <div class="h-3 w-full bg-bg-elevated rounded"></div>
        <div class="h-3 w-3/4 bg-bg-elevated rounded"></div>
      </div>
    </div>
  `).join('');
}
```

## Step 2: Error States

**File: `src/client/views.ts`**

```typescript
interface ErrorInfo {
  status: number;
  message?: string;
}

export function renderSessionError(error: ErrorInfo): string {
  const { icon, title, description } = getErrorContent(error);

  return `
    <div class="h-screen flex flex-col items-center justify-center p-4">
      <div class="text-center max-w-md">
        <div class="text-4xl mb-4">${icon}</div>
        <h1 class="text-lg font-semibold text-text-primary mb-2">${title}</h1>
        <p class="text-sm text-text-secondary mb-6">${description}</p>
        <a href="/" class="inline-flex items-center gap-2 px-4 py-2 bg-accent-primary text-white rounded-lg hover:bg-accent-primary/90 transition-colors">
          Go to Sessions
        </a>
      </div>
    </div>
  `;
}

function getErrorContent(error: ErrorInfo): { icon: string; title: string; description: string } {
  switch (error.status) {
    case 404:
      return {
        icon: '🔍',
        title: 'Session not found',
        description: 'This session may have been deleted or the link may be incorrect.'
      };
    case 403:
      return {
        icon: '🔒',
        title: "You don't have access to this session",
        description: 'This session may be private or require authentication.'
      };
    case 500:
      return {
        icon: '⚠️',
        title: 'Something went wrong',
        description: error.message || 'Please try again later.'
      };
    default:
      return {
        icon: '❌',
        title: 'Unable to load session',
        description: 'Please check your internet connection and try again.'
      };
  }
}
```

## Step 3: Empty States

```typescript
export function renderEmptyConversation(): string {
  return `
    <div class="flex flex-col items-center justify-center h-full text-center p-4">
      <div class="text-3xl mb-3">💬</div>
      <h3 class="text-sm font-medium text-text-secondary mb-1">No messages</h3>
      <p class="text-xs text-text-muted max-w-xs">
        This session has no conversation data. It may have been imported incorrectly.
      </p>
    </div>
  `;
}

// Update renderConversationPanel to use empty state
function renderConversationPanel(messages: Message[]): string {
  const isEmpty = messages.length === 0;

  return `
    <div class="flex flex-col bg-bg-secondary border border-bg-elevated rounded-lg overflow-hidden h-full">
      <div class="flex items-center justify-between px-3 py-2 bg-bg-tertiary border-b border-bg-elevated shrink-0">
        <h2 class="text-sm font-medium text-text-primary">Conversation</h2>
        <span class="text-xs text-text-muted">${messages.length} messages</span>
      </div>
      ${isEmpty
        ? renderEmptyConversation()
        : `<div class="flex-1 overflow-y-auto divide-y divide-bg-elevated">
            ${messages.map((msg, _, arr) => renderMessageBlock(msg, arr)).join('')}
          </div>`
      }
    </div>
  `;
}
```

## Step 4: Loading State Management

**File: `src/client/index.ts`**

Update router to show loading skeleton:

```typescript
import { renderSessionDetailSkeleton, renderSessionError } from './views';

// In the route handler for /sessions/:id
async function loadSessionDetail(sessionId: string) {
  const container = document.getElementById('app');
  if (!container) return;

  // Show loading skeleton immediately
  container.innerHTML = renderSessionDetailSkeleton();

  try {
    const response = await fetch(`/api/sessions/${sessionId}`);

    if (!response.ok) {
      container.innerHTML = renderSessionError({ status: response.status });
      return;
    }

    const data = await response.json();
    container.innerHTML = renderSessionDetail(data);

    // Initialize diff rendering
    initializeDiffs();

  } catch (error) {
    container.innerHTML = renderSessionError({
      status: 0,
      message: 'Network error'
    });
  }
}
```

## Step 5: Shared Session Handling

**File: `src/routes/api.ts`**

Add `isShared` flag to API response:

```typescript
// In getSessionDetail and getSharedSessionDetail
return json({
  session,
  messages,
  diffs,
  shareUrl,
  isShared: false  // or true for shared endpoint
});
```

**File: `src/client/views.ts`**

Update header to handle shared sessions:

```typescript
interface SessionDetailData {
  session: Session;
  messages: Message[];
  diffs: Diff[];
  shareUrl: string | null;
  isShared?: boolean;
}

function renderHeader(session: Session, date: string, isShared: boolean = false): string {
  return `
    <header class="shrink-0 border-b border-bg-elevated bg-bg-secondary px-4 py-3">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-2 min-w-0">
          ${isShared ? '<span class="text-text-muted">🔗</span>' : ''}
          <h1 class="text-lg font-semibold text-text-primary truncate">
            ${escapeHtml(session.title)}
          </h1>
          ${session.project_path ? `
            <span class="text-text-muted">·</span>
            <span class="text-sm font-mono text-text-muted truncate max-w-[200px]">
              ${escapeHtml(truncatePath(session.project_path))}
            </span>
          ` : ''}
          <span class="text-text-muted">·</span>
          <span class="text-sm text-text-muted shrink-0">${date}</span>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          ${session.pr_url ? `
            <a href="${escapeHtml(session.pr_url)}" target="_blank" rel="noopener noreferrer"
               class="btn btn-secondary text-sm">
              View PR
            </a>
          ` : ''}
          ${!isShared ? `
            <button data-share-session="${escapeHtml(session.id)}" class="btn btn-secondary text-sm">
              ${session.share_token ? 'Shared ✓' : 'Share'}
            </button>
          ` : ''}
          <a href="/api/sessions/${escapeHtml(session.id)}/export" class="btn btn-secondary text-sm">
            Export
          </a>
        </div>
      </div>
      ${session.description ? `
        <p class="text-sm text-text-secondary mt-1">${escapeHtml(session.description)}</p>
      ` : ''}
    </header>
  `;
}
```

Update footer for shared sessions:

```typescript
function renderFooter(
  resumeCommand: string,
  shareUrl: string | null,
  isShared: boolean = false
): string {
  return `
    <footer class="shrink-0 border-t border-bg-elevated bg-bg-secondary px-4 py-2">
      <div class="flex items-center gap-6">
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

        ${isShared ? `
          <div class="flex items-center gap-2 text-text-muted">
            <span>🔗</span>
            <span class="text-xs">Shared link</span>
          </div>
        ` : shareUrl ? `
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

## Step 6: Diff Render Error State

Already covered in `plans/diff_panel.md`, but ensure the error state is styled properly:

```typescript
function renderDiffError(filename: string, content: string): string {
  return `
    <div class="p-4">
      <div class="flex items-center gap-2 text-text-muted mb-2">
        <span>⚠️</span>
        <span class="text-sm">Unable to render diff</span>
      </div>
      <p class="text-xs text-text-muted mb-3">
        The diff content could not be parsed.
      </p>
      <button class="text-accent-primary text-sm hover:underline" data-show-raw-diff>
        Show raw diff
      </button>
      <pre class="hidden raw-diff mt-2 text-xs font-mono whitespace-pre-wrap bg-bg-primary p-2 rounded overflow-x-auto max-h-64">${escapeHtml(content)}</pre>
    </div>
  `;
}
```

## Step 7: Toast Notifications

Add simple toast for copy feedback:

```typescript
// Add to views.ts
export function renderToastContainer(): string {
  return `<div id="toast-container" class="fixed bottom-4 right-4 z-50"></div>`;
}

// Add to index.ts
function showToast(message: string, type: 'success' | 'error' = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `
    px-4 py-2 rounded-lg shadow-lg text-sm font-medium
    transform transition-all duration-300 translate-y-2 opacity-0
    ${type === 'success' ? 'bg-diff-add/20 text-diff-add' : 'bg-diff-del/20 text-diff-del'}
  `;
  toast.textContent = message;

  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  // Remove after delay
  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// Use in copy handlers
await navigator.clipboard.writeText(text);
showToast('Copied to clipboard');
```

## Testing

1. Test loading state:
   - Add artificial delay to API
   - Verify skeleton appears immediately
   - Verify no layout shift when content loads

2. Test error states:
   - Navigate to non-existent session ID
   - Simulate network error
   - Verify appropriate messages shown

3. Test empty states:
   - Create session with no messages
   - Verify empty state message in conversation panel

4. Test shared sessions:
   - Share a session
   - Navigate to shared URL
   - Verify no Share/Delete buttons
   - Verify 🔗 indicator shown

5. Test toast notifications:
   - Click copy buttons
   - Verify toast appears and fades out

## Dependencies

- Can be implemented in parallel with other frontend work
- Does not depend on schema migration
- Benefits from layout restructure being done first
