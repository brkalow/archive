# Implementation Plan: Message Components

> **ABANDONED**: This plan was superseded by migrating directly to React. See `plans/react_migration_parallel.md` for the approach that was used instead.

Migrate message and content block rendering to JSX components.

**Spec reference:** `specs/component_model.md` - Example Components (MessageBlock)

**Depends on:** `plans/component_model_01_foundation.md`

## Overview

Convert the string-based rendering in `blocks.ts` and `views.ts` to JSX components:
1. `TextBlock` - Markdown text rendering
2. `ToolBlock` - Tool use/result with collapsible content
3. `ThinkingBlock` - Collapsible thinking display
4. `MessageBlock` - Container for all content blocks

## Current State

In `src/client/blocks.ts` (~817 lines):
- `renderContentBlocks()` - dispatches to block renderers
- `renderTextBlock()` - markdown formatting with HTML strings
- `renderToolUseBlock()` - tool rendering with inline results
- `renderThinkingBlock()` - collapsible thinking
- All return HTML strings, assembled with template literals

In `src/client/views.ts`:
- `renderSingleMessage()` - renders message with role badge
- Uses `renderContentBlocks()` for content

**Problems:**
- No type safety in HTML strings
- Event handlers added via document-level delegation
- Copy button state managed globally
- No cleanup of event listeners

## Files to Create

| File | Purpose |
|------|---------|
| `src/client/components/TextBlock.tsx` | Markdown text rendering |
| `src/client/components/ToolBlock.tsx` | Tool use with result |
| `src/client/components/ThinkingBlock.tsx` | Collapsible thinking |
| `src/client/components/MessageBlock.tsx` | Message container |
| `src/client/components/blocks/index.tsx` | Block type dispatcher |

## Files to Modify

| File | Changes |
|------|---------|
| `src/client/blocks.ts` | Keep for utilities, export to components |

## Step 1: Create TextBlock Component

**File: `src/client/components/TextBlock.tsx`**

