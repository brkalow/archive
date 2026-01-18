import { useState, useCallback } from 'react';
import { formatMarkdown, escapeHtml, getToolIcon, stripSystemTags } from '../blocks';
import type { ToolUseBlock as ToolUseBlockType, ToolResultBlock } from '../../db/schema';

interface ToolBlockProps {
  block: ToolUseBlockType;
  result?: ToolResultBlock;
}

export function ToolBlock({ block, result }: ToolBlockProps) {
  const [expanded, setExpanded] = useState(false);

  // Dispatch to render functions based on tool name
  switch (block.name) {
    case 'mcp__conductor__AskUserQuestion':
    case 'AskUserQuestion':
      return <AskUserQuestionBlock block={block} result={result} />;
    case 'TodoWrite':
      return <TodoWriteBlock block={block} />;
    case 'Task':
      return <TaskBlock block={block} result={result} />;
    default:
      return (
        <GenericToolBlock
          block={block}
          result={result}
          expanded={expanded}
          setExpanded={setExpanded}
        />
      );
  }
}

// Helper functions
function getToolSummary(block: ToolUseBlockType): string {
  const input = block.input as Record<string, unknown>;

  switch (block.name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return getDisplayPath(String(input.file_path || ''));
    case 'Bash': {
      const cmd = String(input.command || '');
      return cmd.length > 40 ? cmd.slice(0, 40) + '...' : cmd;
    }
    case 'Glob':
    case 'Grep':
      return String(input.pattern || '');
    case 'Task':
      return String(input.description || input.prompt || '').slice(0, 40);
    default:
      return '';
  }
}

function getFullPath(block: ToolUseBlockType): string | null {
  const input = block.input as Record<string, unknown>;
  if (['Read', 'Write', 'Edit'].includes(block.name)) {
    return String(input.file_path || '') || null;
  }
  return null;
}

function getStatus(result?: ToolResultBlock): string {
  if (!result) {
    return '<span class="tool-status text-text-muted">...</span>';
  }
  if (result.is_error) {
    return '<span class="tool-status text-diff-del">\u2717</span>';
  }
  return '<span class="tool-status text-diff-add">\u2713</span>';
}

function getStatusIcon(status: string): JSX.Element {
  switch (status) {
    case 'completed':
      return <span className="text-diff-add">{'\u2713'}</span>;
    case 'in_progress':
      return <span className="text-accent-primary">{'\u25CF'}</span>;
    default:
      return <span className="text-text-muted">{'\u25CB'}</span>;
  }
}

function getDisplayPath(fullPath: string): string {
  if (!fullPath) return '';
  const parts = fullPath.split('/');
  const indicators = ['src', 'lib', 'bin', 'test', 'tests', 'packages', 'apps'];
  for (let i = 0; i < parts.length; i++) {
    if (indicators.includes(parts[i] ?? '')) {
      return parts.slice(i).join('/');
    }
  }
  return parts[parts.length - 1] || fullPath;
}

function getAgentDisplayName(agentType: string): string {
  const typeMap: Record<string, string> = {
    Bash: 'Bash Agent',
    'general-purpose': 'Agent',
    Explore: 'Explorer',
    Plan: 'Planner',
  };
  return typeMap[agentType] || agentType;
}

function truncateValue(value: unknown): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return str.length > 100 ? str.slice(0, 100) + '...' : str;
}

// Sub-components
interface GenericToolBlockProps {
  block: ToolUseBlockType;
  result?: ToolResultBlock;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
}

function GenericToolBlock({ block, result, expanded, setExpanded }: GenericToolBlockProps) {
  const [copied, setCopied] = useState(false);

  const summary = getToolSummary(block);
  const fullPath = getFullPath(block);
  const status = getStatus(result);
  const blockId = `tool-${block.id}`;
  const icon = getToolIcon(block.name);

  const handleToggle = useCallback(() => {
    setExpanded(!expanded);
  }, [expanded, setExpanded]);

  const handleCopyResult = useCallback(async (content: string) => {
    await window.copyToClipboard(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1000);
  }, []);

  const handleShowAllLines = useCallback((resultId: string, fullContent: string) => {
    const el = document.getElementById(resultId);
    if (el) {
      el.textContent = fullContent;
      el.nextElementSibling?.remove(); // Remove "Show all" button
    }
  }, []);

  return (
    <div className="tool-block min-w-0" data-tool-id={block.id}>
      <button
        className="tool-header flex items-center gap-1.5 pr-1.5 py-0.5 -ml-0.5 rounded hover:bg-bg-elevated transition-colors"
        title={fullPath || undefined}
        onClick={handleToggle}
      >
        <span className="text-text-primary" dangerouslySetInnerHTML={{ __html: icon }} />
        <span className="text-[13px] font-medium text-text-primary">{block.name}</span>
        <span className="font-mono text-[13px] text-text-muted">{summary}</span>
        <span dangerouslySetInnerHTML={{ __html: status }} />
        <span className="toggle-icon text-text-muted text-[10px]">
          {expanded ? '\u25BC' : '\u25B6'}
        </span>
      </button>
      <div id={blockId} className={`tool-content pl-6 mt-1 ${expanded ? '' : 'hidden'}`}>
        {fullPath && fullPath !== summary && (
          <div className="text-xs text-text-muted font-mono mb-2 break-all">{fullPath}</div>
        )}
        <ToolInput block={block} fullPath={fullPath} />
        {result ? (
          <ToolResult
            result={result}
            onCopy={handleCopyResult}
            onShowAllLines={handleShowAllLines}
          />
        ) : (
          <div className="text-text-muted text-sm italic">... pending</div>
        )}
      </div>
    </div>
  );
}

interface ToolInputProps {
  block: ToolUseBlockType;
  fullPath: string | null;
}

