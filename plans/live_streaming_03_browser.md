# Browser Live Session UI

> **Spec reference:** [specs/live_streaming.md](../specs/live_streaming.md)

## Overview

This plan covers the browser-side implementation for viewing live sessions: WebSocket subscription, real-time message rendering, live indicators, auto-scroll behavior, and connection status.

## Dependencies

- [live_streaming_01_server.md](./live_streaming_01_server.md) - Server WebSocket endpoint must be ready

## Tasks

### 1. Session Status in API Response

Ensure the session detail API returns status information.

**File:** `src/routes/api.ts`

The `getSessionDetail` response should include:

```typescript
return json({
  session: {
    ...session,
    status: session.status,  // 'live' | 'complete' | 'archived'
    last_activity_at: session.last_activity_at,
  },
  messages,
  diffs,
  shareUrl,
});
```

### 2. WebSocket Hook

Create a reusable hook for WebSocket subscriptions.

**File:** `src/client/hooks/useWebSocket.ts`

```typescript
type WebSocketMessage =
  | { type: "connected"; session_id: string; status: string; message_count: number; last_index: number }
  | { type: "message"; messages: unknown[]; index: number }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; message_index: number }
  | { type: "diff"; files: Array<{ filename: string; additions: number; deletions: number }> }
  | { type: "complete"; final_message_count: number }
  | { type: "heartbeat"; timestamp: string }
  | { type: "error"; code: string; message: string };

interface UseWebSocketOptions {
  sessionId: string;
  enabled: boolean;
  onMessage: (messages: unknown[]) => void;
  onToolResult: (result: { tool_use_id: string; content: string; is_error?: boolean }) => void;
  onDiff: (files: Array<{ filename: string; additions: number; deletions: number }>) => void;
  onComplete: () => void;
  onConnectionChange: (connected: boolean) => void;
}

export function useWebSocket(options: UseWebSocketOptions) {
  let ws: WebSocket | null = null;
  let lastIndex = -1;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 10;
  const RECONNECT_DELAY_MS = 1000;

  function connect() {
    if (!options.enabled) return;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/api/sessions/${options.sessionId}/ws`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectAttempts = 0;
      options.onConnectionChange(true);

      // Resume from last index if reconnecting
      if (lastIndex >= 0) {
        ws?.send(JSON.stringify({ type: "subscribe", from_index: lastIndex + 1 }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data);
        handleMessage(data);
      } catch {
        // Invalid message
      }
    };

    ws.onclose = (event) => {
      options.onConnectionChange(false);

      // Reconnect unless normal close or session complete
      if (event.code !== 1000 && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1);
        setTimeout(connect, Math.min(delay, 30000));
      }
    };

    ws.onerror = () => {
      options.onConnectionChange(false);
    };
  }

  function handleMessage(data: WebSocketMessage) {
    switch (data.type) {
      case "connected":
        lastIndex = data.last_index;
        break;

      case "message":
        lastIndex = data.index;
        options.onMessage(data.messages);
        break;

      case "tool_result":
        options.onToolResult({
          tool_use_id: data.tool_use_id,
          content: data.content,
          is_error: data.is_error,
        });
        break;

      case "diff":
        options.onDiff(data.files);
        break;

      case "complete":
        options.onComplete();
        disconnect();
        break;

      case "heartbeat":
        // Keep-alive, no action needed
        break;

      case "error":
        console.error("WebSocket error:", data.message);
        break;
    }
  }

  function disconnect() {
    if (ws) {
      ws.close(1000);
      ws = null;
    }
  }

  function sendPing() {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }

  // Start connection if enabled
  if (options.enabled) {
    connect();
  }

  return {
    connect,
    disconnect,
    sendPing,
    isConnected: () => ws?.readyState === WebSocket.OPEN,
  };
}
```

### 3. Live Indicator Component

Create a pulsing live indicator for the session header.

**File:** `src/components/LiveIndicator.ts`

```typescript
export function LiveIndicator(): string {
  return `
    <div class="live-indicator flex items-center gap-1.5">
      <span class="live-dot w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
      <span class="live-label text-xs font-bold uppercase tracking-wide text-green-500">
        LIVE
      </span>
    </div>
  `;
}