```tsx
import { Component } from "../component";
import { formatMarkdown } from "../blocks";

interface TextBlockProps {
  text: string;
}

export class TextBlock extends Component<TextBlockProps> {
  render(): HTMLElement {
    const { text } = this.props;

    // Check for command/skill prompt
    const commandInfo = this.extractCommandInfo(text);
    if (commandInfo) {
      return this.renderCommandBlock(commandInfo);
    }

    // Strip system tags
    const cleaned = this.stripSystemTags(text);
    if (!cleaned.trim()) {
      return <div className="text-block hidden" />;
    }

    const formatted = formatMarkdown(cleaned);
    return (
      <div
        className="text-block"
        dangerouslySetInnerHTML={{ __html: formatted }}
      />
    );
  }

  protected onMount(): void {
    // Initialize syntax highlighting for code blocks
    this.initializeCodeBlocks();
  }

  private initializeCodeBlocks(): void {
    // Find code blocks that need highlighting
    this.$$("[data-code-content]").forEach((el) => {
      const htmlEl = el as HTMLElement;
      const encodedContent = htmlEl.dataset.codeContent;
      const language = htmlEl.dataset.language || "";

      if (encodedContent) {
        // Lazy import @pierre/diffs for syntax highlighting
        import("@pierre/diffs").then(({ File }) => {
          const code = decodeURIComponent(atob(encodedContent));

          const fileInstance = new File({
            theme: { dark: "pierre-dark", light: "pierre-light" },
            themeType: "dark",
            overflow: "scroll",
            disableFileHeader: true,
          });

          const container = document.createElement("diffs-container");
          const copyBtn = htmlEl.querySelector(".copy-code");

          htmlEl.innerHTML = "";
          htmlEl.appendChild(container);

          if (copyBtn) {
            container.appendChild(copyBtn);
          }

          fileInstance.render({
            file: {
              name: "code",
              contents: code,
              lang: language || undefined,
            },
            fileContainer: container,
          });
        });
      }
    });
  }

  private extractCommandInfo(text: string): { name: string; output: string } | null {
    const nameMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
    if (!nameMatch) return null;

    const name = nameMatch[1];
    let output = "";

    const stdoutMatch = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
    if (stdoutMatch) {
      output = stdoutMatch[1].trim();
    }

    return { name, output };
  }

  private renderCommandBlock(info: { name: string; output: string }): HTMLElement {
    const blockId = `cmd-${Math.random().toString(36).slice(2, 10)}`;

    return (
      <div className="command-block bg-bg-tertiary/30 rounded py-1.5 pr-2 -ml-1 pl-1">
        <button
          className="flex items-center gap-1.5 text-[13px] hover:bg-bg-elevated rounded px-1 py-0.5 transition-colors w-full text-left"
          onClick={() => this.toggleBlock(blockId)}
        >
          <span className="text-text-muted">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </span>
          <span className="font-medium text-text-primary">Ran</span>
          <code className="px-1.5 py-0.5 bg-bg-elevated rounded text-accent-primary text-[13px]">
            {info.name}
          </code>
          <span className="toggle-icon text-text-muted text-[10px] ml-auto">▶</span>
        </button>
        <div id={blockId} className="hidden mt-2 pl-5">
          {info.output && (
            <div
              className="text-sm text-text-secondary"
              dangerouslySetInnerHTML={{ __html: formatMarkdown(info.output) }}
            />
          )}
        </div>
      </div>
    );
  }

  private toggleBlock(blockId: string): void {
    const content = document.getElementById(blockId);
    const icon = this.$(".toggle-icon");

    if (content) {
      const isHidden = content.classList.contains("hidden");
      content.classList.toggle("hidden");
      if (icon) {
        icon.textContent = isHidden ? "▼" : "▶";
      }
    }
  }

  private stripSystemTags(text: string): string {
    let cleaned = text;
    cleaned = cleaned.replace(/<system_instruction>[\s\S]*?<\/system_instruction>/gi, "");
    cleaned = cleaned.replace(/<system-instruction>[\s\S]*?<\/system-instruction>/gi, "");
    cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
    cleaned = cleaned.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "");
    cleaned = cleaned.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, "");
    return cleaned.trim();
  }
}
```

## Step 2: Create ToolBlock Component

**File: `src/client/components/ToolBlock.tsx`**

