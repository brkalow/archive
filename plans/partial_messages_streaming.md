# Plan: Support for `--include-partial-messages` in Spawned Sessions

## Overview

Enable real-time token-by-token streaming in the UI by adding support for the Claude CLI's `--include-partial-messages` flag. This involves changes across the CLI daemon, server, and client.

## Current State

- CLI spawns Claude with `--output-format stream-json --input-format stream-json --verbose`
- Messages arrive as complete NDJSON objects (type: `system`, `assistant`, `user`, `result`)
- Each message has a complete `content: ContentBlock[]` array
- Client accumulates complete messages and renders them
- `SpawnableHarnessInfo` already has `supports_streaming: boolean` field (unused)

## Prerequisites

**Before implementation, verify actual CLI output format:**
```bash
claude -p "explain bloom filters" --output-format stream-json --include-partial-messages --verbose 2>/dev/null | head -50
```

Expected format (to be verified):
```json
{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A"}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" bloom"}}
{"type":"content_block_stop","index":0}
{"type":"assistant",...}  // Complete message at end
```

## Design Decisions

**1. Per-session streaming mode**
- Streaming is opt-in per session via `start_session.streaming: boolean`
- Required because TUI-driven/live sessions won't support this mode
- Daemon only adds `--include-partial-messages` when `streaming: true`
- Leverage existing `SpawnableHarnessInfo.supports_streaming` for capability check

**2. Server-side batching (not client-side)**
- Server batches deltas before forwarding to browsers (configurable, default 50ms)
- Reduces WebSocket message count significantly
- Client receives pre-batched updates, simpler rendering logic

**3. Stream text and thinking blocks**
- Both text and thinking content blocks are forwarded
- Skip tool_input streaming (small payloads, not useful for UX)
- UI shows thinking in real-time in expandable section

**4. Server caches current streaming state**
- Server maintains accumulated content for each streaming block
- Late-joining browsers receive current accumulated state on subscribe
- Cleared when complete message arrives

**5. Message ID-based transition**
- Streaming deltas have no message ID
- Complete `assistant` message has ID → signals end of streaming
- Client clears streaming state when complete message with ID arrives

## Data Flow

```
Claude CLI (with --include-partial-messages)
    │
    │ NDJSON: content_block_delta, content_block_start/stop, assistant
    ▼
SpawnedSessionManager (daemon)
    │
    │ Detects delta events, forwards as session_stream_delta
    │ Complete messages forwarded as session_output (existing)
    ▼
Server
    │
    │ Batches deltas (50ms window)
    │ Caches accumulated streaming content per session
    │ Broadcasts batched stream_delta to browsers
    │ Stores complete messages to DB (existing)
    ▼
Browser WebSocket
    │
    │ Receives: stream_delta (batched) or message (complete)
    ▼
useSpawnedSession hook
    │
    │ Accumulates streaming blocks in state
    │ Clears on complete message arrival
    ▼
SpawnedSessionView
    │
    │ Renders streaming "pending message" at end
    │ Shows typing cursor, partial markdown
```

## Implementation Plan

### Phase 0: Verify CLI Output Format

Run the CLI with `--include-partial-messages` and document actual event types:
- Confirm `content_block_delta` structure
- Check if thinking blocks use `thinking_delta` or different format
- Note any `content_block_start`/`content_block_stop` events

### Phase 1: Type Definitions

**Files:**
- `cli/types/daemon-ws.ts`
- `src/types/daemon-ws.ts`
- `src/types/browser-ws.ts`

```typescript
// Extend StartSessionMessage
interface StartSessionMessage {
  // existing fields...
  streaming?: boolean;  // Enable --include-partial-messages
}

// CLI output events (structure TBD based on Phase 0 verification)
interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: {
    type: "text_delta" | "thinking_delta";
    text?: string;
    thinking?: string;
  };
}

interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: { type: string };
}

interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

// Daemon -> Server
interface SessionStreamDelta {
  type: "session_stream_delta";
  session_id: string;
  deltas: Array<{
    block_index: number;
    block_type: "text" | "thinking";
    content: string;  // Delta text to append
  }>;
}

// Server -> Browser (in browser-ws.ts)
interface StreamDeltaMessage {
  type: "stream_delta";
  blocks: Map<number, { type: string; content: string }>;  // Accumulated content
}
```

### Phase 2: CLI Daemon Changes

**File:** `cli/lib/spawned-session-manager.ts`

1. Add `streaming` to `SpawnedSession` interface:
   ```typescript
   interface SpawnedSession {
     // existing...
     streaming: boolean;
     streamingBlocks: Map<number, { type: string; content: string }>;
   }
   ```

