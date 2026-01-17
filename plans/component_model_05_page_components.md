# Implementation Plan: Page Components and Router

Create page-level components and integrate with the router for automatic lifecycle management.

**Spec reference:** `specs/component_model.md` - Migration Phase 3 (Page Components)

**Depends on:** `plans/component_model_04_message_list.md`

## Overview

This plan introduces:
1. `SessionDetailPage` - Page-level component that owns MessageList and DiffPanel
2. `SessionListPage` - Home page component
3. Router integration for automatic mount/unmount on navigation

## Current State

In `src/client/index.ts`:
- Route handlers directly manipulate DOM with `innerHTML`
- Multiple module-level component references (`messageListComponent`, `diffPanelComponent`)
- Manual cleanup in each route handler
- Event handlers attached globally

## Files to Create

| File | Purpose |
|------|---------|
| `src/client/components/SessionDetailPage.tsx` | Session detail page |
| `src/client/components/SessionListPage.tsx` | Session list page |

## Files to Modify

| File | Changes |
|------|---------|
| `src/client/index.ts` | Simplify to just router setup |
| `src/client/router.ts` | Add component lifecycle support |

## Step 1: Create SessionDetailPage Component

**File: `src/client/components/SessionDetailPage.tsx`**

```tsx
import { Component } from "../component";
import { MessageList } from "./MessageList";
import { DiffPanel } from "./DiffPanel";
import type { Session, Message, Diff, Review, Annotation } from "../../db/schema";

interface SessionDetailPageProps {
  session: Session;
  messages: Message[];
  diffs: Diff[];
  shareUrl: string | null;
  review?: Review | null;
  annotationsByDiff: Record<number, Annotation[]>;
}

interface SessionDetailPageState {
  connectionStatus: "connected" | "disconnected" | "reconnecting";
  sessionStatus: "live" | "complete";
  interactiveState: InteractiveState;
}

interface InteractiveState {
  isInteractive: boolean;
  claudeState: string;
  sessionComplete: boolean;
  pendingFeedback: Array<{ id: string; status: string }>;
}

export class SessionDetailPage extends Component<SessionDetailPageProps, SessionDetailPageState> {
  private messageList: MessageList | null = null;
  private diffPanel: DiffPanel | null = null;

  constructor(props: SessionDetailPageProps) {
    super(props, {
      connectionStatus: "disconnected",
      sessionStatus: props.session.status === "live" ? "live" : "complete",
      interactiveState: {
        isInteractive: props.session.interactive ?? false,
        claudeState: "unknown",
        sessionComplete: props.session.status !== "live",
        pendingFeedback: [],
      },
    });
  }

  render(): HTMLElement {
    const { session, diffs, shareUrl } = this.props;
    const { sessionStatus, connectionStatus, interactiveState } = this.state;
    const hasDiffs = diffs.length > 0;

    return (
      <div className="session-detail-page h-full flex flex-col">
        {/* Header */}
        <header className="session-header shrink-0 border-b border-bg-elevated bg-bg-secondary px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <a
                href="/"
                className="text-text-muted hover:text-text-primary transition-colors"
                data-link
              >
                ← Back
              </a>
              <h1 className="text-lg font-semibold text-text-primary truncate">
                {session.title || "Untitled Session"}
              </h1>
              {sessionStatus === "live" && (
                <span className="live-indicator flex items-center gap-1 text-xs text-diff-add">
                  <span className="w-2 h-2 bg-diff-add rounded-full animate-pulse" />
                  Live
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {sessionStatus === "live" && (
                <div id="connection-status">
                  {this.renderConnectionStatus()}
                </div>
              )}
              {shareUrl ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={shareUrl}
                    readOnly
                    className="text-xs bg-bg-tertiary border border-bg-elevated rounded px-2 py-1 w-48"
                    id="share-url"
                  />
                  <button
                    className="text-xs text-accent-primary hover:underline"
                    data-copy-target="share-url"
                    onClick={() => this.copyShareUrl()}
                  >
                    Copy
                  </button>
                </div>
              ) : (
                <button
                  className="text-xs text-accent-primary hover:underline"
                  onClick={() => this.shareSession()}
                >
                  Share
                </button>
              )}
            </div>
          </div>
          {session.summary && (
            <p className="text-sm text-text-secondary mt-2">{session.summary}</p>
          )}
          <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
            <span id="message-count">{this.props.messages.length} messages</span>
            {session.model && <span>{session.model}</span>}
            {session.project_path && (
              <span className="font-mono">{this.getProjectName(session.project_path)}</span>
            )}
          </div>
        </header>

        {/* Content grid */}
        <div
          className={`content-grid flex-1 overflow-hidden ${hasDiffs ? "two-column" : "single-column"}`}
          data-content-grid
        >
          {/* Conversation panel */}
          <div
            className={`conversation-panel h-full overflow-hidden ${hasDiffs ? "" : "full-width"}`}
            data-conversation-panel
          >
            <div id="conversation-list" className="h-full" />

            {/* Feedback input for interactive sessions */}
            {interactiveState.isInteractive && (
              <div id="feedback-input-placeholder" className="shrink-0 border-t border-bg-elevated p-4">
                {this.renderFeedbackInput()}
              </div>
            )}
          </div>

          {/* Diff panel */}
          {hasDiffs && (
            <div
              className="diff-panel h-full overflow-hidden"
              data-diff-panel
            />
          )}
        </div>
      </div>
    );
  }

  protected onMount(): void {
    // Mount MessageList
    const conversationContainer = this.$("#conversation-list");
    if (conversationContainer) {
      this.messageList = new MessageList({
        sessionId: this.props.session.id,
        initialMessages: this.props.messages,
        session: this.props.session,
        isLive: this.props.session.status === "live",
      });

      this.addChild(this.messageList, conversationContainer, "replace");
      this.setupMessageListEvents();
    }

    // Mount DiffPanel
    const diffContainer = this.$("[data-diff-panel]");
    if (diffContainer && this.props.diffs.length > 0) {
      this.diffPanel = new DiffPanel({
        diffs: this.props.diffs,
        annotationsByDiff: this.props.annotationsByDiff,
        review: this.props.review || null,
      });

      this.addChild(this.diffPanel, diffContainer, "replace");
    }

    // Set up copy button handlers
    this.setupCopyHandlers();
  }

  protected onUnmount(): void {
    // Child components (messageList, diffPanel) are automatically cleaned up
    this.messageList = null;
    this.diffPanel = null;
  }

  private setupMessageListEvents(): void {
    const el = this.messageList?.getElement();
    if (!el) return;

    el.addEventListener("session-complete", () => {
      this.setState({
        sessionStatus: "complete",
        interactiveState: { ...this.state.interactiveState, sessionComplete: true },
      });
    });

    el.addEventListener("connection-change", ((e: CustomEvent) => {
      this.setState({
        connectionStatus: e.detail.connected ? "connected" : "disconnected",
      });
    }) as EventListener);

    el.addEventListener("reconnect-attempt", (() => {
      this.setState({ connectionStatus: "reconnecting" });
    }) as EventListener);

    el.addEventListener("diff-update", (async () => {
      await this.refreshDiffs();
    }) as EventListener);

    el.addEventListener("interactive-info", ((e: CustomEvent) => {
      const { interactive, claudeState } = e.detail;
      this.setState({
        interactiveState: {
          ...this.state.interactiveState,
          isInteractive: interactive,
          claudeState,
        },
      });
    }) as EventListener);

    el.addEventListener("claude-state", ((e: CustomEvent) => {
      this.setState({
        interactiveState: {
          ...this.state.interactiveState,
          claudeState: e.detail.state,
        },
      });
    }) as EventListener);

    el.addEventListener("feedback-queued", ((e: CustomEvent) => {
      const { messageId, position } = e.detail;
      this.setState({
        interactiveState: {
          ...this.state.interactiveState,
          pendingFeedback: [
            ...this.state.interactiveState.pendingFeedback,
            { id: messageId, status: "pending" },
          ],
        },
      });
      window.showToast(`Message queued (position: ${position})`, "info");
    }) as EventListener);

    el.addEventListener("feedback-status", ((e: CustomEvent) => {
      const { messageId, status } = e.detail;
      const updated = this.state.interactiveState.pendingFeedback.map((f) =>
        f.id === messageId ? { ...f, status } : f
      );
      this.setState({
        interactiveState: { ...this.state.interactiveState, pendingFeedback: updated },
      });

      if (status === "approved") {
        window.showToast("Message sent to session", "success");
      } else if (status === "rejected" || status === "expired") {
        window.showToast(`Message was ${status}`, "error");
      }

      // Remove after delay
      setTimeout(() => {
        this.setState({
          interactiveState: {
            ...this.state.interactiveState,
            pendingFeedback: this.state.interactiveState.pendingFeedback.filter(
              (f) => f.id !== messageId
            ),
          },
        });
      }, 3000);
    }) as EventListener);
  }

  private renderConnectionStatus(): HTMLElement {
    const { connectionStatus } = this.state;

    if (connectionStatus === "reconnecting") {
      return (
        <span className="flex items-center gap-1 text-xs text-yellow-500">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
          Reconnecting...
        </span>
      );
    }

    return (
      <span className={`flex items-center gap-1 text-xs ${connectionStatus === "connected" ? "text-diff-add" : "text-text-muted"}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${connectionStatus === "connected" ? "bg-diff-add" : "bg-text-muted"}`} />
        {connectionStatus === "connected" ? "Connected" : "Disconnected"}
      </span>
    );
  }

  private renderFeedbackInput(): HTMLElement {
    const { interactiveState } = this.state;

    if (interactiveState.sessionComplete) {
      return (
        <div className="text-center text-text-muted text-sm py-2">
          Session completed
        </div>
      );
    }

    const isWaiting = interactiveState.claudeState === "waiting_for_user";

    return (
      <div className="flex gap-2">
        <textarea
          id="feedback-input"
          className="flex-1 bg-bg-tertiary border border-bg-elevated rounded px-3 py-2 text-sm resize-none"
          placeholder={isWaiting ? "Claude is waiting for your input..." : "Send feedback to Claude..."}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              this.submitFeedback();
            }
          }}
        />
        <button
          id="feedback-submit"
          className="px-4 py-2 bg-accent-primary text-white rounded hover:bg-accent-primary/90 transition-colors"
          onClick={() => this.submitFeedback()}
        >
          Send
        </button>
      </div>
    );
  }

  private submitFeedback(): void {
    const input = this.$("#feedback-input") as HTMLTextAreaElement | null;
    if (!input || !input.value.trim()) return;

    const content = input.value.trim();
    input.value = "";

    const manager = this.messageList?.getLiveSessionManager();
    manager?.sendFeedback(content);
  }

  private async shareSession(): Promise<void> {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(this.props.session.id)}/share`, {
        method: "POST",
      });
      if (res.ok) {
        // Reload page to get share URL
        window.location.reload();
      } else {
        window.showToast("Failed to create share link", "error");
      }
    } catch {
      window.showToast("Failed to create share link", "error");
    }
  }

  private copyShareUrl(): void {
    const input = this.$("#share-url") as HTMLInputElement | null;
    if (input) {
      window.copyToClipboard(input.value);
    }
  }

  private async refreshDiffs(): Promise<void> {
    const res = await fetch(`/api/sessions/${encodeURIComponent(this.props.session.id)}/diffs`);
    if (!res.ok) return;

    const data = await res.json();
    const diffs = data.diffs || [];

    if (diffs.length > 0 && this.diffPanel) {
      // Update existing panel
      this.diffPanel.update({ diffs });
    } else if (diffs.length > 0 && !this.diffPanel) {
      // Create new panel
      const container = this.$("[data-diff-panel]");
      if (container) {
        // Fetch annotations
        const annotationsRes = await fetch(
          `/api/sessions/${encodeURIComponent(this.props.session.id)}/annotations`
        );
        const annotationsData = annotationsRes.ok ? await annotationsRes.json() : null;

        this.diffPanel = new DiffPanel({
          diffs,
          annotationsByDiff: annotationsData?.annotations_by_diff || {},
          review: annotationsData?.review || null,
        });

        this.addChild(this.diffPanel, container, "replace");

        // Update layout
        const grid = this.$("[data-content-grid]");
        grid?.classList.remove("single-column");
        grid?.classList.add("two-column");
      }
    }
  }

  private setupCopyHandlers(): void {
    this.$$("[data-copy-target]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const targetId = (btn as HTMLElement).dataset.copyTarget;
        const target = document.getElementById(targetId!);
        if (target) {
          const text = (target as HTMLInputElement).value || target.textContent?.trim() || "";
          await window.copyToClipboard(text);
          btn.classList.add("text-diff-add");
          setTimeout(() => btn.classList.remove("text-diff-add"), 1000);
        }
      });
    });
  }

  private getProjectName(path: string): string {
    return path.split("/").pop() || path;
  }
}
```

## Step 2: Create SessionListPage Component

**File: `src/client/components/SessionListPage.tsx`**

```tsx
import { Component } from "../component";
import type { Session } from "../../db/schema";

