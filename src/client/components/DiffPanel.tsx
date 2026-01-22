import { useState, useMemo } from "react";
import { DiffBlock } from "./DiffBlock";
import type { Diff, Annotation, Review } from "../../db/schema";

interface DiffPanelProps {
  diffs: Diff[];
  annotationsByDiff: Record<number, Annotation[]>;
  review: Review | null;
}

export function DiffPanel({ diffs, annotationsByDiff, review }: DiffPanelProps) {
  const [otherExpanded, setOtherExpanded] = useState(false);

  // Memoize diff categorization (Vercel best practice: avoid recalc on every render)
  const { sessionDiffs, otherDiffs } = useMemo(
    () => ({
      sessionDiffs: diffs.filter((d) => d.is_session_relevant),
      otherDiffs: diffs.filter((d) => !d.is_session_relevant),
    }),
    [diffs]
  );

  const totalCount = diffs.length;

  const isLargeDiff = (diff: Diff) =>
    (diff.additions || 0) + (diff.deletions || 0) > 300;

  const summarizeFiles = (diffs: Diff[]) => {
    const names = diffs
      .map((d) => d.filename?.split("/").pop() || "unknown")
      .slice(0, 3);
    return diffs.length > 3 ? names.join(", ") + "..." : names.join(", ");
  };

  return (
    <div className="flex flex-col overflow-hidden h-full">
      {/* Header */}
      <div className="flex items-center justify-between pt-4 pb-4 shrink-0">
        <h2 className="text-sm font-semibold text-text-primary">Diff</h2>
        <span className="text-xs text-text-muted tabular-nums">
          {totalCount} file{totalCount !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Diffs container */}
      <div className="flex-1 overflow-y-auto pb-6">
        {sessionDiffs.length > 0 && (
          <div className="diff-group flex flex-col gap-4">
            {sessionDiffs.map((diff) => (
              <DiffBlock
                key={diff.id}
                diffId={diff.id}
                filename={diff.filename || "Unknown file"}
                diffContent={diff.diff_content}
                additions={diff.additions || 0}
                deletions={diff.deletions || 0}
                annotations={annotationsByDiff[diff.id] || []}
                reviewModel={review?.model || null}
                initiallyExpanded={!isLargeDiff(diff)}
              />
            ))}
          </div>
        )}

        {otherDiffs.length > 0 && (
          <div className="diff-group mt-6">
            <button
              className="other-toggle w-full pr-4 py-2.5 text-xs font-medium text-text-muted bg-bg-secondary flex items-center gap-2 hover:bg-bg-elevated transition-colors mb-4"
              onClick={() => setOtherExpanded(!otherExpanded)}
            >
              <span>{otherExpanded ? "\u25BC" : "\u25B6"}</span>
              <span>Other branch changes ({otherDiffs.length})</span>
              <span className="text-text-muted/60 ml-auto">
                {summarizeFiles(otherDiffs)}
              </span>
            </button>
            {otherExpanded && (
              <div className="flex flex-col gap-4">
                {otherDiffs.map((diff) => (
                  <DiffBlock
                    key={diff.id}
                    diffId={diff.id}
                    filename={diff.filename || "Unknown file"}
                    diffContent={diff.diff_content}
                    additions={diff.additions || 0}
                    deletions={diff.deletions || 0}
                    annotations={annotationsByDiff[diff.id] || []}
                    reviewModel={review?.model || null}
                    initiallyExpanded={false}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {totalCount === 0 && (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            No code changes
          </div>
        )}
      </div>
    </div>
  );
}
