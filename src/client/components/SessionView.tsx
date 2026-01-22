import { useState, useCallback, useRef, useMemo } from "react";
import { stripSystemTags } from "../blocks";
import type { Session, Message, Diff, Review, Annotation } from "../../db/schema";
import type { ParsedDiff } from "../hooks/useSpawnedSession";

// ============================================================================
// Types
// ============================================================================

export type ViewMode = "split" | "conversation" | "diff";
export type SessionMode = "view" | "remote";

export interface SessionViewProps {
  // Core session data
  session: Session;
  messages: Message[];
  diffs: Diff[] | ParsedDiff[];

  // Annotations (view mode only)
  annotationsByDiff?: Record<number, Annotation[]>;
  review?: Review | null;

  // Mode
  mode: SessionMode;

  // Remote session state (only used when mode='remote')
  remoteState?: {
    state: "connecting" | "starting" | "running" | "waiting" | "ending" | "ended" | "failed" | "disconnected";
    duration?: string;
  };

  // Remote session controls (only used when mode='remote')
  remoteControls?: {
    onInterrupt: () => void;
    onEndSession: () => void;
  };

  // Live session state (view mode)
  sessionStatus?: "live" | "complete";
  connectionStatus?: "connected" | "disconnected" | "reconnecting";

  // Interactive feedback (view mode)
  interactiveState?: {
    isInteractive: boolean;
    claudeState: "running" | "waiting" | "unknown";
    sessionComplete: boolean;
  };

  // Sharing
  shareUrl: string | null;
  isOwner: boolean;
  onShare?: () => void;
  onCopy?: (text: string) => void;

  // Pending invite
  hasPendingInvite?: boolean;
  isAcceptingInvite?: boolean;
  onAcceptInvite?: () => void;

  // Callbacks for streaming content
  children?: React.ReactNode;

  // Conversation panel override for custom content
  conversationContent?: React.ReactNode;

  // Bottom input area (for remote mode or interactive feedback)
  inputArea?: React.ReactNode;
}

// ============================================================================
// SessionView Component
// ============================================================================

export function SessionView(props: SessionViewProps) {
  const {
    session,
    messages,
    diffs,
    annotationsByDiff = {},
    review,
    mode,
    remoteState,
    remoteControls,
    sessionStatus = "complete",
    connectionStatus = "disconnected",
    interactiveState,
    shareUrl,
    isOwner,
    onShare,
    onCopy,
    hasPendingInvite = false,
    isAcceptingInvite = false,
    onAcceptInvite,
    children,
    conversationContent,
    inputArea,
  } = props;

  // View mode state - default to split if diffs exist, else conversation
  const hasDiffs = diffs.length > 0;
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    hasDiffs ? "split" : "conversation"
  );

  // Overflow menu state
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Derived state
  const isLive = mode === "remote"
    ? (remoteState?.state !== "ended" && remoteState?.state !== "failed")
    : sessionStatus === "live";

  // Close overflow menu on click outside
  const handleMenuBlur = useCallback(() => {
    setTimeout(() => setShowOverflowMenu(false), 150);
  }, []);

  // Resume command
  const resumeCommand = session.claude_session_id
    ? `claude --resume ${session.claude_session_id}`
    : session.project_path
      ? `cd ${session.project_path} && claude --continue`
      : "claude --continue";

  // Determine content layout based on view mode
  const showConversation = viewMode === "split" || viewMode === "conversation";
  const showDiff = viewMode === "split" || viewMode === "diff";

  return (
    <div
      className="session-view flex flex-col h-full overflow-hidden"
      data-mode={mode}
      data-is-live={String(isLive)}
      data-has-diffs={String(hasDiffs)}
    >
      {/* Header */}
      <SessionViewHeader
        session={session}
        mode={mode}
        isLive={isLive}
        remoteState={remoteState}
        connectionStatus={connectionStatus}
        shareUrl={shareUrl}
        isOwner={isOwner}
        resumeCommand={resumeCommand}
        showOverflowMenu={showOverflowMenu}
        menuRef={menuRef}
        onShare={onShare}
        onCopy={onCopy}
        onMenuToggle={() => setShowOverflowMenu(!showOverflowMenu)}
        onMenuBlur={handleMenuBlur}
        remoteControls={remoteControls}
      />

      {/* Pending invite banner */}
      {hasPendingInvite && (
        <InviteBanner
          isAccepting={isAcceptingInvite}
          onAccept={onAcceptInvite}
        />
      )}

      {/* View toggle bar - only show if there are diffs */}
      {hasDiffs && (
        <ViewToggleBar
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          messageCount={messages.length}
          diffCount={diffs.length}
        />
      )}

      {/* Main content area */}
      <div className="flex-1 overflow-hidden border-bg-elevated flex flex-col min-h-0">
        <div className="max-w-[1400px] w-full mx-auto px-6 lg:px-10 flex flex-1 h-full min-h-0">
          {/* Conversation panel */}
          {showConversation && (
            <div className={`${showDiff ? "w-1/3 pr-6" : "flex-1"} overflow-y-auto flex flex-col min-h-0`}>
              {conversationContent}
            </div>
          )}

          {/* Separator */}
          {showConversation && showDiff && (
            <div className="w-px bg-text-muted/30" />
          )}

          {/* Diff panel */}
          {showDiff && (
            <div className={`${showConversation ? "w-2/3 pl-6" : "flex-1"} overflow-hidden flex flex-col`}>
              {children}
            </div>
          )}
        </div>
      </div>

      {/* Bottom input area */}
      {inputArea}
    </div>
  );
}

