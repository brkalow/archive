# Implementation Plan: Component Model Foundation

Set up the JSX runtime, Component base class, and TypeScript configuration.

**Spec reference:** `specs/component_model.md` - JSX Runtime, Component Base Class, TypeScript Configuration

**Depends on:** None

## Overview

This plan establishes the foundation for the component system:
1. Custom JSX runtime that creates real DOM elements
2. Base Component class with lifecycle methods
3. TypeScript configuration for JSX auto-imports

## Files to Create

| File | Purpose |
|------|---------|
| `src/client/jsx-runtime.ts` | Custom JSX factory (~60 lines) |
| `src/client/component.ts` | Base Component class (~100 lines) |

## Files to Modify

| File | Changes |
|------|---------|
| `tsconfig.json` | Add `jsxImportSource` for auto-imports |

## Step 1: Create JSX Runtime

**File: `src/client/jsx-runtime.ts`**

```typescript
// Custom JSX runtime that creates real DOM elements (no virtual DOM)

export type JSXChild = HTMLElement | DocumentFragment | string | number | boolean | null | undefined | JSXChild[];

export function jsx(
  tag: string | ((props: Record<string, unknown>) => HTMLElement | DocumentFragment),
  props: Record<string, unknown> | null,
  ...children: JSXChild[]
): HTMLElement | DocumentFragment {
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
      } else if (key === "style" && typeof value === "object" && value !== null) {
        Object.assign(el.style, value);
      } else if (value != null && value !== false) {
        el.setAttribute(key, String(value));
      }
    }
  }

  // Append children
  appendChildren(el, children);
  return el;
}

function appendChildren(el: HTMLElement | DocumentFragment, children: JSXChild[]): void {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    if (child instanceof Node) {
      el.appendChild(child);
    } else {
      el.appendChild(document.createTextNode(String(child)));
    }
  }
}

// Export aliases for different JSX modes
export { jsx as jsxs, jsx as jsxDEV };

// Fragment component for grouping without wrapper element
export const Fragment = ({ children }: { children?: JSXChild[] }): DocumentFragment => {
  const frag = document.createDocumentFragment();
  if (children) {
    appendChildren(frag, children);
  }
  return frag;
};
```

## Step 2: Create Component Base Class

**File: `src/client/component.ts`**

```typescript
// Base class for all UI components with lifecycle management

export abstract class Component<Props = {}, State = {}> {
  protected el: HTMLElement | null = null;
  protected props: Props;
  protected state: State;

  private children: Component[] = [];

  constructor(props: Props, initialState?: State) {
    this.props = props;
    this.state = initialState ?? ({} as State);
  }

  // --- Lifecycle (override in subclasses) ---

  /** Return a DOM element. Called on mount and update. */
  abstract render(): HTMLElement;

  /** Called after DOM insertion. Set up external resources here. */
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
    // Unmount children first
    this.children.forEach((c) => c.unmount());
    this.children = [];
    // Call cleanup hook
    this.onUnmount?.();
    // Remove from DOM
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

  /** Get the component's root element (if mounted). */
  getElement(): HTMLElement | null {
    return this.el;
  }

  private rerender(): void {
    if (!this.el?.parentElement) return;

    // Cleanup children before re-render
    this.children.forEach((c) => c.unmount());
    this.children = [];

    // Replace element in place
    const newEl = this.render();
    this.el.replaceWith(newEl);
    this.el = newEl;
    this.onMount?.();
  }

  // --- Scoped Utilities ---

  /** Query within component's DOM tree. */
  protected $(selector: string): HTMLElement | null {
    return this.el?.querySelector(selector) ?? null;
  }

  /** Query all within component's DOM tree. */
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

  /** Remove a specific child component. */
  protected removeChild(child: Component): void {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      child.unmount();
      this.children.splice(index, 1);
    }
  }

  /** Get all child components. */
  protected getChildren(): readonly Component[] {
    return this.children;
  }
}
```

## Step 3: Update TypeScript Configuration

**File: `tsconfig.json`**

Add `jsxImportSource` to enable auto-imports:

```jsonc
{
  "compilerOptions": {
    // ... existing options ...
    "jsx": "react-jsx",
    "jsxImportSource": "./src/client"  // ADD THIS LINE
  }
}
```

This tells TypeScript to auto-import `jsx` from `src/client/jsx-runtime` for all `.tsx` files.

## Step 4: Add JSX Type Declarations

**File: `src/client/jsx-runtime.ts`** (append to end)

```typescript
// JSX namespace for TypeScript
declare global {
  namespace JSX {
    type Element = HTMLElement | DocumentFragment;

    interface IntrinsicElements {
      // Allow any HTML element with standard attributes
      [elemName: string]: Record<string, unknown>;
    }

    interface ElementChildrenAttribute {
      children: {};
    }
  }
}
```

## Verification

After implementing:

1. Create a test file `src/client/components/TestComponent.tsx`:

```tsx
import { Component } from "../component";

interface TestProps {
  message: string;
}

export class TestComponent extends Component<TestProps> {
  render(): HTMLElement {
    return (
      <div className="test-component">
        <p>{this.props.message}</p>
        <button onClick={() => console.log("clicked!")}>Click me</button>
      </div>
    );
  }
}
```

2. Verify TypeScript compiles without errors:
```bash
bun run build
```

3. Verify in browser console:
```javascript
import { TestComponent } from './components/TestComponent';
const test = new TestComponent({ message: 'Hello!' });
test.mount(document.body);
// Should see the component rendered
test.unmount();
// Should be removed
```

## Notes

- The JSX runtime creates real DOM elements, not virtual DOM
- Event handlers are attached directly to elements
- Refs work the same as React (callback refs)
- Fragment returns DocumentFragment for grouping without wrappers
- Component children are automatically cleaned up on unmount
