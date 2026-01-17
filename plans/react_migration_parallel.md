# React Migration - Parallel Implementation Plan

This plan is designed for maximum parallelization using subagents. Each "Wave" represents a set of tasks that can run concurrently. Tasks within a wave have no dependencies on each other.

## Dependency Graph

```
Foundation (Wave 0)
    │
    ├── useLiveSession ──────────────────────────────┐
    ├── useClipboard + useToast ─────────────────────┤
    │                                                │
    ├── ThinkingBlock ───────────────┐               │
    ├── TextBlock ───────────────────┼── MessageBlock┼── MessageList ──┐
    ├── ToolBlock ───────────────────┘               │                 │
    │                                                │                 │
    └── DiffBlock ───────── DiffPanel ───────────────┘                 │
                                                                       │
    SessionListPage ─────────────────────────────────┐                 │
                                                     └── SessionDetailPage
                                                                       │
                                                              App.tsx + main.tsx
                                                                       │
                                                                   Cleanup
```

---

## Wave 0: Foundation (Sequential - Must Complete First)

**Single agent task - blocks everything else**

### Task 0.1: Update Dependencies and Config

1. **Update `package.json`** - Add React dependencies:
   ```json
   {
     "dependencies": {
       "react": "^18.3.1",
       "react-dom": "^18.3.1",
       "react-router-dom": "^6.28.0"
     },
     "devDependencies": {
       "@types/react": "^18.3.16",
       "@types/react-dom": "^18.3.5"
     }
   }
   ```

2. **Update `tsconfig.json`**:
   - Change `jsxImportSource` from `"@jsx"` to `"react"`
   - Remove the custom path aliases for `@jsx/jsx-runtime` and `@jsx/jsx-dev-runtime`

3. **Create directory**: `src/client/hooks/`

4. **Run**: `bun install`

5. **Verify**: TypeScript should compile without JSX errors

**Estimated time**: 5 minutes

---

## Wave 1: Independent Units (5 Parallel Agents)

All tasks in this wave can run simultaneously. No dependencies between them.

### Agent 1A: useLiveSession Hook

**File**: `src/client/hooks/useLiveSession.ts`

**Purpose**: Wrap `LiveSessionManager` class for React use with `useEffect` cleanup

**Implementation**:
```typescript
import { useState, useEffect, useRef, useCallback } from 'react';
import { LiveSessionManager, type LiveSessionCallbacks } from '../liveSession';
import type { Message } from '../../db/schema';

interface UseLiveSessionOptions {
  sessionId: string;
  enabled: boolean;
  initialMessages: Message[];
}

interface LiveSessionState {
  messages: Message[];
  isConnected: boolean;
  pendingToolCalls: Set<string>;
  isInteractive: boolean;
  claudeState: 'running' | 'waiting' | 'unknown';
}

export function useLiveSession(options: UseLiveSessionOptions) {
  // State management
  // Ref to LiveSessionManager
  // useEffect for connection lifecycle
  // Callbacks for message handling
  // Return state + sendFeedback method
}
```

**Key patterns**:
- Use `useRef` for LiveSessionManager instance
- Use `useEffect` with cleanup to call `manager.destroy()`
- Use `useCallback` for sendFeedback to maintain stable reference
- Dispatch state updates via `useState` setters

---

### Agent 1B: useClipboard + useToast Hooks

**Files**:
- `src/client/hooks/useClipboard.ts`
- `src/client/hooks/useToast.ts`

**useClipboard**:
```typescript
export function useClipboard() {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  return { copy, copied };
}
```

**useToast**:
```typescript
// Simple toast context/hook
export function useToast() {
  return useCallback((message: string, type: 'success' | 'error' | 'info' = 'success') => {
    // Create and append toast element
    // Auto-remove after 3s
  }, []);
}
```

Also create `src/client/hooks/index.ts` to re-export all hooks.

---

### Agent 1C: ThinkingBlock Component

**File**: `src/client/components/ThinkingBlock.tsx`

**Convert from**:
```typescript
class ThinkingBlock extends Component<Props, State> {
  constructor() { super(props, { expanded: false }); }
  render() { return <div>...</div> as HTMLElement; }
  toggle() { this.setState({ expanded: !this.state.expanded }); }
}
```

