import { useState, useMemo, useEffect, Suspense, lazy, useSyncExternalStore } from 'react';
import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';
import type { Annotation, AnnotationType } from '../../db/schema';
import { getSingularPatch } from '@pierre/diffs';

// Hook to detect if screen is mobile width (matches Tailwind's md breakpoint)
function useIsMobile() {
  return useSyncExternalStore(
    (callback) => {
      const mq = window.matchMedia('(max-width: 767px)');
      mq.addEventListener('change', callback);
      return () => mq.removeEventListener('change', callback);
    },
    () => window.matchMedia('(max-width: 767px)').matches,
    () => false // SSR fallback
  );
}

// Lazy load the React FileDiff component
const FileDiff = lazy(() =>
  import('@pierre/diffs/react').then(mod => ({ default: mod.FileDiff }))
);

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
  const {
    filename,
    additions,
    deletions,
    diffContent,
    annotations,
    reviewModel,
    initiallyExpanded = false,
  } = props;
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const isMobile = useIsMobile();

  // Parse the diff content
  const fileDiff = useMemo(() => {
    try {
      return getSingularPatch(diffContent) as FileDiffMetadata;
    } catch {
      return null;
    }
  }, [diffContent]);

  // Convert annotations to @pierre/diffs format
  const lineAnnotations = useMemo((): DiffLineAnnotation<AnnotationMetadata>[] => {
    return annotations.map((a) => ({
      side: a.side as 'additions' | 'deletions',
      lineNumber: a.line_number,
      metadata: {
        id: a.id,
        type: a.annotation_type,
        content: a.content,
        model: reviewModel,
        filename: filename,
        lineNumber: a.line_number,
      },
    }));
  }, [annotations, reviewModel, filename]);

  // FileDiff options - use unified (stacked) view on mobile
  const options = useMemo(() => ({
    theme: { dark: 'pierre-dark', light: 'pierre-light' } as const,
    themeType: 'dark' as const,
    diffStyle: isMobile ? 'unified' as const : 'split' as const,
    diffIndicators: 'bars' as const,
    overflow: 'scroll' as const,
    unsafeCSS: `
      [data-code] { padding-block-start: 0 !important; }
      :host-context([data-collapsed]) [data-code] { display: none; }
    `,
  }), [isMobile]);

  // Render header metadata with collapse toggle
  const renderHeaderMetadata = () => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        setExpanded(!expanded);
      }}
      className="px-2 py-1 text-xs text-text-muted hover:text-text-primary hover:bg-bg-elevated rounded transition-colors"
    >
      {expanded ? 'Hide' : 'Show'}
    </button>
  );

  // Render annotation
  const renderAnnotation = (annotation: DiffLineAnnotation<AnnotationMetadata>) => {
    const metadata = annotation.metadata;
    if (!metadata) return null;

    const config = annotationConfig[metadata.type] || annotationConfig.suggestion;
    const locationText = `${metadata.filename}:${metadata.lineNumber}`;

    return (
      <div className="bg-bg-tertiary border border-bg-elevated rounded-lg p-4 my-3 mx-4">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-accent-secondary to-accent-primary flex items-center justify-center text-white text-sm font-semibold shrink-0">
            C
          </div>
          <span className="font-semibold text-text-primary">Claude</span>
          <span className="text-xs text-text-muted font-mono">{locationText}</span>
          <div className="ml-auto flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${config.badgeClass}`}>
              {config.label}
            </span>
            <button
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-text-muted hover:text-text-primary hover:bg-bg-elevated rounded transition-colors"
              onClick={async () => {
                const copyText = `${locationText}\n\n${metadata.content}`;
                await window.copyToClipboard(copyText);
              }}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              copy prompt
            </button>
          </div>
        </div>
        <p className="text-[15px] text-text-primary leading-relaxed font-sans">
          {metadata.content}
        </p>
      </div>
    );
  };

  // Fallback for unparseable diffs
  if (!fileDiff) {
    return (
      <div className="diff-block bg-bg-secondary overflow-hidden rounded-lg border border-bg-elevated" data-filename={filename}>
        <div className="p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-text-muted">Unable to render diff for {filename}</span>
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-text-muted hover:text-text-primary"
            >
              {expanded ? 'Hide raw diff' : 'Show raw diff'}
            </button>
          </div>
          {expanded && (
            <pre className="text-xs font-mono whitespace-pre-wrap bg-bg-primary p-2 rounded overflow-x-auto max-h-96 overflow-y-auto">
              {diffContent}
            </pre>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="diff-block overflow-hidden rounded-none md:rounded-lg border-y md:border border-bg-elevated"
      data-filename={filename}
      data-collapsed={!expanded ? '' : undefined}
    >
      <Suspense fallback={
        <div className="p-4 text-text-muted text-sm">Loading diff...</div>
      }>
        <FileDiff
          fileDiff={fileDiff}
          options={options}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          renderHeaderMetadata={renderHeaderMetadata}
        />
      </Suspense>
    </div>
  );
}
