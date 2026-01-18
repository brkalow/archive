# Implementation Plan: MessageList Component

> **ABANDONED**: This plan was superseded by migrating directly to React. See `plans/react_migration_parallel.md` for the approach that was used instead.

Create a MessageList component that manages message collection and live session updates.

**Spec reference:** `specs/component_model.md` - File Structure (MessageList), Migration Phase 2

**Depends on:** `plans/component_model_03_message_components.md`

## Overview

MessageList is the container component that:
1. Manages a collection of MessageBlock components
2. Integrates with LiveSessionManager for real-time updates
3. Handles auto-scroll and "new messages" button
4. Tracks pending tool calls and typing indicator

## Current State

In `src/client/index.ts`:
- `lastRenderedRole` - module-level state for message grouping (line 27)
- `pendingToolCalls` - Set tracking tool calls awaiting results (line 28)
- `initializeLiveSession()` - creates WebSocket connection, appends messages
- Messages appended as raw HTML via `insertAdjacentHTML`
- No cleanup of message DOM when navigating away

## Files to Create

| File | Purpose |
|------|---------|
| `src/client/components/MessageList.tsx` | Message collection manager |

## Files to Modify

| File | Changes |
|------|---------|
| `src/client/index.ts` | Use MessageList, remove module-level state |

## Step 1: Create MessageList Component

**File: `src/client/components/MessageList.tsx`**