**Convert to**:
```typescript
import { useState } from 'react';
import type { ThinkingBlock as ThinkingBlockType } from '../../db/schema';

interface ThinkingBlockProps {
  block: ThinkingBlockType;
}

export function ThinkingBlock({ block }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const duration = block.duration_ms
    ? `(${(block.duration_ms / 1000).toFixed(1)}s)`
    : '';

  return (
    <div className="thinking-block">
      <button
        className="flex items-center gap-1.5 text-text-muted text-[13px] hover:text-text-secondary pr-1.5 py-0.5 -ml-0.5 rounded hover:bg-bg-elevated transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {/* ... icon and text ... */}
        <span className="toggle-icon text-[10px]">{expanded ? '▼' : '▶'}</span>
      </button>
      <div className={`mt-1 pl-5 text-[13px] text-text-secondary leading-snug ${expanded ? '' : 'hidden'}`}>
        {block.thinking}
      </div>
    </div>
  );
}
```

---

### Agent 1D: TextBlock Component

**File**: `src/client/components/TextBlock.tsx`

**Key changes**:
- Replace `onDidRender()` with `useEffect` for syntax highlighting
- Use `useRef` for the container element
- Keep helper methods as regular functions inside component

```typescript
import { useEffect, useRef } from 'react';
import { formatMarkdown, stripSystemTags } from '../blocks';

interface TextBlockProps {
  text: string;
}

export function TextBlock({ text }: TextBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Check for command/skill prompt
  const commandInfo = extractCommandInfo(text);

  useEffect(() => {
    if (containerRef.current) {
      initializeCodeBlocks(containerRef.current);
    }
  }, [text]);

  if (commandInfo) {
    return <CommandBlock info={commandInfo} />;
  }

  const cleaned = stripSystemTags(text);
  if (!cleaned.trim()) {
    return <div className="text-block hidden" />;
  }

  return (
    <div
      ref={containerRef}
      className="text-block"
      dangerouslySetInnerHTML={{ __html: formatMarkdown(cleaned) }}
    />
  );
}

// Helper: CommandBlock sub-component with its own state
function CommandBlock({ info }: { info: { name: string; output: string } }) {
  const [expanded, setExpanded] = useState(false);
  // ...
}
```

---

### Agent 1E: ToolBlock + DiffBlock Components

**Files**:
- `src/client/components/ToolBlock.tsx`
- `src/client/components/DiffBlock.tsx`

**ToolBlock** - Complex component with multiple render paths:
- Replace `this.state.expanded` with `useState`
- Replace `this.toggle()` with state setter
- Keep switch-case render logic as separate sub-components
- Use `useCallback` for copy handlers

**DiffBlock** - Has @pierre/diffs integration:
- Replace `onDidRender()` with `useEffect` for lazy diff rendering
- Replace `onUnmount()` cleanup with `useEffect` return function
- Use `useRef` for diffInstance and container

```typescript
import { useState, useEffect, useRef } from 'react';

export function DiffBlock({ diffId, filename, diffContent, ... }: DiffBlockProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded ?? false);
  const diffInstanceRef = useRef<FileDiff | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded && !diffInstanceRef.current && containerRef.current) {
      renderDiff();
    }
  }, [expanded]);

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      diffInstanceRef.current?.cleanUp();
    };
  }, []);

  // ... render logic
}
```

---

## Wave 2: First Container Components (2 Parallel Agents)

**Depends on**: Wave 1 completion (specifically 1C, 1D, 1E for components)

### Agent 2A: MessageBlock Component

**File**: `src/client/components/MessageBlock.tsx`

**Key changes**:
- Replace `addChild()` pattern with JSX composition
- Import and render child components directly in JSX
- Replace `this.$$()` selector with `useRef`