interface SessionListPageProps {
  sessions: Session[];
}

interface SessionListPageState {
  filteredSessions: Session[];
  searchQuery: string;
}

export class SessionListPage extends Component<SessionListPageProps, SessionListPageState> {
  constructor(props: SessionListPageProps) {
    super(props, {
      filteredSessions: props.sessions,
      searchQuery: "",
    });
  }

  render(): HTMLElement {
    const { filteredSessions } = this.state;

    return (
      <div className="session-list-page max-w-4xl mx-auto p-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-text-primary mb-4">Sessions</h1>
          <input
            type="text"
            placeholder="Search sessions..."
            className="w-full px-4 py-2 bg-bg-tertiary border border-bg-elevated rounded-lg text-text-primary placeholder-text-muted"
            id="search-input"
            onInput={(e) => this.handleSearch((e.target as HTMLInputElement).value)}
          />
        </header>

        <div className="sessions-grid space-y-4">
          {filteredSessions.length === 0 ? (
            <div className="text-center py-8 text-text-muted">
              {this.props.sessions.length === 0
                ? "No sessions yet"
                : "No sessions match your search"}
            </div>
          ) : (
            filteredSessions.map((session) => this.renderSessionCard(session))
          )}
        </div>
      </div>
    );
  }

  private renderSessionCard(session: Session): HTMLElement {
    const statusColor = session.status === "live" ? "text-diff-add" : "text-text-muted";
    const date = new Date(session.created_at).toLocaleDateString();

    return (
      <a
        href={`/sessions/${session.id}`}
        className="session-card block p-4 bg-bg-secondary border border-bg-elevated rounded-lg hover:border-accent-primary transition-colors"
        data-link
        data-session-card
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-text-primary truncate" data-title>
              {session.title || "Untitled Session"}
            </h2>
            {session.summary && (
              <p className="text-sm text-text-secondary mt-1 line-clamp-2" data-description>
                {session.summary}
              </p>
            )}
            <div className="flex items-center gap-3 mt-2 text-xs text-text-muted">
              <span className={statusColor}>
                {session.status === "live" ? "● Live" : "Complete"}
              </span>
              <span>{date}</span>
              {session.project_path && (
                <span className="font-mono" data-project>
                  {session.project_path.split("/").pop()}
                </span>
              )}
            </div>
          </div>
          {session.model && (
            <span className="text-xs text-text-muted bg-bg-tertiary px-2 py-1 rounded">
              {session.model}
            </span>
          )}
        </div>
      </a>
    );
  }

