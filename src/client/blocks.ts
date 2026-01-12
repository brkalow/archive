import type {
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  ImageBlock,
  FileBlock,
} from "../db/schema";

// Map of tool_use_id to tool_result for inline rendering
type ToolResultMap = Map<string, ToolResultBlock>;

// HTML escaping utility
export function escapeHtml(str: string): string {
  const htmlEscapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return str.replace(/[&<>"']/g, (char) => htmlEscapes[char] || char);
}

export function buildToolResultMap(blocks: ContentBlock[]): ToolResultMap {
  const map = new Map<string, ToolResultBlock>();
  for (const block of blocks) {
    if (block.type === "tool_result") {
      map.set(block.tool_use_id, block);
    }
  }
  return map;
}

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

  return output.join("\n");
}

function renderTextBlock(text: string): string {
  // Strip system tags that shouldn't be displayed
  const cleaned = stripSystemTags(text);
  if (!cleaned.trim()) return ""; // Don't render empty text blocks
  const formatted = formatMarkdown(cleaned);
  return `<div class="text-block">${formatted}</div>`;
}

function stripSystemTags(text: string): string {
  // Remove <system_instruction>...</system_instruction> tags and content
  let cleaned = text.replace(/<system_instruction>[\s\S]*?<\/system_instruction>/gi, "");
  // Remove <system-instruction>...</system-instruction> tags and content
  cleaned = cleaned.replace(/<system-instruction>[\s\S]*?<\/system-instruction>/gi, "");
  // Remove <system-reminder>...</system-reminder> tags and content
  cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  // Remove <local-command-caveat>...</local-command-caveat> tags and content
  cleaned = cleaned.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "");
  // Trim leading/trailing whitespace
  return cleaned.trim();
}

function formatMarkdown(text: string): string {
  // Process code blocks first (preserve their content)
  const codeBlocks: string[] = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const index = codeBlocks.length;
    codeBlocks.push(
      `<pre class="my-2 p-3 bg-bg-primary rounded-md overflow-x-auto relative group"><button class="copy-code absolute top-2 right-2 p-1 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity" title="Copy code"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg></button><code class="text-[13px] language-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`
    );
    return `\x00CODE_BLOCK_${index}\x00`;
  });

  // Process inline code
  const inlineCodes: string[] = [];
  processed = processed.replace(/`([^`]+)`/g, (_, code) => {
    const index = inlineCodes.length;
    inlineCodes.push(
      `<code class="px-1.5 py-0.5 bg-bg-elevated rounded text-accent-primary text-[13px]">${escapeHtml(code)}</code>`
    );
    return `\x00INLINE_CODE_${index}\x00`;
  });

  // Now escape the remaining text
  processed = escapeHtml(processed);

  // Apply markdown formatting to escaped text
  processed = processed.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  processed = processed.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  processed = processed.replace(/\n/g, "<br>");

  // Restore code blocks
  processed = processed.replace(/\x00CODE_BLOCK_(\d+)\x00/g, (match, index) => {
    return codeBlocks[parseInt(index, 10)] ?? match;
  });

  // Restore inline code
  processed = processed.replace(/\x00INLINE_CODE_(\d+)\x00/g, (match, index) => {
    return inlineCodes[parseInt(index, 10)] ?? match;
  });

  return processed;
}

function renderToolUseBlock(
  block: ToolUseBlock,
  result?: ToolResultBlock
): string {
  // Dispatch to special renderers
  switch (block.name) {
    case "mcp__conductor__AskUserQuestion":
    case "AskUserQuestion":
      return renderAskUserQuestion(block, result);
    case "TodoWrite":
      return renderTodoWrite(block);
    case "Task":
      return renderTaskBlock(block, result);
    default:
      return renderGenericToolBlock(block, result);
  }
}

function renderGenericToolBlock(
  block: ToolUseBlock,
  result?: ToolResultBlock
): string {
  const summary = getToolSummary(block);
  const fullPath = getFullPathFromTool(block);
  const status = getToolStatus(result);
  const blockId = `tool-${block.id}`;

  return `
    <div class="tool-block my-2 min-w-0" data-tool-id="${escapeHtml(block.id)}">
      <button class="tool-header flex items-center gap-2 w-full min-w-0 text-left px-2 py-1.5 rounded hover:bg-bg-elevated transition-colors"
              data-toggle-tool="${blockId}"
              ${fullPath ? `title="${escapeHtml(fullPath)}"` : ""}>
        <span class="toggle-icon text-text-muted text-xs shrink-0">&#9654;</span>
        <span class="font-semibold text-accent-primary shrink-0">${escapeHtml(block.name)}</span>
        <span class="font-mono text-sm text-text-muted truncate min-w-0">${escapeHtml(summary)}</span>
        <span class="shrink-0">${status}</span>
      </button>
      <div id="${blockId}" class="tool-content hidden pl-6 mt-1">
        ${fullPath && fullPath !== summary ? `<div class="text-xs text-text-muted font-mono mb-2 break-all">${escapeHtml(fullPath)}</div>` : ""}
        ${renderToolInput(block, fullPath)}
        ${result ? renderToolResult(result) : '<div class="text-text-muted text-sm italic">... pending</div>'}
      </div>
    </div>
  `;
}

// Get full file path from tool input if applicable
function getFullPathFromTool(block: ToolUseBlock): string | null {
  const input = block.input as Record<string, unknown>;
  switch (block.name) {
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path || "") || null;
    default:
      return null;
  }
}

// Extract short display name from a file path
function getShortPath(fullPath: string): string {
  if (!fullPath) return "";
  const parts = fullPath.split("/");
  // Return just the filename
  return parts[parts.length - 1] || fullPath;
}

// Get relative path if within a common project structure
function getDisplayPath(fullPath: string): string {
  if (!fullPath) return "";

  const parts = fullPath.split("/");

  // Look for common project structure indicators
  const projectIndicators = ["src", "lib", "bin", "test", "tests", "packages", "apps", ".context", "public", "dist"];

  for (let i = 0; i < parts.length; i++) {
    if (projectIndicators.includes(parts[i])) {
      // Return from this indicator onwards
      return parts.slice(i).join("/");
    }
  }

  // Fallback: just get filename
  return getShortPath(fullPath);
}

function getToolSummary(block: ToolUseBlock): string {
  const input = block.input as Record<string, unknown>;

  switch (block.name) {
    case "Read":
    case "Write":
    case "Edit":
      return getDisplayPath(String(input.file_path || ""));
    case "Bash":
      const cmd = String(input.command || "");
      return cmd.length > 40 ? cmd.slice(0, 40) + "..." : cmd;
    case "Glob":
      return String(input.pattern || "");
    case "Grep":
      return String(input.pattern || "");
    case "Task":
      return String(input.description || input.prompt || "").slice(0, 40);
    case "WebFetch":
      return String(input.url || "");
    case "WebSearch":
      return String(input.query || "");
    default:
      return "";
  }
}

function getToolStatus(result?: ToolResultBlock): string {
  if (!result) {
    return '<span class="text-text-muted">...</span>';
  }
  if (result.is_error) {
    const errorText = extractErrorSummary(result.content);
    return `<span class="text-diff-del">&#10007; ${escapeHtml(errorText)}</span>`;
  }
  return '<span class="text-diff-add">&#10003;</span>';
}

