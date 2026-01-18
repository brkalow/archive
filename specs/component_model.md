# Component Model Spec

> **ABANDONED**: This spec was superseded by migrating directly to React instead of building a custom component model. The React migration is complete. This document is preserved for historical reference only.

A lightweight vanilla JS component abstraction with JSX for the openctl client.

## Motivation

The current client (~3,500 lines) uses string-based HTML templating with manual DOM and state management. Pain points:

| Problem | Current State | Impact |
|---------|---------------|--------|
| Event listeners | Document-level, never cleaned up | Memory leaks, handler accumulation |
| State | Scattered module-level variables | Race conditions, sync issues |
| Cleanup | Manual arrays (`diffInstances`, `fileInstances`) | Easy to forget, no guarantees |
| Re-rendering | Full HTML replacement | Expensive, loses DOM state |

## Design Principles

- **Incremental adoption**: Works alongside existing code; migrate one component at a time
- **Minimal abstraction**: ~200 lines total (component + JSX runtime), no virtual DOM
- **JSX from day 1**: Type-safe templates, easier React migration later
- **TypeScript-first**: Full type safety for props, state, events

## JSX Runtime

A minimal JSX runtime that creates real DOM elements (not a virtual DOM).

```typescript
// src/client/jsx-runtime.ts

export type JSXChild = HTMLElement | string | number | boolean | null | undefined | JSXChild[];

export function jsx(
  tag: string | ((props: Record<string, unknown>) => HTMLElement),
  props: Record<string, unknown> | null,
  ...children: JSXChild[]
): HTMLElement {
  // Function components
  if (typeof tag === "function") {
    return tag({ ...props, children });
  }

  const el = document.createElement(tag);

  // Set attributes and event handlers
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (key === "className") {
        el.className = value as string;
      } else if (key === "htmlFor") {
        el.setAttribute("for", value as string);
      } else if (key === "dangerouslySetInnerHTML" && value) {
        el.innerHTML = (value as { __html: string }).__html;
      } else if (key.startsWith("on") && typeof value === "function") {
        const event = key.slice(2).toLowerCase();
        el.addEventListener(event, value as EventListener);
      } else if (key === "ref" && typeof value === "function") {
        value(el);
      } else if (value != null && value !== false) {
        el.setAttribute(key, String(value));
      }
    }
  }

  // Append children
  appendChildren(el, children);
  return el;
}

function appendChildren(el: HTMLElement, children: JSXChild[]): void {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    if (child instanceof Node) {
      el.appendChild(child);
    } else {
      el.appendChild(document.createTextNode(String(child)));
    }
  }
}

export { jsx as jsxs, jsx as jsxDEV };
export const Fragment = ({ children }: { children: JSXChild[] }) => {
  const frag = document.createDocumentFragment();
  appendChildren(frag as unknown as HTMLElement, children);
  return frag;
};
```

## TypeScript/Bun Configuration

```jsonc
// tsconfig.json additions
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "./src/client"
  }
}
```

This tells TypeScript to auto-import `jsx` from `src/client/jsx-runtime` for all `.tsx` files.

## Component Base Class

