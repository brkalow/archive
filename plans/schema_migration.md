# Implementation Plan: Schema Migration

This plan covers migrating the database schema to support structured message content and diff relevance filtering. This was planned as part of the `/specs/session_detail_view.md` spec.

## Overview

**Current state:**

- `messages.content` stores flat text, losing tool call structure
- `diffs` table has no relevance indicator
- Parser flattens content arrays to strings

**Target state:**

- `messages.content_blocks` stores JSON array of content blocks
- `diffs.is_session_relevant` indicates if file was touched in conversation
- Parser preserves full content structure

## Files to Modify

| File                   | Changes                                |
| ---------------------- | -------------------------------------- |
| `src/db/schema.ts`     | Add columns, update types              |
| `src/db/repository.ts` | Update prepared statements             |
| `src/routes/api.ts`    | Update parser, add relevance detection |

## Step 1: Update Schema Types

**File: `src/db/schema.ts`**

Add new types for content blocks:

```typescript
// Content block types (matches Claude API structure)
export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  duration_ms?: number;
};

export type ImageBlock = {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
  filename?: string;
};

export type FileBlock = {
  type: "file";
  filename: string;
  media_type?: string;
  size?: number;
};

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ImageBlock
  | FileBlock;
```

Update Message type:

```typescript
export type Message = {
  id: number;
  session_id: string;
  role: string; // 'user' | 'assistant'
  content: string; // Keep for backward compat, derived from content_blocks
  content_blocks: ContentBlock[]; // New: structured content
  timestamp: string | null;
  message_index: number;
};
```

Update Diff type:

```typescript
export type Diff = {
  id: number;
  session_id: string;
  filename: string | null;
  diff_content: string;
  diff_index: number;
  additions: number; // New: pre-computed
  deletions: number; // New: pre-computed
  is_session_relevant: boolean; // New: true if touched in conversation
};
```

## Step 2: Database Migration

**File: `src/db/schema.ts`**

Add safe migration helper and run migrations:

```typescript
function safeAddColumn(
  db: Database,
  table: string,
  column: string,
  definition: string
) {
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    // Column already exists, ignore
  }
}

// In initializeDatabase, after CREATE TABLE statements:
safeAddColumn(db, "messages", "content_blocks", "TEXT DEFAULT '[]'");
safeAddColumn(db, "diffs", "additions", "INTEGER DEFAULT 0");
safeAddColumn(db, "diffs", "deletions", "INTEGER DEFAULT 0");
safeAddColumn(db, "diffs", "is_session_relevant", "INTEGER DEFAULT 1");
```

## Step 3: Update Repository

**File: `src/db/repository.ts`**

Update prepared statements:

```typescript
insertMessage: db.prepare(`
  INSERT INTO messages (session_id, role, content, content_blocks, timestamp, message_index)
  VALUES (?, ?, ?, ?, ?, ?)
`),

insertDiff: db.prepare(`
  INSERT INTO diffs (session_id, filename, diff_content, diff_index, additions, deletions, is_session_relevant)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`),
```

Update `addMessage`:

```typescript
addMessage(message: Omit<Message, "id">): void {
  this.stmts.insertMessage.run(
    message.session_id,
    message.role,
    message.content,
    JSON.stringify(message.content_blocks || []),
    message.timestamp,
    message.message_index
  );
}
```

Update `getMessages` to parse JSON:

```typescript
getMessages(sessionId: string): Message[] {
  const rows = this.stmts.getMessages.all(sessionId) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    ...row,
    content_blocks: JSON.parse((row.content_blocks as string) || '[]'),
  })) as Message[];
}
```

Update `addDiff`:

```typescript
addDiff(diff: Omit<Diff, "id">): void {
  this.stmts.insertDiff.run(
    diff.session_id,
    diff.filename,
    diff.diff_content,
    diff.diff_index,
    diff.additions || 0,
    diff.deletions || 0,
    diff.is_session_relevant ? 1 : 0
  );
}
```

Update `getDiffs`:

```typescript
getDiffs(sessionId: string): Diff[] {
  const rows = this.stmts.getDiffs.all(sessionId) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    ...row,
    is_session_relevant: Boolean(row.is_session_relevant),
  })) as Diff[];
}
```

## Step 4: Update Parser

**File: `src/routes/api.ts`**

Add helper functions:

```typescript
function parseContentBlock(
  block: Record<string, unknown>
): ContentBlock | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text as string };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id as string,
        name: block.name as string,
        input: block.input as Record<string, unknown>,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id as string,
        content:
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content),
        is_error: block.is_error as boolean | undefined,
      };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking as string,
        duration_ms: block.duration_ms as number | undefined,
      };
    case "image":
      return {
        type: "image",
        source: block.source as ImageBlock["source"],
        filename: block.filename as string | undefined,
      };
    default:
      return null;
  }
}

function deriveTextContent(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `[Tool: ${block.name}]`;
      if (block.type === "tool_result") return `[Tool Result]`;
      if (block.type === "thinking") return `[Thinking]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
