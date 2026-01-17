import { useState, useEffect, useRef, useCallback } from 'react';
import { escapeHtml } from '../blocks';
import type { FileDiff as FileDiffType, DiffLineAnnotation } from '@pierre/diffs';
import type { Annotation, AnnotationType } from '../../db/schema';

declare global {
  interface Window {
    copyToClipboard: (text: string) => Promise<void>;
  }
}

// Annotation metadata for rendering
interface AnnotationMetadata {
  id: number;
  type: AnnotationType;
  content: string;
  model: string | null;
  filename: string;
  lineNumber: number;
}

interface DiffBlockProps {
  diffId: number;
  filename: string;
  diffContent: string;
  additions: number;
  deletions: number;
  annotations: Annotation[];
  reviewModel: string | null;
  initiallyExpanded?: boolean;
}

// Annotation type config
const annotationConfig: Record<AnnotationType, { label: string; badgeClass: string }> = {
  suggestion: { label: 'suggestion', badgeClass: 'bg-accent-primary/20 text-accent-primary' },
  issue: { label: 'issue', badgeClass: 'bg-diff-del/20 text-diff-del' },
  praise: { label: 'good', badgeClass: 'bg-diff-add/20 text-diff-add' },
  question: { label: 'question', badgeClass: 'bg-accent-secondary/20 text-accent-secondary' },
};

export function DiffBlock(props: DiffBlockProps) {
  const { filename, additions, deletions, initiallyExpanded = false } = props;
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const diffInstanceRef = useRef<FileDiffType<AnnotationMetadata> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Lazy render diff when expanded
  useEffect(() => {
    if (expanded && !diffInstanceRef.current && containerRef.current) {
      renderDiff();
    }
  }, [expanded]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      diffInstanceRef.current?.cleanUp();
      diffInstanceRef.current = null;
    };
  }, []);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  async function renderDiff(): Promise<void> {
    if (!containerRef.current) return;

    const { diffContent, filename, annotations, reviewModel } = props;

    try {
      // Lazy load @pierre/diffs to reduce initial bundle size
      const { FileDiff, getSingularPatch } = await import('@pierre/diffs');

      const fileDiff = getSingularPatch(diffContent);

      // Convert annotations to @pierre/diffs format
      const lineAnnotations: DiffLineAnnotation<AnnotationMetadata>[] = annotations.map((a) => ({
        side: a.side as 'additions' | 'deletions',
        lineNumber: a.line_number,
        metadata: {
          id: a.id,
          type: a.annotation_type,
          content: a.content,
          model: reviewModel,
          filename,
          lineNumber: a.line_number,
        },
      }));

      diffInstanceRef.current = new FileDiff<AnnotationMetadata>({
        theme: { dark: 'pierre-dark', light: 'pierre-light' },
        themeType: 'dark',
        diffStyle: 'unified',
        diffIndicators: 'classic',
        disableFileHeader: true,
        overflow: 'scroll',
        renderAnnotation: (annotation) => createAnnotationElement(annotation.metadata),
      });

      const diffContainer = document.createElement('diffs-container');
      containerRef.current.innerHTML = '';
      containerRef.current.appendChild(diffContainer);

      diffInstanceRef.current.render({
        fileDiff,
        fileContainer: diffContainer,
        lineAnnotations,
      });
    } catch (err) {
      console.error('Failed to render diff:', err);
      renderFallback();
    }
  }

  function renderFallback(): void {
    if (!containerRef.current) return;

    const { diffContent } = props;
    containerRef.current.innerHTML = `
      <div class="p-4">
        <div class="flex items-center gap-2 text-text-muted mb-2">
          <span>Unable to render diff</span>
        </div>
        <button class="text-accent-primary text-sm hover:underline show-raw-btn">
          Show raw diff
        </button>
        <pre class="hidden raw-diff mt-2 text-xs font-mono whitespace-pre-wrap bg-bg-primary p-2 rounded overflow-x-auto max-h-96 overflow-y-auto">${escapeHtml(diffContent)}</pre>
      </div>
    `;

    // Attach toggle handler
    const showBtn = containerRef.current.querySelector('.show-raw-btn');
    showBtn?.addEventListener('click', () => {
      const raw = containerRef.current?.querySelector('.raw-diff');
      if (raw) {
        raw.classList.toggle('hidden');
        if (showBtn instanceof HTMLElement) {
          showBtn.textContent = raw.classList.contains('hidden') ? 'Show raw diff' : 'Hide raw diff';
        }
      }
    });
  }

  function createAnnotationElement(metadata: AnnotationMetadata): HTMLElement {
    const config = annotationConfig[metadata.type] || annotationConfig.suggestion;
    const locationText = `${metadata.filename}:${metadata.lineNumber}`;
    const copyText = `${locationText}\n\n${metadata.content}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'bg-bg-tertiary border border-bg-elevated rounded-lg p-4 my-3 mx-4';

    wrapper.innerHTML = `
      <div class="flex items-center gap-3 mb-3">
        <div class="w-8 h-8 rounded-full bg-gradient-to-br from-accent-secondary to-accent-primary flex items-center justify-center text-white text-sm font-semibold shrink-0">C</div>
        <span class="font-semibold text-text-primary">Claude</span>
        <span class="text-xs text-text-muted font-mono">${escapeHtml(locationText)}</span>
        <div class="ml-auto flex items-center gap-2">
          <span class="px-2 py-0.5 rounded text-xs font-medium ${config.badgeClass}">${config.label}</span>
          <button class="flex items-center gap-1.5 px-2 py-1 text-xs text-text-muted hover:text-text-primary hover:bg-bg-elevated rounded transition-colors copy-btn">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            copy prompt
          </button>
        </div>
      </div>
      <p class="text-[15px] text-text-primary leading-relaxed font-sans">${escapeHtml(metadata.content)}</p>
    `;

    // Add copy handler
    const copyBtn = wrapper.querySelector('.copy-btn') as HTMLButtonElement | null;
    copyBtn?.addEventListener('click', async () => {
      const originalHtml = copyBtn.innerHTML;
      await window.copyToClipboard(copyText);
      copyBtn.innerHTML = `
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        copied!
      `;
      setTimeout(() => {
        copyBtn.innerHTML = originalHtml;
      }, 1500);
    });

    return wrapper;
  }

  return (
    <div className="diff-block border-b border-bg-elevated last:border-b-0" data-filename={filename}>
      <button
        className="diff-header w-full flex items-center justify-between px-3 py-2 bg-bg-tertiary hover:bg-bg-elevated transition-colors text-left"
        onClick={toggle}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="toggle-icon text-text-muted text-xs">
            {expanded ? '\u25BC' : '\u25B6'}
          </span>
          <span className="text-[13px] font-mono text-text-primary truncate">{filename}</span>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono shrink-0">
          {deletions > 0 && <span className="text-diff-del">-{deletions}</span>}
          {additions > 0 && <span className="text-diff-add">+{additions}</span>}
          <span className="collapse-label text-text-muted ml-2">
            {expanded ? 'Hide' : 'Show'}
          </span>
        </div>
      </button>
      <div className={`diff-content ${expanded ? '' : 'hidden'}`}>
        <div className="diff-container" ref={containerRef} />
      </div>
    </div>
  );
}