```tsx
import { Component } from "../component";
import { MessageBlock } from "./MessageBlock";
import { buildToolResultMap } from "../blocks";
import { LiveSessionManager, isNearBottom, scrollToBottom } from "../liveSession";
import type { Message, ToolResultBlock, Session } from "../../db/schema";

interface MessageListProps {
  sessionId: string;
  initialMessages: Message[];
  session: Session;
  isLive: boolean;
}

interface MessageListState {
  messages: Message[];
  pendingToolCalls: Set<string>;
  showTypingIndicator: boolean;
  showNewMessagesButton: boolean;
  lastRenderedRole: string | null;
}

export class MessageList extends Component<MessageListProps, MessageListState> {
  private messageBlocks: MessageBlock[] = [];
  private liveSessionManager: LiveSessionManager | null = null;
  private scrollContainer: HTMLElement | null = null;

  constructor(props: MessageListProps) {
    super(props, {
      messages: props.initialMessages,
      pendingToolCalls: new Set(),
      showTypingIndicator: false,
      showNewMessagesButton: false,
      lastRenderedRole: props.initialMessages.length > 0
        ? props.initialMessages[props.initialMessages.length - 1].role
        : null,
    });

    // Initialize pending tool calls from existing messages
    this.initializePendingToolCalls(props.initialMessages);
  }

  render(): HTMLElement {
    const { showTypingIndicator, showNewMessagesButton } = this.state;

    return (
      <div className="message-list-container relative h-full">
        <div
          className="conversation-list overflow-y-auto h-full space-y-4 p-4"
          ref={(el) => (this.scrollContainer = el)}
        >
          <div className="messages-container" />

          {/* Typing indicator */}
          <div
            id="typing-indicator"
            className={`flex items-center gap-2 text-text-muted text-sm ${showTypingIndicator ? "" : "hidden"}`}
          >
            <div className="flex gap-1">
              <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
            <span>Claude is working...</span>
          </div>
        </div>

        {/* New messages button */}
        <button
          id="new-messages-btn"
          className={`absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-accent-primary text-white rounded-full shadow-lg hover:bg-accent-primary/90 transition-all ${showNewMessagesButton ? "" : "hidden"}`}
          onClick={() => this.scrollToBottom()}
        >
          ↓ New messages
        </button>
      </div>
    );
  }

  protected onMount(): void {
    // Render initial messages
    this.renderMessages(this.state.messages);

    // Set up scroll handler
    if (this.scrollContainer) {
      this.scrollContainer.addEventListener("scroll", () => this.handleScroll());
    }

    // Initialize live session if needed
    if (this.props.isLive) {
      this.initializeLiveSession();
    }

    // Show typing if there are pending tool calls
    if (this.state.pendingToolCalls.size > 0) {
      this.setState({ showTypingIndicator: true });
    }
  }

  protected onUnmount(): void {
    // Clean up live session manager
    if (this.liveSessionManager) {
      this.liveSessionManager.destroy();
      this.liveSessionManager = null;
    }

    // MessageBlocks are children, will be auto-cleaned
    this.messageBlocks = [];
  }

  private renderMessages(messages: Message[]): void {
    const container = this.$(".messages-container");
    if (!container) return;

    // Build tool result map for inline rendering
    const allBlocks = messages.flatMap((m) => m.content_blocks || []);
    const toolResults = buildToolResultMap(allBlocks);

    let lastRole: string | null = null;

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const showRoleBadge = message.role !== lastRole;

      const messageBlock = new MessageBlock({
        message,
        toolResults,
        showRoleBadge,
        messageIndex: i,
      });

      this.addChild(messageBlock, container);
      this.messageBlocks.push(messageBlock);
      lastRole = message.role;
    }

    this.setState({ lastRenderedRole: lastRole });
  }

  private appendMessage(message: Message): void {
    const container = this.$(".messages-container");
    if (!container) return;

    // Build tool result map including new message
    const allMessages = [...this.state.messages, message];
    const allBlocks = allMessages.flatMap((m) => m.content_blocks || []);
    const toolResults = buildToolResultMap(allBlocks);

    const showRoleBadge = message.role !== this.state.lastRenderedRole;
    const messageIndex = this.messageBlocks.length;

    const messageBlock = new MessageBlock({
      message,
      toolResults,
      showRoleBadge,
      messageIndex,
    });

    // Insert before typing indicator
    const typingIndicator = this.$("#typing-indicator");
    if (typingIndicator) {
      const tempContainer = document.createElement("div");
      messageBlock.mount(tempContainer);
      typingIndicator.before(tempContainer.firstChild!);
      this.messageBlocks.push(messageBlock);
    } else {
      this.addChild(messageBlock, container);
      this.messageBlocks.push(messageBlock);
    }

    // Update state
    this.state.messages.push(message);
    this.state.lastRenderedRole = message.role;

    // Handle auto-scroll
    if (this.scrollContainer && isNearBottom(this.scrollContainer)) {
      scrollToBottom(this.scrollContainer);
      this.setState({ showNewMessagesButton: false });
    } else {
      this.setState({ showNewMessagesButton: true });
    }
  }

  private initializePendingToolCalls(messages: Message[]): void {
    const allToolUseIds = new Set<string>();
    const completedToolUseIds = new Set<string>();

    for (const msg of messages) {
      if (msg.content_blocks) {
        for (const block of msg.content_blocks) {
          if (block.type === "tool_use") {
            allToolUseIds.add(block.id);
          } else if (block.type === "tool_result") {
            completedToolUseIds.add(block.tool_use_id);
          }
        }
      }
    }

    // Pending = tool_use_ids without corresponding tool_result
    for (const id of allToolUseIds) {
      if (!completedToolUseIds.has(id)) {
        this.state.pendingToolCalls.add(id);
      }
    }
  }

  private initializeLiveSession(): void {
    const { sessionId, session } = this.props;

    this.liveSessionManager = new LiveSessionManager(sessionId, {
      onMessage: (messages, _index) => {
        for (const message of messages) {
          // Track pending tool calls from assistant messages
          if (message.role === "assistant" && message.content_blocks) {
            for (const block of message.content_blocks) {
              if (block.type === "tool_use") {
                this.state.pendingToolCalls.add(block.id);
              }
            }
          }

          // Clear pending tool calls when results arrive
          if (message.role === "user" && message.content_blocks) {
            for (const block of message.content_blocks) {
              if (block.type === "tool_result") {
                this.state.pendingToolCalls.delete(block.tool_use_id);
              }
            }
          }

          // Append the message
          this.appendMessage(message);
        }

        // Update typing indicator
        this.setState({
          showTypingIndicator: this.state.pendingToolCalls.size > 0,
        });
      },

      onToolResult: (result) => {
        this.state.pendingToolCalls.delete(result.tool_use_id);
        this.updateToolResult(result.tool_use_id, result.content, result.is_error);

        if (this.state.pendingToolCalls.size === 0) {
          this.setState({ showTypingIndicator: false });
        }
      },

      onComplete: () => {
        this.setState({ showTypingIndicator: false });
        // Emit event for parent to handle status update
        this.el?.dispatchEvent(new CustomEvent("session-complete"));
      },

      onConnectionChange: (connected) => {
        this.el?.dispatchEvent(new CustomEvent("connection-change", { detail: { connected } }));
      },

      onReconnectAttempt: (attempt, maxAttempts) => {
        this.el?.dispatchEvent(new CustomEvent("reconnect-attempt", {
          detail: { attempt, maxAttempts },
        }));
      },

      onReconnectFailed: () => {
        this.el?.dispatchEvent(new CustomEvent("reconnect-failed"));
      },

      onDiff: async (files) => {
        this.el?.dispatchEvent(new CustomEvent("diff-update", { detail: { files } }));
      },

      onInteractiveInfo: (interactive, claudeState) => {
        this.el?.dispatchEvent(new CustomEvent("interactive-info", {
          detail: { interactive, claudeState },
        }));
      },

      onClaudeState: (state) => {
        this.el?.dispatchEvent(new CustomEvent("claude-state", { detail: { state } }));
      },

      onFeedbackQueued: (messageId, position) => {
        this.el?.dispatchEvent(new CustomEvent("feedback-queued", {
          detail: { messageId, position },
        }));
      },

      onFeedbackStatus: (messageId, status) => {
        this.el?.dispatchEvent(new CustomEvent("feedback-status", {
          detail: { messageId, status },
        }));
      },

      onOutput: (data) => {
        this.el?.dispatchEvent(new CustomEvent("terminal-output", { detail: data }));
      },
    });

    this.liveSessionManager.connect();
  }

  private updateToolResult(toolUseId: string, content: string, isError?: boolean): void {
    // Find the tool call element
    const toolCall = this.$(`[data-tool-id="${toolUseId}"]`);
    if (!toolCall) return;

    // Update status indicator
    const statusSpan = toolCall.querySelector(".tool-status");
    if (statusSpan) {
      statusSpan.outerHTML = isError
        ? '<span class="tool-status text-diff-del">✗</span>'
        : '<span class="tool-status text-diff-add">✓</span>';
    }
  }

  private handleScroll(): void {
    if (this.scrollContainer && isNearBottom(this.scrollContainer)) {
      this.setState({ showNewMessagesButton: false });
    }
  }

  private scrollToBottom(): void {
    if (this.scrollContainer) {
      scrollToBottom(this.scrollContainer);
      this.setState({ showNewMessagesButton: false });
    }
  }

  // Public API for external control

  /** Get the LiveSessionManager for sending feedback */
  getLiveSessionManager(): LiveSessionManager | null {
    return this.liveSessionManager;
  }

  /** Get current message count */
  getMessageCount(): number {
    return this.messageBlocks.length;
  }
}
```

