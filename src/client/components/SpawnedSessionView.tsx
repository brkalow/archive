import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  useSpawnedSession,
  type QuestionPrompt,
  type PermissionPrompt,
  type ControlRequestPrompt as ControlRequestPromptType,
  type ParsedDiff,
} from "../hooks/useSpawnedSession";
import { ControlRequestPrompt } from "./ControlRequestPrompt";
import { SessionView } from "./SessionView";
import { SessionInput } from "./SessionInput";
import { UserBubble } from "./UserBubble";
import { AgentTurn } from "./AgentTurn";
import { QuestionModal } from "./QuestionModal";
import { ConnectionLostBanner } from "./ConnectionLostBanner";
import { DiffBlock } from "./DiffBlock";
import { ShareModal } from "./ShareModal";
import { buildToolResultMap } from "../blocks";
import { isNearBottom, scrollToBottom } from "../liveSession";
import { groupMessagesIntoTurns } from "../lib/messageUtils";
import { useToast, useClipboard } from "../hooks";
import type { Message, ContentBlock as SchemaContentBlock, Session } from "../../db/schema";

interface SpawnedSessionViewProps {
  sessionId: string;
  cwd: string;
  harness: string;
  model?: string;
  createdAt?: string;
}

export function SpawnedSessionView({
  sessionId,
  cwd,
  harness,
  model,
  createdAt,
}: SpawnedSessionViewProps) {
  const [title, setTitle] = useState("New Session");
  // Use createdAt from server if available, otherwise fall back to now
  const [startTime] = useState(() => createdAt ? new Date(createdAt) : new Date());
  const [duration, setDuration] = useState("0s");
  const [questionPrompt, setQuestionPrompt] = useState<QuestionPrompt | null>(
    null
  );
  const [permissionPrompt, setPermissionPrompt] =
    useState<PermissionPrompt | null>(null);
  const [controlRequest, setControlRequest] =
    useState<ControlRequestPromptType | null>(null);
  const [showShareModal, setShowShareModal] = useState(false);
  const [currentShareUrl, setCurrentShareUrl] = useState<string | null>(null);
  const [hasPendingInvite, setHasPendingInvite] = useState(false);
  const [isAcceptingInvite, setIsAcceptingInvite] = useState(false);
  const [isOwner, setIsOwner] = useState(true); // Default to true until we know otherwise
  const [showEndConfirm, setShowEndConfirm] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(0);
  const [showNewMessagesButton, setShowNewMessagesButton] = useState(false);

  // Hooks
  const { showToast } = useToast();
  const { copy } = useClipboard();

  const {
    state,
    messages,
    error,
    diffs,
    canResume,
    daemonConnected,
    isResuming,
    repoUrl,
    branch,
    sendMessage,
    interrupt,
    endSession,
    answerQuestion,
    respondToPermission,
    sendControlResponse,
    resumeSession,
  } = useSpawnedSession({
    sessionId,
    onQuestionPrompt: setQuestionPrompt,
    onPermissionPrompt: setPermissionPrompt,
    onControlRequest: setControlRequest,
  });

  // Update duration every second
  useEffect(() => {
    const interval = setInterval(() => {
      const ms = Date.now() - startTime.getTime();
      setDuration(formatDuration(ms));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  // Check for pending invite and ownership on mount
  useEffect(() => {
    async function checkSessionAccess() {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          if (data.pendingInvite) {
            setHasPendingInvite(true);
          }
          // Update ownership status
          setIsOwner(data.isOwner ?? true);
        }
      } catch {
        // Ignore errors - default to owner for safety
      }
    }
    checkSessionAccess();
  }, [sessionId]);

  // Convert StreamMessages to Message format for MessageBlock
  // Filter out messages with no renderable content (system init, result without content, etc.)
  const convertedMessages: Message[] = useMemo(() => {
    return messages
      .filter((msg) => {
        // Keep user and assistant messages that have content
        if (msg.type === "user" || msg.type === "assistant") {
          const content = msg.message?.content;
          // Check if there's actual content to render
          if (Array.isArray(content) && content.length > 0) {
            // Filter out user messages that only contain tool_result blocks
            // (these are rendered inline with their corresponding tool_use blocks)
            if (msg.type === "user" || msg.message?.role === "user") {
              const hasNonToolResult = content.some(
                (block: { type: string }) => block.type !== "tool_result"
              );
              if (!hasNonToolResult) {
                return false;
              }
            }
            return true;
          }
          // Also accept string content (shouldn't happen but be safe)
          // Cast to unknown first to satisfy TypeScript - this branch is defensive
          if (typeof content === "string" && (content as unknown as string).length > 0) {
            return true;
          }
          return false;
        }
        // Filter out system and result messages (they have no user-visible content)
        return false;
      })
      .map((msg, index) => {
        // Extract content blocks from the message
        const contentBlocks = msg.message?.content || [];

        // Extract text content for the legacy content field
        const textContent = contentBlocks
          .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n");

        return {
          id: index, // Message.id is a number
          session_id: sessionId,
          message_index: index,
          role: (msg.message?.role || msg.type) as string,
          content: textContent, // Legacy field
          // Cast daemon-ws ContentBlock[] to schema ContentBlock[] (compatible structure)
          content_blocks: contentBlocks as SchemaContentBlock[],
          timestamp: new Date().toISOString(),
        };
      });
  }, [messages, sessionId]);

  // Build tool result map for AgentTurn
  const toolResults = useMemo(() => {
    const allBlocks = convertedMessages.flatMap((m) => m.content_blocks || []);
    return buildToolResultMap(allBlocks);
  }, [convertedMessages]);

  // Group messages into turns
  const turns = useMemo(() => groupMessagesIntoTurns(convertedMessages), [convertedMessages]);

  // Create a session object for SessionView
  // Note: Remote sessions are newly spawned and don't have pre-existing database records,
  // so we use sensible defaults. Visibility defaults to "private" as a safe default for
  // new sessions - users can share via the share modal if desired.
  // repo_url and branch are populated asynchronously via session_metadata from the daemon.
  const session: Session = useMemo(() => ({
    id: sessionId,
    title: title,
    status: state === "ended" || state === "failed" ? "complete" : "live",
    created_at: startTime.toISOString(),
    updated_at: new Date().toISOString(),
    harness: harness,
    model: model || null,
    project_path: cwd,
    client_id: null,
    user_id: null,
    claude_session_id: null,
    agent_session_id: null,
    pr_url: null,
    pr_number: null,
    interactive: true,
    share_token: null,
    description: null,
    repo_url: repoUrl,
    branch: branch,
    visibility: "private",
    last_activity_at: null,
    remote: true,
  }), [sessionId, title, state, startTime, harness, model, cwd, repoUrl, branch]);

  // Derive title from first user message
  useEffect(() => {
    if (title !== "New Session") return;

    const firstUserMessage = messages.find(
      (m) => m.type === "user" || m.message?.role === "user"
    );

    if (firstUserMessage && firstUserMessage.message?.content) {
      const content = firstUserMessage.message.content;
      if (Array.isArray(content)) {
        const textBlock = content.find(
          (b): b is { type: "text"; text: string } =>
            b.type === "text" && typeof b.text === "string"
        );
        if (textBlock?.text) {
          const truncated =
            textBlock.text.slice(0, 50) +
            (textBlock.text.length > 50 ? "..." : "");
          setTitle(truncated);
        }
      }
    }
  }, [messages, title]);

  // Auto-scroll effect when messages change
  useEffect(() => {
    const hasNewMessages = convertedMessages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = convertedMessages.length;

    if (scrollContainerRef.current) {
      if (isNearBottom(scrollContainerRef.current)) {
        scrollToBottom(scrollContainerRef.current);
        setShowNewMessagesButton(false);
      } else if (hasNewMessages) {
        setShowNewMessagesButton(true);
      }
    }
  }, [convertedMessages.length]);

  // Scroll handler
  const handleScroll = useCallback(() => {
    if (
      scrollContainerRef.current &&
      isNearBottom(scrollContainerRef.current)
    ) {
      setShowNewMessagesButton(false);
    }
  }, []);

  const handleScrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      scrollToBottom(scrollContainerRef.current);
      setShowNewMessagesButton(false);
    }
  }, []);

  // Handle question answer
  const handleQuestionAnswer = useCallback(
    (answer: string) => {
      if (questionPrompt) {
        answerQuestion(questionPrompt.toolUseId, answer);
        setQuestionPrompt(null);
      }
    },
    [questionPrompt, answerQuestion]
  );

  // Handle permission response
  const handlePermissionResponse = useCallback(
    (allow: boolean) => {
      if (permissionPrompt) {
        respondToPermission(permissionPrompt.requestId, allow);
        setPermissionPrompt(null);
      }
    },
    [permissionPrompt, respondToPermission]
  );

  // Handle control request response (SDK format)
  const handleControlRequestAllow = useCallback(() => {
    if (controlRequest) {
      sendControlResponse(controlRequest.requestId, true);
      setControlRequest(null);
    }
  }, [controlRequest, sendControlResponse]);

  const handleControlRequestDeny = useCallback(
    (message: string) => {
      if (controlRequest) {
        sendControlResponse(controlRequest.requestId, false, message);
        setControlRequest(null);
      }
    },
    [controlRequest, sendControlResponse]
  );

  // Copy to clipboard with toast
  const copyToClipboard = useCallback((text: string) => {
    copy(text);
    showToast("Copied to clipboard", "success");
  }, [copy, showToast]);

  // Create share link
  const createShareLink = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/share`, {
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
  }, [sessionId, showToast]);

  // Open share modal
  const openShareModal = useCallback(() => {
    setShowShareModal(true);
  }, []);

  // Accept invite
  const acceptInvite = useCallback(async () => {
    setIsAcceptingInvite(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/collaborators/accept`, {
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
  }, [sessionId, showToast]);

  // Handle end session with confirmation
  const handleEndSession = useCallback(() => {
    if (state === "running") {
      setShowEndConfirm(true);
    } else {
      endSession();
    }
  }, [state, endSession]);

  const confirmEndSession = useCallback(() => {
    setShowEndConfirm(false);
    endSession();
  }, [endSession]);

  const showTypingIndicator = state === "running" || state === "starting";

  // Conversation content
  const conversationContent = (
    <div className="flex flex-col h-full relative">
      {/* Connection lost banner */}
      {state === "disconnected" && (
        <ConnectionLostBanner
          sessionId={sessionId}
          onEndSession={endSession}
          canResume={canResume}
          daemonConnected={daemonConnected}
          isResuming={isResuming}
          onResume={resumeSession}
        />
      )}

      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto px-6"
        onScroll={handleScroll}
      >
        {/* Chat bubble layout */}
        <div className="flex flex-col gap-4 py-4">
          {turns.map((turn, i) => {
            if (turn.type === 'user') {
              const message = turn.messages[0];
              if (!message) return null;
              return <UserBubble key={`user-${message.id}`} message={message} />;
            } else {
              return (
                <AgentTurn
                  key={`agent-${turn.messages[0]?.id ?? i}`}
                  messages={turn.messages}
                  toolResults={toolResults}
                />
              );
            }
          })}

          {/* Control request prompt (inline, SDK format) */}
          {controlRequest && (
            <ControlRequestPrompt
              request={controlRequest}
              onAllow={handleControlRequestAllow}
              onDeny={handleControlRequestDeny}
            />
          )}

          {/* Typing indicator */}
          {showTypingIndicator && <TypingIndicator />}
        </div>
      </div>

      {/* New messages button */}
      {showNewMessagesButton && (
        <button
          className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-accent-primary text-white rounded-full shadow-lg hover:bg-accent-primary/90 transition-all"
          onClick={handleScrollToBottom}
        >
          New messages
        </button>
      )}
    </div>
  );

  // Diff panel content
  const diffContent = diffs.length > 0 ? (
    <SpawnedDiffPanel diffs={diffs} />
  ) : null;

  // Input area
  const inputArea = (
    <SessionInput state={state} onSend={sendMessage} />
  );

  return (
    <>
      <SessionView
        session={session}
        messages={convertedMessages}
        diffs={diffs}
        mode="remote"
        remoteState={{ state, duration }}
        remoteControls={{
          onInterrupt: interrupt,
          onEndSession: handleEndSession,
        }}
        shareUrl={currentShareUrl}
        isOwner={isOwner}
        onShare={openShareModal}
        onCopy={copyToClipboard}
        hasPendingInvite={hasPendingInvite}
        isAcceptingInvite={isAcceptingInvite}
        onAcceptInvite={acceptInvite}
        conversationContent={conversationContent}
        inputArea={inputArea}
      >
        {diffContent}
      </SessionView>

      {/* Question modal */}
      {questionPrompt && (
        <QuestionModal
          question={questionPrompt.question}
          options={questionPrompt.options}
          onAnswer={handleQuestionAnswer}
          onClose={() => setQuestionPrompt(null)}
        />
      )}

      {/* Permission modal */}
      {permissionPrompt && (
        <PermissionModal
          tool={permissionPrompt.tool}
          description={permissionPrompt.description}
          details={permissionPrompt.details}
          onAllow={() => handlePermissionResponse(true)}
          onDeny={() => handlePermissionResponse(false)}
        />
      )}

      {/* Share modal */}
      {showShareModal && (
        <ShareModal
          sessionId={sessionId}
          shareUrl={currentShareUrl}
          isOwner={true}
          onClose={() => setShowShareModal(false)}
          onCopy={copyToClipboard}
          onCreateShareLink={createShareLink}
        />
      )}

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
                onClick={confirmEndSession}
                className="px-4 py-2 bg-diff-del hover:bg-red-500 text-white rounded-md font-medium transition-colors"
              >
                End Session
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error state */}
      {(state === "ended" || state === "failed") && error && (
        <div className="p-4 bg-red-900/30 border-t border-red-800">
          <p className="text-diff-del">Session ended with error: {error}</p>
        </div>
      )}
    </>
  );
}

