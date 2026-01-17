# Implementation Plan: DiffBlock Component

Migrate diff rendering to the component system, validating cleanup patterns.

**Spec reference:** `specs/component_model.md` - Example Components (DiffBlock)

**Depends on:** `plans/component_model_01_foundation.md`

## Overview

DiffBlock is the ideal first component to migrate because:
1. It has the most complex cleanup requirements (FileDiff instances)
2. It demonstrates lazy rendering patterns
3. It validates the component lifecycle approach

## Current State

In `src/client/index.ts`:
- `diffInstances: FileDiff[]` - manual array tracking (line 349)
- `fileInstances: File[]` - manual array tracking (line 352)
- `renderedDiffs: Set<string>` - tracks which diffs are rendered (line 355)
- `renderDiffContent()` - creates FileDiff instances, pushes to array
- `initializeDiffs()` - cleans up old instances, sets up new ones
- Cleanup happens at route change, easy to forget

## Files to Create

| File | Purpose |
|------|---------|
| `src/client/components/DiffBlock.tsx` | Single diff file component |

## Files to Modify

| File | Changes |
|------|---------|
| `src/client/index.ts` | Use DiffBlock instead of manual rendering |
| `src/client/views.ts` | Update `renderDiffPanel` to output mounting targets |

## Step 1: Create DiffBlock Component

**File: `src/client/components/DiffBlock.tsx`**