```typescript
import { useState, useCallback } from 'react';
import { TextBlock } from './TextBlock';
import { ToolBlock } from './ToolBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { useClipboard } from '../hooks';

export function MessageBlock({ message, toolResults, showRoleBadge, messageIndex }: Props) {
  const { copy, copied } = useClipboard();

  const renderContentBlock = (block: ContentBlock) => {
    switch (block.type) {
      case 'text':
        return <TextBlock key={block.id} text={block.text} />;
      case 'tool_use':
        return <ToolBlock key={block.id} block={block} result={toolResults.get(block.id)} />;
      case 'thinking':
        return <ThinkingBlock key={block.id} block={block} />;
      // ... other cases
    }
  };

  return (
    <div className={`message group relative ${isAssistant ? 'bg-bg-secondary' : ''} rounded-lg p-4`}>
      {showRoleBadge && <div className="text-xs text-text-muted mb-2">{...}</div>}
      <div className="message-content">
        {message.content_blocks?.map(renderContentBlock)}
      </div>
      <button onClick={() => handleCopy()} className="copy-message ...">
        {copied ? 'Copied!' : <CopyIcon />}
      </button>
    </div>
  );
}
```

---

### Agent 2B: DiffPanel Component

**File**: `src/client/components/DiffPanel.tsx`

**Key changes**:
- Replace `addChild()` with mapping over diffs in JSX
- Use local state for `otherExpanded` toggle

```typescript
import { useState } from 'react';
import { DiffBlock } from './DiffBlock';

export function DiffPanel({ diffs, annotationsByDiff, review }: Props) {
  const [otherExpanded, setOtherExpanded] = useState(false);

  const sessionDiffs = diffs.filter(d => d.is_session_relevant);
  const otherDiffs = diffs.filter(d => !d.is_session_relevant);

  return (
    <div className="flex flex-col bg-bg-secondary ...">
      <div className="header">...</div>
      <div className="flex-1 overflow-y-auto">
        {sessionDiffs.length > 0 && (
          <div className="diff-group">
            <div className="sticky-header">Changed in this session ({sessionDiffs.length})</div>
            {sessionDiffs.map(diff => (
              <DiffBlock
                key={diff.id}
                diffId={diff.id}
                filename={diff.filename}
                // ... other props
                initiallyExpanded={!isLargeDiff(diff)}
              />
            ))}
          </div>
        )}

        {otherDiffs.length > 0 && (
          <div className="diff-group">
            <button onClick={() => setOtherExpanded(!otherExpanded)}>
              Other branch changes ({otherDiffs.length})
            </button>
            {otherExpanded && otherDiffs.map(diff => (
              <DiffBlock key={diff.id} {...diffProps} initiallyExpanded={false} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## Wave 3: MessageList + SessionListPage (2 Parallel Agents)

**Depends on**: Wave 2A (MessageBlock) and Wave 1A (useLiveSession)

### Agent 3A: MessageList Component

**File**: `src/client/components/MessageList.tsx`

**Most complex migration** - has WebSocket integration:

```typescript
import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageBlock } from './MessageBlock';
import { useLiveSession } from '../hooks/useLiveSession';
import { buildToolResultMap } from '../blocks';
import { isNearBottom, scrollToBottom } from '../liveSession';

interface MessageListProps {
  sessionId: string;
  initialMessages: Message[];
  session: Session;
  isLive: boolean;
  onSessionComplete?: () => void;
  onConnectionChange?: (connected: boolean) => void;
  onDiffUpdate?: () => void;
  onInteractiveInfo?: (interactive: boolean, claudeState: string) => void;
  // ... other event callbacks
}