```tsx
import { Component } from "../component";
import { formatMarkdown, escapeHtml, getToolIcon } from "../blocks";
import type { ToolUseBlock as ToolUseBlockType, ToolResultBlock } from "../../db/schema";

interface ToolBlockProps {
  block: ToolUseBlockType;
  result?: ToolResultBlock;
}

interface ToolBlockState {
  expanded: boolean;
  copied: boolean;
}

export class ToolBlock extends Component<ToolBlockProps, ToolBlockState> {
  constructor(props: ToolBlockProps) {
    super(props, { expanded: false, copied: false });
  }

  render(): HTMLElement {
    const { block, result } = this.props;
    const { expanded } = this.state;

    // Dispatch to special renderers
    switch (block.name) {
      case "mcp__conductor__AskUserQuestion":
      case "AskUserQuestion":
        return this.renderAskUserQuestion();
      case "TodoWrite":
        return this.renderTodoWrite();
      case "Task":
        return this.renderTaskBlock();
      default:
        return this.renderGenericTool();
    }
  }

  private renderGenericTool(): HTMLElement {
    const { block, result } = this.props;
    const { expanded } = this.state;

    const summary = this.getToolSummary();
    const fullPath = this.getFullPath();
    const status = this.getStatus();
    const blockId = `tool-${block.id}`;
    const icon = getToolIcon(block.name);

    return (
      <div className="tool-block min-w-0" data-tool-id={block.id}>
        <button
          className="tool-header flex items-center gap-1.5 pr-1.5 py-0.5 -ml-0.5 rounded hover:bg-bg-elevated transition-colors"
          title={fullPath || undefined}
          onClick={() => this.toggle()}
        >
          <span className="text-text-primary" dangerouslySetInnerHTML={{ __html: icon }} />
          <span className="text-[13px] font-medium text-text-primary">{block.name}</span>
          <span className="font-mono text-[13px] text-text-muted">{summary}</span>
          <span dangerouslySetInnerHTML={{ __html: status }} />
          <span className="toggle-icon text-text-muted text-[10px]">
            {expanded ? "▼" : "▶"}
          </span>
        </button>
        <div id={blockId} className={`tool-content pl-6 mt-1 ${expanded ? "" : "hidden"}`}>
          {fullPath && fullPath !== summary && (
            <div className="text-xs text-text-muted font-mono mb-2 break-all">{fullPath}</div>
          )}
          {this.renderToolInput()}
          {result ? this.renderToolResult() : (
            <div className="text-text-muted text-sm italic">... pending</div>
          )}
        </div>
      </div>
    );
  }

  private renderToolInput(): HTMLElement {
    const { block } = this.props;
    const input = block.input as Record<string, unknown>;
    const fullPath = this.getFullPath();

    const entries = Object.entries(input)
      .filter(([k, v]) => {
        if (v === undefined || v === null) return false;
        if (k === "file_path" && fullPath) return false;
        return true;
      })
      .slice(0, 5);

    if (entries.length === 0) {
      return <div className="hidden" />;
    }

    return (
      <div className="text-xs text-text-muted mb-2">
        <div className="font-semibold mb-1">Input:</div>
        {entries.map(([k, v]) => (
          <div className="pl-2 break-all">
            <span className="text-text-secondary">{k}:</span>{" "}
            <span className="font-mono">{this.truncateValue(v)}</span>
          </div>
        ))}
      </div>
    );
  }

  private renderToolResult(): HTMLElement {
    const { block, result } = this.props;
    if (!result) return <div className="hidden" />;

    const content = this.stripSystemTags(result.content);
    const lines = content.split("\n");
    const isLarge = lines.length > 100;
    const displayContent = isLarge ? lines.slice(0, 50).join("\n") : content;
    const resultId = `result-${result.tool_use_id}`;

    return (
      <div className="tool-result">
        <div className="flex items-center justify-between text-xs text-text-muted mb-1">
          <span>
            Result: {result.is_error ? (
              <span className="text-diff-del">(error)</span>
            ) : (
              `(${lines.length} lines)`
            )}
          </span>
          <button
            className="copy-result p-1 text-text-muted hover:text-text-primary transition-opacity"
            title="Copy result"
            onClick={() => this.copyResult(content)}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
        </div>
        <div className="tool-result-content bg-bg-primary rounded overflow-hidden max-h-64 overflow-y-auto group">
          <pre id={resultId} className="p-2 text-xs font-mono whitespace-pre-wrap overflow-x-auto">
            {displayContent}
          </pre>
          {isLarge && (
            <button
              className="text-accent-primary text-xs hover:underline mt-2 px-2 pb-2"
              onClick={() => this.showAllLines(resultId, content)}
            >
              Show all {lines.length} lines
            </button>
          )}
        </div>
      </div>
    );
  }

  private renderAskUserQuestion(): HTMLElement {
    const { block, result } = this.props;
    const input = block.input as { questions?: Array<{ question: string }> };
    const questions = input.questions || [];

    let answers: string[] = [];
    if (result?.content) {
      try {
        const parsed = JSON.parse(result.content);
        answers = Object.values(parsed.answers || parsed || {});
      } catch {
        answers = [result.content];
      }
    }

    return (
      <div className="bg-bg-tertiary/30 rounded py-1.5 pr-2 -ml-1 pl-1">
        <div className="flex items-center gap-1.5 text-[13px] font-medium mb-1">
          <span className="text-text-primary">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </span>
          <span>Question</span>
        </div>
        {questions.map((q, i) => (
          <div className="mb-1 last:mb-0 pl-5">
            <div className="text-[13px] text-text-primary">{q.question}</div>
            {answers[i] && (
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-accent-primary text-xs">→</span>
                <span className="text-[13px] font-medium">{String(answers[i])}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  private renderTodoWrite(): HTMLElement {
    const { block } = this.props;
    const input = block.input as { todos?: Array<{ content: string; status: string }> };
    const todos = input.todos || [];

    return (
      <div className="bg-bg-tertiary/30 rounded py-1.5 pr-2 -ml-1 pl-1">
        <div className="flex items-center gap-1.5 text-[13px] font-medium mb-1">
          <span className="text-text-primary">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </span>
          <span>Tasks</span>
        </div>
        <div className="space-y-0.5 pl-5">
          {todos.map((todo) => (
            <div className="flex items-center gap-1.5 text-[13px]">
              {this.getStatusIcon(todo.status)}
              <span className={todo.status === "completed" ? "text-text-muted line-through" : ""}>
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  private renderTaskBlock(): HTMLElement {
    const { block, result } = this.props;
    const { expanded } = this.state;

    const input = block.input as {
      description?: string;
      prompt?: string;
      subagent_type?: string;
    };
    const description = input.description || input.prompt || "Sub-task";
    const agentType = input.subagent_type || "general-purpose";
    const status = this.getStatus();
    const blockId = `task-${block.id}`;

    const agentDisplayName = this.getAgentDisplayName(agentType);
    const resultContent = result?.content || "";
    const isLarge = resultContent.length > 2000;
    const displayContent = isLarge ? resultContent.slice(0, 2000) : resultContent;

    return (
      <div className="tool-block border-l-2 border-accent-primary/30 ml-4" data-tool-id={block.id}>
        <button
          className="tool-header flex items-center gap-1.5 py-0.5 pl-2 pr-1.5 rounded hover:bg-bg-elevated transition-colors"
          onClick={() => this.toggle()}
        >
          <span className="text-accent-primary">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </span>
          <span className="text-[13px] font-medium text-text-primary">{agentDisplayName}</span>
          <span className="text-[13px] text-text-muted truncate max-w-[300px]">
            {description.slice(0, 60)}
          </span>
          <span dangerouslySetInnerHTML={{ __html: status }} />
          <span className="toggle-icon text-text-muted text-[10px]">
            {expanded ? "▼" : "▶"}
          </span>
        </button>
        <div id={blockId} className={`task-content mt-1 pl-2 ${expanded ? "" : "hidden"}`}>
          {result ? (
            <div className="text-sm text-text-secondary leading-relaxed">
              <div dangerouslySetInnerHTML={{ __html: formatMarkdown(displayContent) }} />
              {isLarge && (
                <button className="text-accent-primary text-xs hover:underline mt-2 block">
                  Show all ({Math.round(resultContent.length / 1000)}k chars)
                </button>
              )}
            </div>
          ) : (
            <div className="text-text-muted text-sm italic">... running</div>
          )}
        </div>
      </div>
    );
  }

  // Helper methods
  private toggle(): void {
    this.setState({ expanded: !this.state.expanded });
  }

  private getToolSummary(): string {
    const { block } = this.props;
    const input = block.input as Record<string, unknown>;

    switch (block.name) {
      case "Read":
      case "Write":
      case "Edit":
        return this.getDisplayPath(String(input.file_path || ""));
      case "Bash":
        const cmd = String(input.command || "");
        return cmd.length > 40 ? cmd.slice(0, 40) + "..." : cmd;
      case "Glob":
      case "Grep":
        return String(input.pattern || "");
      case "Task":
        return String(input.description || input.prompt || "").slice(0, 40);
      default:
        return "";
    }
  }

  private getFullPath(): string | null {
    const { block } = this.props;
    const input = block.input as Record<string, unknown>;
    if (["Read", "Write", "Edit"].includes(block.name)) {
      return String(input.file_path || "") || null;
    }
    return null;
  }

  private getStatus(): string {
    const { result } = this.props;
    if (!result) {
      return '<span class="tool-status text-text-muted">...</span>';
    }
    if (result.is_error) {
      return '<span class="tool-status text-diff-del">✗</span>';
    }
    return '<span class="tool-status text-diff-add">✓</span>';
  }

  private getStatusIcon(status: string): HTMLElement {
    switch (status) {
      case "completed":
        return <span className="text-diff-add">✓</span>;
      case "in_progress":
        return <span className="text-accent-primary">●</span>;
      default:
        return <span className="text-text-muted">○</span>;
    }
  }

  private getDisplayPath(fullPath: string): string {
    if (!fullPath) return "";
    const parts = fullPath.split("/");
    const indicators = ["src", "lib", "bin", "test", "tests", "packages", "apps"];
    for (let i = 0; i < parts.length; i++) {
      if (indicators.includes(parts[i])) {
        return parts.slice(i).join("/");
      }
    }
    return parts[parts.length - 1] || fullPath;
  }

  private getAgentDisplayName(agentType: string): string {
    const typeMap: Record<string, string> = {
      Bash: "Bash Agent",
      "general-purpose": "Agent",
      Explore: "Explorer",
      Plan: "Planner",
    };
    return typeMap[agentType] || agentType;
  }

  private truncateValue(value: unknown): string {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    return str.length > 100 ? str.slice(0, 100) + "..." : str;
  }

  private stripSystemTags(text: string): string {
    return text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
      .trim();
  }

  private async copyResult(content: string): Promise<void> {
    await window.copyToClipboard(content);
    this.setState({ copied: true });
    setTimeout(() => this.setState({ copied: false }), 1000);
  }

  private showAllLines(resultId: string, fullContent: string): void {
    const el = document.getElementById(resultId);
    if (el) {
      el.textContent = fullContent;
      el.nextElementSibling?.remove(); // Remove "Show all" button
    }
  }
}
```

