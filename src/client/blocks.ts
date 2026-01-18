import type {
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  ImageBlock,
  FileBlock,
} from "../db/schema";
import type { AdapterUIConfig, ToolIconCategory } from "../../cli/adapters/types";

// Map of tool_use_id to tool_result for inline rendering
type ToolResultMap = Map<string, ToolResultBlock>;

// Tool-specific icons
const toolIcons = {
  // Brain icon for thinking
  thinking: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>`,

  // File icon for Read tool
  file: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>`,

  // Edit/pencil icon for Edit/Write tools
  edit: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>`,

  // Checkbox/list icon for TodoWrite
  todo: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>`,

  // Gear icon for MCP tools
  gear: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>`,

  // Terminal icon for Bash
  terminal: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>`,

  // Search icon for Glob/Grep
  search: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>`,

  // Globe icon for WebFetch/WebSearch
  web: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" /></svg>`,

  // Task/subtask icon
  task: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>`,

  // Question mark icon for AskUserQuestion
  question: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`,

  // Default wrench icon
  default: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>`,
};

// Map icon categories to SVG icons
const iconsByCategory: Record<ToolIconCategory, string> = {
  file: toolIcons.file,
  edit: toolIcons.edit,
  terminal: toolIcons.terminal,
  search: toolIcons.search,
  web: toolIcons.web,
  todo: toolIcons.todo,
  question: toolIcons.question,
  task: toolIcons.task,
  thinking: toolIcons.thinking,
  mcp: toolIcons.gear,
  default: toolIcons.default,
};

// Get the appropriate icon for a tool
export function getToolIcon(toolName: string, adapterConfig?: AdapterUIConfig | null): string {
  // Try adapter config first if available
  if (adapterConfig?.tools) {
    // Check exact match
    if (adapterConfig.tools[toolName]) {
      return iconsByCategory[adapterConfig.tools[toolName].icon];
    }
    // Check MCP prefixes
    if (adapterConfig.mcpToolPrefixes) {
      for (const prefix of adapterConfig.mcpToolPrefixes) {
        if (toolName.startsWith(prefix)) {
          return iconsByCategory.mcp;
        }
      }
    }
    // Use default from adapter config
    if (adapterConfig.defaultToolIcon) {
      return iconsByCategory[adapterConfig.defaultToolIcon];
    }
  }

  // Fallback to hardcoded logic for backward compatibility
  // MCP tools get gear icon
  if (toolName.startsWith("mcp__")) {
    return toolIcons.gear;
  }

  switch (toolName) {
    case "Read":
      return toolIcons.file;
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return toolIcons.edit;
    case "TodoWrite":
      return toolIcons.todo;
    case "Bash":
    case "KillShell":
      return toolIcons.terminal;
    case "Glob":
    case "Grep":
      return toolIcons.search;
    case "WebFetch":
    case "WebSearch":
      return toolIcons.web;
    case "Task":
    case "TaskOutput":
      return toolIcons.task;
    case "AskUserQuestion":
      return toolIcons.question;
    default:
      return toolIcons.default;
  }
}

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
  // Check if this is a command/skill prompt message BEFORE stripping system tags
  // because extractCommandInfo needs to find <local-command-stdout> tags
  const commandInfo = extractCommandInfo(text);
  if (commandInfo) {
    return renderCommandBlock(commandInfo.name, commandInfo.output, text);
  }

  // Strip system tags that shouldn't be displayed
  const cleaned = stripSystemTags(text);
  if (!cleaned.trim()) return ""; // Don't render empty text blocks

  const formatted = formatMarkdown(cleaned);
  return `<div class="text-block">${formatted}</div>`;
}

// Extract command info from text if it's a command/skill prompt
function extractCommandInfo(text: string): { name: string; output: string } | null {
  // Match command-name tag
  const nameMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (!nameMatch) return null;

  const name = nameMatch[1];
  let output = "";

  // Extract local-command-stdout content if present
  const stdoutMatch = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (stdoutMatch) {
    output = stdoutMatch[1].trim();
  }

  return { name, output };
}

// Render a collapsed command block
function renderCommandBlock(commandName: string, output: string, fullContent: string): string {
  const blockId = `cmd-${Math.random().toString(36).slice(2, 10)}`;
  const hasOutput = output.length > 0;

  // Format the output with markdown if present
  const formattedOutput = hasOutput ? formatMarkdown(output) : "";

  // Strip all command tags and system tags to get clean remaining content
  let remainingContent = fullContent
    .replace(/<command-name>[^<]*<\/command-name>/g, "")
    .replace(/<command-message>[^<]*<\/command-message>/g, "")
    .replace(/<command-args>[^<]*<\/command-args>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "");
  // Also strip system tags from remaining content
  remainingContent = stripSystemTags(remainingContent);

  const hasRemainingContent = remainingContent.length > 0;

  return `
    <div class="command-block bg-bg-tertiary/30 rounded py-1.5 pr-2 -ml-1 pl-1">
      <button class="flex items-center gap-1.5 text-[13px] hover:bg-bg-elevated rounded px-1 py-0.5 transition-colors w-full text-left"
              data-toggle-tool="${blockId}">
        <span class="text-text-muted">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </span>
        <span class="font-medium text-text-primary">Ran</span>
        <code class="px-1.5 py-0.5 bg-bg-elevated rounded text-accent-primary text-[13px]">${escapeHtml(commandName)}</code>
        <span class="toggle-icon text-text-muted text-[10px] ml-auto">&#9654;</span>
      </button>
      <div id="${blockId}" class="hidden mt-2 pl-5">
        ${formattedOutput ? `<div class="text-sm text-text-secondary">${formattedOutput}</div>` : ""}
        ${hasRemainingContent ? `<div class="text-sm text-text-secondary mt-2">${formatMarkdown(remainingContent)}</div>` : ""}
      </div>
    </div>
  `;
}

// Strip line number prefixes from code blocks (for markdown code blocks that may contain line-numbered output)
function stripLineNumbersFromCode(code: string): string {
  const lines = code.split("\n");
  const firstNonEmpty = lines.find(l => l.trim().length > 0);
  if (!firstNonEmpty) return code;

  // Match line number formats: "  1→", "  1:", "  1|", "  1\t"
  const lineNumberPattern = /^\s*\d+[→:\|\t]/;
  if (!lineNumberPattern.test(firstNonEmpty)) {
    return code;
  }
  return lines.map((line) => line.replace(/^\s*\d+[→:\|\t]\s?/, "")).join("\n");
}

export function stripSystemTags(text: string, adapterConfig?: AdapterUIConfig | null): string {
  let cleaned = text;

  // Use adapter config if available
  if (adapterConfig?.systemTags) {
    for (const tagPattern of adapterConfig.systemTags) {
      if (tagPattern.style === "regex" && tagPattern.pattern) {
        cleaned = cleaned.replace(tagPattern.pattern, "");
      } else {
        // XML style (default)
        const regex = new RegExp(`<${tagPattern.tag}>[\\s\\S]*?<\\/${tagPattern.tag}>`, "gi");
        cleaned = cleaned.replace(regex, "");
      }
    }
  } else {
    // Fallback to hardcoded tags for backward compatibility
    // Remove <system_instruction>...</system_instruction> tags and content
    cleaned = cleaned.replace(/<system_instruction>[\s\S]*?<\/system_instruction>/gi, "");
    // Remove <system-instruction>...</system-instruction> tags and content
    cleaned = cleaned.replace(/<system-instruction>[\s\S]*?<\/system-instruction>/gi, "");
    // Remove <system-reminder>...</system-reminder> tags and content
    cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
    // Remove <local-command-caveat>...</local-command-caveat> tags and content
    cleaned = cleaned.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "");
    // Remove <local-command-stdout>...</local-command-stdout> tags and content
    // (these are handled by extractCommandInfo when paired with command-name, this is a fallback)
    cleaned = cleaned.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, "");
  }

  // Trim leading/trailing whitespace
  return cleaned.trim();
}

export function formatMarkdown(text: string): string {
  // Process code blocks first (preserve their content)
  const codeBlocks: string[] = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const index = codeBlocks.length;
    // Strip line number prefixes that may appear in code blocks (e.g., from Read tool output)
    const cleanedCode = stripLineNumbersFromCode(code);
    // Store code in data attribute for client-side syntax highlighting
    // Use base64 encoding to safely store code with special characters
    const encodedCode = btoa(encodeURIComponent(cleanedCode));
    codeBlocks.push(
      `<div class="code-block-container my-2 rounded-md overflow-hidden" data-code-content="${encodedCode}" data-language="${escapeHtml(lang || "")}"><pre class="p-3 bg-bg-primary overflow-x-auto relative group"><button class="copy-code absolute top-2 right-2 p-1 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity" title="Copy code"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg></button><code class="text-[13px]">${escapeHtml(cleanedCode)}</code></pre></div>`
    );
    return `\x00CODE_BLOCK_${index}\x00`;
  });

  // Process markdown tables before inline code (tables use | which could be in code)
  const tables: string[] = [];
  processed = processed.replace(/(?:^|\n)((?:\|[^\n]+\|\n)+)/g, (match, tableContent) => {
    const lines = tableContent.trim().split("\n");
    if (lines.length < 2) return match;

    // Check if second line is a separator row (|---|---|)
    const separatorLine = lines[1];
    if (!/^\|[\s-:|]+\|$/.test(separatorLine)) return match;

    const index = tables.length;
    const headerCells = parsePipedRow(lines[0]);
    const alignments = parseSeparatorRow(separatorLine);
    const bodyRows = lines.slice(2);

    let tableHtml = '<div class="my-2 overflow-x-auto"><table class="min-w-full text-sm border-collapse">';

    // Header
    tableHtml += '<thead><tr class="border-b border-bg-elevated">';
    headerCells.forEach((cell, i) => {
      const align = alignments[i] || "left";
      tableHtml += `<th class="px-3 py-1.5 text-left font-medium text-text-primary" style="text-align: ${align}">${escapeHtml(cell.trim())}</th>`;
    });
    tableHtml += "</tr></thead>";

    // Body
    tableHtml += "<tbody>";
    for (const row of bodyRows) {
      const cells = parsePipedRow(row);
      tableHtml += '<tr class="border-b border-bg-elevated/50">';
      cells.forEach((cell, i) => {
        const align = alignments[i] || "left";
        tableHtml += `<td class="px-3 py-1.5 text-text-secondary" style="text-align: ${align}">${escapeHtml(cell.trim())}</td>`;
      });
      tableHtml += "</tr>";
    }
    tableHtml += "</tbody></table></div>";

    tables.push(tableHtml);
    return `\x00TABLE_${index}\x00`;
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

  // Restore tables
  processed = processed.replace(/\x00TABLE_(\d+)\x00/g, (match, index) => {
    return tables[parseInt(index, 10)] ?? match;
  });

  // Restore inline code
  processed = processed.replace(/\x00INLINE_CODE_(\d+)\x00/g, (match, index) => {
    return inlineCodes[parseInt(index, 10)] ?? match;
  });

  return processed;
}

// Parse a markdown table row like "| cell1 | cell2 | cell3 |" into cells
function parsePipedRow(row: string): string[] {
  // Remove leading and trailing pipes, then split by pipe
  const trimmed = row.replace(/^\||\|$/g, "");
  return trimmed.split("|");
}

// Parse separator row like "|:---|---:|:---:|" to get alignments
function parseSeparatorRow(row: string): string[] {
  const cells = parsePipedRow(row);
  return cells.map(cell => {
    const trimmed = cell.trim();
    const leftColon = trimmed.startsWith(":");
    const rightColon = trimmed.endsWith(":");
    if (leftColon && rightColon) return "center";
    if (rightColon) return "right";
    return "left";
  });
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
  const icon = getToolIcon(block.name);

  return `
    <div class="tool-block min-w-0" data-tool-id="${escapeHtml(block.id)}">
      <button class="tool-header flex items-center gap-1.5 pr-1.5 py-0.5 -ml-0.5 rounded hover:bg-bg-elevated transition-colors"
              data-toggle-tool="${blockId}"
              ${fullPath ? `title="${escapeHtml(fullPath)}"` : ""}>
        <span class="text-text-primary">${icon}</span>
        <span class="text-[13px] font-medium text-text-primary">${escapeHtml(block.name)}</span>
        <span class="font-mono text-[13px] text-text-muted">${escapeHtml(summary)}</span>
        ${status}
        <span class="toggle-icon text-text-muted text-[10px]">&#9654;</span>
      </button>
      <div id="${blockId}" class="tool-content hidden pl-6 mt-1">
        ${fullPath && fullPath !== summary ? `<div class="text-xs text-text-muted font-mono mb-2 break-all">${escapeHtml(fullPath)}</div>` : ""}
        ${renderToolInput(block, fullPath)}
        ${result ? renderToolResult(result, block.name, fullPath) : '<div class="text-text-muted text-sm italic">... pending</div>'}
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
    return '<span class="tool-status text-text-muted">...</span>';
  }
  if (result.is_error) {
    return '<span class="tool-status text-diff-del">&#10007;</span>';
  }
  return '<span class="tool-status text-diff-add">&#10003;</span>';
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

