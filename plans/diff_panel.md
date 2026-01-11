# Implementation Plan: Diff Panel Enhancements

Enhance the diff panel with relevance grouping, collapsible large diffs, and conversation linking.

**Spec reference:** `specs/session_detail_view.md` - Code Changes Panel, Collapsible Diffs, Diff Relevance Filtering

**Depends on:** `plans/schema_migration.md` (needs `is_session_relevant`, `additions`, `deletions`)

## Overview

**Current state:**
- All diffs shown in order uploaded
- No collapsing for large diffs
- No relevance indication
- Stats computed on render

**Target state:**
- Diffs grouped by relevance (session files vs other branch changes)
- Large diffs (>300 lines) collapsed by default
- Pre-computed addition/deletion stats
- Link from conversation tool calls to diff

## Files to Modify

| File | Changes |
|------|---------|
| `src/client/views.ts` | Update `renderDiffPanel`, add grouping |
| `src/client/index.ts` | Collapse toggle, diff linking handlers |

## Step 1: Update Diff Panel Structure

**File: `src/client/views.ts`**

Group diffs by relevance:

```typescript
import type { Diff } from '../db/schema';

function renderDiffPanel(diffs: Diff[]): string {
  // Separate by relevance
  const sessionDiffs = diffs.filter(d => d.is_session_relevant);
  const otherDiffs = diffs.filter(d => !d.is_session_relevant);

  const sessionCount = sessionDiffs.length;
  const otherCount = otherDiffs.length;
  const totalCount = diffs.length;

  return `
    <div class="flex flex-col bg-bg-secondary border border-bg-elevated rounded-lg overflow-hidden h-full">
      <div class="flex items-center justify-between px-3 py-2 bg-bg-tertiary border-b border-bg-elevated shrink-0">
        <h2 class="text-sm font-medium text-text-primary">Code Changes</h2>
        <span class="text-xs text-text-muted">${totalCount} file${totalCount !== 1 ? 's' : ''}</span>
      </div>
      <div id="diffs-container" class="flex-1 overflow-y-auto">
        ${sessionCount > 0 ? `
          <div class="diff-group">
            <div class="px-3 py-2 text-xs font-medium text-text-secondary bg-bg-tertiary/50 border-b border-bg-elevated sticky top-0">
              Changed in this session (${sessionCount})
            </div>
            ${sessionDiffs.map(d => renderDiffBlock(d, false)).join('')}
          </div>
        ` : ''}

        ${otherCount > 0 ? `
          <div class="diff-group">
            <button class="w-full px-3 py-2 text-xs font-medium text-text-muted bg-bg-tertiary/50 border-b border-bg-elevated flex items-center gap-2 hover:bg-bg-elevated transition-colors"
                    data-toggle-other-diffs>
              <span class="toggle-icon">▶</span>
              <span>Other branch changes (${otherCount})</span>
              <span class="text-text-muted/60 ml-auto">
                ${summarizeOtherFiles(otherDiffs)}
              </span>
            </button>
            <div id="other-diffs-content" class="hidden">
              ${otherDiffs.map(d => renderDiffBlock(d, true)).join('')}
            </div>
          </div>
        ` : ''}

        ${totalCount === 0 ? `
          <div class="flex items-center justify-center h-full text-text-muted text-sm">
            No code changes
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function summarizeOtherFiles(diffs: Diff[]): string {
  const names = diffs
    .map(d => d.filename?.split('/').pop() || 'unknown')
    .slice(0, 3);

  if (diffs.length > 3) {
    return names.join(', ') + '...';
  }
  return names.join(', ');
}
```

## Step 2: Update Diff Block Renderer

Add collapsible behavior for large diffs:

```typescript
function renderDiffBlock(diff: Diff, isOther: boolean): string {
  const filename = diff.filename || 'Unknown file';
  const additions = diff.additions || 0;
  const deletions = diff.deletions || 0;
  const totalChanges = additions + deletions;

  // Large diff threshold
  const isLarge = totalChanges > 300;
  const blockId = `diff-${diff.diff_index}`;

  // Collapsed by default if large
  const isCollapsed = isLarge;

  return `
    <div class="diff-file border-b border-bg-elevated last:border-b-0"
         id="diff-file-${encodeFilename(filename)}"
         data-filename="${escapeHtml(filename)}">
      <button class="diff-file-header flex items-center justify-between w-full px-3 py-2 bg-bg-tertiary border-b border-bg-elevated hover:bg-bg-elevated transition-colors text-left"
              data-toggle-diff="${blockId}"
              data-collapsed="${isCollapsed}">
        <div class="flex items-center gap-2 min-w-0">
          <span class="toggle-icon text-text-muted text-xs">${isCollapsed ? '▶' : '▼'}</span>
          <span class="text-[13px] font-mono text-text-primary truncate">${escapeHtml(filename)}</span>
        </div>
        <div class="flex items-center gap-2 text-xs font-mono shrink-0">
          ${deletions > 0 ? `<span class="text-diff-del">-${deletions}</span>` : ''}
          ${additions > 0 ? `<span class="text-diff-add">+${additions}</span>` : ''}
          ${isLarge ? `<span class="text-text-muted ml-2">${isCollapsed ? 'Show' : 'Hide'}</span>` : ''}
        </div>
      </button>
      <div id="${blockId}" class="diff-content ${isCollapsed ? 'hidden' : ''}"
           data-diff-content="${escapeHtml(diff.diff_content)}"
           data-filename="${escapeHtml(filename)}">
        ${isCollapsed ? '' : '<div class="p-4 text-text-muted text-sm">Loading diff...</div>'}
      </div>
    </div>
  `;
}

function encodeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9]/g, '-');
}
```

## Step 3: Lazy Diff Loading

Only render diffs when expanded (for performance):

**File: `src/client/index.ts`**

```typescript
import { FileDiff, getSingularPatch } from "@pierre/diffs";

// Track rendered diffs to avoid re-rendering
const renderedDiffs = new Set<string>();

// Diff collapse/expand toggle
document.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  const toggleBtn = target.closest('[data-toggle-diff]') as HTMLElement;

  if (toggleBtn) {
    const contentId = toggleBtn.dataset.toggleDiff;
    const content = document.getElementById(contentId!);
    const icon = toggleBtn.querySelector('.toggle-icon');
    const showHideLabel = toggleBtn.querySelector('.text-text-muted:last-child');

    if (content && icon) {
      const isHidden = content.classList.contains('hidden');
      content.classList.toggle('hidden');
      icon.textContent = isHidden ? '▼' : '▶';

      if (showHideLabel) {
        showHideLabel.textContent = isHidden ? 'Hide' : 'Show';
      }

      // Render diff content if expanding and not yet rendered
      if (isHidden && !renderedDiffs.has(contentId!)) {
        await renderDiffContent(content);
        renderedDiffs.add(contentId!);
      }
    }
  }
});

// Other diffs section toggle
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const toggleBtn = target.closest('[data-toggle-other-diffs]') as HTMLElement;

  if (toggleBtn) {
    const content = document.getElementById('other-diffs-content');
    const icon = toggleBtn.querySelector('.toggle-icon');

    if (content && icon) {
      const isHidden = content.classList.contains('hidden');
      content.classList.toggle('hidden');
      icon.textContent = isHidden ? '▼' : '▶';
    }
  }
});

async function renderDiffContent(container: HTMLElement) {
  const diffContent = container.dataset.diffContent;
  const filename = container.dataset.filename;

  if (!diffContent) {
    container.innerHTML = '<div class="p-4 text-text-muted text-sm">No diff content</div>';
    return;
  }

  try {
    const fileDiff = getSingularPatch(diffContent);

    const diffComponent = new FileDiff({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: "dark",
      diffStyle: "unified",
      diffIndicators: "classic",
      disableFileHeader: true,
      overflow: "scroll",
    });

    diffComponent.data = fileDiff;
    container.innerHTML = '';
    container.appendChild(diffComponent);
  } catch (error) {
    console.error('Failed to render diff:', error);
    container.innerHTML = `
      <div class="p-4">
        <div class="flex items-center gap-2 text-text-muted mb-2">
          <span>⚠️</span>
          <span>Unable to render diff</span>
        </div>
        <button class="text-accent-primary text-sm hover:underline" data-show-raw-diff>
          Show raw diff
        </button>
        <pre class="hidden raw-diff mt-2 text-xs font-mono whitespace-pre-wrap bg-bg-primary p-2 rounded overflow-x-auto">${escapeHtml(diffContent)}</pre>
      </div>
    `;
  }
}

// Show raw diff fallback
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.matches('[data-show-raw-diff]')) {
    const rawDiff = target.nextElementSibling;
    if (rawDiff) {
      rawDiff.classList.toggle('hidden');
      target.textContent = rawDiff.classList.contains('hidden') ? 'Show raw diff' : 'Hide raw diff';
    }
  }
});
```

## Step 4: Conversation-to-Diff Linking

Add link from tool calls to diff panel:

**File: `src/client/blocks.ts`**

Update tool use renderer to include diff link:

```typescript
function renderToolUseBlock(
  block: ToolUseBlock,
  result?: ToolResultBlock,
  diffFiles?: Set<string>  // Pass available diff filenames
): string {
  const summary = getToolSummary(block);
  const status = getToolStatus(result);
  const blockId = `tool-${block.id}`;

  // Check if this tool modified a file that's in the diffs
  const filePath = getToolFilePath(block);
  const hasDiff = filePath && diffFiles?.has(normalizeForMatch(filePath));

  return `
    <div class="tool-block my-2" data-tool-id="${block.id}">
      <button class="tool-header flex items-center gap-2 w-full text-left px-2 py-1.5 rounded hover:bg-bg-elevated transition-colors"
              data-toggle-tool="${blockId}">
        <span class="toggle-icon text-text-muted">▶</span>
        <span class="font-semibold text-accent-primary">${escapeHtml(block.name)}</span>
        <span class="font-mono text-sm text-text-muted truncate flex-1">${escapeHtml(summary)}</span>
        ${status}
        ${hasDiff ? `
          <a href="#diff-file-${encodeFilename(filePath!)}"
             class="text-xs text-accent-primary hover:underline ml-2"
             data-scroll-to-diff="${escapeHtml(filePath!)}"
             onclick="event.stopPropagation()">
            → diff
          </a>
        ` : ''}
      </button>
      <div id="${blockId}" class="tool-content hidden pl-6 mt-1">
        ${renderToolInput(block)}
        ${result ? renderToolResult(result) : '<div class="text-text-muted text-sm italic">⋯ pending</div>'}
      </div>
    </div>
  `;
}

function getToolFilePath(block: ToolUseBlock): string | null {
  const input = block.input as Record<string, unknown>;
  if (['Write', 'Edit', 'Read'].includes(block.name)) {
    return (input.file_path as string) || null;
  }
  if (block.name === 'NotebookEdit') {
    return (input.notebook_path as string) || null;
  }
  return null;
}

function normalizeForMatch(path: string): string {
  // Remove leading ./ and normalize
  return path.replace(/^\.\//, '').replace(/\/+/g, '/');
}

function encodeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9]/g, '-');
}
```

**File: `src/client/index.ts`**

Add scroll-to-diff handler:

```typescript
// Scroll to diff when clicking link
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const link = target.closest('[data-scroll-to-diff]') as HTMLElement;

  if (link) {
    e.preventDefault();
    const filename = link.dataset.scrollToDiff;

    // Find the diff element
    const diffEl = document.querySelector(`[data-filename="${filename}"]`) as HTMLElement;
    if (!diffEl) {
      // Try normalized match
      const allDiffs = document.querySelectorAll('[data-filename]');
      for (const el of allDiffs) {
        const elFilename = (el as HTMLElement).dataset.filename;
        if (elFilename && (
          elFilename.endsWith(filename!) ||
          filename!.endsWith(elFilename)
        )) {
          scrollToDiff(el as HTMLElement);
          return;
        }
      }
      return;
    }

    scrollToDiff(diffEl);
  }
});

function scrollToDiff(diffEl: HTMLElement) {
  // Expand the diff if collapsed
  const content = diffEl.querySelector('.diff-content') as HTMLElement;
  const toggleBtn = diffEl.querySelector('[data-toggle-diff]') as HTMLElement;

  if (content?.classList.contains('hidden')) {
    toggleBtn?.click();
  }

  // Expand "Other branch changes" section if needed
  const otherSection = diffEl.closest('#other-diffs-content');
  if (otherSection?.classList.contains('hidden')) {
    const otherToggle = document.querySelector('[data-toggle-other-diffs]') as HTMLElement;
    otherToggle?.click();
  }

  // Scroll into view
  diffEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Highlight briefly
  diffEl.classList.add('ring-2', 'ring-accent-primary', 'ring-opacity-50');
  setTimeout(() => {
    diffEl.classList.remove('ring-2', 'ring-accent-primary', 'ring-opacity-50');
  }, 2000);
}
```

## Step 5: Pass Diff Files to Block Renderer

Update the message rendering to pass available diff filenames:

```typescript
// In renderSessionDetail or renderConversationPanel
const diffFilenames = new Set(
  diffs.map(d => d.filename).filter(Boolean).map(f => normalizeForMatch(f!))
);

// Pass to message renderer
messages.map(msg => renderMessageBlock(msg, allMessages, diffFilenames))
```

## Testing

1. Upload session with:
   - Files changed in conversation (Edit/Write calls)
   - Other files in diff (e.g., lockfiles, unrelated changes)
2. Verify:
   - Diffs grouped into "Changed in this session" and "Other branch changes"
   - Other section collapsed by default
   - Large diffs (>300 lines) collapsed by default
   - Clicking header expands/collapses diff
   - "→ diff" link appears on relevant tool calls
   - Clicking link scrolls to and highlights diff
   - Raw diff fallback works if parsing fails

## Performance Considerations

- Diffs are lazily rendered only when expanded
- `renderedDiffs` Set prevents re-parsing
- Large diffs stay collapsed to avoid initial render cost
- Consider virtualization for sessions with many files (future)

## Dependencies

- Requires `plans/schema_migration.md` for `is_session_relevant`, `additions`, `deletions` fields
- Uses existing `@pierre/diffs` integration