function ToolInput({ block, fullPath }: ToolInputProps) {
  const input = block.input as Record<string, unknown>;

  const entries = Object.entries(input)
    .filter(([k, v]) => {
      if (v === undefined || v === null) return false;
      if (k === 'file_path' && fullPath) return false;
      return true;
    })
    .slice(0, 5);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="text-xs text-text-muted mb-2">
      <div className="font-semibold mb-1">Input:</div>
      {entries.map(([k, v]) => (
        <div key={k} className="pl-2 break-all">
          <span className="text-text-secondary">{k}:</span>{' '}
          <span className="font-mono">{truncateValue(v)}</span>
        </div>
      ))}
    </div>
  );
}

interface ToolResultProps {
  result: ToolResultBlock;
  onCopy: (content: string) => void;
  onShowAllLines: (resultId: string, content: string) => void;
}

function ToolResult({ result, onCopy, onShowAllLines }: ToolResultProps) {
  const content = stripSystemTags(result.content);
  const lines = content.split('\n');
  const isLarge = lines.length > 100;
  const displayContent = isLarge ? lines.slice(0, 50).join('\n') : content;
  const resultId = `result-${result.tool_use_id}`;

  return (
    <div className="tool-result">
      <div className="flex items-center justify-between text-xs text-text-muted mb-1">
        <span>
          Result:{' '}
          {result.is_error ? (
            <span className="text-diff-del">(error)</span>
          ) : (
            `(${lines.length} lines)`
          )}
        </span>
        <button
          className="copy-result p-1 text-text-muted hover:text-text-primary transition-opacity"
          title="Copy result"
          onClick={() => onCopy(content)}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        </button>
      </div>
      <div className="tool-result-content bg-bg-primary rounded overflow-hidden max-h-64 overflow-y-auto group">
        <pre
          id={resultId}
          className="p-2 text-xs font-mono whitespace-pre-wrap overflow-x-auto"
        >
          {displayContent}
        </pre>
        {isLarge && (
          <button
            className="text-accent-primary text-xs hover:underline mt-2 px-2 pb-2"
            onClick={() => onShowAllLines(resultId, content)}
          >
            Show all {lines.length} lines
          </button>
        )}
      </div>
    </div>
  );
}

interface AskUserQuestionBlockProps {
  block: ToolUseBlockType;
  result?: ToolResultBlock;
}

function AskUserQuestionBlock({ block, result }: AskUserQuestionBlockProps) {
  const input = block.input as { questions?: Array<{ question: string }> };
  const questions = input.questions || [];

  let answers: string[] = [];
  if (result?.content) {
    try {
      const parsed = JSON.parse(result.content);
      answers = Object.values(parsed.answers || parsed || {}) as string[];
    } catch {
      answers = [result.content];
    }
  }

  return (
    <div className="bg-bg-tertiary/30 rounded py-1.5 pr-2 -ml-1 pl-1">
      <div className="flex items-center gap-1.5 text-[13px] font-medium mb-1">
        <span className="text-text-primary">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </span>
        <span>Question</span>
      </div>
      {questions.map((q, i) => (
        <div key={i} className="mb-1 last:mb-0 pl-5">
          <div className="text-[13px] text-text-primary">{q.question}</div>
          {answers[i] && (
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-accent-primary text-xs">{'\u2192'}</span>
              <span className="text-[13px] font-medium">{String(answers[i])}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

interface TodoWriteBlockProps {
  block: ToolUseBlockType;
}

function TodoWriteBlock({ block }: TodoWriteBlockProps) {
  const input = block.input as { todos?: Array<{ content: string; status: string }> };
  const todos = input.todos || [];

  return (
    <div className="bg-bg-tertiary/30 rounded py-1.5 pr-2 -ml-1 pl-1">
      <div className="flex items-center gap-1.5 text-[13px] font-medium mb-1">
        <span className="text-text-primary">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
            />
          </svg>
        </span>
        <span>Tasks</span>
      </div>
      <div className="space-y-0.5 pl-5">
        {todos.map((todo, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[13px]">
            {getStatusIcon(todo.status)}
            <span className={todo.status === 'completed' ? 'text-text-muted line-through' : ''}>
              {todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface TaskBlockProps {
  block: ToolUseBlockType;
  result?: ToolResultBlock;
}

function TaskBlock({ block, result }: TaskBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const input = block.input as {
    description?: string;
    prompt?: string;
    subagent_type?: string;
  };
  const description = input.description || input.prompt || 'Sub-task';
  const agentType = input.subagent_type || 'general-purpose';
  const status = getStatus(result);
  const blockId = `task-${block.id}`;

  const agentDisplayName = getAgentDisplayName(agentType);
  const resultContent = result?.content || '';
  const isLarge = resultContent.length > 2000;
  const displayContent = isLarge ? resultContent.slice(0, 2000) : resultContent;

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  return (
    <div className="tool-block border-l-2 border-accent-primary/30 ml-4" data-tool-id={block.id}>
      <button
        className="tool-header flex items-center gap-1.5 py-0.5 pl-2 pr-1.5 rounded hover:bg-bg-elevated transition-colors"
        onClick={handleToggle}
      >
        <span className="text-accent-primary">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
            />
          </svg>
        </span>
        <span className="text-[13px] font-medium text-text-primary">{agentDisplayName}</span>
        <span className="text-[13px] text-text-muted truncate max-w-[300px]">
          {description.slice(0, 60)}
        </span>
        <span dangerouslySetInnerHTML={{ __html: status }} />
        <span className="toggle-icon text-text-muted text-[10px]">
          {expanded ? '\u25BC' : '\u25B6'}
        </span>
      </button>
      <div id={blockId} className={`task-content mt-1 pl-2 ${expanded ? '' : 'hidden'}`}>
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
