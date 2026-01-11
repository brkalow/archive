# Implementation Plan: Conversation Panel

Implement rich message rendering with content block types, collapsible tool calls, and special tool rendering.

**Spec reference:** `specs/session_detail_view.md` - Message Content Types, Special Tool Rendering, Timestamps, Copy Actions, etc.

**Depends on:** `plans/schema_migration.md` (needs `content_blocks` data)

## Overview

**Current state:**
- Flat text rendering with basic markdown
- Tool calls shown as `[Tool: name]` placeholders
- No collapsible sections

**Target state:**
- Render all content block types (text, tool_use, tool_result, thinking, image, file)
- Collapsible tool calls with inline results
- Special rendering for AskUserQuestion, TodoWrite, Task
- Timestamps on hover, copy buttons, truncation

## Files to Modify

| File | Changes |
|------|---------|
| `src/client/views.ts` | New message/block renderers |
| `src/client/index.ts` | Collapse toggle handlers |
| (new) `src/client/blocks.ts` | Content block rendering logic |

## Step 1: Create Block Renderer Module

**File: `src/client/blocks.ts`**

```typescript
import type { ContentBlock, ToolUseBlock, ToolResultBlock } from "../db/schema";
import { escapeHtml } from "./views";

// Map of tool_use_id to tool_result for inline rendering
type ToolResultMap = Map<string, ToolResultBlock>;

export function renderContentBlocks(
  blocks: ContentBlock[],
  toolResults: ToolResultMap
): string {
  const output: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        output.push(renderTextBlock(block.text));
        break;
      case "tool_use":
        output.push(renderToolUseBlock(block, toolResults.get(block.id)));
        break;
      case "tool_result":
        // Skip - rendered inline with tool_use
        break;
      case "thinking":
        output.push(renderThinkingBlock(block));
        break;
      case "image":
        output.push(renderImageBlock(block));
        break;
      case "file":
        output.push(renderFileBlock(block));
        break;
    }
  }

  return output.join('\n');
}

function renderTextBlock(text: string): string {
  return `<div class="text-block">${formatMarkdown(escapeHtml(text))}</div>`;
}

function formatMarkdown(text: string): string {
  let formatted = text;

  // Code blocks
  formatted = formatted.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    '<pre class="my-2 p-3 bg-bg-primary rounded-md overflow-x-auto relative group"><button class="copy-code absolute top-2 right-2 p-1 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg></button><code class="text-[13px] language-$1">$2</code></pre>'
  );

  // Inline code
  formatted = formatted.replace(
    /`([^`]+)`/g,
    '<code class="px-1.5 py-0.5 bg-bg-elevated rounded text-accent-primary text-[13px]">$1</code>'
  );

  // Bold
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Line breaks
  formatted = formatted.replace(/\n/g, '<br>');

  return formatted;
}
```

## Step 2: Tool Use Block Renderer

```typescript
function renderToolUseBlock(
  block: ToolUseBlock,
  result?: ToolResultBlock
): string {
  const summary = getToolSummary(block);
  const status = getToolStatus(result);
  const blockId = `tool-${block.id}`;

  return `
    <div class="tool-block my-2" data-tool-id="${block.id}">
      <button class="tool-header flex items-center gap-2 w-full text-left px-2 py-1.5 rounded hover:bg-bg-elevated transition-colors"
              data-toggle-tool="${blockId}">
        <span class="toggle-icon text-text-muted">▶</span>
        <span class="font-semibold text-accent-primary">${escapeHtml(block.name)}</span>
        <span class="font-mono text-sm text-text-muted truncate flex-1">${escapeHtml(summary)}</span>
        ${status}
      </button>
      <div id="${blockId}" class="tool-content hidden pl-6 mt-1">
        ${renderToolInput(block)}
        ${result ? renderToolResult(result) : '<div class="text-text-muted text-sm italic">⋯ pending</div>'}
      </div>
    </div>
  `;
}

