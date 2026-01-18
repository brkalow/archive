# Implementation Plan: Cleanup and Consolidation

> **ABANDONED**: This plan was superseded by migrating directly to React. See `plans/react_migration_parallel.md` for the approach that was used instead.

Remove legacy patterns and consolidate remaining module-level state.

**Spec reference:** `specs/component_model.md` - Migration Phase 4 (Cleanup)

**Depends on:** `plans/component_model_05_page_components.md`

## Overview

After migrating to components, this plan removes:
1. Old string-based rendering functions from views.ts
2. Module-level state arrays (`diffInstances`, `fileInstances`)
3. Document-level event listeners
4. Unused utility functions

## Files to Modify

| File | Changes |
|------|---------|
| `src/client/index.ts` | Remove legacy code |
| `src/client/views.ts` | Remove migrated functions |
| `src/client/blocks.ts` | Keep only utilities needed by components |

## Step 1: Clean Up index.ts

Remove the following from `src/client/index.ts`:

### Remove Module-Level State

```typescript
// DELETE these lines:
let liveSessionManager: LiveSessionManager | null = null;
let lastRenderedRole: string | null = null;
let pendingToolCalls = new Set<string>();
let interactiveState: FeedbackInputState = { ... };
const diffInstances: FileDiff<AnnotationMetadata>[] = [];
const fileInstances: File[] = [];
const renderedDiffs = new Set<string>();
let currentAnnotationsData: AnnotationsData | null = null;
```

These are now encapsulated in components:
- `liveSessionManager` → `MessageList`
- `lastRenderedRole` → `MessageList`
- `pendingToolCalls` → `MessageList`
- `interactiveState` → `SessionDetailPage`
- `diffInstances` → `DiffBlock` instances (auto-cleaned)
- `fileInstances` → `TextBlock` instances (auto-cleaned)
- `renderedDiffs` → `DiffBlock` state
- `currentAnnotationsData` → `SessionDetailPage` props

### Remove Legacy Functions

```typescript
// DELETE these functions (now in components):
function initializeLiveSession(...) { ... }
function initializeFeedbackInput() { ... }
function updateFeedbackInput() { ... }
function attachFeedbackInputHandlers() { ... }
function submitFeedback() { ... }
function updateMessageCount() { ... }
function updateConnectionStatus(...) { ... }
function updateSessionStatus(...) { ... }
function updateToolResult(...) { ... }
function showTypingIndicator() { ... }
function hideTypingIndicator() { ... }
function showNewMessagesButton() { ... }
function hideNewMessagesButton() { ... }
function initNewMessagesButton(...) { ... }
function initializeDiffs(...) { ... }
function renderDiffContent(...) { ... }
function attachDiffToggleHandlers() { ... }
function initializeCodeBlocks() { ... }
function createAnnotationElement(...) { ... }
function escapeHtmlForDiff(...) { ... }
function attachSessionListHandlers() { ... }
function attachSessionDetailHandlers(...) { ... }
function attachBlockHandlers() { ... }
```

### Remove Legacy Route Handlers

```typescript
// DELETE these (replaced by router.onComponent):
router.on("/", async () => { ... });
router.on("/sessions/:id", async (params) => { ... });
router.on("/s/:shareToken", async (params) => { ... });
```

### Final index.ts Structure

```typescript
import { Router } from "./router";
import { SessionListPage } from "./components/SessionListPage";
import { SessionDetailPage } from "./components/SessionDetailPage";
import type { Session, Message, Diff, Review, Annotation } from "../db/schema";

// Types
interface SessionDetailData {
  session: Session;
  messages: Message[];
  diffs: Diff[];
  shareUrl: string | null;
  review?: Review | null;
}

interface AnnotationsData {
  review: Review | null;
  annotations_by_diff: Record<number, Annotation[]>;
}

// Global utilities (kept for convenience)
declare global {
  interface Window {
    showToast: (message: string, type?: "success" | "error" | "info") => void;
    copyToClipboard: (text: string) => Promise<void>;
  }
}

window.showToast = (message: string, type = "success") => {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(1rem)";
    setTimeout(() => toast.remove(), 200);
  }, 3000);
};

window.copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    window.showToast("Copied to clipboard");
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    window.showToast("Copied to clipboard");
  }
};

// API helpers
async function fetchSessions(): Promise<Session[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) return [];
  const data = await res.json();
  return data.sessions || [];
}

async function fetchSessionDetail(id: string): Promise<SessionDetailData | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchSharedSession(shareToken: string): Promise<SessionDetailData | null> {
  const res = await fetch(`/api/s/${encodeURIComponent(shareToken)}`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchAnnotations(sessionId: string): Promise<AnnotationsData | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/annotations`);
  if (!res.ok) return null;
  return res.json();
}

// Initialize router
const router = new Router();

// Routes
router.onComponent("/", async () => {
  const sessions = await fetchSessions();
  return new SessionListPage({ sessions });
});

router.onComponent("/sessions/:id", async (params) => {
  const data = await fetchSessionDetail(params.id);
  if (!data) return null;

  const annotations = await fetchAnnotations(params.id);

  return new SessionDetailPage({
    session: data.session,
    messages: data.messages,
    diffs: data.diffs,
    shareUrl: data.shareUrl,
    review: annotations?.review || null,
    annotationsByDiff: annotations?.annotations_by_diff || {},
  });
});

