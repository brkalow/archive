import { useState, useMemo } from 'react';
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

interface BlockItem {
  block: ContentBlock;
  key: string;
  isActivity: boolean;
}

export function AgentTurn({ messages, toolResults }: AgentTurnProps) {
  // Collect all blocks in order, tracking which are activity (tools/thinking) vs text
  const { allBlocks, toolCount } = useMemo(() => {
    const blocks: BlockItem[] = [];
    let tools = 0;

    for (const message of messages) {
      for (let i = 0; i < (message.content_blocks ?? []).length; i++) {
        const block = message.content_blocks![i]!;
        const key = `${message.id}-${i}`;

        if (block.type === 'text' && block.text.trim()) {
          blocks.push({ block, key, isActivity: false });
        } else if (block.type === 'tool_use' || block.type === 'thinking') {
          blocks.push({ block, key, isActivity: true });
          if (block.type === 'tool_use') tools++;
        }
      }
    }

    return { allBlocks: blocks, toolCount: tools };
  }, [messages]);

  // Split blocks: activity section (up to last tool/thinking) and trailing text (response)
  const lastActivityIndex = allBlocks.findLastIndex(b => b.isActivity);
  const activitySection = lastActivityIndex >= 0 ? allBlocks.slice(0, lastActivityIndex + 1) : [];
  const trailingTextBlocks = lastActivityIndex >= 0 ? allBlocks.slice(lastActivityIndex + 1) : allBlocks;

  // Show activity section if there are tools
  const showActivity = toolCount > 0;

  return (
    <div className="agent-turn">
      {/* Activity list (sequential tools - always visible) */}
      {showActivity && (
        <div className="activity-list flex flex-col gap-1.5 py-1">
          {activitySection.map(({ block, key, isActivity }) => {
            if (isActivity) {
              return renderActivityBlock(block, key, toolResults);
            }
            return (
              <div key={key} className="text-sm text-text-secondary leading-relaxed py-0.5 italic">
                <TextBlock text={(block as { text: string }).text} />
              </div>
            );
          })}
        </div>
      )}

      {/* Trailing text responses (always visible) */}
      {trailingTextBlocks.length > 0 && showActivity && (
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
  toolResults: Map<string, ToolResultBlock>
): JSX.Element | null {
  if (block.type === 'thinking') {
    return <ThinkingLine key={key} block={block as ThinkingBlock} />;
  }

  if (block.type !== 'tool_use') {
    return null;
  }

  const toolBlock = block as ToolUseBlock;
  const result = toolResults.get(block.id);

  switch (block.name) {
    case 'TodoWrite':
      return <TodoWriteLine key={key} block={toolBlock} />;
    case 'AskUserQuestion':
    case 'mcp__conductor__AskUserQuestion':
      return <QuestionLine key={key} block={toolBlock} result={result} />;
    case 'Task':
      return <TaskLine key={key} block={toolBlock} result={result} />;
    default:
      return <ToolLine key={key} block={toolBlock} result={result} />;
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
      <div className="flex items-center gap-1.5 text-text-muted text-sm">
        <IconList />
        <span className="font-medium">Tasks</span>
      </div>
      <div className="ml-5 mt-1 space-y-0.5">
        {todos.map((todo, i) => {
          const icon = getStatusIcon(todo.status);
          return (
            <div key={i} className="flex items-center gap-1.5 text-sm">
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
      <div className="flex items-center gap-1.5 text-text-muted text-sm">
        <IconQuestion />
        <span className="font-medium">Question</span>
      </div>
      <div className="ml-5 mt-1 space-y-1">
        {questions.map((q, i) => (
          <div key={i}>
            <div className="text-sm text-text-primary">{q.question}</div>
            {answers[i] && (
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-accent-primary text-xs">&rarr;</span>
                <span className="text-sm font-medium text-text-primary">{String(answers[i])}</span>
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
  const hasContent = Boolean(result?.content);

  const content = (
    <>
      <span className={`flex-shrink-0 ${expanded ? 'text-text-secondary' : ''}`}>
        {expanded ? <IconChevron expanded /> : <IconRobot />}
      </span>
      <span className="font-medium">{agentName}</span>
      <span className="truncate max-w-[350px]">{description.slice(0, 60)}</span>
      {status && <span className={statusColor}>{status}</span>}
    </>
  );

  return (
    <div className="task-line py-1">
      {hasContent ? (
        <button
          className="flex items-center gap-1.5 text-text-muted text-sm hover:text-text-secondary transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          {content}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 text-text-muted text-sm">
          {content}
        </div>
      )}

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