```typescript
// src/client/component.ts

export abstract class Component<Props = {}, State = {}> {
  protected el: HTMLElement | null = null;
  protected props: Props;
  protected state: State;

  private children: Component[] = [];

  constructor(props: Props, initialState?: State) {
    this.props = props;
    this.state = initialState ?? {} as State;
  }

  // --- Lifecycle (override in subclasses) ---

  /** Return a DOM element. Called on mount and update. */
  abstract render(): HTMLElement;

  /** Called after DOM insertion. */
  protected onMount?(): void;

  /** Called before removal. Cleanup external resources here. */
  protected onUnmount?(): void;

  /** Called after props/state change and re-render. */
  protected onUpdate?(prevProps: Props, prevState: State): void;

  // --- Core API ---

  /** Insert rendered element into container. */
  mount(container: HTMLElement, position: "append" | "prepend" | "replace" = "append"): void {
    this.el = this.render();
    if (position === "replace") {
      container.replaceChildren(this.el);
    } else if (position === "prepend") {
      container.prepend(this.el);
    } else {
      container.append(this.el);
    }
    this.onMount?.();
  }

  /** Cleanup and remove from DOM. */
  unmount(): void {
    this.children.forEach(c => c.unmount());
    this.children = [];
    this.onUnmount?.();
    this.el?.remove();
    this.el = null;
  }

  /** Update props and re-render in place. */
  update(newProps: Partial<Props>): void {
    const prevProps = { ...this.props };
    const prevState = { ...this.state };
    this.props = { ...this.props, ...newProps };
    this.rerender();
    this.onUpdate?.(prevProps, prevState);
  }

  /** Update state and re-render in place. */
  setState(partial: Partial<State>): void {
    const prevProps = { ...this.props };
    const prevState = { ...this.state };
    this.state = { ...this.state, ...partial };
    this.rerender();
    this.onUpdate?.(prevProps, prevState);
  }

  private rerender(): void {
    if (!this.el?.parentElement) return;

    // Cleanup children
    this.children.forEach(c => c.unmount());
    this.children = [];

    // Replace element in place
    const newEl = this.render();
    this.el.replaceWith(newEl);
    this.el = newEl;
    this.onMount?.();
  }

  // --- Scoped Utilities ---

  protected $(selector: string): HTMLElement | null {
    return this.el?.querySelector(selector) ?? null;
  }

  protected $$(selector: string): HTMLElement[] {
    return Array.from(this.el?.querySelectorAll(selector) ?? []);
  }

  /** Mount a child component into a container within this component. */
  protected addChild<C extends Component>(
    child: C,
    container: HTMLElement | string,
    position: "append" | "prepend" | "replace" = "append"
  ): C {
    const target = typeof container === "string" ? this.$(container) : container;
    if (target) {
      child.mount(target, position);
      this.children.push(child);
    }
    return child;
  }
}
```

## Example Components

### DiffBlock (highest cleanup complexity)

```tsx
// src/client/components/DiffBlock.tsx

import { Component } from "../component";
import { FileDiff, getSingularPatch } from "@pierre/diffs";

interface DiffBlockProps {
  filename: string;
  diffContent: string;
  additions: number;
  deletions: number;
  initiallyExpanded?: boolean;
}

interface DiffBlockState {
  expanded: boolean;
  rendered: boolean;
}

export class DiffBlock extends Component<DiffBlockProps, DiffBlockState> {
  private diffInstance: FileDiff | null = null;
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
      <div className="diff-block border border-bg-elevated rounded-lg">
        <button
          className="diff-header w-full flex items-center justify-between p-3 hover:bg-bg-tertiary"
          onClick={() => this.toggle()}
        >
          <span className="font-mono text-sm">{filename}</span>
          <span className="text-xs">
            <span className="text-diff-add">+{additions}</span>
            <span className="text-diff-del ml-2">-{deletions}</span>
          </span>
        </button>
        <div className={`diff-content ${expanded ? "" : "hidden"}`}>
          <div className="diff-container" ref={(el) => (this.diffContainerRef = el)} />
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
    this.diffInstance?.cleanUp();
    this.diffInstance = null;
  }

  private toggle(): void {
    const expanded = !this.state.expanded;

    // Lazy render on first expand
    if (expanded && !this.state.rendered) {
      this.renderDiff();
    }

    this.setState({ expanded });
  }

  private renderDiff(): void {
    if (!this.diffContainerRef) return;

    const fileDiff = getSingularPatch(this.props.diffContent);

    this.diffInstance = new FileDiff({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: "dark",
      diffStyle: "unified",
      disableFileHeader: true,
    });

    const diffContainer = document.createElement("diffs-container");
    this.diffContainerRef.appendChild(diffContainer);

    this.diffInstance.render({
      fileDiff,
      fileContainer: diffContainer,
    });

    this.state.rendered = true;
  }
}
```

### MessageBlock