  private handleSearch(query: string): void {
    const q = query.toLowerCase();
    const filtered = this.props.sessions.filter((session) => {
      const title = (session.title || "").toLowerCase();
      const summary = (session.summary || "").toLowerCase();
      const project = (session.project_path || "").toLowerCase();
      return title.includes(q) || summary.includes(q) || project.includes(q);
    });

    this.setState({ searchQuery: query, filteredSessions: filtered });
  }
}
```

## Step 3: Update Router for Component Lifecycle

**File: `src/client/router.ts`**

Add support for component-based pages:

```typescript
import { Component } from "./component";

type RouteHandler = (params: Record<string, string>) => Promise<void>;
type ComponentFactory = (params: Record<string, string>) => Promise<Component | null>;

interface Route {
  pattern: RegExp;
  keys: string[];
  handler?: RouteHandler;
  componentFactory?: ComponentFactory;
}

export class Router {
  private routes: Route[] = [];
  private currentComponent: Component | null = null;

  on(path: string, handler: RouteHandler): void {
    const { pattern, keys } = this.pathToRegex(path);
    this.routes.push({ pattern, keys, handler });
  }

  // New method for component-based routes
  onComponent(path: string, factory: ComponentFactory): void {
    const { pattern, keys } = this.pathToRegex(path);
    this.routes.push({ pattern, keys, componentFactory: factory });
  }

