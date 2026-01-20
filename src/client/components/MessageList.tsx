import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { UserBubble } from './UserBubble';
import { AgentTurn } from './AgentTurn';
import { useLiveSession } from '../hooks/useLiveSession';
import { buildToolResultMap } from '../blocks';
import { isNearBottom, scrollToBottom } from '../liveSession';
import type { Message, Session } from '../../db/schema';

interface MessageListProps {
  sessionId: string;
  initialMessages: Message[];
  session: Session;
  isLive: boolean;
  onSessionComplete?: () => void;
  onConnectionChange?: (connected: boolean) => void;
  onDiffUpdate?: () => void;
  onInteractiveInfo?: (interactive: boolean, claudeState: string) => void;
  onClaudeState?: (state: 'running' | 'waiting') => void;
  onFeedbackQueued?: (messageId: string, position: number) => void;
  onFeedbackStatus?: (messageId: string, status: string) => void;
  // Callback ref to expose handle to parent
  onHandle?: (handle: MessageListHandle) => void;
}

export interface MessageListHandle {
  sendFeedback: (content: string) => void;
  getMessageCount: () => number;
}

// Group messages into turns: each user message starts a new turn,
// followed by consecutive assistant messages
interface Turn {
  type: 'user' | 'agent';
  messages: Message[];
}

function groupMessagesIntoTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let currentAgentMessages: Message[] = [];

  for (const message of messages) {
    // Skip user messages that only contain tool_result blocks
    if (message.role === 'user') {
      const hasNonToolResult = message.content_blocks?.some(
        (block) => block.type !== 'tool_result'
      );
      if (!hasNonToolResult) {
        continue;
      }

      // Flush any pending agent messages
      if (currentAgentMessages.length > 0) {
        turns.push({ type: 'agent', messages: currentAgentMessages });
        currentAgentMessages = [];
      }

      // Add user turn
      turns.push({ type: 'user', messages: [message] });
    } else if (message.role === 'assistant') {
      // Accumulate assistant messages
      currentAgentMessages.push(message);
    }
    // Skip system messages
  }

  // Flush remaining agent messages
  if (currentAgentMessages.length > 0) {
    turns.push({ type: 'agent', messages: currentAgentMessages });
  }

  return turns;
}

export function MessageList(props: MessageListProps) {
  const {
    sessionId,
    initialMessages,
    isLive,
    onSessionComplete,
    onConnectionChange,
    onDiffUpdate,
    onInteractiveInfo,
    onClaudeState,
    onFeedbackQueued,
    onFeedbackStatus,
    onHandle,
  } = props;

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showNewMessagesButton, setShowNewMessagesButton] = useState(false);
  const prevMessageCountRef = useRef(initialMessages.length);

  // Use the live session hook
  const {
    messages,
    pendingToolCalls,
    sendFeedback,
  } = useLiveSession({
    sessionId,
    enabled: isLive,
    initialMessages,
    onComplete: onSessionComplete,
    onConnectionChange,
    onDiffUpdate,
    onInteractiveInfo,
    onClaudeState,
    onFeedbackQueued,
    onFeedbackStatus,
  });

  // Build tool result map (memoized per Vercel best practice: rerender-memo)
  const toolResults = useMemo(() => {
    const allBlocks = messages.flatMap(m => m.content_blocks || []);
    return buildToolResultMap(allBlocks);
  }, [messages]);

  // Group messages into turns
  const turns = useMemo(() => groupMessagesIntoTurns(messages), [messages]);

  // Expose handle to parent via callback
  useEffect(() => {
    if (onHandle) {
      onHandle({
        sendFeedback,
        getMessageCount: () => messages.length,
      });
    }
  }, [onHandle, sendFeedback, messages.length]);

  // Auto-scroll effect when messages change
  useEffect(() => {
    const hasNewMessages = messages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    if (scrollContainerRef.current) {
      if (isNearBottom(scrollContainerRef.current)) {
        scrollToBottom(scrollContainerRef.current);
        setShowNewMessagesButton(false);
      } else if (hasNewMessages) {
        // User is scrolled up and new messages arrived - show the button
        setShowNewMessagesButton(true);
      }
    }
  }, [messages.length]);

  // Scroll handler
  const handleScroll = useCallback(() => {
    if (scrollContainerRef.current && isNearBottom(scrollContainerRef.current)) {
      setShowNewMessagesButton(false);
    }
  }, []);

  const handleScrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      scrollToBottom(scrollContainerRef.current);
      setShowNewMessagesButton(false);
    }
  }, []);

  const showTypingIndicator = pendingToolCalls.size > 0;

  return (
    <div className="message-list-container relative h-full">
      <div
        ref={scrollContainerRef}
        className="conversation-panel flex-1 overflow-y-auto flex flex-col h-full"
        onScroll={handleScroll}
      >
        {/* Chat bubble layout */}
        <div className="flex flex-col gap-4 px-2 py-4">
          {turns.map((turn, i) => {
            if (turn.type === 'user') {
              return <UserBubble key={`user-${i}`} message={turn.messages[0]!} />;
            } else {
              return (
                <AgentTurn
                  key={`agent-${i}`}
                  messages={turn.messages}
                  toolResults={toolResults}
                />
              );
            }
          })}

          {/* Typing indicator */}
          {showTypingIndicator && <TypingIndicator />}
        </div>
      </div>

      {/* New messages button */}
      {showNewMessagesButton && (
        <button
          className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-accent-primary text-bg-primary font-medium rounded-full shadow-lg hover:bg-accent-primary/90 transition-all text-sm"
          onClick={handleScrollToBottom}
        >
          ↓ New messages
        </button>
      )}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="agent-turn">
      {/* Turn header style */}
      <div className="turn-header flex items-center gap-3 text-text-muted text-xs py-1">
        <div className="flex-1 h-px bg-bg-elevated" />
        <span>working</span>
        <div className="flex-1 h-px bg-bg-elevated" />
      </div>

      {/* Typing dots */}
      <div className="flex items-center gap-2 py-2 text-text-muted">
        <div className="flex gap-1">
          <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
        <span className="text-sm">Claude is working...</span>
      </div>
    </div>
  );
}