export function LiveIndicatorStyles(): string {
  return `
    <style>
      .live-indicator .live-dot {
        animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
      }

      @keyframes pulse {
        0%, 100% {
          opacity: 1;
        }
        50% {
          opacity: 0.5;
        }
      }
    </style>
  `;
}
```

### 4. Connection Status Indicator

Show WebSocket connection status.

**File:** `src/components/ConnectionStatus.ts`

```typescript
export function ConnectionStatus(connected: boolean): string {
  if (connected) {
    return `
      <div class="connection-status flex items-center gap-1 text-xs text-gray-500">
        <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span>
        <span>Connected</span>
      </div>
    `;
  }

  return `
    <div class="connection-status flex items-center gap-1 text-xs text-yellow-600">
      <span class="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse"></span>
      <span>Reconnecting...</span>
    </div>
  `;
}
```

### 5. Session Header Updates

Update the session header to show live status.

**File:** `src/components/SessionDetail.ts`

Add live indicator to the header:

```typescript
function renderHeader(session: Session): string {
  const isLive = session.status === "live";

  return `
    <div class="session-header flex items-center justify-between py-4 border-b">
      <div class="flex items-center gap-3">
        ${isLive ? LiveIndicator() : ""}
        <h1 class="text-xl font-semibold">${escapeHtml(session.title)}</h1>
      </div>

      <div class="flex items-center gap-4">
        ${isLive ? `<span id="connection-status"></span>` : ""}
        ${isLive ? renderDuration(session.created_at) : renderDate(session.created_at)}
        ${session.pr_url ? renderPRLink(session.pr_url) : ""}
        ${renderShareButton(session)}
      </div>
    </div>
  `;
}

function renderDuration(createdAt: string): string {
  const started = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - started.getTime();
  const minutes = Math.floor(diffMs / 60000);

  if (minutes < 1) return `<span class="text-sm text-gray-500">started just now</span>`;
  if (minutes === 1) return `<span class="text-sm text-gray-500">started 1m ago</span>`;
  return `<span class="text-sm text-gray-500">started ${minutes}m ago</span>`;
}
```

### 6. Real-Time Message Appending

Update the conversation panel to support live message appending.

**File:** `src/components/ConversationPanel.ts`

```typescript
interface MessageAppendOptions {
  scrollToBottom: boolean;
}

// Function to append a new message to the DOM
export function appendMessage(
  container: HTMLElement,
  message: Message,
  options: MessageAppendOptions = { scrollToBottom: true }
): void {
  const messageHtml = renderMessage(message);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = messageHtml;

  const messageEl = wrapper.firstElementChild;
  if (messageEl) {
    container.appendChild(messageEl);

    // Animate in
    messageEl.classList.add("message-enter");
    requestAnimationFrame(() => {
      messageEl.classList.remove("message-enter");
    });

    if (options.scrollToBottom && isNearBottom(container)) {
      scrollToBottom(container);
    }
  }
}

// Check if user is near the bottom of the scroll container
function isNearBottom(container: HTMLElement): boolean {
  const threshold = 100;
  return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}

// Smooth scroll to bottom
function scrollToBottom(container: HTMLElement): void {
  container.scrollTo({
    top: container.scrollHeight,
    behavior: "smooth",
  });
}
```

### 7. New Messages Button

Show a button when new messages arrive while user is scrolled up.

**File:** `src/components/NewMessagesButton.ts`

```typescript
export function NewMessagesButton(): string {
  return `
    <button
      id="new-messages-btn"
      class="new-messages-btn hidden fixed bottom-24 left-1/2 -translate-x-1/2
             px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-full
             shadow-lg hover:bg-blue-700 transition-all"
    >
      ↓ New messages
    </button>
  `;
}

export function showNewMessagesButton(): void {
  const btn = document.getElementById("new-messages-btn");
  if (btn) {
    btn.classList.remove("hidden");
  }
}

export function hideNewMessagesButton(): void {
  const btn = document.getElementById("new-messages-btn");
  if (btn) {
    btn.classList.add("hidden");
  }
}