  async navigate(path: string): Promise<void> {
    // Clean up current component
    if (this.currentComponent) {
      this.currentComponent.unmount();
      this.currentComponent = null;
    }

    window.history.pushState({}, "", path);
    await this.handleRoute(path);
  }

  async start(): Promise<void> {
    // Handle initial load
    await this.handleRoute(window.location.pathname);

    // Handle back/forward
    window.addEventListener("popstate", () => {
      // Clean up current component
      if (this.currentComponent) {
        this.currentComponent.unmount();
        this.currentComponent = null;
      }
      this.handleRoute(window.location.pathname);
    });

    // Handle link clicks
    document.addEventListener("click", (e) => {
      const link = (e.target as HTMLElement).closest("a[data-link]");
      if (link) {
        e.preventDefault();
        const href = link.getAttribute("href");
        if (href) {
          this.navigate(href);
        }
      }
    });
  }

  private async handleRoute(path: string): Promise<void> {
    for (const route of this.routes) {
      const match = path.match(route.pattern);
      if (match) {
        const params: Record<string, string> = {};
        route.keys.forEach((key, i) => {
          params[key] = match[i + 1];
        });

        if (route.componentFactory) {
          // Component-based route
          const component = await route.componentFactory(params);
          if (component) {
            const app = document.getElementById("app")!;
            app.innerHTML = "";
            component.mount(app);
            this.currentComponent = component;
          }
        } else if (route.handler) {
          // Handler-based route (legacy)
          await route.handler(params);
        }
        return;
      }
    }

    // 404
    const app = document.getElementById("app")!;
    app.innerHTML = '<div class="text-center py-8 text-text-muted">Page not found</div>';
  }

