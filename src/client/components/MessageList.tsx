import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { MessageBlock } from './MessageBlock';
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
    if (scrollContainerRef.current && isNearBottom(scrollContainerRef.current)) {
      scrollToBottom(scrollContainerRef.current);
      setShowNewMessagesButton(false);
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
        className="conversation-list overflow-y-auto h-full space-y-4 p-4"
        onScroll={handleScroll}
      >
        {messages.map((message, i) => (
          <MessageBlock
            key={message.id || i}
            message={message}
            toolResults={toolResults}
            showRoleBadge={i === 0 || message.role !== messages[i - 1]?.role}
            messageIndex={i}
          />
        ))}

        {/* Typing indicator */}
        {showTypingIndicator && <TypingIndicator />}
      </div>

      {/* New messages button */}
      {showNewMessagesButton && (
        <button
          className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-accent-primary text-white rounded-full shadow-lg hover:bg-accent-primary/90 transition-all"
          onClick={handleScrollToBottom}
        >
          New messages
        </button>
      )}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-2 text-text-muted text-sm">
      <div className="flex gap-1">
        <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-2 h-2 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      <span>Claude is working...</span>
    </div>
  );
}