// ============================================================================
// Header Component
// ============================================================================

interface SessionViewHeaderProps {
  session: Session;
  mode: SessionMode;
  isLive: boolean;
  remoteState?: SessionViewProps["remoteState"];
  connectionStatus?: "connected" | "disconnected" | "reconnecting";
  shareUrl: string | null;
  isOwner: boolean;
  resumeCommand: string;
  showOverflowMenu: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onShare?: () => void;
  onCopy?: (text: string) => void;
  onMenuToggle: () => void;
  onMenuBlur: () => void;
  remoteControls?: SessionViewProps["remoteControls"];
}

function SessionViewHeader({
  session,
  mode,
  isLive,
  remoteState,
  connectionStatus,
  shareUrl,
  isOwner,
  resumeCommand,
  showOverflowMenu,
  menuRef,
  onShare,
  onCopy,
  onMenuToggle,
  onMenuBlur,
  remoteControls,
}: SessionViewHeaderProps) {
  // Status badge
  const statusBadge = useMemo(() => {
    if (mode === "remote" && remoteState) {
      const stateMap: Record<string, { label: string; dotColor: string; textColor: string; pulse: boolean }> = {
        connecting: { label: "Connecting", dotColor: "bg-text-muted", textColor: "text-text-muted", pulse: true },
        starting: { label: "Starting", dotColor: "bg-amber-500", textColor: "text-amber-500", pulse: true },
        running: { label: "Running", dotColor: "bg-accent-primary", textColor: "text-accent-primary", pulse: true },
        waiting: { label: "Waiting", dotColor: "bg-green-500", textColor: "text-green-500", pulse: false },
        ending: { label: "Ending", dotColor: "bg-text-muted", textColor: "text-text-muted", pulse: false },
        ended: { label: "Ended", dotColor: "bg-text-muted", textColor: "text-text-muted", pulse: false },
        failed: { label: "Failed", dotColor: "bg-diff-del", textColor: "text-diff-del", pulse: false },
        disconnected: { label: "Reconnecting", dotColor: "bg-amber-500", textColor: "text-amber-500", pulse: true },
      };
      return stateMap[remoteState.state] || { label: "", dotColor: "bg-text-muted", textColor: "text-text-muted", pulse: false };
    }
    if (isLive) {
      return { label: "LIVE", dotColor: "bg-green-500", textColor: "text-green-500", pulse: true };
    }
    return null;
  }, [mode, remoteState, isLive]);

  // Time display
  const timeDisplay = useMemo(() => {
    if (mode === "remote" && remoteState?.duration) {
      return remoteState.duration;
    }
    const date = new Date(session.created_at);
    if (isLive) {
      return formatRelativeTime(date);
    }
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }, [mode, remoteState?.duration, session.created_at, isLive]);

  const canInterrupt = mode === "remote" && remoteState?.state === "running";
  const canEnd = mode === "remote" && remoteState?.state !== "ended" && remoteState?.state !== "failed";

  return (
    <header className="bg-bg-primary border-b border-bg-elevated">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-4">
        {/* Row 1: Title with status */}
        <div className="flex items-center gap-3 mb-2">
          {statusBadge && (
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${statusBadge.dotColor} ${statusBadge.pulse ? "animate-pulse" : ""}`} />
              <span className={`text-xs font-bold uppercase tracking-wide ${statusBadge.textColor}`}>
                {statusBadge.label}
              </span>
            </div>
          )}
          <h1 className="text-xl font-semibold text-text-primary truncate">
            {stripSystemTags(session.title)}
          </h1>
        </div>

        {/* Row 2: Metadata badges + time + actions */}
        <div className="flex items-center justify-between gap-4">
          {/* Left: Metadata badges */}
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {/* Repo/path badge */}
            {session.project_path && (
              <Badge icon={<BookmarkIcon />}>
                {extractRepoName(session.project_path)}
              </Badge>
            )}

            {/* Model badge */}
            {session.model && (
              <Badge icon={<ModelIcon model={session.model} />}>
                {formatModelName(session.model)}
              </Badge>
            )}

            {/* Harness badge */}
            {session.harness && (
              <Badge icon={<HarnessIcon harness={session.harness} />}>
                {session.harness}
              </Badge>
            )}

            {/* PR badge */}
            {session.pr_url && (
              <a
                href={session.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-bg-tertiary hover:bg-bg-elevated text-text-secondary text-xs rounded-md transition-colors"
              >
                <PRIcon />
                <span>PR</span>
              </a>
            )}

            {/* Remote badge */}
            {mode === "remote" && (
              <span className="px-2 py-0.5 bg-purple-900/50 text-purple-300 text-xs rounded-md font-medium">
                Remote
              </span>
            )}

            {/* Interactive badge */}
            {session.interactive && mode === "view" && (
              <span className="px-2 py-0.5 bg-accent-primary/20 text-accent-primary text-xs rounded-md font-medium">
                Interactive
              </span>
            )}

            {/* Connection status for live view mode */}
            {mode === "view" && isLive && connectionStatus && (
              <ConnectionStatusBadge status={connectionStatus} />
            )}

            {/* Time */}
            <span className="text-xs text-text-muted tabular-nums">{timeDisplay}</span>
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Remote mode controls */}
            {mode === "remote" && isOwner && remoteControls && (
              <>
                {canInterrupt && (
                  <button
                    onClick={remoteControls.onInterrupt}
                    className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-sm rounded-md font-medium transition-colors"
                  >
                    Interrupt
                  </button>
                )}
                {canEnd && (
                  <button
                    onClick={remoteControls.onEndSession}
                    className="px-3 py-1.5 bg-diff-del hover:bg-red-500 text-white text-sm rounded-md font-medium transition-colors"
                  >
                    End
                  </button>
                )}
              </>
            )}

            {/* Share button */}
            {onShare && (
              <button
                onClick={onShare}
                className="px-3 py-1.5 bg-bg-tertiary hover:bg-bg-elevated text-text-primary text-sm rounded-md font-medium transition-colors border border-bg-elevated"
              >
                Share
              </button>
            )}

            {/* Overflow menu */}
            <div className="relative" ref={menuRef as React.RefObject<HTMLDivElement>}>
              <button
                onClick={onMenuToggle}
                onBlur={onMenuBlur}
                className="w-8 h-8 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors"
                title="More actions"
              >
                <MoreIcon />
              </button>

              {showOverflowMenu && (
                <div className="absolute right-0 top-full mt-1 w-48 bg-bg-secondary border border-bg-elevated rounded-lg shadow-lg z-50 py-1">
                  {/* Resume command */}
                  <button
                    className="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-tertiary transition-colors flex items-center gap-2"
                    onClick={() => {
                      onCopy?.(resumeCommand);
                    }}
                  >
                    <CopyIcon />
                    Copy resume command
                  </button>

                  {/* Share URL if exists */}
                  {shareUrl && (
                    <button
                      className="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-tertiary transition-colors flex items-center gap-2"
                      onClick={() => {
                        onCopy?.(shareUrl);
                      }}
                    >
                      <CopyIcon />
                      Copy share URL
                    </button>
                  )}

                  {/* Export */}
                  <a
                    href={`/api/sessions/${encodeURIComponent(session.id)}/export`}
                    className="block w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-tertiary transition-colors"
                  >
                    Export session
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

// ============================================================================
// View Toggle Bar
// ============================================================================

interface ViewToggleBarProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  messageCount: number;
  diffCount: number;
}

function ViewToggleBar({ viewMode, onViewModeChange, messageCount, diffCount }: ViewToggleBarProps) {
  return (
    <div className="bg-bg-secondary border-b border-bg-elevated">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-2 flex items-center justify-between">
        <div className="flex items-center gap-1 bg-bg-tertiary rounded-lg p-1">
          <ViewToggleButton
            active={viewMode === "split"}
            onClick={() => onViewModeChange("split")}
            icon={<SplitIcon />}
            label="Split"
          />
          <ViewToggleButton
            active={viewMode === "conversation"}
            onClick={() => onViewModeChange("conversation")}
            icon={<ConversationIcon />}
            label="Conversation"
          />
          <ViewToggleButton
            active={viewMode === "diff"}
            onClick={() => onViewModeChange("diff")}
            icon={<DiffIcon />}
            label="Diff"
          />
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 text-xs text-text-muted">
          <span>{messageCount} messages</span>
          <span>{diffCount} files changed</span>
        </div>
      </div>
    </div>
  );
}

interface ViewToggleButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

function ViewToggleButton({ active, onClick, icon, label }: ViewToggleButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${
        active
          ? "bg-bg-elevated text-text-primary"
          : "text-text-muted hover:text-text-primary hover:bg-bg-elevated/50"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// ============================================================================
// Invite Banner
// ============================================================================

interface InviteBannerProps {
  isAccepting: boolean;
  onAccept?: () => void;
}

function InviteBanner({ isAccepting, onAccept }: InviteBannerProps) {
  return (
    <div className="bg-accent-primary/10 border-b border-accent-primary/20">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <svg className="w-5 h-5 text-accent-primary shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
          </svg>
          <span className="text-sm text-text-primary">
            You've been invited to collaborate on this session.
          </span>
        </div>
        <button
          onClick={onAccept}
          disabled={isAccepting}
          className="px-4 py-1.5 bg-accent-primary hover:bg-accent-primary/90 text-bg-primary text-sm rounded-md font-medium transition-colors disabled:opacity-50"
        >
          {isAccepting ? "Accepting..." : "Accept Invite"}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Connection Status Badge
// ============================================================================

interface ConnectionStatusBadgeProps {
  status: "connected" | "disconnected" | "reconnecting";
}

function ConnectionStatusBadge({ status }: ConnectionStatusBadgeProps) {
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
// Badge Component
// ============================================================================

interface BadgeProps {
  icon?: React.ReactNode;
  children: React.ReactNode;
}

function Badge({ icon, children }: BadgeProps) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-bg-tertiary text-text-secondary text-xs rounded-md">
      {icon}
      <span className="truncate max-w-[150px]">{children}</span>
    </span>
  );
}

// ============================================================================
// Icons
// ============================================================================

function BookmarkIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
    </svg>
  );
}

function PRIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
      />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
    </svg>
  );
}

function ConversationIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  );
}

function DiffIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
    </svg>
  );
}

function ModelIcon({ model }: { model: string }) {
  const lower = model.toLowerCase();
  if (lower.includes("claude") || lower.includes("opus") || lower.includes("sonnet") || lower.includes("haiku")) {
    return (
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
        <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017L3.592 20H0l6.569-16.48zm2.327 5.14l-2.36 6.076h4.873l-2.513-6.077z" />
      </svg>
    );
  }
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3")) {
    return (
      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
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
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
      </svg>
    );
  }
  return null;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format model name for display (e.g., "claude-opus-4-5-20251101" -> "Opus 4.5")
 */
export function formatModelName(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus-4-5') || lower.includes('opus-4.5') || lower.includes('opus4.5')) return 'Opus 4.5';
  if (lower.includes('opus-4') || lower.includes('opus4')) return 'Opus 4';
  if (lower.includes('sonnet-4') || lower.includes('sonnet4')) return 'Sonnet 4';
  if (lower.includes('sonnet-3-5') || lower.includes('sonnet-3.5') || lower.includes('sonnet3.5')) return 'Sonnet 3.5';
  if (lower.includes('haiku-3-5') || lower.includes('haiku-3.5') || lower.includes('haiku3.5')) return 'Haiku 3.5';
  if (lower.includes('haiku')) return 'Haiku';
  if (lower.includes('gpt-4o')) return 'GPT-4o';
  if (lower.includes('gpt-4')) return 'GPT-4';
  if (lower.includes('o1')) return 'o1';
  if (lower.includes('o3')) return 'o3';
  // Fallback: extract recognizable parts
  const parts = model.split('-');
  if (parts.length >= 2) {
    return parts.slice(0, 2).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }
  return model;
}

/**
 * Extract repo name from project path (e.g., "/Users/me/code/myrepo" -> "myrepo")
 */
function extractRepoName(path: string): string {
  const parts = path.split('/');
  // Return last non-empty part
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part) return part;
  }
  return path;
}

/**
 * Format relative time (e.g., "5m ago")
 */
function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ago`;
  } else if (minutes > 0) {
    return `${minutes}m ago`;
  } else {
    return `${seconds}s ago`;
  }
}