// ============================================================================
// Helper Components
// ============================================================================

interface SpawnedDiffPanelProps {
  diffs: ParsedDiff[];
}

function SpawnedDiffPanel({ diffs }: SpawnedDiffPanelProps) {
  // Separate session-relevant diffs from other diffs
  const sessionDiffs = diffs.filter((d) => d.is_session_relevant);
  const otherDiffs = diffs.filter((d) => !d.is_session_relevant);
  const [otherExpanded, setOtherExpanded] = useState(false);

  const isLargeDiff = (diff: ParsedDiff) =>
    diff.additions + diff.deletions > 300;

  const summarizeFiles = (diffs: ParsedDiff[]) => {
    const names = diffs
      .map((d) => d.filename.split("/").pop() || "unknown")
      .slice(0, 3);
    return diffs.length > 3 ? names.join(", ") + "..." : names.join(", ");
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between pt-4 pb-4 pr-4 shrink-0">
        <h2 className="text-sm font-semibold text-text-primary">Diff</h2>
        <span className="text-xs text-text-muted tabular-nums">
          {diffs.length} file{diffs.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Diffs container */}
      <div className="flex-1 overflow-y-auto pb-6 pl-6">
        {sessionDiffs.length > 0 && (
          <div className="diff-group flex flex-col gap-4">
            {sessionDiffs.map((diff, index) => (
              <DiffBlock
                key={`session-${index}`}
                diffId={index}
                filename={diff.filename}
                diffContent={diff.diff_content}
                additions={diff.additions}
                deletions={diff.deletions}
                annotations={[]}
                reviewModel={null}
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
                {otherDiffs.map((diff, index) => (
                  <DiffBlock
                    key={`other-${index}`}
                    diffId={1000 + index}
                    filename={diff.filename}
                    diffContent={diff.diff_content}
                    additions={diff.additions}
                    deletions={diff.deletions}
                    annotations={[]}
                    reviewModel={null}
                    initiallyExpanded={false}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {diffs.length === 0 && (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            No code changes yet
          </div>
        )}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="agent-turn">
      {/* Turn header style */}
      <div className="turn-header flex items-center gap-3 text-text-muted text-xs py-1">
        <div className="flex-1 h-px bg-bg-elevated" />
        <span>working</span>
        <div className="flex-1 h-px bg-bg-elevated" />
      </div>

      {/* Typing dots */}
      <div className="flex items-center gap-2 py-2 text-text-muted">
        <div className="flex gap-1">
          <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
        <span className="text-sm">Claude is working...</span>
      </div>
    </div>
  );
}

interface PermissionModalProps {
  tool: string;
  description: string;
  details: Record<string, unknown>;
  onAllow: () => void;
  onDeny: () => void;
}

function PermissionModal({
  tool,
  description,
  details,
  onAllow,
  onDeny,
}: PermissionModalProps) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-secondary border border-bg-elevated rounded-lg w-full max-w-lg mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-bg-elevated">
          <h2 className="text-lg font-semibold text-text-primary">
            Permission Request
          </h2>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-amber-900/50 flex items-center justify-center flex-shrink-0">
              <svg
                className="w-5 h-5 text-amber-500"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div>
              <p className="text-text-primary font-medium mb-1">
                Claude wants to use: {tool}
              </p>
              <p className="text-text-secondary text-sm">{description}</p>
            </div>
          </div>

          {/* Details */}
          {Object.keys(details).length > 0 && (
            <div className="bg-bg-tertiary rounded-md p-3 text-sm">
              <pre className="text-text-muted whitespace-pre-wrap break-words">
                {JSON.stringify(details, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-bg-elevated flex justify-end gap-3">
          <button
            onClick={onDeny}
            className="px-4 py-2 bg-diff-del hover:bg-red-500 text-white rounded-md font-medium transition-colors"
          >
            Deny
          </button>
          <button
            onClick={onAllow}
            className="px-4 py-2 bg-diff-add hover:bg-green-500 text-white rounded-md font-medium transition-colors"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}
