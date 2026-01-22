import { useState } from "react";
import type { SessionState } from "../hooks/useSpawnedSession";

interface SessionHeaderProps {
  title: string;
  state: SessionState;
  harness: string;
  model?: string;
  cwd: string;
  duration: string;
  isOwner?: boolean;
  onInterrupt: () => void;
  onEndSession: () => void;
  onShare?: () => void;
}

export function SessionHeader({
  title,
  state,
  harness,
  model,
  cwd,
  duration,
  isOwner = true,
  onInterrupt,
  onEndSession,
  onShare,
}: SessionHeaderProps) {
  const [showEndConfirm, setShowEndConfirm] = useState(false);

  // State indicator styling
  const getStateIndicator = () => {
    switch (state) {
      case "connecting":
        return { color: "bg-text-muted", pulse: true, label: "Connecting" };
      case "starting":
        return { color: "bg-amber-500", pulse: true, label: "Starting" };
      case "running":
        return { color: "bg-accent-primary", pulse: true, label: "Running" };
      case "waiting":
        return { color: "bg-green-500", pulse: false, label: "Waiting" };
      case "ending":
        return { color: "bg-text-muted", pulse: false, label: "Ending" };
      case "ended":
        return { color: "bg-text-muted", pulse: false, label: "Ended" };
      case "failed":
        return { color: "bg-diff-del", pulse: false, label: "Failed" };
      case "disconnected":
        return { color: "bg-amber-500", pulse: true, label: "Reconnecting" };
      default:
        return { color: "bg-text-muted", pulse: false, label: "" };
    }
  };

  const indicator = getStateIndicator();
  const isActive =
    state !== "ended" && state !== "ending" && state !== "failed";
  const canInterrupt = state === "running";

  const handleEndClick = () => {
    if (state === "running") {
      setShowEndConfirm(true);
    } else {
      onEndSession();
    }
  };

  return (
    <header className="border-b border-bg-elevated">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-5">
        {/* Top row: Title and actions */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            {/* Live indicator */}
            {isActive && (
              <div className="flex items-center gap-1.5">
                <span
                  className={`w-2 h-2 rounded-full ${indicator.color} ${indicator.pulse ? "animate-pulse" : ""}`}
                />
                <span className="text-xs font-bold uppercase tracking-wide text-green-500">
                  LIVE
                </span>
              </div>
            )}

            {/* Title */}
            <h1 className="text-2xl font-semibold text-text-primary">{title}</h1>

            {/* Remote badge */}
            <span className="px-2 py-0.5 bg-purple-900/50 text-purple-300 text-xs rounded font-medium">
              Remote
            </span>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            {onShare && (
              <button
                onClick={onShare}
                className="px-3 py-1.5 bg-bg-tertiary hover:bg-bg-elevated text-text-primary text-sm rounded-md font-medium transition-colors border border-bg-elevated"
              >
                Share
              </button>
            )}
            {isActive && isOwner && (
              <>
                {canInterrupt && (
                  <button
                    onClick={onInterrupt}
                    className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-sm rounded-md font-medium transition-colors"
                  >
                    Interrupt
                  </button>
                )}
                <button
                  onClick={handleEndClick}
                  className="px-3 py-1.5 bg-diff-del hover:bg-red-500 text-white text-sm rounded-md font-medium transition-colors"
                >
                  End
                </button>
              </>
            )}
          </div>
        </div>

        {/* Bottom row: Metadata - wraps on mobile */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-text-muted">
          {/* State indicator */}
          <span className="flex items-center gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full ${indicator.color} ${indicator.pulse ? "animate-pulse" : ""}`}
            />
            <span
              className={
                state === "running"
                  ? "text-accent-primary"
                  : state === "waiting"
                    ? "text-green-500"
                    : ""
              }
            >
              {indicator.label}
            </span>
          </span>
          <span className="text-text-muted/30 hidden sm:inline">.</span>

          {/* Harness */}
          <span className="inline-flex items-center gap-1.5 text-text-secondary">
            <HarnessIcon harness={harness} />
            <span>{harness}</span>
          </span>
          <span className="text-text-muted/30 hidden sm:inline">.</span>

          {/* Model */}
          {model && (
            <>
              <span className="inline-flex items-center gap-1.5 font-mono text-[13px]">
                <ModelIcon model={model} />
                <span>{model}</span>
              </span>
              <span className="text-text-muted/30 hidden sm:inline">.</span>
            </>
          )}

          {/* Working directory */}
          <span className="font-mono text-[13px] truncate max-w-[200px] sm:max-w-none" title={cwd}>
            {truncatePath(cwd)}
          </span>
          <span className="text-text-muted/30 hidden sm:inline">.</span>

          {/* Duration */}
          <span>{duration}</span>
        </div>
      </div>

      {/* End confirmation dialog */}
      {showEndConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-bg-secondary border border-bg-elevated rounded-lg p-6 max-w-md mx-4 shadow-xl">
            <h3 className="text-lg font-semibold text-text-primary mb-2">
              End Session?
            </h3>
            <p className="text-text-muted mb-4">
              Claude is still working on your request. Are you sure you want to
              end this session?
            </p>
            <p className="text-text-muted text-sm mb-4">
              The session will be saved and you can review it later.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowEndConfirm(false)}
                className="px-4 py-2 text-text-muted hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowEndConfirm(false);
                  onEndSession();
                }}
                className="px-4 py-2 bg-diff-del hover:bg-red-500 text-white rounded-md font-medium transition-colors"
              >
                End Session
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

// Helper functions and icons

function truncatePath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return ".../" + parts.slice(-2).join("/");
}

function ModelIcon({ model }: { model: string }) {
  const lower = model.toLowerCase();
  if (
    lower.includes("claude") ||
    lower.includes("opus") ||
    lower.includes("sonnet") ||
    lower.includes("haiku")
  ) {
    return (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017L3.592 20H0l6.569-16.48zm2.327 5.14l-2.36 6.076h4.873l-2.513-6.077z" />
      </svg>
    );
  }
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3")) {
    return (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
      </svg>
    );
  }
  return null;
}

function HarnessIcon({ harness }: { harness: string }) {
  const lower = harness.toLowerCase();
  if (
    lower.includes("code") ||
    lower.includes("cli") ||
    lower.includes("terminal")
  ) {
    return (
      <svg
        className="w-4 h-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
      </svg>
    );
  }
  if (lower.includes("api")) {
    return (
      <svg
        className="w-4 h-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
        />
      </svg>
    );
  }
  return null;
}
