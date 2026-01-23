import { useCallback } from 'react';
import { useUser } from '@clerk/react';
import { TextBlock } from './TextBlock';
import { useClipboard } from '../hooks';
import { useClerkConfigured } from './AuthContext';
import type { Message, ContentBlock } from '../../db/schema';

interface UserBubbleProps {
  message: Message;
}

export function UserBubble({ message }: UserBubbleProps) {
  const { copy, copied } = useClipboard();
  const isClerkConfigured = useClerkConfigured();

  const handleCopy = useCallback(() => {
    const textContent = message.content_blocks
      ?.filter((b) => b.type === 'text')
      .map((b) => (b as ContentBlock & { type: 'text' }).text)
      .join('\n')
      .trim();

    if (textContent) {
      copy(textContent);
    }
  }, [message.content_blocks, copy]);

  // Render text blocks, skip tool_result blocks (handled inline with tool_use)
  const textBlocks = message.content_blocks?.filter((b) => b.type === 'text') || [];

  if (textBlocks.length === 0) {
    return null;
  }

  return (
    <div className="flex justify-end items-start gap-3 w-full">
      <div className="user-bubble group relative max-w-[70%] border border-white/10 rounded-lg px-4 py-3">
        {/* Copy button - appears on hover */}
        <button
          className={`absolute -left-8 top-2 p-1 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity ${copied ? 'text-diff-add' : ''}`}
          title="Copy message"
          onClick={handleCopy}
        >
          {copied ? (
            <CheckIcon />
          ) : (
            <CopyIcon />
          )}
        </button>

        {/* Message content */}
        <div className="text-sm text-text-primary leading-relaxed">
          {textBlocks.map((block, i) => (
            <TextBlock key={i} text={(block as ContentBlock & { type: 'text' }).text} />
          ))}
        </div>
      </div>

      {/* User avatar - use message's user_id for attribution */}
      {isClerkConfigured ? <UserAvatar messageUserId={message.user_id} /> : <DefaultAvatar />}
    </div>
  );
}

function UserAvatar({ messageUserId }: { messageUserId: string | null | undefined }) {
  const { user } = useUser();

  // If message has a user_id that differs from current user, show default avatar
  // (In the future, we could fetch the other user's avatar from Clerk)
  if (messageUserId && user?.id && messageUserId !== user.id) {
    return <DefaultAvatar />;
  }

  // Show current user's avatar for their own messages or messages without attribution
  if (!user?.imageUrl) {
    return <DefaultAvatar />;
  }

  return (
    <img
      src={user.imageUrl}
      alt={user.fullName || 'User'}
      className="w-7 h-7 rounded-full flex-shrink-0"
    />
  );
}

function DefaultAvatar() {
  return (
    <div className="w-7 h-7 rounded-full bg-surface-tertiary flex items-center justify-center flex-shrink-0">
      <svg className="w-4 h-4 text-text-muted" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
      </svg>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
    </svg>
  );
}