  private pathToRegex(path: string): { pattern: RegExp; keys: string[] } {
    const keys: string[] = [];
    const pattern = path
      .replace(/:(\w+)/g, (_, key) => {
        keys.push(key);
        return "([^/]+)";
      })
      .replace(/\//g, "\\/");
    return { pattern: new RegExp(`^${pattern}$`), keys };
  }
}
```

## Step 4: Simplify index.ts

**File: `src/client/index.ts`**

The file becomes much simpler:

```typescript
import { Router } from "./router";
import { SessionListPage } from "./components/SessionListPage";
import { SessionDetailPage } from "./components/SessionDetailPage";

// Initialize router
const router = new Router();

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

async function fetchAnnotations(sessionId: string): Promise<AnnotationsData | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/annotations`);
  if (!res.ok) return null;
  return res.json();
}

// Register component-based routes
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
  const res = await fetch(`/api/s/${encodeURIComponent(params.shareToken)}`);
  if (!res.ok) return null;
  const data = await res.json();

  return new SessionDetailPage({
    session: data.session,
    messages: data.messages,
    diffs: data.diffs,
    shareUrl: null,
    review: null,
    annotationsByDiff: {},
  });
});

// Toast and clipboard utilities remain global
window.showToast = (message: string, type = "success") => { /* ... */ };
window.copyToClipboard = async (text: string) => { /* ... */ };

// Start the router
router.start();
```

## Verification

1. **Navigation**: Click between sessions, verify proper cleanup and mounting
2. **Back/forward**: Browser history works correctly
3. **Live session**: Real-time updates still work
4. **Search**: Session list filtering works
5. **Share**: Share button creates link
6. **Memory**: No leaks when navigating between sessions

## Benefits

| Before | After |
|--------|-------|
| ~1,143 lines in index.ts | ~100 lines in index.ts |
| Manual cleanup in each route | Automatic via router |
| Multiple module-level refs | No module-level component refs |
| Document-level event handlers | Scoped to components |
| String HTML manipulation | Component-based rendering |

## Notes

- `onComponent` is the new preferred way to register routes
- Old `on` method still works for gradual migration
- Router automatically calls `unmount` on navigation
- Components use `data-link` attribute for client-side navigation
- Global utilities (`showToast`, `copyToClipboard`) remain for convenience