```tsx
import { Component } from "../component";
import { FileDiff, getSingularPatch } from "@pierre/diffs";
import type { DiffLineAnnotation } from "@pierre/diffs";
import type { Annotation, AnnotationType } from "../../db/schema";

// Annotation metadata for rendering
interface AnnotationMetadata {
  id: number;
  type: AnnotationType;
  content: string;
  model: string | null;
  filename: string;
  lineNumber: number;
}

interface DiffBlockProps {
  diffId: number;
  filename: string;
  diffContent: string;
  additions: number;
  deletions: number;
  annotations: Annotation[];
  reviewModel: string | null;
  initiallyExpanded?: boolean;
}

interface DiffBlockState {
  expanded: boolean;
  rendered: boolean;
}

// Annotation type config
const annotationConfig: Record<AnnotationType, { label: string; badgeClass: string }> = {
  suggestion: { label: "suggestion", badgeClass: "bg-accent-primary/20 text-accent-primary" },
  issue: { label: "issue", badgeClass: "bg-diff-del/20 text-diff-del" },
  praise: { label: "good", badgeClass: "bg-diff-add/20 text-diff-add" },
  question: { label: "question", badgeClass: "bg-accent-secondary/20 text-accent-secondary" },
};

export class DiffBlock extends Component<DiffBlockProps, DiffBlockState> {
  private diffInstance: FileDiff<AnnotationMetadata> | null = null;
  private diffContainerRef: HTMLElement | null = null;

  constructor(props: DiffBlockProps) {
    super(props, {
      expanded: props.initiallyExpanded ?? false,
      rendered: false,
    });
  }

  render(): HTMLElement {
    const { filename, additions, deletions } = this.props;
    const { expanded } = this.state;

    return (
      <div
        className="diff-block border-b border-bg-elevated last:border-b-0"
        data-filename={filename}
      >
        <button
          className="diff-header w-full flex items-center justify-between px-3 py-2 bg-bg-tertiary hover:bg-bg-elevated transition-colors text-left"
          onClick={() => this.toggle()}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="toggle-icon text-text-muted text-xs">
              {expanded ? "▼" : "▶"}
            </span>
            <span className="text-[13px] font-mono text-text-primary truncate">
              {filename}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono shrink-0">
            {deletions > 0 && <span className="text-diff-del">-{deletions}</span>}
            {additions > 0 && <span className="text-diff-add">+{additions}</span>}
            <span className="collapse-label text-text-muted ml-2">
              {expanded ? "Hide" : "Show"}
            </span>
          </div>
        </button>
        <div className={`diff-content ${expanded ? "" : "hidden"}`}>
          <div
            className="diff-container"
            ref={(el) => (this.diffContainerRef = el)}
          />
        </div>
      </div>
    );
  }

  protected onMount(): void {
    if (this.state.expanded && !this.state.rendered) {
      this.renderDiff();
    }
  }

  protected onUnmount(): void {
    // Clean up FileDiff instance - this is the key improvement!
    this.diffInstance?.cleanUp();
    this.diffInstance = null;
    this.diffContainerRef = null;
  }

  private toggle(): void {
    const expanded = !this.state.expanded;

    // Lazy render on first expand
    if (expanded && !this.state.rendered) {
      this.setState({ expanded, rendered: true });
      // Need to wait for render, then call renderDiff
      requestAnimationFrame(() => this.renderDiff());
    } else {
      this.setState({ expanded });
    }
  }

  private renderDiff(): void {
    if (!this.diffContainerRef) return;

    const { diffContent, filename, annotations, reviewModel } = this.props;

    try {
      const fileDiff = getSingularPatch(diffContent);

      // Convert annotations to @pierre/diffs format
      const lineAnnotations: DiffLineAnnotation<AnnotationMetadata>[] = annotations.map((a) => ({
        side: a.side as "additions" | "deletions",
        lineNumber: a.line_number,
        metadata: {
          id: a.id,
          type: a.annotation_type,
          content: a.content,
          model: reviewModel,
          filename,
          lineNumber: a.line_number,
        },
      }));

      this.diffInstance = new FileDiff<AnnotationMetadata>({
        theme: { dark: "pierre-dark", light: "pierre-light" },
        themeType: "dark",
        diffStyle: "unified",
        diffIndicators: "classic",
        disableFileHeader: true,
        overflow: "scroll",
        renderAnnotation: (annotation) => this.createAnnotationElement(annotation.metadata),
      });

      const diffContainer = document.createElement("diffs-container");
      this.diffContainerRef.innerHTML = "";
      this.diffContainerRef.appendChild(diffContainer);

      this.diffInstance.render({
        fileDiff,
        fileContainer: diffContainer,
        lineAnnotations,
      });
    } catch (err) {
      console.error("Failed to render diff:", err);
      this.renderFallback();
    }
  }

  private renderFallback(): void {
    if (!this.diffContainerRef) return;

    const { diffContent } = this.props;
    this.diffContainerRef.innerHTML = `
      <div class="p-4">
        <div class="flex items-center gap-2 text-text-muted mb-2">
          <span>⚠️</span>
          <span>Unable to render diff</span>
        </div>
        <button class="text-accent-primary text-sm hover:underline show-raw-btn">
          Show raw diff
        </button>
        <pre class="hidden raw-diff mt-2 text-xs font-mono whitespace-pre-wrap bg-bg-primary p-2 rounded overflow-x-auto max-h-96 overflow-y-auto">${this.escapeHtml(diffContent)}</pre>
      </div>
    `;

    // Attach toggle handler
    const showBtn = this.diffContainerRef.querySelector(".show-raw-btn");
    showBtn?.addEventListener("click", () => {
      const raw = this.diffContainerRef?.querySelector(".raw-diff");
      if (raw) {
        raw.classList.toggle("hidden");
        showBtn.textContent = raw.classList.contains("hidden") ? "Show raw diff" : "Hide raw diff";
      }
    });
  }

  private createAnnotationElement(metadata: AnnotationMetadata): HTMLElement {
    const config = annotationConfig[metadata.type] || annotationConfig.suggestion;
    const locationText = `${metadata.filename}:${metadata.lineNumber}`;
    const copyText = `${locationText}\n\n${metadata.content}`;

    const wrapper = document.createElement("div");
    wrapper.className = "bg-bg-tertiary border border-bg-elevated rounded-lg p-4 my-3 mx-4";

    wrapper.innerHTML = `
      <div class="flex items-center gap-3 mb-3">
        <div class="w-8 h-8 rounded-full bg-gradient-to-br from-accent-secondary to-accent-primary flex items-center justify-center text-white text-sm font-semibold shrink-0">C</div>
        <span class="font-semibold text-text-primary">Claude</span>
        <span class="text-xs text-text-muted font-mono">${this.escapeHtml(locationText)}</span>
        <div class="ml-auto flex items-center gap-2">
          <span class="px-2 py-0.5 rounded text-xs font-medium ${config.badgeClass}">${config.label}</span>
          <button class="flex items-center gap-1.5 px-2 py-1 text-xs text-text-muted hover:text-text-primary hover:bg-bg-elevated rounded transition-colors copy-btn">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            copy prompt
          </button>
        </div>
      </div>
      <p class="text-[15px] text-text-primary leading-relaxed font-sans">${this.escapeHtml(metadata.content)}</p>
    `;

    // Add copy handler
    const copyBtn = wrapper.querySelector(".copy-btn") as HTMLButtonElement | null;
    copyBtn?.addEventListener("click", async () => {
      const originalHtml = copyBtn.innerHTML;
      await window.copyToClipboard(copyText);
      copyBtn.innerHTML = `
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        copied!
      `;
      setTimeout(() => {
        copyBtn.innerHTML = originalHtml;
      }, 1500);
    });

    return wrapper;
  }

  private escapeHtml(str: string): string {
    const htmlEscapes: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return str.replace(/[&<>"']/g, (char) => htmlEscapes[char] || char);
  }
}
```