// Get language from file extension
function getLanguageFromPath(filePath: string | null): string {
  if (!filePath) return "";
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const extToLang: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    css: "css",
    scss: "scss",
    html: "html",
    yaml: "yaml",
    yml: "yaml",
    sh: "bash",
    bash: "bash",
    sql: "sql",
  };
  return extToLang[ext] || "";
}

// Strip line number prefixes from Read tool output
// Format: "     1→content" (spaces + number + arrow + content)
// Also handles variations like "  1:" or "  1|" for diff-style output
function stripLineNumbers(content: string): string {
  const lines = content.split("\n");
  // Check if first non-empty line matches the pattern (handles leading empty lines)
  const firstNonEmpty = lines.find(l => l.trim().length > 0);
  if (!firstNonEmpty) return content;

  // Match various line number formats: "  1→", "  1:", "  1|", "  1 " (with tab after)
  const lineNumberPattern = /^\s*\d+[→:\|\t]/;
  if (!lineNumberPattern.test(firstNonEmpty)) {
    return content; // No line numbers to strip
  }
  return lines.map((line) => line.replace(/^\s*\d+[→:\|\t]\s?/, "")).join("\n");
}

function renderToolResult(result: ToolResultBlock, toolName?: string, filePath?: string | null): string {
  // Strip system tags from tool result content (e.g., <system-reminder> tags in Read output)
  const content = stripSystemTags(result.content);
  const lines = content.split("\n");
  const lineCount = lines.length;
  const isLarge = lineCount > 100;
  const resultId = `result-${result.tool_use_id}`;

  // Determine if this result should have syntax highlighting
  const shouldHighlight = !result.is_error && (toolName === "Read" || toolName === "Edit") && filePath;
  const language = shouldHighlight ? getLanguageFromPath(filePath) : "";

  // Strip line numbers from Read/Edit tool output (they add "     1→" prefixes)
  // Always strip for these tools regardless of syntax highlighting
  const shouldStripLineNumbers = !result.is_error && (toolName === "Read" || toolName === "Edit");
  const strippedContent = shouldStripLineNumbers ? stripLineNumbers(content) : content;
  const strippedLines = strippedContent.split("\n");
  const displayContent = isLarge ? strippedLines.slice(0, 50).join("\n") : strippedContent;

  // For syntax-highlighted content, we use data attributes for client-side highlighting
  const codeAttrs = shouldHighlight && language
    ? `data-code-content="${btoa(encodeURIComponent(displayContent))}" data-language="${escapeHtml(language)}"`
    : "";

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
      <div class="tool-result-content bg-bg-primary rounded overflow-hidden max-h-64 overflow-y-auto group" ${codeAttrs}>
        <pre id="${resultId}" class="p-2 text-xs font-mono whitespace-pre-wrap overflow-x-auto">${escapeHtml(displayContent)}</pre>
        ${
          isLarge
            ? `
          <button class="text-accent-primary text-xs hover:underline mt-2 px-2 pb-2" data-show-all-result="${resultId}" data-full-content="${escapeHtml(strippedContent)}">
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
    <div class="bg-bg-tertiary/30 rounded py-1.5 pr-2 -ml-1 pl-1">
      <div class="flex items-center gap-1.5 text-[13px] font-medium mb-1">
        <span class="text-text-primary">${toolIcons.question}</span>
        <span>Question</span>
      </div>
      ${questions
        .map(
          (q, i) => `
        <div class="mb-1 last:mb-0 pl-5">
          <div class="text-[13px] text-text-primary">${escapeHtml(q.question)}</div>
          ${
            answers[i]
              ? `
            <div class="flex items-center gap-1 mt-0.5">
              <span class="text-accent-primary text-xs">&#8594;</span>
              <span class="text-[13px] font-medium">${escapeHtml(String(answers[i]))}</span>
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
    <div class="bg-bg-tertiary/30 rounded py-1.5 pr-2 -ml-1 pl-1">
      <div class="flex items-center gap-1.5 text-[13px] font-medium mb-1">
        <span class="text-text-primary">${toolIcons.todo}</span>
        <span>Tasks</span>
      </div>
      <div class="space-y-0.5 pl-5">
        ${todos
          .map(
            (todo) => `
          <div class="flex items-center gap-1.5 text-[13px]">
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
  const input = block.input as {
    description?: string;
    prompt?: string;
    subagent_type?: string;
    model?: string;
  };
  const description = input.description || input.prompt || "Sub-task";
  const agentType = input.subagent_type || "general-purpose";
  const status = getToolStatus(result);
  const blockId = `task-${block.id}`;

  // Get display name for agent type
  const agentDisplayName = getAgentDisplayName(agentType);

  // Format result content with markdown if present
  const resultContent = result?.content || "";
  const isLarge = resultContent.length > 2000;
  const displayContent = isLarge ? resultContent.slice(0, 2000) : resultContent;
  const formattedResult = result ? formatMarkdown(displayContent) : "";

  return `
    <div class="tool-block border-l-2 border-accent-primary/30 ml-4" data-tool-id="${escapeHtml(block.id)}">
      <button class="tool-header flex items-center gap-1.5 py-0.5 pl-2 pr-1.5 rounded hover:bg-bg-elevated transition-colors"
              data-toggle-tool="${blockId}">
        <span class="text-accent-primary">${toolIcons.task}</span>
        <span class="text-[13px] font-medium text-text-primary">${escapeHtml(agentDisplayName)}</span>
        <span class="text-[13px] text-text-muted truncate max-w-[300px]">${escapeHtml(description.slice(0, 60))}</span>
        ${status}
        <span class="toggle-icon text-text-muted text-[10px]">&#9654;</span>
      </button>
      <div id="${blockId}" class="task-content hidden mt-1 pl-2">
        ${
          result
            ? `
          <div id="${blockId}-result" class="text-sm text-text-secondary leading-relaxed" data-format-markdown="true">
            ${formattedResult}
            ${isLarge ? `<button class="text-accent-primary text-xs hover:underline mt-2 block" data-show-all-result="${blockId}-result" data-full-content="${escapeHtml(resultContent)}">Show all (${Math.round(resultContent.length / 1000)}k chars)</button>` : ""}
          </div>
        `
            : '<div class="text-text-muted text-sm italic">... running</div>'
        }
      </div>
    </div>
  `;
}

// Get human-readable display name for agent types
function getAgentDisplayName(agentType: string): string {
  const typeMap: Record<string, string> = {
    Bash: "Bash Agent",
    "general-purpose": "Agent",
    Explore: "Explorer",
    Plan: "Planner",
    "feature-dev:code-reviewer": "Code Reviewer",
    "feature-dev:code-explorer": "Code Explorer",
    "feature-dev:code-architect": "Architect",
  };
  return typeMap[agentType] || agentType;
}

function renderThinkingBlock(block: ThinkingBlock): string {
  const duration = block.duration_ms
    ? `(${(block.duration_ms / 1000).toFixed(1)}s)`
    : "";
  const blockId = `thinking-${Math.random().toString(36).slice(2, 10)}`;

  return `
    <div class="thinking-block">
      <button class="flex items-center gap-1.5 text-text-muted text-[13px] hover:text-text-secondary pr-1.5 py-0.5 -ml-0.5 rounded hover:bg-bg-elevated transition-colors"
              data-toggle-tool="${blockId}">
        <span class="shrink-0">${toolIcons.thinking}</span>
        <span class="italic">Thinking</span>
        <span class="text-xs opacity-60">${duration}</span>
        <span class="toggle-icon text-[10px]">&#9654;</span>
      </button>
      <div id="${blockId}" class="hidden mt-1 pl-5 text-[13px] text-text-secondary leading-snug">
        ${escapeHtml(block.thinking)}
      </div>
    </div>
  `;
}

function renderImageBlock(block: ImageBlock): string {
  const label = block.filename || "Image";
  return `
    <div class="inline-block bg-bg-tertiary rounded px-2 py-1">
      <span class="text-sm text-text-muted font-mono">[Image: ${escapeHtml(label)}]</span>
    </div>
  `;
}

function renderFileBlock(block: FileBlock): string {
  const size = block.size ? ` (${formatBytes(block.size)})` : "";
  return `
    <div class="inline-block bg-bg-tertiary rounded px-2 py-1">
      <span class="text-sm text-text-muted font-mono">[File: ${escapeHtml(block.filename)}${size}]</span>
    </div>
  `;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
