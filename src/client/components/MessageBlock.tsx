import { useCallback } from 'react';
import { TextBlock } from './TextBlock';
import { ToolBlock } from './ToolBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { useClipboard } from '../hooks';
import type { Message, ToolResultBlock, ContentBlock } from '../../db/schema';

interface MessageBlockProps {
  message: Message;
  toolResults: Map<string, ToolResultBlock>;
  showRoleBadge: boolean;
  messageIndex: number;
}

// Icons for role indicators
const messageIcons = {
  user: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
    </svg>
  ),
  assistant: (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017L3.592 20H0l6.569-16.48zm2.327 5.14l-2.36 6.076h4.873l-2.513-6.077z"/>
    </svg>
  ),
  system: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
};

export function MessageBlock({ message, toolResults, showRoleBadge, messageIndex }: MessageBlockProps) {
  const { copy, copied } = useClipboard();

  const handleCopy = useCallback(() => {
    // Get text content from message.content_blocks directly
    const textContent = message.content_blocks
      ?.filter(b => b.type === 'text')
      .map(b => (b as ContentBlock & { type: 'text' }).text)
      .join('\n')
      .trim();

    if (textContent) {
      copy(textContent);
    }
  }, [message.content_blocks, copy]);

  const renderContentBlock = (block: ContentBlock, index: number) => {
    switch (block.type) {
      case 'text':
        return <TextBlock key={`text-${index}`} text={block.text} />;
      case 'tool_use':
        return <ToolBlock key={block.id} block={block} result={toolResults.get(block.id)} />;
      case 'tool_result':
        // Skip - rendered inline with tool_use
        return null;
      case 'thinking':
        return <ThinkingBlock key={`thinking-${index}`} block={block} />;
      case 'image':
        return renderImageBlock(block, index);
      case 'file':
        return renderFileBlock(block, index);
      default:
        return null;
    }
  };

  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const roleLabel = isUser ? 'You' : isSystem ? 'System' : 'Claude';
  const roleColor = isUser ? 'text-role-user' : isSystem ? 'text-text-muted' : 'text-role-assistant';
  const borderColor = isUser ? 'border-role-user' : isSystem ? 'border-text-muted' : 'border-role-assistant';
  const icon = isUser ? messageIcons.user : isSystem ? messageIcons.system : messageIcons.assistant;

  return (
    <div
      className={`message py-1 pl-4 pr-3 border-l-2 ${borderColor} group relative`}
      data-message-index={messageIndex}
    >
      {showRoleBadge && (
        <div className="flex items-center justify-between mb-0.5">
          <div className="flex items-center gap-1.5">
            <span className={roleColor}>{icon}</span>
            <span className={`text-[13px] font-semibold uppercase tracking-wide ${roleColor}`}>
              {roleLabel}
            </span>
          </div>
          <button
            className={`copy-message p-0.5 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity ${copied ? 'text-diff-add' : ''}`}
            title="Copy message"
            onClick={handleCopy}
          >
            {copied ? 'Copied!' : <CopyIcon />}
          </button>
        </div>
      )}
      <div className="text-sm text-text-primary leading-snug flex flex-col gap-0.5">
        {message.content_blocks?.map((block, i) => renderContentBlock(block, i))}
      </div>
    </div>
  );
}

// Helper render functions for image and file blocks
function renderImageBlock(block: ContentBlock & { type: 'image' }, index: number) {
  const label = block.filename || 'Image';
  return (
    <div key={`image-${index}`} className="inline-block bg-bg-tertiary rounded px-2 py-1">
      <span className="text-sm text-text-muted font-mono">[Image: {label}]</span>
    </div>
  );
}

function renderFileBlock(block: ContentBlock & { type: 'file' }, index: number) {
  const size = block.size ? ` (${formatBytes(block.size)})` : '';
  return (
    <div key={`file-${index}`} className="inline-block bg-bg-tertiary rounded px-2 py-1">
      <span className="text-sm text-text-muted font-mono">[File: {block.filename}{size}]</span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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