function getToolSummary(block: ToolUseBlock): string {
  const input = block.input as Record<string, unknown>;

  switch (block.name) {
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path || '');
    case "Bash":
      const cmd = String(input.command || '');
      return cmd.length > 40 ? cmd.slice(0, 40) + '...' : cmd;
    case "Glob":
      return String(input.pattern || '');
    case "Grep":
      return String(input.pattern || '');
    case "Task":
      return String(input.description || input.prompt || '').slice(0, 40);
    case "WebFetch":
      return String(input.url || '');
    case "WebSearch":
      return String(input.query || '');
    default:
      return '';
  }
}

function getToolStatus(result?: ToolResultBlock): string {
  if (!result) {
    return '<span class="text-text-muted">⋯</span>';
  }
  if (result.is_error) {
    return '<span class="text-diff-del">✗</span>';
  }
  return '<span class="text-diff-add">✓</span>';
}

function renderToolInput(block: ToolUseBlock): string {
  const input = block.input as Record<string, unknown>;
  const entries = Object.entries(input)
    .filter(([_, v]) => v !== undefined && v !== null)
    .slice(0, 5); // Limit displayed fields

  if (entries.length === 0) return '';

  return `
    <div class="text-xs text-text-muted mb-2">
      <div class="font-semibold mb-1">Input:</div>
      ${entries.map(([k, v]) => `
        <div class="pl-2">
          <span class="text-text-secondary">${escapeHtml(k)}:</span>
          <span class="font-mono">${escapeHtml(truncateValue(v))}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function truncateValue(value: unknown): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return str.length > 100 ? str.slice(0, 100) + '...' : str;
}