function extractErrorSummary(content: string): string {
  // Extract first line or first 20 chars of error
  const firstLine = content.split("\n")[0] || "";
  if (firstLine.length <= 20) return firstLine;
  return firstLine.slice(0, 20) + "...";
}

function renderToolInput(block: ToolUseBlock, fullPathShown?: string | null): string {
  const input = block.input as Record<string, unknown>;
  const entries = Object.entries(input)
    .filter(([k, v]) => {
      // Skip if undefined/null
      if (v === undefined || v === null) return false;
      // Skip file_path if already shown separately
      if (k === "file_path" && fullPathShown) return false;
      return true;
    })
    .slice(0, 5);

  if (entries.length === 0) return "";

  return `
    <div class="text-xs text-text-muted mb-2">
      <div class="font-semibold mb-1">Input:</div>
      ${entries
        .map(
          ([k, v]) => `
        <div class="pl-2 break-all">
          <span class="text-text-secondary">${escapeHtml(k)}:</span>
          <span class="font-mono">${escapeHtml(truncateValue(v))}</span>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function truncateValue(value: unknown): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return str.length > 100 ? str.slice(0, 100) + "..." : str;
}

function renderToolResult(result: ToolResultBlock): string {
  const content = result.content;
  const lines = content.split("\n");
  const lineCount = lines.length;
  const isLarge = lineCount > 100;
  const displayContent = isLarge ? lines.slice(0, 50).join("\n") : content;
  const resultId = `result-${result.tool_use_id}`;

  return `
    <div class="tool-result">
      <div class="flex items-center justify-between text-xs text-text-muted mb-1">
        <span>Result: ${result.is_error ? '<span class="text-diff-del">(error)</span>' : `(${lineCount} lines)`}</span>
        <button class="copy-result p-1 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                data-copy-result="${resultId}" title="Copy result">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
      </div>
      <div class="bg-bg-primary rounded p-2 overflow-x-auto max-h-64 overflow-y-auto group">
        <pre id="${resultId}" class="text-xs font-mono whitespace-pre-wrap">${escapeHtml(displayContent)}</pre>
        ${
          isLarge
            ? `
          <button class="text-accent-primary text-xs hover:underline mt-2" data-show-all-result="${resultId}" data-full-content="${escapeHtml(content)}">
            Show all ${lineCount} lines
          </button>
        `
            : ""
        }
      </div>
    </div>
  `;
}

