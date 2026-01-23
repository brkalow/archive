import { useState, useCallback } from 'react';
import { stripSystemTags } from '../blocks';
import type { ToolUseBlock, ToolResultBlock, ThinkingBlock as ThinkingBlockType } from '../../db/schema';

// SVG Icon Components
function IconThinking({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {/* Brain outline with characteristic bumps */}
      <path d="M12 4.5c-2 0-3.5.8-4.5 2-.8 0-2 .5-2.5 1.5s-.5 2 0 3c-.5.5-1 1.5-1 2.5 0 2 1.5 3.5 3.5 3.5.5.8 1.5 1.5 3 1.5h3c1.5 0 2.5-.7 3-1.5 2 0 3.5-1.5 3.5-3.5 0-1-.5-2-1-2.5.5-1 .5-2 0-3s-1.7-1.5-2.5-1.5c-1-1.2-2.5-2-4.5-2z" />
      <path d="M12 4.5v14" />
      <path d="M7.5 9c1.5 0 2.5 1 2.5 2.5" />
      <path d="M16.5 9c-1.5 0-2.5 1-2.5 2.5" />
    </svg>
  );
}

function IconDocument({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 2h5l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" />
      <path d="M9 2v4h4" />
    </svg>
  );
}

function IconPencil({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" />
      <path d="M10 4l2 2" />
    </svg>
  );
}

function IconTerminal({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 5l3 3-3 3" />
      <path d="M9 11h4" />
    </svg>
  );
}

function IconSearch({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3 3" />
    </svg>
  );
}

function IconBolt({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M9 2L4 9h4l-1 5 5-7H8l1-5z" />
    </svg>
  );
}

function IconGlobe({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12" />
      <path d="M8 2c2 2 2 10 0 12" />
      <path d="M8 2c-2 2-2 10 0 12" />
    </svg>
  );
}

function IconGear({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3" />
    </svg>
  );
}

function IconChevron({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 6l3 3 3-3" />
    </svg>
  );
}

// Tool line component
interface ToolLineProps {
  block: ToolUseBlock;
  result?: ToolResultBlock;
}

export function ToolLine({ block, result }: ToolLineProps) {
  const [expanded, setExpanded] = useState(false);

  const Icon = getToolIcon(block.name);
  const summary = getToolSummary(block);
  const status = getToolStatus(result);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  return (
    <div className="tool-line">
      <button
        className="flex items-center gap-1.5 text-text-muted hover:text-text-secondary transition-colors text-sm py-1"
        onClick={handleToggle}
      >
        <span className={`flex-shrink-0 ${expanded ? 'text-text-secondary' : ''}`}>
          {expanded ? <IconChevron /> : <Icon />}
        </span>
        <span className="font-medium">{block.name}</span>
        <span className="font-mono truncate max-w-[350px]">{summary}</span>
        {status}
      </button>

      {expanded && result && (
        <ExpandedToolContent result={result} />
      )}

      {expanded && !result && (
        <div className="ml-5 mt-1 text-text-muted text-xs italic">Running...</div>
      )}
    </div>
  );
}

// Thinking line component
interface ThinkingLineProps {
  block: ThinkingBlockType;
}

export function ThinkingLine({ block }: ThinkingLineProps) {
  const [expanded, setExpanded] = useState(false);

  const preview = block.thinking.slice(0, 50).replace(/\n/g, ' ');
  const duration = block.duration_ms ? `(${(block.duration_ms / 1000).toFixed(1)}s)` : '';

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  return (
    <div className="thinking-line">
      <button
        className="flex items-center gap-1.5 text-text-muted hover:text-text-secondary transition-colors text-sm py-1"
        onClick={handleToggle}
      >
        <span className="flex-shrink-0">
          {expanded ? <IconChevron /> : <IconThinking />}
        </span>
        <span className="font-medium">Thinking</span>
        {!expanded && (
          <span className="truncate max-w-[450px] opacity-70">{preview}...</span>
        )}
        {expanded && duration && (
          <span className="text-xs opacity-70">{duration}</span>
        )}
      </button>

      {expanded && (
        <div className="ml-5 mt-1 p-2 bg-bg-secondary rounded border border-bg-elevated">
          <pre className="text-xs font-mono text-text-muted whitespace-pre-wrap leading-relaxed">
            {block.thinking}
          </pre>
        </div>
      )}
    </div>
  );
}

// Expanded tool content
interface ExpandedToolContentProps {
  result: ToolResultBlock;
}

function ExpandedToolContent({ result }: ExpandedToolContentProps) {
  const [showAll, setShowAll] = useState(false);

  const content = result.content ? stripSystemTags(result.content) : '';
  const lines = content.split('\n');
  const isLarge = lines.length > 20;
  const displayContent = isLarge && !showAll ? lines.slice(0, 20).join('\n') : content;

  return (
    <div className="ml-5 mt-1">
      <div className="bg-bg-secondary rounded border border-bg-elevated overflow-hidden">
        <pre className="p-2 text-xs font-mono text-text-secondary whitespace-pre-wrap max-h-64 overflow-y-auto">
          {displayContent}
        </pre>
        {isLarge && !showAll && (
          <button
            className="px-2 pb-2 text-accent-primary text-xs hover:underline"
            onClick={() => setShowAll(true)}
          >
            Show all {lines.length} lines
          </button>
        )}
      </div>
      {result.is_error && (
        <div className="text-xs text-diff-del mt-1">Error</div>
      )}
    </div>
  );
}

// Helper functions
type IconComponent = ({ className }: { className?: string }) => JSX.Element;

function getToolIcon(name: string): IconComponent {
  switch (name) {
    case 'Read':
      return IconDocument;
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return IconPencil;
    case 'Bash':
      return IconTerminal;
    case 'Glob':
    case 'Grep':
      return IconSearch;
    case 'Task':
      return IconBolt;
    case 'WebFetch':
    case 'WebSearch':
      return IconGlobe;
    default:
      return IconGear;
  }
}

function getToolSummary(block: ToolUseBlock): string {
  const input = block.input as Record<string, unknown>;

  switch (block.name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return getDisplayPath(String(input.file_path || input.notebook_path || ''));
    case 'Bash': {
      const cmd = String(input.command || '');
      return cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd;
    }
    case 'Glob':
      return String(input.pattern || '');
    case 'Grep':
      return `"${String(input.pattern || '')}"`;
    case 'Task':
      return String(input.description || '').slice(0, 40);
    case 'WebFetch':
    case 'WebSearch':
      return String(input.url || input.query || '').slice(0, 40);
    default:
      return '';
  }
}

function getDisplayPath(fullPath: string): string {
  if (!fullPath) return '';
  const parts = fullPath.split('/');
  const indicators = ['src', 'lib', 'bin', 'test', 'tests', 'packages', 'apps', 'components'];
  for (let i = 0; i < parts.length; i++) {
    if (indicators.includes(parts[i] ?? '')) {
      return parts.slice(i).join('/');
    }
  }
  return parts.slice(-2).join('/') || fullPath;
}

function getToolStatus(result?: ToolResultBlock): JSX.Element | null {
  if (!result) {
    return <span className="text-text-muted">...</span>;
  }
  if (result.is_error) {
    return <span className="text-diff-del">✗</span>;
  }
  // Only show indicator for errors, not for success
  return null;
}