router.onComponent("/s/:shareToken", async (params) => {
  const data = await fetchSharedSession(params.shareToken);
  if (!data) return null;

  return new SessionDetailPage({
    session: data.session,
    messages: data.messages,
    diffs: data.diffs,
    shareUrl: null,
    review: null,
    annotationsByDiff: {},
  });
});

// Start
router.start();
```

## Step 2: Clean Up views.ts

Remove functions that are now handled by components:

```typescript
// DELETE these functions:
export function renderSessionList(sessions: Session[]): string { ... }
export function renderSessionDetail(data: SessionDetailData): string { ... }
export function renderSingleMessage(message: Message, lastRole: string | null): string { ... }
export function renderConnectionStatusHtml(connected: boolean): string { ... }
export function renderDiffPanel(diffs: Diff[]): string { ... }
export function renderFeedbackInput(state: FeedbackInputState): string { ... }
export function renderSessionStatus(status: string): string { ... }

// KEEP these (may still be useful):
export function renderNotFound(): string { ... }
export function renderComponentsShowcase(): string { ... }
export function escapeHtml(str: string): string { ... }
```

## Step 3: Clean Up blocks.ts

Keep only utilities needed by components:

```typescript
// KEEP these exports (used by components):
export { escapeHtml, formatMarkdown, buildToolResultMap };
export function getToolIcon(toolName: string): string { ... }

// Keep the toolIcons object
const toolIcons = { ... };

// DELETE these functions (now in ToolBlock component):
function renderContentBlocks(...): string { ... }
function renderTextBlock(...): string { ... }
function renderToolUseBlock(...): string { ... }
function renderGenericToolBlock(...): string { ... }
function renderAskUserQuestion(...): string { ... }
function renderTodoWrite(...): string { ... }
function renderTaskBlock(...): string { ... }
function renderThinkingBlock(...): string { ... }
function renderImageBlock(...): string { ... }
function renderFileBlock(...): string { ... }
function renderToolInput(...): string { ... }
function renderToolResult(...): string { ... }
function renderCommandBlock(...): string { ... }

// Keep utility functions used by formatMarkdown:
function stripLineNumbersFromCode(...): string { ... }
function stripSystemTags(...): string { ... }
function parsePipedRow(...): string[] { ... }
function parseSeparatorRow(...): string[] { ... }
```

## Step 4: Remove Unused Imports

Update imports in all modified files:

```typescript
// index.ts - remove these imports:
import { FileDiff, getSingularPatch, File } from "@pierre/diffs";
import type { SupportedLanguages, DiffLineAnnotation } from "@pierre/diffs";
import { renderSessionList, renderSessionDetail, renderSingleMessage, ... } from "./views";
import { formatMarkdown } from "./blocks";

// These are now imported by components instead
```

## Step 5: Verify No Orphaned Code

Run a search for:
1. References to deleted functions
2. Unused imports
3. Dead code paths

```bash
# Check for any remaining references
grep -r "diffInstances" src/client/
grep -r "fileInstances" src/client/
grep -r "pendingToolCalls" src/client/
grep -r "lastRenderedRole" src/client/
grep -r "renderSingleMessage" src/client/
grep -r "initializeDiffs" src/client/
```

## Final File Structure

After cleanup:

```
src/client/
├── jsx-runtime.ts            # JSX factory (~60 lines)
├── component.ts              # Base Component class (~100 lines)
├── components/
│   ├── DiffBlock.tsx         # Diff visualization
│   ├── DiffPanel.tsx         # Container for DiffBlocks
│   ├── MessageBlock.tsx      # Single message
│   ├── MessageList.tsx       # Message container + live updates
│   ├── TextBlock.tsx         # Markdown text rendering
│   ├── ToolBlock.tsx         # Tool use/result rendering
│   ├── ThinkingBlock.tsx     # Collapsible thinking
│   ├── SessionDetailPage.tsx # Page-level component
│   └── SessionListPage.tsx   # Home page component
├── blocks.ts                 # Utilities (formatMarkdown, escapeHtml, etc.)
├── views.ts                  # Minimal utilities (renderNotFound, renderComponentsShowcase)
├── index.ts                  # Router setup only (~100 lines)
├── router.ts                 # Client-side routing with component lifecycle
└── liveSession.ts            # WebSocket manager (unchanged)
```

## Line Count Comparison

| File | Before | After | Reduction |
|------|--------|-------|-----------|
| index.ts | ~1,143 | ~100 | 91% |
| blocks.ts | ~817 | ~200 | 75% |
| views.ts | ~500 | ~50 | 90% |
| **New components** | 0 | ~1,000 | - |
| **Total** | ~2,460 | ~1,350 | 45% |

The total line count decreases because:
1. No duplication between string templates and component render
2. No manual cleanup code (handled by component lifecycle)
3. No document-level event handler registration
4. Type inference reduces explicit type annotations

## Verification Checklist

- [ ] All routes work correctly
- [ ] Live session updates work
- [ ] Diff rendering with annotations works
- [ ] Message copy/paste works
- [ ] Tool blocks expand/collapse
- [ ] Search filtering works
- [ ] Share button works
- [ ] No console errors
- [ ] No TypeScript errors
- [ ] Memory usage stable across navigations

## Benefits Summary

1. **Automatic cleanup**: Component lifecycle handles resource management
2. **Encapsulated state**: No module-level pollution
3. **Scoped events**: Handlers attached to component elements
4. **Type safety**: JSX provides compile-time checking
5. **Testability**: Components can be tested in isolation
6. **Maintainability**: Clear ownership of functionality
7. **Future React migration**: JSX syntax already in place