// Special tool renderers

function renderAskUserQuestion(
  block: ToolUseBlock,
  result?: ToolResultBlock
): string {
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
        <span>&#10067;</span>
        <span>Question</span>
      </div>
      ${questions
        .map(
          (q, i) => `
        <div class="mb-2">
          <div class="text-sm text-text-primary">${escapeHtml(q.question)}</div>
          ${
            answers[i]
              ? `
            <div class="flex items-center gap-1 mt-1">
              <span class="text-accent-primary">&#8594;</span>
              <span class="text-sm font-medium">${escapeHtml(String(answers[i]))}</span>
            </div>
          `
              : ""
          }
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderTodoWrite(block: ToolUseBlock): string {
  const input = block.input as {
    todos?: Array<{ content: string; status: string }>;
  };
  const todos = input.todos || [];

  const statusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return '<span class="text-diff-add">&#10003;</span>';
      case "in_progress":
        return '<span class="text-accent-primary">&#9679;</span>';
      default:
        return '<span class="text-text-muted">&#9675;</span>';
    }
  };

  return `
    <div class="bg-bg-tertiary/50 rounded-lg p-3 my-2">
      <div class="flex items-center gap-2 text-sm font-medium mb-2">
        <span>&#128203;</span>
        <span>Tasks</span>
      </div>
      <div class="space-y-1">
        ${todos
          .map(
            (todo) => `
          <div class="flex items-center gap-2 text-sm">
            ${statusIcon(todo.status)}
            <span class="${todo.status === "completed" ? "text-text-muted line-through" : ""}">${escapeHtml(todo.content)}</span>
          </div>
        `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderTaskBlock(
  block: ToolUseBlock,
  result?: ToolResultBlock
): string {
  const input = block.input as { description?: string; prompt?: string };
  const description = input.description || input.prompt || "Sub-task";
  const status = getToolStatus(result);
  const blockId = `task-${block.id}`;

  return `
    <div class="tool-block my-2 border-l-2 border-bg-elevated pl-3">
      <button class="tool-header flex items-center gap-2 w-full text-left py-1"
              data-toggle-tool="${blockId}">
        <span class="toggle-icon text-text-muted text-xs">&#9654;</span>
        <span class="font-semibold text-accent-primary">Task</span>
        <span class="text-sm text-text-muted truncate flex-1">${escapeHtml(description.slice(0, 50))}</span>
        ${status}
      </button>
      <div id="${blockId}" class="task-content hidden mt-2">
        ${
          result
            ? `
          <div class="text-sm text-text-secondary whitespace-pre-wrap">
            ${escapeHtml(result.content.slice(0, 2000))}
            ${result.content.length > 2000 ? "..." : ""}
          </div>
        `
            : '<div class="text-text-muted text-sm italic">... running</div>'
        }
      </div>
    </div>
  `;
}

function renderThinkingBlock(block: ThinkingBlock): string {
  const duration = block.duration_ms
    ? `(${(block.duration_ms / 1000).toFixed(1)}s)`
    : "";
  const blockId = `thinking-${Math.random().toString(36).slice(2, 10)}`;

  return `
    <div class="thinking-block my-2">
      <button class="flex items-center gap-2 text-text-muted italic text-sm hover:text-text-secondary"
              data-toggle-tool="${blockId}">
        <span class="toggle-icon text-xs">&#9654;</span>
        <span>Thinking</span>
        <span class="text-xs">${duration}</span>
      </button>
      <div id="${blockId}" class="hidden mt-2 pl-4 text-sm text-text-secondary">
        ${escapeHtml(block.thinking)}
      </div>
    </div>
  `;
}

function renderImageBlock(block: ImageBlock): string {
  const label = block.filename || "Image";
  return `
    <div class="inline-block bg-bg-tertiary rounded px-2 py-1 my-1">
      <span class="text-sm text-text-muted font-mono">[Image: ${escapeHtml(label)}]</span>
    </div>
  `;
}

function renderFileBlock(block: FileBlock): string {
  const size = block.size ? ` (${formatBytes(block.size)})` : "";
  return `
    <div class="inline-block bg-bg-tertiary rounded px-2 py-1 my-1">
      <span class="text-sm text-text-muted font-mono">[File: ${escapeHtml(block.filename)}${size}]</span>
    </div>
  `;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