## Step 2: Update index.ts to Use MessageList

**File: `src/client/index.ts`**

Replace module-level state and live session handling:

```typescript
import { MessageList } from "./components/MessageList";

// Remove these module-level variables:
// let lastRenderedRole: string | null = null;
// let pendingToolCalls = new Set<string>();

// Add component tracking:
let messageListComponent: MessageList | null = null;

// Update route handler:
router.on("/sessions/:id", async (params) => {
  // Clean up previous components
  if (messageListComponent) {
    messageListComponent.unmount();
    messageListComponent = null;
  }
  if (diffPanelComponent) {
    diffPanelComponent.unmount();
    diffPanelComponent = null;
  }

  const app = document.getElementById("app")!;
  app.innerHTML = '<div class="text-center py-8 text-text-muted">Loading...</div>';

  const data = await fetchSessionDetail(params.id);
  if (!data) {
    app.innerHTML = renderNotFound();
    return;
  }

  // Render page structure (without message content)
  app.innerHTML = renderSessionDetailShell(data);

  // Mount MessageList component
  const conversationContainer = document.getElementById("conversation-list");
  if (conversationContainer) {
    messageListComponent = new MessageList({
      sessionId: data.session.id,
      initialMessages: data.messages,
      session: data.session,
      isLive: data.session.status === "live",
    });

    messageListComponent.mount(conversationContainer, "replace");

    // Listen for events from MessageList
    messageListComponent.getElement()?.addEventListener("session-complete", () => {
      updateSessionStatus("complete");
    });

    messageListComponent.getElement()?.addEventListener("connection-change", (e: CustomEvent) => {
      updateConnectionStatus(e.detail.connected);
    });

    messageListComponent.getElement()?.addEventListener("diff-update", async () => {
      // Refresh diff panel
      await refreshDiffPanel(data.session.id);
    });
  }

  // Mount DiffPanel component (from previous plan)
  initializeDiffs(data.session.id);
});
```