## Step 3: Create MessageBlock Component

**File: `src/client/components/MessageBlock.tsx`**

```tsx
import { Component } from "../component";
import { TextBlock } from "./TextBlock";
import { ToolBlock } from "./ToolBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import type { Message, ContentBlock, ToolResultBlock } from "../../db/schema";

interface MessageBlockProps {
  message: Message;
  toolResults: Map<string, ToolResultBlock>;
  showRoleBadge: boolean;
  messageIndex: number;
}

interface MessageBlockState {
  copied: boolean;
}

export class MessageBlock extends Component<MessageBlockProps, MessageBlockState> {
  constructor(props: MessageBlockProps) {
    super(props, { copied: false });
  }

  render(): HTMLElement {
    const { message, showRoleBadge, messageIndex } = this.props;
    const isAssistant = message.role === "assistant";

    return (
      <div
        className={`message group ${isAssistant ? "bg-bg-secondary" : ""} rounded-lg p-4`}
        data-message-index={messageIndex}
      >
        {showRoleBadge && (
          <div className="text-xs text-text-muted mb-2">
            {isAssistant ? "Assistant" : "User"}
          </div>
        )}
        <div className="message-content" />
        <button
          className={`copy-message opacity-0 group-hover:opacity-100 absolute top-2 right-2 p-1 text-text-muted hover:text-text-primary transition-opacity ${this.state.copied ? "text-diff-add" : ""}`}
          onClick={() => this.handleCopy()}
        >
          {this.state.copied ? "Copied!" : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          )}
        </button>
      </div>
    );
  }

  protected onMount(): void {
    this.renderContentBlocks();
  }

  private renderContentBlocks(): void {
    const { message, toolResults } = this.props;
    const contentContainer = this.$(".message-content");
    if (!contentContainer) return;

    const blocks = message.content_blocks || [];

    for (const block of blocks) {
      switch (block.type) {
        case "text":
          this.addChild(new TextBlock({ text: block.text }), contentContainer);
          break;

        case "tool_use":
          const result = toolResults.get(block.id);
          this.addChild(new ToolBlock({ block, result }), contentContainer);
          break;

        case "tool_result":
          // Skip - rendered inline with tool_use
          break;

        case "thinking":
          this.addChild(new ThinkingBlock({ block }), contentContainer);
          break;

        case "image":
          contentContainer.appendChild(this.renderImageBlock(block));
          break;

        case "file":
          contentContainer.appendChild(this.renderFileBlock(block));
          break;
      }
    }
  }

  private renderImageBlock(block: { filename?: string }): HTMLElement {
    const label = block.filename || "Image";
    return (
      <div className="inline-block bg-bg-tertiary rounded px-2 py-1">
        <span className="text-sm text-text-muted font-mono">[Image: {label}]</span>
      </div>
    );
  }

  private renderFileBlock(block: { filename: string; size?: number }): HTMLElement {
    const size = block.size ? ` (${this.formatBytes(block.size)})` : "";
    return (
      <div className="inline-block bg-bg-tertiary rounded px-2 py-1">
        <span className="text-sm text-text-muted font-mono">[File: {block.filename}{size}]</span>
      </div>
    );
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  private async handleCopy(): Promise<void> {
    // Get text content only (from text-block elements)
    const textBlocks = this.$$(".text-block");
    const text = Array.from(textBlocks)
      .map((b) => b.textContent)
      .join("\n")
      .trim();

    if (text) {
      await window.copyToClipboard(text);
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 1000);
    }
  }
}
```