```tsx
// src/client/components/MessageBlock.tsx

import { Component } from "../component";
import { renderContentBlocks } from "../blocks";

interface MessageBlockProps {
  message: Message;
  toolResults: ToolResultMap;
  showRoleBadge: boolean;
}

interface MessageBlockState {
  copied: boolean;
}

export class MessageBlock extends Component<MessageBlockProps, MessageBlockState> {
  private contentRef: HTMLElement | null = null;

  constructor(props: MessageBlockProps) {
    super(props, { copied: false });
  }

  render(): HTMLElement {
    const { message, toolResults, showRoleBadge } = this.props;
    const { copied } = this.state;
    const isAssistant = message.role === "assistant";

    return (
      <div className={`message group ${isAssistant ? "bg-bg-secondary" : ""} rounded-lg p-4`}>
        {showRoleBadge && (
          <div className="text-xs text-text-muted mb-2">
            {isAssistant ? "Assistant" : "User"}
          </div>
        )}
        <div
          className="message-content"
          ref={(el) => (this.contentRef = el)}
          // Note: renderContentBlocks still returns string, injected via innerHTML
          // This is a migration bridge - eventually convert to JSX components
          dangerouslySetInnerHTML={{ __html: renderContentBlocks(message.content_blocks ?? [], toolResults) }}
        />
        <button
          className={`copy-btn opacity-0 group-hover:opacity-100 ${copied ? "text-diff-add" : ""}`}
          onClick={() => this.handleCopy()}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    );
  }

  private async handleCopy(): Promise<void> {
    const content = this.contentRef?.textContent?.trim() ?? "";
    await window.copyToClipboard(content);
    this.setState({ copied: true });
    setTimeout(() => this.setState({ copied: false }), 1000);
  }
}
```

## File Structure

```
src/client/
├── jsx-runtime.ts            # Custom JSX runtime (~60 lines)
├── component.ts              # Base Component class (~100 lines)
├── components/
│   ├── DiffBlock.tsx         # Diff visualization
│   ├── DiffPanel.tsx         # Container for DiffBlocks
│   ├── MessageBlock.tsx      # Single message
│   ├── MessageList.tsx       # Message container + live updates
│   ├── ToolBlock.tsx         # Tool use/result rendering
│   └── SessionDetail.tsx     # Page-level component
├── blocks.ts                 # Keep existing (migrate to .tsx later)
├── views.ts                  # Keep existing (migrate to .tsx later)
├── index.ts                  # Router + page mounting
└── liveSession.ts            # Keep as-is, used by MessageList
```

## Migration Strategy

### Phase 1: Foundation
1. Create `Component` base class
2. Create `DiffBlock` component (validates cleanup pattern)
3. Integrate into existing `initializeDiffs()` flow

### Phase 2: Core Components
1. `MessageBlock` — replaces `renderMessageBlock()`
2. `ToolBlock` — replaces tool rendering with proper lifecycle
3. `MessageList` — manages collection + live updates

### Phase 3: Page Components
1. `SessionDetail` — page-level component
2. Update router to mount/unmount pages
3. Remove document-level event listeners

### Phase 4: Cleanup
1. Remove `diffInstances`, `fileInstances` arrays from index.ts
2. Remove module-level state (`pendingToolCalls`, etc.)
3. Consolidate into component state

## React Migration Path

Using JSX from day 1 means a future React migration is mostly mechanical:

| This spec | React equivalent |
|-----------|------------------|
| `class X extends Component` | `class X extends React.Component` |
| `render(): HTMLElement` | `render(): JSX.Element` |
| `onMount()` | `componentDidMount()` |
| `onUnmount()` | `componentWillUnmount()` |
| `onUpdate(prev)` | `componentDidUpdate(prev)` |
| `this.setState()` | `this.setState()` |
| `ref={(el) => ...}` | `ref={(el) => ...}` |

**What changes:**
1. Import React instead of custom runtime
2. `render()` returns JSX (already does)
3. Rename lifecycle methods
4. Remove `mount()`/`unmount()` calls (React manages this)

**What stays the same:**
- All JSX templates
- Props and state patterns
- Event handlers (`onClick`, etc.)
- Refs pattern