```

Update `extractMessage` to return structured content:

```typescript
function extractMessage(
  item: Record<string, unknown>,
  sessionId: string,
  index: number
): Omit<Message, "id"> | null {
  let role: string | null = null;
  let contentBlocks: ContentBlock[] = [];
  let timestamp: string | null = null;

  // Handle message wrapper format (Claude Code JSONL)
  const msgData = (item.message as Record<string, unknown>) || item;

  // Extract role
  if (
    msgData.role === "human" ||
    msgData.role === "user" ||
    item.type === "human" ||
    item.type === "user"
  ) {
    role = "user";
  } else if (msgData.role === "assistant" || item.type === "assistant") {
    role = "assistant";
  }

  if (!role) return null;

  // Extract content blocks
  const content = msgData.content;
  if (typeof content === "string") {
    contentBlocks = [{ type: "text", text: content }];
  } else if (Array.isArray(content)) {
    contentBlocks = content
      .map(parseContentBlock)
      .filter(Boolean) as ContentBlock[];
  }

  // Timestamp
  if (item.timestamp) timestamp = String(item.timestamp);
  else if (item.created_at) timestamp = String(item.created_at);

  if (contentBlocks.length === 0) return null;

  return {
    session_id: sessionId,
    role,
    content: deriveTextContent(contentBlocks),
    content_blocks: contentBlocks,
    timestamp,
    message_index: index,
  };
}
```

Update `parseSessionData` to handle tool_result merging:

```typescript
function parseSessionData(
  content: string,
  sessionId: string
): Omit<Message, "id">[] {
  const messages: Omit<Message, "id">[] = [];
  const trimmed = content.trim();
  const items: Array<Record<string, unknown>> = [];

  // Parse all items
  if (trimmed.startsWith("[")) {
    try {
      items.push(...JSON.parse(trimmed));
    } catch {}
  } else {
    for (const line of trimmed.split("\n")) {
      if (!line.trim()) continue;
      try {
        items.push(JSON.parse(line));
      } catch {}
    }
  }

  // Collect tool_results separately
  const toolResults = new Map<string, ToolResultBlock>();

  for (const item of items) {
    if (item.type === "tool_result") {
      const block: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: item.tool_use_id as string,
        content:
          typeof item.content === "string"
            ? item.content
            : JSON.stringify(item.content),
        is_error: item.is_error as boolean | undefined,
      };
      toolResults.set(block.tool_use_id, block);
    }
  }

  // Process messages and attach tool_results
  let messageIndex = 0;
  for (const item of items) {
    if (item.type === "tool_result") continue;

    const msg = extractMessage(item, sessionId, messageIndex);
    if (!msg) continue;

    // Find tool_use blocks and attach their results
    const toolUseIds = msg.content_blocks
      .filter((b): b is ToolUseBlock => b.type === "tool_use")
      .map((b) => b.id);

    for (const id of toolUseIds) {
      const result = toolResults.get(id);
      if (result) {
        msg.content_blocks.push(result);
        toolResults.delete(id);
      }
    }

    // Re-derive text content after adding results
    msg.content = deriveTextContent(msg.content_blocks);

    messages.push(msg);
    messageIndex++;
  }

  return messages;
}
```

## Step 5: Diff Relevance Detection

**File: `src/routes/api.ts`**

Add touched files extraction:

```typescript
function extractTouchedFiles(messages: Omit<Message, "id">[]): Set<string> {
  const files = new Set<string>();

  for (const msg of messages) {
    for (const block of msg.content_blocks || []) {
      if (
        block.type === "tool_use" &&
        ["Write", "Edit", "NotebookEdit"].includes(block.name)
      ) {
        const input = block.input as Record<string, unknown>;
        const path = (input.file_path || input.notebook_path) as string;
        if (path) files.add(normalizePath(path));
      }
    }
  }

  return files;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+/g, "/");
}

function countDiffStats(content: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0,
    deletions = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}
```

Update `parseDiffData`:

```typescript
function parseDiffData(
  content: string,
  sessionId: string,
  touchedFiles?: Set<string>
): Omit<Diff, "id">[] {
  // ... existing parsing logic to extract diffs ...

  // For each diff, add stats and relevance
  return diffs.map((diff) => {
    const { additions, deletions } = countDiffStats(diff.diff_content);
    let isRelevant = true;

    if (touchedFiles && diff.filename) {
      const normalized = normalizePath(diff.filename);
      isRelevant =
        touchedFiles.has(normalized) ||
        Array.from(touchedFiles).some(
          (f) => f.endsWith(normalized) || normalized.endsWith(f)
        );
    }

    return {
      ...diff,
      additions,
      deletions,
      is_session_relevant: isRelevant,
    };
  });
}
```

Update session creation to pass touched files:

```typescript
// In createSession handler:
const messages = parseSessionData(sessionDataContent, id);
const touchedFiles = extractTouchedFiles(messages);
const diffs = parseDiffData(diffContent, id, touchedFiles);
```

## Testing

After implementation:

1. Delete existing `sessions.db` (or backup first)
2. Start dev server: `bun run dev`
3. Upload a test session with tool calls
4. Verify API response includes `content_blocks` array
5. Verify diffs include `additions`, `deletions`, `is_session_relevant`

## Rollout Order

1. Schema types (no runtime impact)
2. Database migrations (additive, safe)
3. Repository changes (handle both old/new data)
4. Parser changes (new sessions get structured data)
5. Test with fresh upload