## Step 4: Create ThinkingBlock Component

**File: `src/client/components/ThinkingBlock.tsx`**

```tsx
import { Component } from "../component";
import type { ThinkingBlock as ThinkingBlockType } from "../../db/schema";

interface ThinkingBlockProps {
  block: ThinkingBlockType;
}

interface ThinkingBlockState {
  expanded: boolean;
}

export class ThinkingBlock extends Component<ThinkingBlockProps, ThinkingBlockState> {
  constructor(props: ThinkingBlockProps) {
    super(props, { expanded: false });
  }

  render(): HTMLElement {
    const { block } = this.props;
    const { expanded } = this.state;

    const duration = block.duration_ms
      ? `(${(block.duration_ms / 1000).toFixed(1)}s)`
      : "";

    return (
      <div className="thinking-block">
        <button
          className="flex items-center gap-1.5 text-text-muted text-[13px] hover:text-text-secondary pr-1.5 py-0.5 -ml-0.5 rounded hover:bg-bg-elevated transition-colors"
          onClick={() => this.toggle()}
        >
          <span className="shrink-0">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </span>
          <span className="italic">Thinking</span>
          <span className="text-xs opacity-60">{duration}</span>
          <span className="toggle-icon text-[10px]">{expanded ? "▼" : "▶"}</span>
        </button>
        <div className={`mt-1 pl-5 text-[13px] text-text-secondary leading-snug ${expanded ? "" : "hidden"}`}>
          {block.thinking}
        </div>
      </div>
    );
  }

  private toggle(): void {
    this.setState({ expanded: !this.state.expanded });
  }
}
```

## Step 5: Export Utilities from blocks.ts

**File: `src/client/blocks.ts`**

Add exports for utilities needed by components:

```typescript
// At the top of the file, add exports:
export { escapeHtml, formatMarkdown };

// Export tool icon getter
export function getToolIcon(toolName: string): string {
  // ... existing implementation ...
}
```

## Verification

1. **Type safety**: All props are typed, no string HTML
2. **Event cleanup**: Handlers are attached to component elements, cleaned on unmount
3. **State management**: Copy state is per-component, not global
4. **Composition**: MessageBlock composes TextBlock, ToolBlock, ThinkingBlock

## Migration Path

Phase 1 (this plan):
- Create components
- Test in isolation

Phase 2 (next plan):
- Create MessageList to manage collection
- Integrate with live session updates
- Replace string rendering in views.ts

## Notes

- Components use `dangerouslySetInnerHTML` for markdown (via `formatMarkdown`)
- This is a bridge pattern - eventually markdown parsing could be JSX too
- Tool icons still use SVG strings from `getToolIcon` - could be componentized later
