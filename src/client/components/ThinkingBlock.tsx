import { useState } from 'react';
import type { ThinkingBlock as ThinkingBlockType } from '../../db/schema';

interface ThinkingBlockProps {
  block: ThinkingBlockType;
}

export function ThinkingBlock({ block }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const duration = block.duration_ms
    ? `(${(block.duration_ms / 1000).toFixed(1)}s)`
    : '';

  return (
    <div className="thinking-block">
      <button
        className="flex items-center gap-1.5 text-text-muted text-[13px] hover:text-text-secondary pr-1.5 py-0.5 -ml-0.5 rounded hover:bg-bg-elevated transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="shrink-0">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
        </span>
        <span className="italic">Thinking</span>
        <span className="text-xs opacity-60">{duration}</span>
        <span className="toggle-icon text-[10px]">{expanded ? '▼' : '▶'}</span>
      </button>
      <div className={`mt-1 pl-5 text-[13px] text-text-secondary leading-snug ${expanded ? '' : 'hidden'}`}>
        {block.thinking}
      </div>
    </div>
  );
}