// Set up click handler
export function initNewMessagesButton(scrollContainer: HTMLElement): void {
  const btn = document.getElementById("new-messages-btn");
  if (btn) {
    btn.addEventListener("click", () => {
      scrollToBottom(scrollContainer);
      hideNewMessagesButton();
    });
  }

  // Hide button when user scrolls to bottom
  scrollContainer.addEventListener("scroll", () => {
    if (isNearBottom(scrollContainer)) {
      hideNewMessagesButton();
    }
  });
}
```

### 8. Pending Tool Call Indicator

Show a spinner for tool calls awaiting results.

**File:** `src/components/ToolCallBlock.ts`

Update the tool call rendering to show pending state:

```typescript
export function renderToolCall(block: ToolUseBlock, result?: ToolResultBlock): string {
  const isPending = !result;

  return `
    <div class="tool-call flex items-center gap-2 py-1 text-sm" data-tool-use-id="${block.id}">
      <span class="tool-icon">▶</span>
      <span class="tool-name font-medium">${escapeHtml(block.name)}</span>
      <span class="tool-input text-gray-500">${getToolInputSummary(block)}</span>
      <span class="tool-status ml-auto">
        ${isPending
          ? '<span class="pending-indicator animate-pulse">⋯</span>'
          : result?.is_error
            ? '<span class="text-red-500">✗</span>'
            : '<span class="text-green-500">✓</span>'
        }
      </span>
    </div>
    ${result ? renderToolResult(result) : ""}
  `;
}

// Update tool result in the DOM when it arrives
export function updateToolResult(toolUseId: string, content: string, isError: boolean = false): void {
  const toolCall = document.querySelector(`[data-tool-use-id="${toolUseId}"]`);
  if (!toolCall) return;

  // Update status
  const status = toolCall.querySelector(".tool-status");
  if (status) {
    status.innerHTML = isError
      ? '<span class="text-red-500">✗</span>'
      : '<span class="text-green-500">✓</span>';
  }

  // Add result
  const resultHtml = renderToolResult({ tool_use_id: toolUseId, content, is_error: isError });
  toolCall.insertAdjacentHTML("afterend", resultHtml);
}
```

### 9. Typing Indicator

Show when Claude is thinking (tool call in progress).

**File:** `src/components/TypingIndicator.ts`

```typescript
export function TypingIndicator(): string {
  return `
    <div id="typing-indicator" class="typing-indicator hidden flex items-center gap-2 p-4 text-gray-500">
      <div class="typing-dots flex gap-1">
        <span class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0ms"></span>
        <span class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 150ms"></span>
        <span class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 300ms"></span>
      </div>
      <span>Claude is working...</span>
    </div>
  `;
}

let typingTimeout: number | null = null;

export function showTypingIndicator(): void {
  const indicator = document.getElementById("typing-indicator");
  if (indicator) {
    indicator.classList.remove("hidden");
  }

  // Auto-hide after 30 seconds (fallback)
  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = window.setTimeout(hideTypingIndicator, 30000);
}

export function hideTypingIndicator(): void {
  const indicator = document.getElementById("typing-indicator");
  if (indicator) {
    indicator.classList.add("hidden");
  }

  if (typingTimeout) {
    clearTimeout(typingTimeout);
    typingTimeout = null;
  }
}
```

### 10. Session Detail View Integration

Wire up all the live session features in the session detail view.

**File:** `src/client/views.ts`

```typescript
import { useWebSocket } from "./hooks/useWebSocket";
import { appendMessage, isNearBottom, scrollToBottom } from "../components/ConversationPanel";
import { updateToolResult } from "../components/ToolCallBlock";
import { showNewMessagesButton, hideNewMessagesButton, initNewMessagesButton } from "../components/NewMessagesButton";
import { showTypingIndicator, hideTypingIndicator } from "../components/TypingIndicator";
import { ConnectionStatus } from "../components/ConnectionStatus";

interface SessionDetailState {
  session: Session;
  messages: Message[];
  diffs: Diff[];
  isLive: boolean;
  isConnected: boolean;
  pendingToolCalls: Set<string>;
}

