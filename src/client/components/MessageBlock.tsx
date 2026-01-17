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

  const isAssistant = message.role === 'assistant';

  return (
    <div
      className={`message group relative ${isAssistant ? 'bg-bg-secondary' : ''} rounded-lg p-4`}
      data-message-index={messageIndex}
    >
      {showRoleBadge && (
        <div className="text-xs text-text-muted mb-2">
          {isAssistant ? 'Assistant' : 'User'}
        </div>
      )}
      <div className="message-content">
        {message.content_blocks?.map((block, i) => renderContentBlock(block, i))}
      </div>
      <button
        className={`copy-message opacity-0 group-hover:opacity-100 absolute top-2 right-2 p-1 text-text-muted hover:text-text-primary transition-opacity ${copied ? 'text-diff-add' : ''}`}
        onClick={handleCopy}
      >
        {copied ? 'Copied!' : <CopyIcon />}
      </button>
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
