import { useCallback } from 'react';
import { TextBlock } from './TextBlock';
import { useClipboard } from '../hooks';
import type { Message, ContentBlock } from '../../db/schema';

interface UserBubbleProps {
  message: Message;
}

export function UserBubble({ message }: UserBubbleProps) {
  const { copy, copied } = useClipboard();

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
    <div className="flex justify-end w-full">
      <div className="user-bubble group relative max-w-[70%] bg-bg-tertiary rounded-2xl rounded-br-sm px-4 py-3">
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
