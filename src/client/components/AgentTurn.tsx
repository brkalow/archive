import { useState, useMemo, useEffect, useRef } from 'react';
import { TextBlock } from './TextBlock';
import { ToolLine, ThinkingLine } from './ActivityLine';
import type { Message, ContentBlock, ToolResultBlock, ToolUseBlock, ThinkingBlock } from '../../db/schema';

// SVG Icon Components
function IconList({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M5 4h8M5 8h8M5 12h8" />
      <circle cx="2" cy="4" r="1" fill="currentColor" stroke="none" />
      <circle cx="2" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="2" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconQuestion({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M6 6a2 2 0 012-2 2 2 0 012 2c0 1-1 1.5-1.5 2-.25.25-.5.5-.5 1" />
      <circle cx="8" cy="11.5" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconRobot({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="5" width="10" height="8" rx="1" />
      <circle cx="6" cy="9" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="9" r="1" fill="currentColor" stroke="none" />
      <path d="M8 2v3M6 2h4" />
      <path d="M1 8h2M13 8h2" />
    </svg>
  );
}

function IconChevron({ className = 'w-3.5 h-3.5', expanded = false }: { className?: string; expanded?: boolean }) {
  return (
    <svg
      className={`${className} transition-transform ${expanded ? 'rotate-90' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

interface AgentTurnProps {
  messages: Message[];
  toolResults: Map<string, ToolResultBlock>;
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count !== 1 ? 's' : ''}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

interface BlockItem {
  block: ContentBlock;
  key: string;
  messageId: number;
  isActivity: boolean;
}

export function AgentTurn({ messages, toolResults }: AgentTurnProps) {
  // Collect all blocks in order, tracking which are activity (tools/thinking) vs text
  const { allBlocks, toolCount, totalDurationMs } = useMemo(() => {
    const blocks: BlockItem[] = [];
    let tools = 0;
    let durationMs = 0;

    for (const message of messages) {
      for (let i = 0; i < (message.content_blocks ?? []).length; i++) {
        const block = message.content_blocks![i]!;
        const key = `${message.id}-${i}`;

        if (block.type === 'text' && block.text.trim()) {
          blocks.push({ block, key, messageId: message.id, isActivity: false });
        } else if (block.type === 'tool_use' || block.type === 'thinking') {
          blocks.push({ block, key, messageId: message.id, isActivity: true });
          if (block.type === 'tool_use') tools++;
          if (block.type === 'thinking' && (block as { duration_ms?: number }).duration_ms) {
            durationMs += (block as { duration_ms: number }).duration_ms;
          }
        }
      }
    }

    return { allBlocks: blocks, toolCount: tools, totalDurationMs: durationMs };
  }, [messages]);

  // Split blocks: activity section (up to last tool/thinking) and trailing text (response)
  const lastActivityIndex = allBlocks.findLastIndex(b => b.isActivity);
  const activitySection = lastActivityIndex >= 0 ? allBlocks.slice(0, lastActivityIndex + 1) : [];
  const trailingTextBlocks = lastActivityIndex >= 0 ? allBlocks.slice(lastActivityIndex + 1) : allBlocks;

  // Auto-collapse when response first arrives during streaming
  const [expanded, setExpanded] = useState(trailingTextBlocks.length === 0);
  const hadTextRef = useRef(trailingTextBlocks.length > 0);

  useEffect(() => {
    const hasText = trailingTextBlocks.length > 0;
    // Collapse when response first arrives (transition from no text to has text)
    if (hasText && !hadTextRef.current) {
      setExpanded(false);
    }
    hadTextRef.current = hasText;
  }, [trailingTextBlocks.length]);

  // Build summary text
  const showSummary = toolCount > 0;
  const summaryText = [
    toolCount > 0 && pluralize(toolCount, 'tool call'),
    trailingTextBlocks.length > 0 && pluralize(trailingTextBlocks.length, 'message'),
  ].filter(Boolean).join(', ');
  const durationText = totalDurationMs > 0 ? formatDuration(totalDurationMs) : null;

  return (
    <div className="agent-turn">
      {/* Collapsible activity summary (only if there are tool calls) */}
      {showSummary && (
        <>
          <button
            className="flex items-center gap-1.5 text-text-muted text-[13px] hover:text-text-secondary transition-colors px-2 py-1 rounded border border-bg-elevated"
            onClick={() => setExpanded(!expanded)}
          >
            <IconChevron expanded={expanded} />
            <span>{summaryText}</span>
            {durationText && <span className="opacity-70">({durationText})</span>}
          </button>

          {expanded && (
            <div className="activity-list flex flex-col gap-0.5 py-2">
              {activitySection.map(({ block, key, messageId, isActivity }) => {
                if (isActivity) {
                  return renderActivityBlock(block, key, messageId, toolResults);
                }
                return (
                  <div key={key} className="text-sm text-text-secondary leading-relaxed py-0.5 italic">
                    <TextBlock text={(block as { text: string }).text} />
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Trailing text responses (always visible) */}
      {trailingTextBlocks.length > 0 && showSummary && (
        <div className="text-xs uppercase tracking-[0.1em] text-text-muted font-mono mt-3 mb-1">Response</div>
      )}
      {trailingTextBlocks.map(({ block, key }) => (
        <div key={key} className="agent-text text-sm text-text-primary leading-relaxed py-1">
          <TextBlock text={(block as { text: string }).text} />
        </div>
      ))}
    </div>
  );
}

function renderActivityBlock(
  block: ContentBlock,
  key: string,
  messageId: number,
  toolResults: Map<string, ToolResultBlock>
): JSX.Element | null {
  switch (block.type) {
    case 'tool_use':
      if (block.name === 'TodoWrite') {
        return <TodoWriteLine key={key} block={block as ToolUseBlock} />;
      }
      if (block.name === 'AskUserQuestion' || block.name === 'mcp__conductor__AskUserQuestion') {
        return <QuestionLine key={key} block={block as ToolUseBlock} result={toolResults.get(block.id)} />;
      }
      if (block.name === 'Task') {
        return <TaskLine key={key} block={block as ToolUseBlock} result={toolResults.get(block.id)} />;
      }
      return (
        <ToolLine
          key={key}
          block={block as ToolUseBlock}
          result={toolResults.get(block.id)}
        />
      );

    case 'thinking':
      return <ThinkingLine key={key} block={block as ThinkingBlock} />;

    default:
      return null;
  }
}

// Special tool renderers

interface TodoWriteLineProps {
  block: ToolUseBlock;
}

function TodoWriteLine({ block }: TodoWriteLineProps) {
  const input = block.input as { todos?: Array<{ content: string; status: string }> };
  const todos = input.todos || [];

  if (todos.length === 0) return null;

  return (
    <div className="todo-line py-1">
      <div className="flex items-center gap-1.5 text-text-muted text-[13px]">
        <IconList />
        <span className="font-medium">Tasks</span>
      </div>
      <div className="ml-5 mt-1 space-y-0.5">
        {todos.map((todo, i) => {
          const icon = getStatusIcon(todo.status);
          return (
            <div key={i} className="flex items-center gap-1.5 text-[13px]">
              {icon}
              <span className={todo.status === 'completed' ? 'text-text-muted line-through' : 'text-text-primary'}>
                {todo.content}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface QuestionLineProps {
  block: ToolUseBlock;
  result?: ToolResultBlock;
}

function QuestionLine({ block, result }: QuestionLineProps) {
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
    <div className="question-line py-1">
      <div className="flex items-center gap-1.5 text-text-muted text-[13px]">
        <IconQuestion />
        <span className="font-medium">Question</span>
      </div>
      <div className="ml-5 mt-1 space-y-1">
        {questions.map((q, i) => (
          <div key={i}>
            <div className="text-[13px] text-text-primary">{q.question}</div>
            {answers[i] && (
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-accent-primary text-xs">&rarr;</span>
                <span className="text-[13px] font-medium text-text-primary">{String(answers[i])}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface TaskLineProps {
  block: ToolUseBlock;
  result?: ToolResultBlock;
}

// Subagent configuration - use robot icon for all, just map display names
const SUBAGENT_CONFIG: Record<string, string> = {
  Bash: 'Bash',
  'general-purpose': 'Agent',
  Explore: 'Explorer',
  Plan: 'Planner',
  'statusline-setup': 'Setup',
  'feature-dev:code-reviewer': 'Reviewer',
  'feature-dev:code-explorer': 'Explorer',
  'feature-dev:code-architect': 'Architect',
};

function getTaskStatus(result?: ToolResultBlock): { status: string | null; statusColor: string } {
  if (!result) {
    return { status: '...', statusColor: 'text-text-muted' };
  }
  if (result.is_error) {
    return { status: '✗', statusColor: 'text-diff-del' };
  }
  // Only show indicator for errors or pending, not for success
  return { status: null, statusColor: '' };
}

function TaskLine({ block, result }: TaskLineProps) {
  const [expanded, setExpanded] = useState(false);

  const input = block.input as {
    description?: string;
    prompt?: string;
    subagent_type?: string;
  };
  const description = input.description || input.prompt || 'Sub-task';
  const agentType = input.subagent_type || 'general-purpose';
  const agentName = SUBAGENT_CONFIG[agentType] || agentType;
  const { status, statusColor } = getTaskStatus(result);
  const hasContent = result?.content && result.content.length > 0;

  const baseClassName = "flex items-center gap-1.5 text-text-muted text-[13px]";
  const Element = hasContent ? 'button' : 'div';
  const elementProps = hasContent
    ? { className: `${baseClassName} hover:text-text-secondary transition-colors`, onClick: () => setExpanded(!expanded) }
    : { className: baseClassName };

  return (
    <div className="task-line py-0.5">
      <Element {...elementProps}>
        <span className={`flex-shrink-0 ${expanded ? 'text-text-secondary' : ''}`}>
          {expanded ? <IconChevron expanded /> : <IconRobot />}
        </span>
        <span className="font-medium">{agentName}</span>
        <span className="truncate max-w-[300px]">{description.slice(0, 50)}</span>
        {status && <span className={statusColor}>{status}</span>}
      </Element>

      {expanded && result?.content && (
        <div className="ml-5 mt-1">
          <div className="bg-bg-secondary rounded border border-bg-elevated overflow-hidden">
            <pre className="p-2 text-xs font-mono text-text-secondary whitespace-pre-wrap max-h-48 overflow-y-auto">
              {result.content.slice(0, 2000)}
              {result.content.length > 2000 && '...'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function getStatusIcon(status: string): JSX.Element | null {
  switch (status) {
    case 'completed':
      return null; // No indicator for success
    case 'in_progress':
      return <span className="text-accent-primary">●</span>;
    default:
      return <span className="text-text-muted">○</span>;
  }
}