function initLiveSession(state: SessionDetailState): void {
  if (!state.isLive) return;

  const conversationPanel = document.querySelector(".conversation-panel") as HTMLElement;
  if (!conversationPanel) return;

  initNewMessagesButton(conversationPanel);

  // Track pending tool calls for typing indicator
  const pendingToolCalls = new Set<string>();

  // Initialize message indices for new messages
  let lastMessageIndex = state.messages.length - 1;

  const ws = useWebSocket({
    sessionId: state.session.id,
    enabled: true,

    onMessage: (messages) => {
      for (const msg of messages) {
        const message = msg as Message;
        lastMessageIndex++;
        message.message_index = lastMessageIndex;

        // Track pending tool calls
        for (const block of message.content_blocks || []) {
          if (block.type === "tool_use") {
            pendingToolCalls.add(block.id);
          }
        }

        // Show typing indicator if there are pending tool calls
        if (pendingToolCalls.size > 0) {
          showTypingIndicator();
        }

        // Append to DOM
        const shouldScroll = isNearBottom(conversationPanel);
        appendMessage(conversationPanel, message, { scrollToBottom: shouldScroll });

        if (!shouldScroll) {
          showNewMessagesButton();
        }
      }
    },

    onToolResult: (result) => {
      // Update the tool call in the DOM
      updateToolResult(result.tool_use_id, result.content, result.is_error);

      // Remove from pending
      pendingToolCalls.delete(result.tool_use_id);

      // Hide typing indicator if no more pending
      if (pendingToolCalls.size === 0) {
        hideTypingIndicator();
      }
    },

    onDiff: (files) => {
      // Update diff panel
      updateDiffPanel(files);
    },

    onComplete: () => {
      // Update header to show completed status
      updateSessionStatus("complete");
      hideTypingIndicator();
    },

    onConnectionChange: (connected) => {
      state.isConnected = connected;
      updateConnectionStatus(connected);
    },
  });

  // Clean up on navigation
  window.addEventListener("beforeunload", () => {
    ws.disconnect();
  });
}

function updateConnectionStatus(connected: boolean): void {
  const container = document.getElementById("connection-status");
  if (container) {
    container.innerHTML = ConnectionStatus(connected);
  }
}

function updateSessionStatus(status: string): void {
  // Remove live indicator
  const liveIndicator = document.querySelector(".live-indicator");
  if (liveIndicator) {
    liveIndicator.remove();
  }

  // Update header
  const header = document.querySelector(".session-header h1");
  if (header) {
    header.insertAdjacentHTML("beforebegin", `
      <span class="text-xs font-medium uppercase tracking-wide text-gray-500 bg-gray-100 px-2 py-1 rounded">
        ${status}
      </span>
    `);
  }
}

function updateDiffPanel(files: Array<{ filename: string; additions: number; deletions: number }>): void {
  // Find and update the diff panel
  const diffPanel = document.querySelector(".diff-panel");
  if (!diffPanel) return;

  // Flash to indicate update
  diffPanel.classList.add("diff-update-flash");
  setTimeout(() => diffPanel.classList.remove("diff-update-flash"), 500);

  // Update file list (simplified - full implementation would re-render diffs)
  const fileList = diffPanel.querySelector(".diff-file-list");
  if (fileList) {
    fileList.innerHTML = files.map((f) => `
      <div class="flex items-center gap-2 py-1">
        <span class="filename">${escapeHtml(f.filename)}</span>
        <span class="text-green-600">+${f.additions}</span>
        <span class="text-red-600">-${f.deletions}</span>
      </div>
    `).join("");
  }
}
```

### 11. CSS Animations

Add CSS for live session animations.

**File:** `public/styles.css` (additions)

```css
/* Message enter animation */
.message-enter {
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 0.2s ease, transform 0.2s ease;
}

/* Diff update flash */
.diff-update-flash {
  animation: diff-flash 0.5s ease;
}

@keyframes diff-flash {
  0% {
    background-color: rgba(59, 130, 246, 0.1);
  }
  100% {
    background-color: transparent;
  }
}

/* Bounce animation for typing indicator */
@keyframes bounce {
  0%, 80%, 100% {
    transform: translateY(0);
  }
  40% {
    transform: translateY(-6px);
  }
}

.animate-bounce {
  animation: bounce 1.4s infinite ease-in-out;
}

