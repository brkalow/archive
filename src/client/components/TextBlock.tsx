import { useState, useEffect, useRef } from 'react';
import { formatMarkdown, stripSystemTags } from '../blocks';
import type { SupportedLanguages } from '@pierre/diffs';

interface TextBlockProps {
  text: string;
}

export function TextBlock({ text }: TextBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Check for command/skill prompt
  const commandInfo = extractCommandInfo(text);

  useEffect(() => {
    if (containerRef.current) {
      initializeCodeBlocks(containerRef.current);
    }
  }, [text]);

  if (commandInfo) {
    return <CommandBlock info={commandInfo} />;
  }

  const cleaned = stripSystemTags(text);
  if (!cleaned.trim()) {
    return <div className="text-block hidden" />;
  }

  return (
    <div
      ref={containerRef}
      className="text-block"
      dangerouslySetInnerHTML={{ __html: formatMarkdown(cleaned) }}
    />
  );
}

// Sub-component for command blocks with its own state
function CommandBlock({ info }: { info: { name: string; output: string } }) {
  const [expanded, setExpanded] = useState(false);
  const blockId = useRef(`cmd-${Math.random().toString(36).slice(2, 10)}`);

  return (
    <div className="command-block bg-bg-tertiary/30 rounded py-1.5 pr-2 -ml-1 pl-1">
      <button
        className="flex items-center gap-1.5 text-[13px] hover:bg-bg-elevated rounded px-1 py-0.5 transition-colors w-full text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-text-muted">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </span>
        <span className="font-medium text-text-primary">Ran</span>
        <code className="px-1.5 py-0.5 bg-bg-elevated rounded text-accent-primary text-[13px]">
          {info.name}
        </code>
        <span className="toggle-icon text-text-muted text-[10px] ml-auto">
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
      </button>
      <div id={blockId.current} className={`${expanded ? '' : 'hidden'} mt-2 pl-5`}>
        {info.output && (
          <div
            className="text-sm text-text-secondary"
            dangerouslySetInnerHTML={{ __html: formatMarkdown(info.output) }}
          />
        )}
      </div>
    </div>
  );
}

// Helper function to extract command info from text
function extractCommandInfo(text: string): { name: string; output: string } | null {
  const nameMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (!nameMatch) return null;

  const name = nameMatch[1] ?? "";
  let output = "";

  const stdoutMatch = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (stdoutMatch) {
    output = (stdoutMatch[1] ?? "").trim();
  }

  return { name, output };
}

// Helper function to initialize syntax highlighting for code blocks
function initializeCodeBlocks(container: HTMLElement): void {
  // Find code blocks that need highlighting
  container.querySelectorAll("[data-code-content]").forEach((el) => {
    const htmlEl = el as HTMLElement;
    const encodedContent = htmlEl.dataset.codeContent;
    const language = htmlEl.dataset.language || "";

    if (encodedContent) {
      // Lazy import @pierre/diffs for syntax highlighting (bundle-dynamic-imports)
      import("@pierre/diffs").then(({ File }) => {
        const code = decodeURIComponent(atob(encodedContent));

        const fileInstance = new File({
          theme: { dark: "pierre-dark", light: "pierre-light" },
          themeType: "dark",
          overflow: "scroll",
          disableFileHeader: true,
        });

        const diffContainer = document.createElement("diffs-container");
        const copyBtn = htmlEl.querySelector(".copy-code");

        htmlEl.innerHTML = "";
        htmlEl.appendChild(diffContainer);

        if (copyBtn) {
          diffContainer.appendChild(copyBtn);
        }

        fileInstance.render({
          file: {
            name: "code",
            contents: code,
            lang: language as SupportedLanguages || undefined,
          },
          fileContainer: diffContainer,
        });
      });
    }
  });
}