export function MessageList({ sessionId, initialMessages, isLive, ...callbacks }: Props) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showNewMessagesButton, setShowNewMessagesButton] = useState(false);

  // Use the live session hook
  const {
    messages,
    isConnected,
    pendingToolCalls,
    sendFeedback,
    isComplete,
  } = useLiveSession({
    sessionId,
    enabled: isLive,
    initialMessages,
    onComplete: callbacks.onSessionComplete,
    onConnectionChange: callbacks.onConnectionChange,
    onDiffUpdate: callbacks.onDiffUpdate,
    // ... other callbacks
  });

  // Build tool result map
  const toolResults = useMemo(() => {
    const allBlocks = messages.flatMap(m => m.content_blocks || []);
    return buildToolResultMap(allBlocks);
  }, [messages]);

  // Scroll handling
  const handleScroll = useCallback(() => {
    if (scrollContainerRef.current && isNearBottom(scrollContainerRef.current)) {
      setShowNewMessagesButton(false);
    }
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollContainerRef.current && isNearBottom(scrollContainerRef.current)) {
      scrollToBottom(scrollContainerRef.current);
    } else if (messages.length > initialMessages.length) {
      setShowNewMessagesButton(true);
    }
  }, [messages.length]);

  return (
    <div className="message-list-container relative h-full">
      <div ref={scrollContainerRef} className="conversation-list ..." onScroll={handleScroll}>
        {messages.map((message, i) => (
          <MessageBlock
            key={message.id || i}
            message={message}
            toolResults={toolResults}
            showRoleBadge={i === 0 || message.role !== messages[i-1]?.role}
            messageIndex={i}
          />
        ))}

        {/* Typing indicator */}
        {pendingToolCalls.size > 0 && <TypingIndicator />}
      </div>

      {showNewMessagesButton && (
        <button onClick={() => scrollToBottom(scrollContainerRef.current!)}>
          ↓ New messages
        </button>
      )}
    </div>
  );
}

// Expose sendFeedback via ref or context for parent to use
```

---

### Agent 3B: SessionListPage Component

**File**: `src/client/components/SessionListPage.tsx`

**Simpler migration** - mainly state for search filter:

```typescript
import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { stripSystemTags } from '../blocks';

export function SessionListPage({ sessions }: { sessions: Session[] }) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredSessions = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return sessions.filter(session => {
      const title = (session.title || '').toLowerCase();
      const description = (session.description || '').toLowerCase();
      const project = (session.project_path || '').toLowerCase();
      return title.includes(q) || description.includes(q) || project.includes(q);
    });
  }, [sessions, searchQuery]);

  return (
    <div className="session-list-page max-w-[1400px] mx-auto px-6 lg:px-10 py-8">
      <div className="flex items-center justify-between gap-6 mb-8">
        <h1>Sessions</h1>
        <input
          type="search"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="sessions-grid ...">
        {filteredSessions.map(session => (
          <Link
            key={session.id}
            to={`/sessions/${encodeURIComponent(session.id)}`}
            className="session-card ..."
          >
            {/* Session card content */}
          </Link>
        ))}
      </div>
    </div>
  );
}
```

**Key change**: Replace `<a href="..." data-link>` with React Router `<Link to="...">`.

---

## Wave 4: SessionDetailPage (Single Agent)

**Depends on**: Wave 2B (DiffPanel) and Wave 3A (MessageList)

### Agent 4A: SessionDetailPage Component

**File**: `src/client/components/SessionDetailPage.tsx`

**Largest component** - orchestrates child components:

```typescript
import { useState, useCallback, useRef } from 'react';
import { MessageList } from './MessageList';
import { DiffPanel } from './DiffPanel';
import { useToast, useClipboard } from '../hooks';

interface SessionDetailPageProps {
  session: Session;
  messages: Message[];
  diffs: Diff[];
  shareUrl: string | null;
  review?: Review | null;
  annotationsByDiff: Record<number, Annotation[]>;
}