2. Conditionally add CLI flag:
   ```typescript
   if (request.streaming) {
     args.push("--include-partial-messages");
   }
   ```

3. In `streamOutput()`, detect streaming events:
   ```typescript
   // After JSON.parse(line)
   if (msg.type === "content_block_delta" && session.streaming) {
     this.handleStreamingDelta(session, msg);
     continue;  // Don't add to messages array
   }
   if (msg.type === "content_block_start" || msg.type === "content_block_stop") {
     continue;  // Skip start/stop markers
   }
   // Existing logic for complete messages...
   ```

4. Add `handleStreamingDelta()`:
   ```typescript
   private handleStreamingDelta(session: SpawnedSession, event: ContentBlockDeltaEvent) {
     const { index, delta } = event;
     const existing = session.streamingBlocks.get(index) || { type: delta.type, content: "" };
     existing.content += delta.text || delta.thinking || "";
     session.streamingBlocks.set(index, existing);

     this.sendToServer({
       type: "session_stream_delta",
       session_id: session.id,
       deltas: [{ block_index: index, block_type: existing.type, content: delta.text || delta.thinking || "" }],
     });
   }
   ```

5. Clear streaming state on complete `assistant` message:
   ```typescript
   if (msg.type === "assistant") {
     session.streamingBlocks.clear();
     // existing logic...
   }
   ```

### Phase 3: Server Changes

**File:** `src/server.ts`

1. Add streaming state to session tracking:
   ```typescript
   // In-memory cache of current streaming content per session
   const streamingCache = new Map<string, Map<number, { type: string; content: string }>>();
   ```

2. Add batching logic:
   ```typescript
   const STREAM_BATCH_INTERVAL_MS = 50;
   const pendingStreamDeltas = new Map<string, { deltas: StreamDelta[]; timer: Timer }>();

   function scheduleStreamBroadcast(sessionId: string, delta: StreamDelta) {
     let pending = pendingStreamDeltas.get(sessionId);
     if (!pending) {
       pending = { deltas: [], timer: setTimeout(() => flushStreamDeltas(sessionId), STREAM_BATCH_INTERVAL_MS) };
       pendingStreamDeltas.set(sessionId, pending);
     }
     pending.deltas.push(delta);
   }

   function flushStreamDeltas(sessionId: string) {
     const pending = pendingStreamDeltas.get(sessionId);
     if (!pending) return;
     pendingStreamDeltas.delete(sessionId);

     // Update cache
     const cache = streamingCache.get(sessionId) || new Map();
     for (const delta of pending.deltas) {
       const existing = cache.get(delta.block_index) || { type: delta.block_type, content: "" };
       existing.content += delta.content;
       cache.set(delta.block_index, existing);
     }
     streamingCache.set(sessionId, cache);

     // Broadcast accumulated state to browsers
     broadcastToSession(sessionId, {
       type: "stream_delta",
       blocks: Object.fromEntries(cache),
     });
   }
   ```

3. Handle `session_stream_delta` in `handleDaemonMessage()`:
   ```typescript
   case "session_stream_delta":
     for (const delta of message.deltas) {
       scheduleStreamBroadcast(message.session_id, delta);
     }
     break;
   ```

4. Clear streaming cache on complete message:
   ```typescript
   case "session_output":
     // Clear streaming cache when complete assistant message arrives
     if (message.messages.some(m => m.type === "assistant")) {
       streamingCache.delete(message.session_id);
       pendingStreamDeltas.delete(message.session_id);
     }
     // existing DB storage logic...
   ```

5. Send accumulated state on browser subscribe (for late joiners):
   ```typescript
   // In subscribe handler
   const streamingState = streamingCache.get(sessionId);
   if (streamingState && streamingState.size > 0) {
     ws.send(JSON.stringify({
       type: "stream_delta",
       blocks: Object.fromEntries(streamingState),
     }));
   }
   ```

### Phase 4: Client Hook Changes

**File:** `src/client/hooks/useSpawnedSession.ts`

1. Add streaming state:
   ```typescript
   const [streamingBlocks, setStreamingBlocks] = useState<Record<number, { type: string; content: string }>>({});
   ```

2. Handle `stream_delta` message:
   ```typescript
   case "stream_delta":
     setStreamingBlocks(data.blocks as Record<number, { type: string; content: string }>);
     break;
   ```

3. Clear streaming on complete message:
   ```typescript
   case "message":
     // Check if any message is complete assistant (has message.id)
     const hasCompleteAssistant = newMessages.some(
       m => m.type === "assistant" && m.message?.id
     );
     if (hasCompleteAssistant) {
       setStreamingBlocks({});
     }
     // existing logic...
   ```

4. Return streaming state:
   ```typescript
   return {
     // existing...
     streamingBlocks,
     isStreaming: Object.keys(streamingBlocks).length > 0,
   };
   ```

