import { useMemo, useState } from 'react';
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

function IconChevron({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 6l3 3 3-3" />
    </svg>
  );
}

interface AgentTurnProps {
  messages: Message[];
  toolResults: Map<string, ToolResultBlock>;
}

export function AgentTurn({ messages, toolResults }: AgentTurnProps) {
  // Count tool calls and text messages for the turn header
  const { toolCount, messageCount } = useMemo(() => {
    let tools = 0;
    let msgs = 0;

    for (const message of messages) {
      for (const block of message.content_blocks || []) {
        if (block.type === 'tool_use') {
          tools++;
        } else if (block.type === 'text' && block.text.trim()) {
          msgs++;
        }
      }
    }

    return { toolCount: tools, messageCount: msgs };
  }, [messages]);

  // Build the turn header text
  const headerParts: string[] = [];
  if (toolCount > 0) {
    headerParts.push(`${toolCount} tool call${toolCount !== 1 ? 's' : ''}`);
  }
  if (messageCount > 0) {
    headerParts.push(`${messageCount} message${messageCount !== 1 ? 's' : ''}`);
  }
  const headerText = headerParts.join(', ') || 'response';

  return (
    <div className="agent-turn">
      {/* Turn header */}
      <div className="turn-header flex items-center gap-3 text-text-muted text-xs py-1">
        <div className="flex-1 h-px bg-bg-elevated" />
        <span>{headerText}</span>
        <div className="flex-1 h-px bg-bg-elevated" />
      </div>

      {/* Activity list */}
      <div className="activity-list flex flex-col gap-0.5 py-1">
        {messages.map((message) =>
          (message.content_blocks ?? []).map((block, i) =>
            renderBlock(block, i, message.id, toolResults)
          )
        )}
      </div>
    </div>
  );
}

function renderBlock(
  block: ContentBlock,
  index: number,
  messageId: number,
  toolResults: Map<string, ToolResultBlock>
): JSX.Element | null {
  const key = `${messageId}-${index}`;

  switch (block.type) {
    case 'text':
      // Agent text renders as full-width prose
      if (!block.text.trim()) return null;
      return (
        <div key={key} className="agent-text text-sm text-text-primary leading-relaxed py-0.5">
          <TextBlock text={block.text} />
        </div>
      );

    case 'tool_use':
      // Special handling for certain tools
      if (block.name === 'TodoWrite') {
        return <TodoWriteLine key={key} block={block as ToolUseBlock} />;
      }
      if (block.name === 'AskUserQuestion' || block.name === 'mcp__conductor__AskUserQuestion') {
        return <QuestionLine key={key} block={block as ToolUseBlock} result={toolResults.get(block.id)} />;
      }
      if (block.name === 'Task') {
        return <TaskLine key={key} block={block as ToolUseBlock} result={toolResults.get(block.id)} />;
      }
      // Generic tool line
      return (
        <ToolLine
          key={key}
          block={block as ToolUseBlock}
          result={toolResults.get(block.id)}
        />
      );

    case 'thinking':
      return <ThinkingLine key={key} block={block as ThinkingBlock} />;

    case 'tool_result':
      // Skip - rendered inline with tool_use
      return null;

    case 'image':
      return (
        <div key={key} className="text-text-muted text-sm py-0.5">
          [Image: {(block as ContentBlock & { type: 'image' }).filename || 'attachment'}]
        </div>
      );

    case 'file':
      return (
        <div key={key} className="text-text-muted text-sm py-0.5">
          [File: {(block as ContentBlock & { type: 'file' }).filename}]
        </div>
      );

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
        {todos.map((todo, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[13px]">
            {getStatusIcon(todo.status)}
            <span className={todo.status === 'completed' ? 'text-text-muted line-through' : 'text-text-primary'}>
              {todo.content}
            </span>
          </div>
        ))}
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

  const status = result ? (result.is_error ? '✗' : '✓') : '...';
  const statusColor = result ? (result.is_error ? 'text-diff-del' : 'text-diff-add') : 'text-text-muted';

  const hasContent = result?.content && result.content.length > 0;

  const sharedClassName = "flex items-center gap-1.5 text-text-muted text-[13px]";
  const interactiveClassName = `${sharedClassName} hover:text-text-secondary transition-colors`;

  return (
    <div className="task-line py-0.5">
      {hasContent ? (
        <button
          className={interactiveClassName}
          onClick={() => setExpanded(!expanded)}
        >
          <span className={`flex-shrink-0 ${expanded ? 'text-text-secondary' : ''}`}>
            {expanded ? <IconChevron /> : <IconRobot />}
          </span>
          <span className="font-medium">{agentName}</span>
          <span className="truncate max-w-[300px]">{description.slice(0, 50)}</span>
          <span className={statusColor}>{status}</span>
        </button>
      ) : (
        <div className={sharedClassName}>
          <span className="flex-shrink-0">
            <IconRobot />
          </span>
          <span className="font-medium">{agentName}</span>
          <span className="truncate max-w-[300px]">{description.slice(0, 50)}</span>
          <span className={statusColor}>{status}</span>
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

function getStatusIcon(status: string): JSX.Element {
  switch (status) {
    case 'completed':
      return <span className="text-diff-add">✓</span>;
    case 'in_progress':
      return <span className="text-accent-primary">●</span>;
    default:
      return <span className="text-text-muted">○</span>;
  }
}