function renderToolResult(result: ToolResultBlock): string {
  const content = result.content;
  const lines = content.split('\n');
  const lineCount = lines.length;
  const isLarge = lineCount > 100;
  const displayContent = isLarge ? lines.slice(0, 50).join('\n') : content;

  return `
    <div class="tool-result">
      <div class="text-xs text-text-muted mb-1">
        Result: ${result.is_error ? '<span class="text-diff-del">(error)</span>' : `(${lineCount} lines)`}
      </div>
      <div class="bg-bg-primary rounded p-2 overflow-x-auto max-h-64 overflow-y-auto">
        <pre class="text-xs font-mono whitespace-pre-wrap">${escapeHtml(displayContent)}</pre>
        ${isLarge ? `
          <button class="text-accent-primary text-xs hover:underline mt-2" data-show-all-result>
            Show all ${lineCount} lines
          </button>
        ` : ''}
      </div>
    </div>
  `;
}
```

## Step 3: Special Tool Renderers

```typescript
// AskUserQuestion
function renderAskUserQuestion(block: ToolUseBlock, result?: ToolResultBlock): string {
  const input = block.input as { questions?: Array<{ question: string }> };
  const questions = input.questions || [];

  // Parse result to get answers
  let answers: string[] = [];
  if (result?.content) {
    try {
      const parsed = JSON.parse(result.content);
      answers = Object.values(parsed.answers || parsed || {});
    } catch {
      answers = [result.content];
    }
  }

  return `
    <div class="bg-bg-tertiary/50 rounded-lg p-3 my-2">
      <div class="flex items-center gap-2 text-sm font-medium mb-2">
        <span>❓</span>
        <span>Question</span>
      </div>
      ${questions.map((q, i) => `
        <div class="mb-2">
          <div class="text-sm text-text-primary">${escapeHtml(q.question)}</div>
          ${answers[i] ? `
            <div class="flex items-center gap-1 mt-1">
              <span class="text-accent-primary">→</span>
              <span class="text-sm font-medium">${escapeHtml(answers[i])}</span>
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

// TodoWrite
function renderTodoWrite(block: ToolUseBlock): string {
  const input = block.input as { todos?: Array<{ content: string; status: string }> };
  const todos = input.todos || [];

  const statusIcon = (status: string) => {
    switch (status) {
      case 'completed': return '<span class="text-diff-add">✓</span>';
      case 'in_progress': return '<span class="text-accent-primary">●</span>';
      default: return '<span class="text-text-muted">○</span>';
    }
  };

  return `
    <div class="bg-bg-tertiary/50 rounded-lg p-3 my-2">
      <div class="flex items-center gap-2 text-sm font-medium mb-2">
        <span>📋</span>
        <span>Tasks</span>
      </div>
      <div class="space-y-1">
        ${todos.map(todo => `
          <div class="flex items-center gap-2 text-sm">
            ${statusIcon(todo.status)}
            <span class="${todo.status === 'completed' ? 'text-text-muted line-through' : ''}">${escapeHtml(todo.content)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// Task (sub-agent)
function renderTaskBlock(block: ToolUseBlock, result?: ToolResultBlock): string {
  const input = block.input as { description?: string; prompt?: string };
  const description = input.description || input.prompt || 'Sub-task';
  const status = getToolStatus(result);
  const blockId = `task-${block.id}`;

  return `
    <div class="tool-block my-2 border-l-2 border-bg-elevated pl-3">
      <button class="tool-header flex items-center gap-2 w-full text-left py-1"
              data-toggle-tool="${blockId}">
        <span class="toggle-icon text-text-muted">▶</span>
        <span class="font-semibold text-accent-primary">Task</span>
        <span class="text-sm text-text-muted truncate flex-1">${escapeHtml(description.slice(0, 50))}</span>
        ${status}
      </button>
      <div id="${blockId}" class="task-content hidden mt-2">
        ${result ? `
          <div class="text-sm text-text-secondary whitespace-pre-wrap">
            ${escapeHtml(result.content.slice(0, 2000))}
            ${result.content.length > 2000 ? '...' : ''}
          </div>
        ` : '<div class="text-text-muted text-sm italic">⋯ running</div>'}
      </div>
    </div>
  `;
}
```

## Step 4: Thinking & Media Blocks

```typescript
function renderThinkingBlock(block: { thinking: string; duration_ms?: number }): string {
  const duration = block.duration_ms ? `(${(block.duration_ms / 1000).toFixed(1)}s)` : '';
  const blockId = `thinking-${Math.random().toString(36).slice(2)}`;

  return `
    <div class="thinking-block my-2">
      <button class="flex items-center gap-2 text-text-muted italic text-sm hover:text-text-secondary"
              data-toggle-tool="${blockId}">
        <span class="toggle-icon">▶</span>
        <span>Thinking</span>
        <span class="text-xs">${duration}</span>
      </button>
      <div id="${blockId}" class="hidden mt-2 pl-4 text-sm text-text-secondary">
        ${escapeHtml(block.thinking)}
      </div>
    </div>
  `;
}

function renderImageBlock(block: { filename?: string; source?: unknown }): string {
  const label = block.filename || 'Image';
  return `
    <div class="inline-block bg-bg-tertiary rounded px-2 py-1 my-1">
      <span class="text-sm text-text-muted font-mono">[Image: ${escapeHtml(label)}]</span>
    </div>
  `;
}

function renderFileBlock(block: { filename: string; size?: number }): string {
  const size = block.size ? ` (${formatBytes(block.size)})` : '';
  return `
    <div class="inline-block bg-bg-tertiary rounded px-2 py-1 my-1">
      <span class="text-sm text-text-muted font-mono">[File: ${escapeHtml(block.filename)}${size}]</span>
    </div>
  `;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
```

## Step 5: Update Message Renderer

**File: `src/client/views.ts`**

```typescript
import { renderContentBlocks } from './blocks';
import type { Message, ToolResultBlock } from '../db/schema';

function renderMessageBlock(message: Message, allMessages: Message[]): string {
  const isUser = message.role === 'user';
  const roleLabel = isUser ? 'You' : 'Claude';
  const bgClass = isUser ? '' : 'bg-bg-tertiary';
  const roleColor = isUser ? 'text-role-user' : 'text-role-assistant';

  // Build tool result map from this and next messages
  const toolResults = buildToolResultMap(message, allMessages);

  // Render content blocks
  const content = message.content_blocks?.length
    ? renderContentBlocks(message.content_blocks, toolResults)
    : formatMessageContent(message.content); // Fallback for old data

  return `
    <div class="message px-3 py-3 ${bgClass} group relative" data-message-index="${message.message_index}">
      <div class="flex items-center justify-between mb-1">
        <span class="text-xs font-semibold uppercase tracking-wider ${roleColor}">
          ${roleLabel}
        </span>
        <button class="copy-message p-1 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                title="Copy message">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
      </div>
      <div class="text-sm text-text-primary leading-relaxed">
        ${content}
      </div>
    </div>
  `;
}

function buildToolResultMap(message: Message, allMessages: Message[]): Map<string, ToolResultBlock> {
  const map = new Map<string, ToolResultBlock>();

  // Get results from this message
  for (const block of message.content_blocks || []) {
    if (block.type === 'tool_result') {
      map.set(block.tool_use_id, block);
    }
  }

  // Get results from next message (tool results often in separate message)
  const nextIdx = message.message_index + 1;
  const nextMsg = allMessages.find(m => m.message_index === nextIdx);
  if (nextMsg) {
    for (const block of nextMsg.content_blocks || []) {
      if (block.type === 'tool_result') {
        map.set(block.tool_use_id, block);
      }
    }
  }

  return map;
}
```

## Step 6: Toggle Handlers

**File: `src/client/index.ts`**

```typescript
// Tool collapse/expand toggle
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const toggleBtn = target.closest('[data-toggle-tool]') as HTMLElement;

  if (toggleBtn) {
    const contentId = toggleBtn.dataset.toggleTool;
    const content = document.getElementById(contentId!);
    const icon = toggleBtn.querySelector('.toggle-icon');

    if (content && icon) {
      const isHidden = content.classList.contains('hidden');
      content.classList.toggle('hidden');
      icon.textContent = isHidden ? '▼' : '▶';
    }
  }
});

// Copy message handler
document.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  const copyBtn = target.closest('.copy-message') as HTMLElement;

  if (copyBtn) {
    const message = copyBtn.closest('.message');
    if (message) {
      // Get text content only (exclude tool blocks)
      const textBlocks = message.querySelectorAll('.text-block');
      const text = Array.from(textBlocks).map(b => b.textContent).join('\n').trim();

      if (text) {
        await navigator.clipboard.writeText(text);
        copyBtn.classList.add('text-diff-add');
        setTimeout(() => copyBtn.classList.remove('text-diff-add'), 1000);
      }
    }
  }
});

// Copy code block handler
document.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  const copyBtn = target.closest('.copy-code') as HTMLElement;

  if (copyBtn) {
    const pre = copyBtn.closest('pre');
    const code = pre?.querySelector('code');
    if (code) {
      await navigator.clipboard.writeText(code.textContent || '');
      copyBtn.classList.add('text-diff-add');
      setTimeout(() => copyBtn.classList.remove('text-diff-add'), 1000);
    }
  }
});
```

## Step 7: Long Text Truncation

Add truncation for long text blocks:

```typescript
function renderTextBlock(text: string): string {
  const lines = text.split('\n');
  const isLong = lines.length > 50 || text.length > 4000;

  if (!isLong) {
    return `<div class="text-block">${formatMarkdown(escapeHtml(text))}</div>`;
  }

  const truncated = lines.slice(0, 50).join('\n');
  const blockId = `text-${Math.random().toString(36).slice(2)}`;

  return `
    <div class="text-block" data-text-block="${blockId}">
      <div class="truncated-content">${formatMarkdown(escapeHtml(truncated))}</div>
      <div class="text-xs text-text-muted mt-2">(showing 50 of ${lines.length} lines)</div>
      <button class="text-sm text-accent-primary hover:underline" data-expand-text="${blockId}">
        Show more
      </button>
      <div class="full-content hidden">${formatMarkdown(escapeHtml(text))}</div>
    </div>
  `;
}
```

## Testing

1. Upload a session with tool calls (use the test session from earlier)
2. Verify:
   - Text blocks render with markdown formatting
   - Tool calls show collapsed with ▶ icon
   - Clicking expands to show input/result
   - Success/error status icons display correctly
   - AskUserQuestion shows Q&A format
   - TodoWrite shows checklist
   - Copy buttons work for messages and code
   - Long text is truncated with "Show more"

## Dependencies

- Requires `plans/schema_migration.md` to be implemented first
- `content_blocks` must be populated in database