## Step 2: Create DiffPanel Container Component

**File: `src/client/components/DiffPanel.tsx`**

```tsx
import { Component } from "../component";
import { DiffBlock } from "./DiffBlock";
import type { Diff, Annotation, Review } from "../../db/schema";

interface DiffPanelProps {
  diffs: Diff[];
  annotationsByDiff: Record<number, Annotation[]>;
  review: Review | null;
}

export class DiffPanel extends Component<DiffPanelProps> {
  private diffBlocks: DiffBlock[] = [];
  private otherExpanded = false;

  render(): HTMLElement {
    const { diffs } = this.props;

    // Separate by relevance
    const sessionDiffs = diffs.filter((d) => d.is_session_relevant);
    const otherDiffs = diffs.filter((d) => !d.is_session_relevant);
    const totalCount = diffs.length;

    return (
      <div className="flex flex-col bg-bg-secondary border border-bg-elevated rounded-lg overflow-hidden h-full">
        <div className="flex items-center justify-between px-3 py-2 bg-bg-tertiary border-b border-bg-elevated shrink-0">
          <h2 className="text-sm font-medium text-text-primary">Code Changes</h2>
          <span className="text-xs text-text-muted">
            {totalCount} file{totalCount !== 1 ? "s" : ""}
          </span>
        </div>
        <div id="diffs-container" className="flex-1 overflow-y-auto">
          {sessionDiffs.length > 0 && (
            <div className="diff-group">
              <div className="px-3 py-2 text-xs font-medium text-text-secondary bg-bg-tertiary/50 border-b border-bg-elevated sticky top-0 z-10">
                Changed in this session ({sessionDiffs.length})
              </div>
              <div className="session-diffs" />
            </div>
          )}

          {otherDiffs.length > 0 && (
            <div className="diff-group">
              <button
                className="w-full px-3 py-2 text-xs font-medium text-text-muted bg-bg-tertiary/50 border-b border-bg-elevated flex items-center gap-2 hover:bg-bg-elevated transition-colors"
                onClick={() => this.toggleOther()}
              >
                <span className="toggle-icon">{this.otherExpanded ? "▼" : "▶"}</span>
                <span>Other branch changes ({otherDiffs.length})</span>
                <span className="text-text-muted/60 ml-auto">
                  {this.summarizeFiles(otherDiffs)}
                </span>
              </button>
              <div className={`other-diffs ${this.otherExpanded ? "" : "hidden"}`} />
            </div>
          )}

          {totalCount === 0 && (
            <div className="flex items-center justify-center h-full text-text-muted text-sm">
              No code changes
            </div>
          )}
        </div>
      </div>
    );
  }

  protected onMount(): void {
    this.mountDiffBlocks();
  }

  protected onUnmount(): void {
    // DiffBlocks are tracked as children, will be auto-cleaned
    this.diffBlocks = [];
  }

  private mountDiffBlocks(): void {
    const { diffs, annotationsByDiff, review } = this.props;

    const sessionDiffs = diffs.filter((d) => d.is_session_relevant);
    const otherDiffs = diffs.filter((d) => !d.is_session_relevant);

    // Mount session diffs (expanded for small diffs)
    const sessionContainer = this.$(".session-diffs");
    if (sessionContainer) {
      for (const diff of sessionDiffs) {
        const isLarge = (diff.additions || 0) + (diff.deletions || 0) > 300;
        const block = this.createDiffBlock(diff, !isLarge);
        this.addChild(block, sessionContainer);
        this.diffBlocks.push(block);
      }
    }

    // Mount other diffs (always collapsed initially)
    const otherContainer = this.$(".other-diffs");
    if (otherContainer) {
      for (const diff of otherDiffs) {
        const block = this.createDiffBlock(diff, false);
        this.addChild(block, otherContainer);
        this.diffBlocks.push(block);
      }
    }
  }

  private createDiffBlock(diff: Diff, expanded: boolean): DiffBlock {
    const { annotationsByDiff, review } = this.props;

    return new DiffBlock({
      diffId: diff.id,
      filename: diff.filename || "Unknown file",
      diffContent: diff.diff_content,
      additions: diff.additions || 0,
      deletions: diff.deletions || 0,
      annotations: annotationsByDiff[diff.id] || [],
      reviewModel: review?.model || null,
      initiallyExpanded: expanded,
    });
  }

  private toggleOther(): void {
    this.otherExpanded = !this.otherExpanded;
    const container = this.$(".other-diffs");
    const icon = this.$(".toggle-icon");

    if (container) {
      container.classList.toggle("hidden", !this.otherExpanded);
    }
    if (icon) {
      icon.textContent = this.otherExpanded ? "▼" : "▶";
    }
  }

  private summarizeFiles(diffs: Diff[]): string {
    const names = diffs
      .map((d) => d.filename?.split("/").pop() || "unknown")
      .slice(0, 3);

    if (diffs.length > 3) {
      return names.join(", ") + "...";
    }
    return names.join(", ");
  }
}
```

