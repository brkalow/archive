import { useState, useCallback, useRef, useEffect } from "react";
import { MessageList, type MessageListHandle } from "./MessageList";
import { DiffPanel } from "./DiffPanel";
import { ShareModal } from "./ShareModal";
import { SessionView } from "./SessionView";
import { useToast, useClipboard } from "../hooks";
import type { Session, Message, Diff, Review, Annotation } from "../../db/schema";

interface SessionDetailPageProps {
  session: Session;
  messages: Message[];
  diffs: Diff[];
  shareUrl: string | null;
  review?: Review | null;
  annotationsByDiff: Record<number, Annotation[]>;
  isOwner?: boolean;
  pendingInvite?: boolean;
}

interface InteractiveState {
  isInteractive: boolean;
  claudeState: "running" | "waiting" | "unknown";
  sessionComplete: boolean;
  pendingFeedback: Array<{ id: string; status: string }>;
}

export function SessionDetailPage(props: SessionDetailPageProps) {
  const { session, messages, diffs, shareUrl, review, annotationsByDiff, isOwner = true, pendingInvite = false } = props;

  // State
  const [showShareModal, setShowShareModal] = useState(false);
  const [hasPendingInvite, setHasPendingInvite] = useState(pendingInvite);
  const [isAcceptingInvite, setIsAcceptingInvite] = useState(false);
  const [currentShareUrl, setCurrentShareUrl] = useState(shareUrl);
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

  // Share handler - creates share token link
  const createShareLink = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/share`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        const baseUrl = `${window.location.protocol}//${window.location.host}`;
        const newShareUrl = `${baseUrl}/s/${data.share_token}`;
        setCurrentShareUrl(newShareUrl);
        showToast("Share link created", "success");
      } else {
        showToast("Failed to create share link", "error");
      }
    } catch {
      showToast("Failed to create share link", "error");
    }
  }, [session.id, showToast]);

  // Open share modal
  const openShareModal = useCallback(() => {
    setShowShareModal(true);
  }, []);

  // Accept invite
  const acceptInvite = useCallback(async () => {
    setIsAcceptingInvite(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/collaborators/accept`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        setHasPendingInvite(false);
        showToast("Invite accepted", "success");
      } else {
        const data = await res.json();
        showToast(data.message || "Failed to accept invite", "error");
      }
    } catch {
      showToast("Failed to accept invite", "error");
    } finally {
      setIsAcceptingInvite(false);
    }
  }, [session.id, showToast]);

  // Submit feedback
  const submitFeedback = useCallback((content: string) => {
    messageListHandleRef.current?.sendFeedback(content);
  }, []);

  // Handle copy with toast
  const handleCopy = useCallback((text: string) => {
    copy(text);
    showToast("Copied to clipboard", "success");
  }, [copy, showToast]);

  // Conversation content
  const conversationContent = (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between pt-4 pb-2">
        <h2 className="text-sm font-semibold text-text-primary">Conversation</h2>
        <span className="text-xs text-text-muted tabular-nums">{messages.length} messages</span>
      </div>
      <div className="flex-1 min-h-0">
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
  );

  // Diff panel content
  const diffContent = currentDiffs.length > 0 ? (
    <DiffPanel diffs={currentDiffs} annotationsByDiff={currentAnnotationsByDiff} review={currentReview || null} />
  ) : null;

  // Feedback input for interactive sessions
  const inputArea = interactiveState.isInteractive && isLive && !interactiveState.sessionComplete ? (
    <FeedbackInput
      onSubmit={submitFeedback}
      claudeState={interactiveState.claudeState}
      pendingCount={interactiveState.pendingFeedback.filter((f) => f.status === "pending").length}
    />
  ) : null;

  return (
    <>
      <SessionView
        session={session}
        messages={messages}
        diffs={currentDiffs}
        annotationsByDiff={currentAnnotationsByDiff}
        review={currentReview}
        mode="view"
        sessionStatus={sessionStatus}
        connectionStatus={connectionStatus}
        interactiveState={interactiveState}
        shareUrl={currentShareUrl}
        isOwner={isOwner}
        onShare={openShareModal}
        onCopy={handleCopy}
        hasPendingInvite={hasPendingInvite}
        isAcceptingInvite={isAcceptingInvite}
        onAcceptInvite={acceptInvite}
        conversationContent={conversationContent}
        inputArea={inputArea}
      >
        {diffContent}
      </SessionView>

      {showShareModal && (
        <ShareModal
          sessionId={session.id}
          shareUrl={currentShareUrl}
          isOwner={isOwner}
          onClose={() => setShowShareModal(false)}
          onCopy={(text) => {
            copy(text);
            showToast("Copied to clipboard", "success");
          }}
          onCreateShareLink={createShareLink}
        />
      )}
    </>
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
          className="flex-1 bg-transparent text-text-primary text-base leading-relaxed placeholder:text-text-muted resize-none border-none outline-none focus-visible:outline-none py-1 min-h-[24px] max-h-[150px]"
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