### Phase 5: Client Rendering Changes

**File:** `src/client/components/SpawnedSessionView.tsx`

1. Get streaming state from hook:
   ```typescript
   const { messages, streamingBlocks, isStreaming, ... } = useSpawnedSession({ ... });
   ```

2. Render streaming message at end:
   ```typescript
   {/* Existing messages */}
   {convertedMessages.map((msg) => <MessageBlock key={msg.id} ... />)}

   {/* Streaming message (in progress) */}
   {isStreaming && (
     <StreamingMessage blocks={streamingBlocks} />
   )}
   ```

**New File:** `src/client/components/StreamingMessage.tsx`

```typescript
interface StreamingMessageProps {
  blocks: Record<number, { type: string; content: string }>;
}

export function StreamingMessage({ blocks }: StreamingMessageProps) {
  const sortedBlocks = Object.entries(blocks)
    .sort(([a], [b]) => Number(a) - Number(b));

  return (
    <div className="message assistant streaming">
      {sortedBlocks.map(([index, block]) => (
        block.type === "text" ? (
          <StreamingTextBlock key={index} content={block.content} />
        ) : block.type === "thinking" ? (
          <StreamingThinkingBlock key={index} content={block.content} />
        ) : null
      ))}
    </div>
  );
}

function StreamingTextBlock({ content }: { content: string }) {
  return (
    <div className="text-block">
      <FormattedMarkdown text={content} />
      <span className="cursor-blink">▊</span>
    </div>
  );
}

function StreamingThinkingBlock({ content }: { content: string }) {
  return (
    <details className="thinking-block" open>
      <summary>Thinking...</summary>
      <pre>{content}</pre>
    </details>
  );
}
```

### Phase 6: API Integration

**File:** `src/routes/api.ts` (or session start handler)

1. Accept `streaming` parameter:
   ```typescript
   const streaming = body.streaming ?? true;  // Default to true for spawned sessions
   ```

2. Pass to daemon:
   ```typescript
   daemonConnections.sendToDaemon(daemonId, {
     type: "start_session",
     // existing fields...
     streaming,
   });
   ```

## Files to Modify

| File | Changes |
|------|---------|
| `cli/types/daemon-ws.ts` | Add `streaming` to `StartSessionMessage`, add streaming event types, add `SessionStreamDelta` |
| `src/types/daemon-ws.ts` | Mirror type additions |
| `src/types/browser-ws.ts` | Add `StreamDeltaMessage` type |
| `cli/lib/spawned-session-manager.ts` | Conditional flag, detect deltas, accumulate & forward |
| `src/server.ts` | Handle `session_stream_delta`, batch, cache, broadcast |
| `src/client/hooks/useSpawnedSession.ts` | Add `streamingBlocks` state, handle `stream_delta` |
| `src/client/components/SpawnedSessionView.tsx` | Render `StreamingMessage` component |
| `src/client/components/StreamingMessage.tsx` | **New file** - streaming message renderer |
| `src/routes/api.ts` | Accept `streaming` parameter |

## Edge Cases & Error Handling

| Scenario | Handling |
|----------|----------|
| Browser reconnects mid-stream | Server sends accumulated streaming state on subscribe |
| Session ends during streaming | Streaming cache cleared; partial content not persisted |
| Daemon disconnects mid-stream | Streaming cache cleared; browser shows disconnected state |
| Rapid consecutive messages | Server batching prevents message flood |
| Multiple content blocks | All blocks tracked by index, rendered in order |
| Complete message arrives before all deltas processed | Message ID signals completion; streaming state cleared |

## Testing Plan

1. **Phase 0 verification**: Manually run CLI with `--include-partial-messages`, document output format

2. **Unit tests** (`tests/daemon/spawned-session-manager.test.ts`):
   - Test delta event detection and accumulation
   - Test conditional `--include-partial-messages` flag
   - Test streaming state cleared on complete message

3. **Integration tests**:
   - Server batching logic
   - Cache cleared on session end
   - Late-joiner receives accumulated state

4. **Manual testing**:
   - Start spawned session with `streaming: true`
   - Verify text appears token-by-token
   - Verify thinking blocks stream
   - Open second browser tab mid-stream, verify it catches up
   - Verify complete messages in DB (not deltas)
   - Test with `streaming: false` - behavior unchanged

## Verification

After implementation:
1. Run `bun test` - all tests pass
2. Start dev server: `PORT=3001 bun run dev`
3. Start daemon, spawn streaming session
4. Observe real-time text appearance
5. Open DevTools Network tab, verify batched WebSocket messages (not per-token)
6. Check database contains only complete messages
7. Reconnect browser mid-stream, verify it catches up