## Step 3: Integrate with Existing Code

**File: `src/client/index.ts`**

Replace diff initialization with component-based approach:

```typescript
import { DiffPanel } from "./components/DiffPanel";

// Remove these lines:
// const diffInstances: FileDiff<AnnotationMetadata>[] = [];
// const fileInstances: File[] = [];
// const renderedDiffs = new Set<string>();

// Add component tracking
let diffPanelComponent: DiffPanel | null = null;

// Update initializeDiffs function:
async function initializeDiffs(sessionId: string) {
  // Clean up previous component (handles all FileDiff cleanup automatically!)
  if (diffPanelComponent) {
    diffPanelComponent.unmount();
    diffPanelComponent = null;
  }

  // Fetch annotations
  const annotationsData = await fetchAnnotations(sessionId);

  // Get the container
  const container = document.querySelector("[data-diff-panel]") as HTMLElement;
  if (!container) return;

  // Get diffs from container's data or fetch fresh
  const diffsContainer = document.getElementById("diffs-container");
  // ... get diffs data ...

  // Create and mount the component
  diffPanelComponent = new DiffPanel({
    diffs,
    annotationsByDiff: annotationsData?.annotations_by_diff || {},
    review: annotationsData?.review || null,
  });

  diffPanelComponent.mount(container, "replace");
}
```

## Step 4: Update Route Handler Cleanup

```typescript
router.on("/sessions/:id", async (params) => {
  // Clean up previous components
  if (diffPanelComponent) {
    diffPanelComponent.unmount();
    diffPanelComponent = null;
  }
  if (liveSessionManager) {
    liveSessionManager.destroy();
    liveSessionManager = null;
  }

  // ... rest of handler ...
});
```

## Verification

1. **Cleanup test**: Navigate between sessions, check that FileDiff instances are properly cleaned up:
   ```javascript
   // Before: diffInstances array would grow
   // After: Each DiffBlock.onUnmount() calls diffInstance.cleanUp()
   ```

2. **Lazy rendering test**: Large diffs should only render when expanded
   - Check network/console for @pierre/diffs parsing on expand

3. **Memory test**: Use DevTools Memory tab
   - Take heap snapshot
   - Navigate between sessions multiple times
   - Take another snapshot
   - Compare - should not see growing number of FileDiff instances

4. **Annotation rendering**: Verify annotations still display correctly on diffs

## Benefits Over Current Approach

| Before | After |
|--------|-------|
| Manual `diffInstances` array | Automatic cleanup via `onUnmount` |
| Easy to forget cleanup | Guaranteed by component lifecycle |
| Global state pollution | Encapsulated in component |
| Document-level event listeners | Scoped to component |

## Notes

- DiffBlock uses `requestAnimationFrame` to wait for DOM before rendering diff
- Annotations are passed as props, not fetched inside component
- The `window.copyToClipboard` global is still used (can be refactored later)