export function SessionDetailPage(props: SessionDetailPageProps) {
  const { session, messages, diffs, shareUrl, review, annotationsByDiff } = props;

  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'reconnecting'>('disconnected');
  const [sessionStatus, setSessionStatus] = useState<'live' | 'complete'>(session.status === 'live' ? 'live' : 'complete');
  const [interactiveState, setInteractiveState] = useState({
    isInteractive: session.interactive ?? false,
    claudeState: 'unknown' as const,
    sessionComplete: session.status !== 'live',
    pendingFeedback: [] as Array<{ id: string; status: string }>,
  });
  const [currentDiffs, setCurrentDiffs] = useState(diffs);

  const messageListRef = useRef<{ sendFeedback: (content: string) => void }>(null);
  const toast = useToast();
  const { copy } = useClipboard();

  const isLive = sessionStatus === 'live';
  const hasDiffs = currentDiffs.length > 0;

  // Callbacks for MessageList events
  const handleSessionComplete = useCallback(() => {
    setSessionStatus('complete');
    setInteractiveState(s => ({ ...s, sessionComplete: true }));
  }, []);

  const handleConnectionChange = useCallback((connected: boolean) => {
    setConnectionStatus(connected ? 'connected' : 'disconnected');
  }, []);

  const handleDiffUpdate = useCallback(async () => {
    const res = await fetch(`/api/sessions/${session.id}/diffs`);
    if (res.ok) {
      const data = await res.json();
      setCurrentDiffs(data.diffs || []);
    }
  }, [session.id]);

  // ... rest of the component

  return (
    <div className="session-detail-page" data-session-is-live={String(isLive)}>
      <Header ... />

      <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-6">
        <div className={gridClass}>
          <div className="conversation-panel-container">
            <MessageList
              ref={messageListRef}
              sessionId={session.id}
              initialMessages={messages}
              session={session}
              isLive={isLive}
              onSessionComplete={handleSessionComplete}
              onConnectionChange={handleConnectionChange}
              onDiffUpdate={handleDiffUpdate}
              onInteractiveInfo={(interactive, claudeState) => {
                setInteractiveState(s => ({ ...s, isInteractive: interactive, claudeState }));
              }}
              // ... other callbacks
            />
          </div>

          {(isLive || hasDiffs) && (
            <div className="diff-panel-container">
              <DiffPanel
                diffs={currentDiffs}
                annotationsByDiff={annotationsByDiff}
                review={review || null}
              />
            </div>
          )}
        </div>
      </div>

      {interactiveState.isInteractive && isLive && (
        <FeedbackInput
          onSubmit={(content) => messageListRef.current?.sendFeedback(content)}
          claudeState={interactiveState.claudeState}
          pendingFeedback={interactiveState.pendingFeedback}
        />
      )}
    </div>
  );
}
```

---

## Wave 5: Router and Entry Point (Single Agent)

**Depends on**: Wave 3B (SessionListPage) and Wave 4A (SessionDetailPage)

### Agent 5A: App.tsx + main.tsx + Server Update

**Files**:
- `src/client/App.tsx`
- `src/client/main.tsx`

**App.tsx**:
```typescript
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { SessionListPage } from './components/SessionListPage';
import { SessionDetailPage } from './components/SessionDetailPage';
import { ComponentsShowcase } from './views';

// Data fetching functions (moved from index.ts)
async function fetchSessions() { ... }
async function fetchSessionDetail(id: string) { ... }
async function fetchSharedSession(shareToken: string) { ... }
async function fetchAnnotations(sessionId: string) { ... }

// Loader components
function SessionListLoader() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSessions().then(data => {
      setSessions(data);
      setLoading(false);
    });
  }, []);

  if (loading) return <LoadingSpinner />;
  return <SessionListPage sessions={sessions} />;
}

function SessionDetailLoader() {
  const { id } = useParams();
  // ... similar pattern
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SessionListLoader />} />
        <Route path="/sessions/:id" element={<SessionDetailLoader />} />
        <Route path="/s/:shareToken" element={<SharedSessionLoader />} />
        <Route path="/_components" element={<ComponentsShowcase />} />
      </Routes>
    </BrowserRouter>
  );
}
```

**main.tsx**:
```typescript
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Global utilities (toast, clipboard)
import './globals';

