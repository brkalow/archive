import { useState, useMemo, useCallback, Suspense, lazy, useSyncExternalStore } from 'react';
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

type DiffSide = 'additions' | 'deletions';

interface UserComment {
  id: string;
  side: DiffSide;
  lineNumber: number;
  content: string;
}

interface AnnotationMetadata {
  id: number;
  type: AnnotationType;
  content: string;
  model: string | null;
  filename: string;
  lineNumber: number;
}

interface UserCommentMetadata {
  id: string;
  type: 'user_comment';
  content: string;
  filename: string;
  lineNumber: number;
}

type CombinedAnnotationMetadata = AnnotationMetadata | UserCommentMetadata;

interface PendingComment {
  side: DiffSide;
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

const FileDiff = lazy(() =>
  import('@pierre/diffs/react').then((mod) => ({ default: mod.FileDiff }))
);

const UserIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
  </svg>
);

const CopyIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const annotationConfig: Record<AnnotationType, { label: string; badgeClass: string }> = {
  suggestion: { label: 'suggestion', badgeClass: 'bg-accent-primary/20 text-accent-primary' },
  issue: { label: 'issue', badgeClass: 'bg-diff-del/20 text-diff-del' },
  praise: { label: 'good', badgeClass: 'bg-diff-add/20 text-diff-add' },
  question: { label: 'question', badgeClass: 'bg-accent-secondary/20 text-accent-secondary' },
};

