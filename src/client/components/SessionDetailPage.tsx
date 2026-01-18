import { useState, useCallback, useRef, useEffect } from "react";
import { stripSystemTags } from "../blocks";
import { MessageList, type MessageListHandle } from "./MessageList";
import { DiffPanel } from "./DiffPanel";
import { useToast, useClipboard } from "../hooks";
import type { Session, Message, Diff, Review, Annotation } from "../../db/schema";

interface SessionDetailPageProps {
  session: Session;
  messages: Message[];
  diffs: Diff[];
  shareUrl: string | null;
  review?: Review | null;
  annotationsByDiff: Record<number, Annotation[]>;
}

interface InteractiveState {
  isInteractive: boolean;
  claudeState: "running" | "waiting" | "unknown";
  sessionComplete: boolean;
  pendingFeedback: Array<{ id: string; status: string }>;
}

export function SessionDetailPage(props: SessionDetailPageProps) {
  const { session, messages, diffs, shareUrl, review, annotationsByDiff } = props;

  // State
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "disconnected" | "reconnecting">("disconnected");
  const [sessionStatus, setSessionStatus] = useState<"live" | "complete">(
    session.status === "live" ? "live" : "complete"
  );
  const [interactiveState, setInteractiveState] = useState<InteractiveState>({
    isInteractive: session.interactive ?? false,
    claudeState: "unknown",
    sessionComplete: session.status !== "live",
    pendingFeedback: [],
  });
  const [currentDiffs, setCurrentDiffs] = useState(diffs);
  const [currentAnnotationsByDiff, setCurrentAnnotationsByDiff] = useState(annotationsByDiff);
  const [currentReview, setCurrentReview] = useState(review);

  // Refs
  const messageListHandleRef = useRef<MessageListHandle | null>(null);
  const isMountedRef = useRef(true);

  // Track mounted state for async callbacks
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Hooks
  const { showToast } = useToast();
  const { copy } = useClipboard();

  // Derived state
  const isLive = sessionStatus === "live";
  const hasDiffs = currentDiffs.length > 0;

  // Callbacks for MessageList
  const handleSessionComplete = useCallback(() => {
    setSessionStatus("complete");
    setInteractiveState((s) => ({ ...s, sessionComplete: true }));
  }, []);

  const handleConnectionChange = useCallback((connected: boolean) => {
    setConnectionStatus(connected ? "connected" : "disconnected");
  }, []);

  const handleDiffUpdate = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/diffs`);
      if (!isMountedRef.current) return;
      if (res.ok) {
        const data = await res.json();
        if (!isMountedRef.current) return;
        setCurrentDiffs(data.diffs || []);
      }

      // Also fetch annotations
      const annotationsRes = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/annotations`);
      if (!isMountedRef.current) return;
      if (annotationsRes.ok) {
        const annotationsData = await annotationsRes.json();
        if (!isMountedRef.current) return;
        setCurrentAnnotationsByDiff(annotationsData?.annotations_by_diff || {});
        setCurrentReview(annotationsData?.review || null);
      }
    } catch (error) {
      if (!isMountedRef.current) return;
      console.error("Failed to update diffs:", error);
    }
  }, [session.id]);

  const handleInteractiveInfo = useCallback((interactive: boolean, claudeState: string) => {
    setInteractiveState((s) => ({
      ...s,
      isInteractive: interactive,
      claudeState: claudeState as InteractiveState["claudeState"],
    }));
  }, []);

  const handleClaudeState = useCallback((state: "running" | "waiting") => {
    setInteractiveState((s) => ({ ...s, claudeState: state }));
  }, []);

  const handleFeedbackQueued = useCallback(
    (messageId: string, position: number) => {
      setInteractiveState((s) => ({
        ...s,
        pendingFeedback: [...s.pendingFeedback, { id: messageId, status: "pending" }],
      }));
      showToast(`Message queued (position: ${position})`, "info");
    },
    [showToast]
  );

  const handleFeedbackStatus = useCallback(
    (messageId: string, status: string) => {
      setInteractiveState((s) => ({
        ...s,
        pendingFeedback: s.pendingFeedback.map((f) => (f.id === messageId ? { ...f, status } : f)),
      }));

      if (status === "approved") {
        showToast("Message sent to session", "success");
      } else if (status === "rejected" || status === "expired") {
        showToast(`Message was ${status}`, "error");
      }

      // Remove after delay
      setTimeout(() => {
        setInteractiveState((s) => ({
          ...s,
          pendingFeedback: s.pendingFeedback.filter((f) => f.id !== messageId),
        }));
      }, 3000);
    },
    [showToast]
  );

  // Share handler
  const shareSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/share`, {
        method: "POST",
      });
      if (res.ok) {
        window.location.reload();
      } else {
        showToast("Failed to create share link", "error");
      }
    } catch {
      showToast("Failed to create share link", "error");
    }
  }, [session.id, showToast]);

  // Submit feedback
  const submitFeedback = useCallback((content: string) => {
    messageListHandleRef.current?.sendFeedback(content);
  }, []);

  // Determine layout
  const gridClass = hasDiffs ? "session-content-grid two-column" : isLive ? "session-content-grid single-column" : "";
  const conversationClass = !hasDiffs && !isLive ? "" : "conversation-panel-container";
  const diffPanelClass = hasDiffs ? "diff-panel-container visible" : "diff-panel-container hidden";

  return (
    <div
      className="session-detail-page"
      data-session-is-live={String(isLive)}
      data-session-has-diffs={String(hasDiffs)}
      data-session-is-interactive={String(interactiveState.isInteractive)}
    >
      <Header
        session={session}
        shareUrl={shareUrl}
        sessionStatus={sessionStatus}
        connectionStatus={connectionStatus}
        isLive={isLive}
        onCopy={copy}
        onShare={shareSession}
      />

      <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-6">
        <div className={gridClass} data-content-grid>
          <div className={conversationClass} data-conversation-panel>
            <div
              className="min-w-0 lg:sticky lg:top-[calc(3.5rem+1.5rem)] lg:self-start"
              style={{ height: "calc(100vh - 10rem)" }}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-text-primary">Conversation</h2>
                <span className="text-xs text-text-muted tabular-nums">{messages.length} messages</span>
              </div>
              <MessageList
                sessionId={session.id}
                initialMessages={messages}
                session={session}
                isLive={isLive}
                onSessionComplete={handleSessionComplete}
                onConnectionChange={handleConnectionChange}
                onDiffUpdate={handleDiffUpdate}
                onInteractiveInfo={handleInteractiveInfo}
                onClaudeState={handleClaudeState}
                onFeedbackQueued={handleFeedbackQueued}
                onFeedbackStatus={handleFeedbackStatus}
                onHandle={(handle) => {
                  messageListHandleRef.current = handle;
                }}
              />
            </div>
          </div>

          {(isLive || hasDiffs) && (
            <div className={diffPanelClass} data-diff-panel>
              {hasDiffs && (
                <DiffPanel diffs={currentDiffs} annotationsByDiff={currentAnnotationsByDiff} review={currentReview || null} />
              )}
            </div>
          )}
        </div>
      </div>

      {interactiveState.isInteractive && isLive && !interactiveState.sessionComplete && (
        <FeedbackInput
          onSubmit={submitFeedback}
          claudeState={interactiveState.claudeState}
          pendingCount={interactiveState.pendingFeedback.filter((f) => f.status === "pending").length}
        />
      )}
    </div>
  );
}

// ============================================================================
// Header Component
// ============================================================================

interface HeaderProps {
  session: Session;
  shareUrl: string | null;
  sessionStatus: "live" | "complete";
  connectionStatus: "connected" | "disconnected" | "reconnecting";
  isLive: boolean;
  onCopy: (text: string) => void;
  onShare: () => void;
}

function Header({ session, shareUrl, sessionStatus, connectionStatus, isLive, onCopy, onShare }: HeaderProps) {
  const date = new Date(session.created_at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const timeDisplay = isLive ? formatDuration(session.created_at) : date;

  const resumeCommand = session.claude_session_id
    ? `claude --resume ${session.claude_session_id}`
    : session.project_path
      ? `cd ${session.project_path} && claude --continue`
      : "claude --continue";

  return (
    <header className="border-b border-bg-elevated">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-5">
        <div className="flex items-center gap-3 mb-2">
          {isLive && (
            <div className="live-indicator flex items-center gap-1.5">
              <span className="live-dot w-2 h-2 rounded-full bg-green-500" />
              <span className="text-xs font-bold uppercase tracking-wide text-green-500">LIVE</span>
            </div>
          )}
          <h1 className="text-2xl font-semibold text-text-primary">{stripSystemTags(session.title)}</h1>
        </div>

        <div className="flex items-center gap-4 text-sm text-text-muted overflow-hidden">
          {isLive && (
            <>
              <ConnectionStatusIndicator status={connectionStatus} />
              <span className="text-text-muted/30">.</span>
            </>
          )}
          {session.harness && (
            <>
              <span className="inline-flex items-center gap-1.5 text-text-secondary">
                <HarnessIcon harness={session.harness} />
                <span>{session.harness}</span>
              </span>
              <span className="text-text-muted/30">.</span>
            </>
          )}
          {session.model && (
            <>
              <span className="inline-flex items-center gap-1.5 font-mono text-[13px]">
                <ModelIcon model={session.model} />
                <span>{session.model}</span>
              </span>
              <span className="text-text-muted/30">.</span>
            </>
          )}
          {session.project_path && (
            <>
              <span className="font-mono text-[13px]" title={session.project_path}>
                {truncatePath(session.project_path)}
              </span>
              <span className="text-text-muted/30">.</span>
            </>
          )}
          <span>{timeDisplay}</span>
          {session.pr_url && (
            <>
              <span className="text-text-muted/30">.</span>
              <a
                href={session.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-text-muted hover:text-text-primary transition-colors"
              >
                <span>PR</span>
              </a>
            </>
          )}
          <span className="text-text-muted/30">.</span>
          <div className="inline-flex items-center gap-1.5 min-w-0">
            <code className="text-[13px] font-mono text-accent-primary truncate">{resumeCommand}</code>
            <button
              title="Copy command"
              className="p-1 text-text-muted hover:text-text-primary rounded transition-colors"
              onClick={() => onCopy(resumeCommand)}
            >
              <CopyIcon />
            </button>
          </div>
          <div className="flex-1" />
          {shareUrl ? (
            <div className="flex items-center gap-2">
              <code className="text-[13px] font-mono text-diff-add truncate">{shareUrl}</code>
              <button
                title="Copy URL"
                className="p-1 text-text-muted hover:text-text-primary rounded transition-colors"
                onClick={() => onCopy(shareUrl)}
              >
                <CopyIcon />
              </button>
            </div>
          ) : (
            <button className="text-text-muted hover:text-text-primary transition-colors" onClick={onShare}>
              Share
            </button>
          )}
          <a
            href={`/api/sessions/${encodeURIComponent(session.id)}/export`}
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            Export
          </a>
        </div>
      </div>
    </header>
  );
}

// ============================================================================
// FeedbackInput Component
// ============================================================================

interface FeedbackInputProps {
  onSubmit: (content: string) => void;
  claudeState: "running" | "waiting" | "unknown";
  pendingCount: number;
}

function FeedbackInput({ onSubmit, claudeState, pendingCount }: FeedbackInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
  const shortcutKey = isMac ? "\u2318" : "Ctrl";

  const handleSubmit = useCallback(() => {
    if (!value.trim()) return;
    onSubmit(value.trim());
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const textarea = e.target;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + "px";
  }, []);

  // Global keyboard shortcut for focusing
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "i") {
        e.preventDefault();
        textareaRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  const showStatusBadge = claudeState === "running" || pendingCount > 0;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center">
      {showStatusBadge && (
        <div className="flex items-center gap-3 text-xs px-3 py-1 bg-bg-secondary/80 backdrop-blur-sm border border-bg-elevated rounded mb-2">
          {claudeState === "running" && (
            <span className="flex items-center gap-1.5 text-text-secondary">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-primary animate-pulse" />
              Working
            </span>
          )}
          {pendingCount > 0 && <span className="text-amber-400 font-medium">{pendingCount} queued</span>}
        </div>
      )}
      <div className="flex items-center w-[min(600px,calc(100vw-2rem))] bg-bg-secondary border border-bg-elevated rounded-md px-4 py-2 shadow-lg transition-all duration-200 focus-within:outline focus-within:outline-2 focus-within:outline-accent-primary focus-within:outline-offset-2">
        <textarea
          ref={textareaRef}
          className="flex-1 bg-transparent text-text-primary text-[15px] leading-relaxed placeholder:text-text-muted resize-none border-none outline-none focus-visible:outline-none py-1 min-h-[24px] max-h-[150px]"
          placeholder="Ask a question..."
          rows={1}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
        />
        <div className="flex items-center gap-2 ml-3">
          <kbd className="hidden sm:inline-flex text-[11px] text-text-muted font-mono px-2 py-1 bg-bg-tertiary rounded">
            {shortcutKey}I
          </kbd>
          <button
            className="w-7 h-7 flex items-center justify-center rounded bg-text-muted text-bg-primary transition-all duration-150 hover:bg-text-primary hover:scale-105 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
            title={`Send (${shortcutKey}+Enter)`}
            onClick={handleSubmit}
            disabled={!value.trim()}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// ConnectionStatusIndicator Component
// ============================================================================

interface ConnectionStatusIndicatorProps {
  status: "connected" | "disconnected" | "reconnecting";
}

function ConnectionStatusIndicator({ status }: ConnectionStatusIndicatorProps) {
  if (status === "connected") {
    return (
      <span className="flex items-center gap-1 text-xs text-text-muted">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
        Connected
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-xs text-yellow-500">
      <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
      Reconnecting...
    </span>
  );
}

// ============================================================================
// Icon Components
// ============================================================================

function CopyIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
      />
    </svg>
  );
}

function ModelIcon({ model }: { model: string }) {
  const lower = model.toLowerCase();
  if (lower.includes("claude") || lower.includes("opus") || lower.includes("sonnet") || lower.includes("haiku")) {
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
  if (lower.includes("code") || lower.includes("cli") || lower.includes("terminal")) {
    return (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
      </svg>
    );
  }
  return null;
}

// ============================================================================
// Helper Functions
// ============================================================================

function truncatePath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return ".../" + parts.slice(-2).join("/");
}

function formatDuration(startTime: string): string {
  const start = new Date(startTime).getTime();
  const now = Date.now();
  const diffMs = now - start;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