const container = document.getElementById('app')!;
const root = createRoot(container);
root.render(<App />);
```

**Server HTML template update**:
- Change script src from `index.ts` to `main.tsx`

---

## Wave 6: Cleanup and Verification (Single Agent)

**Depends on**: Wave 5 completion and successful testing

### Agent 6A: Delete Old Files + Test

1. **Delete obsolete files**:
   - `src/client/component.ts`
   - `src/client/jsx-runtime.ts`
   - `src/client/jsx-dev-runtime.ts`
   - `src/client/router.ts`
   - `src/client/index.ts`

2. **Keep utility files**:
   - `src/client/blocks.ts` (formatMarkdown, icons, etc.)
   - `src/client/liveSession.ts` (LiveSessionManager class - used by hook)

3. **Verify all routes work**:
   - `/` - Session list with search
   - `/sessions/:id` - Session detail with WebSocket
   - `/s/:shareToken` - Shared session view
   - `/_components` - Component showcase

4. **Test interactions**:
   - Expand/collapse thinking blocks
   - Copy code to clipboard
   - Search/filter sessions
   - Live session streaming
   - Diff panel expand/collapse

---

## Parallelization Summary

| Wave | Agents | Tasks | Depends On |
|------|--------|-------|------------|
| 0 | 1 | Foundation setup | - |
| 1 | 5 | useLiveSession, useClipboard/useToast, ThinkingBlock, TextBlock, ToolBlock/DiffBlock | Wave 0 |
| 2 | 2 | MessageBlock, DiffPanel | Wave 1 |
| 3 | 2 | MessageList, SessionListPage | Wave 2A, Wave 1A-B |
| 4 | 1 | SessionDetailPage | Wave 2B, Wave 3A |
| 5 | 1 | App.tsx, main.tsx, server | Wave 3B, Wave 4 |
| 6 | 1 | Cleanup + verification | Wave 5 |

**Total parallel speedup**: ~3x faster than sequential execution

---

## Agent Task Specifications

For spawning subagents, use these task descriptions:

### Wave 1 Tasks (spawn all 5 in parallel)

```
Agent 1A: "Create useLiveSession React hook wrapping LiveSessionManager"
Agent 1B: "Create useClipboard and useToast React hooks"
Agent 1C: "Convert ThinkingBlock from class to functional React component"
Agent 1D: "Convert TextBlock from class to functional React component with useEffect for syntax highlighting"
Agent 1E: "Convert ToolBlock and DiffBlock from class to functional React components"
```

### Wave 2 Tasks (spawn both in parallel)

```
Agent 2A: "Convert MessageBlock to React, composing ThinkingBlock/TextBlock/ToolBlock as JSX children"
Agent 2B: "Convert DiffPanel to React, composing DiffBlock children in JSX"
```

### Wave 3 Tasks (spawn both in parallel)

```
Agent 3A: "Convert MessageList to React using useLiveSession hook, with proper scroll handling"
Agent 3B: "Convert SessionListPage to React with React Router Link components"
```

### Wave 4-6 Tasks (sequential)

```
Agent 4A: "Convert SessionDetailPage to React, orchestrating MessageList and DiffPanel"
Agent 5A: "Create React App.tsx with React Router, main.tsx entry point, update server HTML"
Agent 6A: "Delete old component system files, verify all routes work"
```

---

## File Checklist

### Files to Create
- [ ] `src/client/hooks/useLiveSession.ts`
- [ ] `src/client/hooks/useClipboard.ts`
- [ ] `src/client/hooks/useToast.ts`
- [ ] `src/client/hooks/index.ts`
- [ ] `src/client/App.tsx`
- [ ] `src/client/main.tsx`
- [ ] `src/client/globals.ts` (toast/clipboard globals)

### Files to Modify
- [ ] `package.json` - Add React deps
- [ ] `tsconfig.json` - Change jsxImportSource
- [ ] `src/client/components/ThinkingBlock.tsx`
- [ ] `src/client/components/TextBlock.tsx`
- [ ] `src/client/components/ToolBlock.tsx`
- [ ] `src/client/components/DiffBlock.tsx`
- [ ] `src/client/components/MessageBlock.tsx`
- [ ] `src/client/components/DiffPanel.tsx`
- [ ] `src/client/components/MessageList.tsx`
- [ ] `src/client/components/SessionListPage.tsx`
- [ ] `src/client/components/SessionDetailPage.tsx`
- [ ] Server HTML template (script src)

### Files to Delete (Wave 6)
- [ ] `src/client/component.ts`
- [ ] `src/client/jsx-runtime.ts`
- [ ] `src/client/jsx-dev-runtime.ts`
- [ ] `src/client/router.ts`
- [ ] `src/client/index.ts`

### Files to Keep
- [x] `src/client/blocks.ts` (utilities)
- [x] `src/client/liveSession.ts` (WebSocket manager)
- [x] `src/client/views.ts` (ComponentsShowcase)