export function DiffBlock({
  filename,
  diffContent,
  annotations,
  reviewModel,
  initiallyExpanded = false,
}: DiffBlockProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [userComments, setUserComments] = useState<UserComment[]>([]);
  const [pendingComment, setPendingComment] = useState<PendingComment | null>(null);
  const [commentText, setCommentText] = useState('');
  const isMobile = useIsMobile();

  // Parse the diff content
  const fileDiff = useMemo(() => {
    try {
      return getSingularPatch(diffContent) as FileDiffMetadata;
    } catch {
      return null;
    }
  }, [diffContent]);

  // Convert annotations to @pierre/diffs format (AI annotations + user comments)
  const lineAnnotations = useMemo((): DiffLineAnnotation<CombinedAnnotationMetadata>[] => {
    // AI-generated annotations
    const aiAnnotations: DiffLineAnnotation<CombinedAnnotationMetadata>[] = annotations.map((a) => ({
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

    // User comments
    const userAnnotations: DiffLineAnnotation<CombinedAnnotationMetadata>[] = userComments.map((c) => ({
      side: c.side,
      lineNumber: c.lineNumber,
      metadata: {
        id: c.id,
        type: 'user_comment' as const,
        content: c.content,
        filename: filename,
        lineNumber: c.lineNumber,
      },
    }));

    // Pending comment placeholder (for showing input form)
    const pendingAnnotations: DiffLineAnnotation<CombinedAnnotationMetadata>[] = pendingComment
      ? [{
          side: pendingComment.side,
          lineNumber: pendingComment.lineNumber,
          metadata: {
            id: 'pending',
            type: 'user_comment' as const,
            content: '',
            filename: filename,
            lineNumber: pendingComment.lineNumber,
          },
        }]
      : [];

    return [...aiAnnotations, ...userAnnotations, ...pendingAnnotations];
  }, [annotations, reviewModel, filename, userComments, pendingComment]);

  // FileDiff options - use unified (stacked) view on mobile
  const options = useMemo(() => ({
    theme: { dark: 'pierre-dark', light: 'pierre-light' } as const,
    themeType: 'dark' as const,
    diffStyle: isMobile ? 'unified' as const : 'split' as const,
    diffIndicators: 'bars' as const,
    overflow: 'scroll' as const,
    enableLineSelection: true,
    enableHoverUtility: true,
    unsafeCSS: `
      [data-code] { padding-block-start: 0 !important; }
      :host-context([data-collapsed]) [data-code] { display: none; }
      :host { max-width: 100%; width: 100%; }
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

  // Handle adding a new comment
  const handleAddComment = useCallback((lineNumber: number, side: 'additions' | 'deletions') => {
    setPendingComment({ lineNumber, side });
    setCommentText('');
  }, []);

  // Handle line selection end (when user finishes selecting lines)
  const handleLineSelectionEnd = useCallback((range: { start: number; end: number; side: 'additions' | 'deletions' } | null) => {
    if (range) {
      // Use the end line for the comment (or start if single line)
      handleAddComment(range.end, range.side);
    }
  }, [handleAddComment]);

  // Handle submitting a comment
  const handleSubmitComment = useCallback(() => {
    if (!pendingComment || !commentText.trim()) return;

    const newComment: UserComment = {
      id: `comment-${Date.now()}`,
      side: pendingComment.side,
      lineNumber: pendingComment.lineNumber,
      content: commentText.trim(),
    };

    setUserComments((prev) => [...prev, newComment]);
    setPendingComment(null);
    setCommentText('');
  }, [pendingComment, commentText]);

  // Handle canceling a comment
  const handleCancelComment = useCallback(() => {
    setPendingComment(null);
    setCommentText('');
  }, []);

  // Render hover utility (add comment button)
  // Using inline styles since this renders in shadow DOM
  const renderHoverUtility = useCallback((getHoveredLine: () => { lineNumber: number; side: 'additions' | 'deletions' }) => (
    <button
      onClick={() => {
        const { lineNumber, side } = getHoveredLine();
        handleAddComment(lineNumber, side);
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '22px',
        height: '22px',
        borderRadius: '50%',
        backgroundColor: '#67e8f9',
        color: '#0c0c0c',
        border: 'none',
        cursor: 'pointer',
        transition: 'opacity 0.15s, transform 0.15s',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = '0.9';
        e.currentTarget.style.transform = 'scale(1.05)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = '1';
        e.currentTarget.style.transform = 'scale(1)';
      }}
      title="Add comment"
    >
      <svg style={{ width: '14px', height: '14px' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
      </svg>
    </button>
  ), [handleAddComment]);

  // Render annotation (AI or user comment)
  const renderAnnotation = (annotation: DiffLineAnnotation<CombinedAnnotationMetadata>) => {
    const metadata = annotation.metadata;
    if (!metadata) return null;

    const locationText = `${metadata.filename}:${metadata.lineNumber}`;

    // Render pending comment input form
    if (metadata.type === 'user_comment' && metadata.id === 'pending') {
      return (
        <div className="bg-bg-secondary border border-bg-elevated rounded-lg p-4 my-3 mx-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-medium text-text-primary">Add comment</span>
            <span className="text-xs text-text-muted">Line {metadata.lineNumber}</span>
          </div>
          <textarea
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Write a comment..."
            className="w-full bg-bg-primary border border-bg-elevated rounded-lg p-3 text-sm text-text-primary placeholder:text-text-muted resize-none transition-shadow focus:outline-2 focus:outline-accent-primary focus:outline-offset-2"
            rows={2}
            autoFocus
          />
          <div className="flex items-center justify-end gap-2 mt-3">
            <button
              onClick={handleCancelComment}
              className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmitComment}
              disabled={!commentText.trim()}
              className="px-4 py-1.5 text-sm font-medium bg-accent-primary text-bg-primary rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Comment
            </button>
          </div>
        </div>
      );
    }

    // Render user comment
    if (metadata.type === 'user_comment') {
      return (
        <div className="bg-bg-secondary border border-bg-elevated rounded-lg p-4 my-3 mx-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-6 h-6 rounded-full bg-role-user/20 flex items-center justify-center text-role-user shrink-0">
              <UserIcon />
            </div>
            <span className="text-sm font-medium text-text-primary">You</span>
            <span className="text-xs text-text-muted">Line {metadata.lineNumber}</span>
          </div>
          <p className="text-sm text-text-secondary leading-relaxed pl-8">
            {metadata.content}
          </p>
        </div>
      );
    }

    // Render AI annotation
    const config = annotationConfig[(metadata as AnnotationMetadata).type] || annotationConfig.suggestion;

    return (
      <div className="bg-bg-secondary border border-bg-elevated rounded-lg p-4 my-3 mx-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-accent-secondary to-accent-primary flex items-center justify-center text-white text-xs font-semibold shrink-0">
            C
          </div>
          <span className="text-sm font-medium text-text-primary">Claude</span>
          <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${config.badgeClass}`}>
            {config.label}
          </span>
          <span className="text-xs text-text-muted ml-auto">Line {(metadata as AnnotationMetadata).lineNumber}</span>
          <button
            className="p-1 text-text-muted hover:text-text-primary hover:bg-bg-tertiary rounded transition-colors"
            onClick={async () => {
              const copyText = `${locationText}\n\n${metadata.content}`;
              await window.copyToClipboard(copyText);
            }}
            title="Copy to clipboard"
          >
            <CopyIcon />
          </button>
        </div>
        <p className="text-sm text-text-secondary leading-relaxed pl-8">
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
      className="diff-block overflow-hidden rounded-none md:rounded-lg border-y md:border border-bg-elevated w-full max-w-full"
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
          renderHoverUtility={renderHoverUtility}
          onLineSelectionEnd={handleLineSelectionEnd}
        />
      </Suspense>
    </div>
  );
}