## Step 3: Create Shell Renderer

Add a function that renders the page structure without message content:

**File: `src/client/views.ts`**

```typescript
export function renderSessionDetailShell(data: SessionDetailData): string {
  // Returns the page layout with empty containers for:
  // - #conversation-list (for MessageList component)
  // - [data-diff-panel] (for DiffPanel component)
  // Similar to current renderSessionDetail but without message HTML
  // ...
}
```

## Step 4: Interactive Session Support

The MessageList emits events that the parent handles. For interactive sessions:

```typescript
// In index.ts, after mounting MessageList:

messageListComponent.getElement()?.addEventListener("interactive-info", (e: CustomEvent) => {
  const { interactive, claudeState } = e.detail;
  interactiveState.isInteractive = interactive;
  interactiveState.claudeState = claudeState;
  if (interactive) {
    initializeFeedbackInput();
  }
  updateFeedbackInput();
});

messageListComponent.getElement()?.addEventListener("feedback-queued", (e: CustomEvent) => {
  const { messageId, position } = e.detail;
  interactiveState.pendingFeedback.push({ id: messageId, status: "pending" });
  updateFeedbackInput();
  window.showToast(`Message queued (position: ${position})`, "info");
});

// For sending feedback:
document.getElementById("feedback-submit")?.addEventListener("click", () => {
  const input = document.getElementById("feedback-input") as HTMLTextAreaElement;
  const content = input?.value.trim();
  if (content && messageListComponent) {
    const manager = messageListComponent.getLiveSessionManager();
    manager?.sendFeedback(content);
    input.value = "";
  }
});
```

## Verification

1. **Live updates**: Navigate to a live session, verify new messages appear
2. **Auto-scroll**: New messages scroll into view when near bottom
3. **New messages button**: Button appears when scrolled up, clicking scrolls down
4. **Typing indicator**: Shows when tool calls are pending, hides when complete
5. **Cleanup**: Navigate away and back, verify no memory leaks
6. **Tool result updates**: Tool status updates from ✗ to ✓ when results arrive

## Benefits

| Before | After |
|--------|-------|
| Module-level `lastRenderedRole` | Encapsulated in component state |
| Module-level `pendingToolCalls` | Encapsulated in component state |
| Global `liveSessionManager` | Owned by MessageList |
| Raw HTML append | Component mounting |
| Manual cleanup in route handler | Automatic via `onUnmount` |

## Event-Based Communication

MessageList uses custom events to communicate with parent:
- `session-complete` - Session finished
- `connection-change` - WebSocket state change
- `reconnect-attempt` - Reconnection in progress
- `reconnect-failed` - All reconnection attempts failed
- `diff-update` - New diffs available
- `interactive-info` - Interactive session state
- `claude-state` - Claude's current state
- `feedback-queued` - Feedback message queued
- `feedback-status` - Feedback status update

This keeps MessageList focused on message management while allowing parent to handle UI updates.

## Notes

- LiveSessionManager is still a separate class (not a component)
- MessageList owns the manager and destroys it on unmount
- Events bubble up for parent handling of global UI state
- Interactive state handling remains in index.ts for now (future: InteractiveFeedback component)