/* Pulse animation for live indicator */
.animate-pulse {
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
```

### 12. Live Session List on Homepage

Add a section showing currently live sessions.

**File:** `src/components/SessionList.ts`

```typescript
function renderLiveSessionsSection(liveSessions: Session[]): string {
  if (liveSessions.length === 0) return "";

  return `
    <section class="live-sessions mb-8">
      <h2 class="text-lg font-semibold mb-4 flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
        Live Sessions
      </h2>
      <div class="grid gap-4">
        ${liveSessions.map(renderLiveSessionCard).join("")}
      </div>
    </section>
  `;
}

function renderLiveSessionCard(session: Session): string {
  const duration = formatDuration(session.created_at);

  return `
    <a href="/sessions/${session.id}" class="live-session-card block p-4 border rounded-lg hover:border-green-400 transition-colors">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
          <span class="font-medium">${escapeHtml(session.title)}</span>
        </div>
        <span class="text-sm text-gray-500">${duration}</span>
      </div>
      ${session.project_path ? `<div class="text-sm text-gray-500 mt-1">${escapeHtml(session.project_path)}</div>` : ""}
    </a>
  `;
}

function formatDuration(createdAt: string): string {
  const started = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - started.getTime();
  const minutes = Math.floor(diffMs / 60000);

  if (minutes < 1) return "just started";
  if (minutes === 1) return "1 minute";
  if (minutes < 60) return `${minutes} minutes`;

  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hour";
  return `${hours} hours`;
}
```

### 13. Homepage Data Fetching

Fetch live sessions separately for the homepage.

**File:** `src/client/views.ts`

```typescript
async function loadHomepage(): Promise<void> {
  // Fetch regular sessions and live sessions in parallel
  const [sessionsRes, liveRes] = await Promise.all([
    fetch("/api/sessions"),
    fetch("/api/sessions/live"),
  ]);

  const { sessions } = await sessionsRes.json();
  const { sessions: liveSessions } = await liveRes.json();

  // Render with live sessions section at top
  const html = `
    ${renderLiveSessionsSection(liveSessions)}
    ${renderSessionList(sessions)}
  `;

  document.getElementById("content")!.innerHTML = html;

  // Poll for live session updates every 30 seconds
  if (liveSessions.length > 0) {
    setInterval(async () => {
      const res = await fetch("/api/sessions/live");
      const { sessions: updated } = await res.json();
      updateLiveSessionsSection(updated);
    }, 30000);
  }
}
```

## Testing

### Manual Testing

1. Start a live session via the daemon
2. Open the session in the browser
3. Verify live indicator is shown
4. Verify messages appear in real-time
5. Verify auto-scroll works
6. Scroll up and verify "New messages" button appears
7. Verify tool call pending/complete states
8. Complete the session and verify status updates
9. Refresh and verify complete status persists

### Unit Tests

```typescript
// tests/client/websocket.test.ts

import { describe, test, expect, mock } from "bun:test";

describe("WebSocket Hook", () => {
  test("connects to correct URL", () => {
    const mockWS = mock((url: string) => {
      expect(url).toMatch(/\/api\/sessions\/test-session\/ws$/);
      return { onopen: null, onmessage: null, onclose: null, onerror: null };
    });

    // Would need to mock WebSocket constructor
  });

  test("calls onMessage when message received", () => {
    const onMessage = mock(() => {});

    // Simulate receiving a message event
    const data = { type: "message", messages: [{ role: "user", content_blocks: [] }], index: 0 };

    // Would call handleMessage with data
    // expect(onMessage).toHaveBeenCalledWith(data.messages);
  });

  test("reconnects on unexpected close", () => {
    // Simulate close event with non-1000 code
    // Verify reconnection attempt
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/client/hooks/useWebSocket.ts` | Create | WebSocket subscription hook |
| `src/components/LiveIndicator.ts` | Create | Pulsing live indicator |
| `src/components/ConnectionStatus.ts` | Create | Connection status display |
| `src/components/NewMessagesButton.ts` | Create | New messages button |
| `src/components/TypingIndicator.ts` | Create | Typing/working indicator |
| `src/components/ToolCallBlock.ts` | Modify | Add pending state |
| `src/components/SessionDetail.ts` | Modify | Add live header |
| `src/components/SessionList.ts` | Modify | Add live sessions section |
| `src/components/ConversationPanel.ts` | Modify | Add message appending |
| `src/client/views.ts` | Modify | Wire up live features |
| `public/styles.css` | Modify | Add animations |

## Acceptance Criteria

- [ ] Live sessions show pulsing live indicator in header
- [ ] WebSocket connection is established for live sessions
- [ ] Connection status is displayed (connected/reconnecting)
- [ ] New messages appear in real-time without page refresh
- [ ] Auto-scroll works when user is at bottom
- [ ] "New messages" button appears when scrolled up
- [ ] Clicking "New messages" scrolls to bottom and hides button
- [ ] Pending tool calls show spinner/dots
- [ ] Tool results update in place when received
- [ ] Typing indicator shows when tool calls are pending
- [ ] Session status updates to "complete" when session ends
- [ ] Reconnection works after brief disconnection
- [ ] Live sessions appear in dedicated section on homepage
- [ ] Duration shows "started Xm ago" format
- [ ] All animations are smooth and non-distracting
