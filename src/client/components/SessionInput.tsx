import { useState, useCallback, useRef, useEffect } from "react";
import type { SessionState } from "../hooks/useSpawnedSession";

interface SessionInputProps {
  state: SessionState;
  onSend: (content: string) => boolean;
  className?: string;
}

export function SessionInput({ state, onSend, className }: SessionInputProps) {
  const [value, setValue] = useState("");
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Determine input state
  const isDisabled =
    state === "starting" ||
    state === "ending" ||
    state === "ended" ||
    state === "connecting";
  const isQueued = state === "running" && queuedMessage !== null;

  const placeholder = (() => {
    switch (state) {
      case "connecting":
        return "Connecting...";
      case "starting":
        return "Starting session...";
      case "running":
        return queuedMessage
          ? "Message queued..."
          : "Type your message... (queued until Claude finishes)";
      case "waiting":
        return "Type your message...";
      case "ending":
        return "Session ending...";
      case "ended":
        return "Session ended";
      case "disconnected":
        return "Reconnecting...";
      default:
        return "Type your message...";
    }
  })();

  // Handle submit
  const handleSubmit = useCallback(() => {
    const content = value.trim();
    if (!content) return;

    if (state === "waiting") {
      // Send immediately
      const sent = onSend(content);
      if (sent) {
        setValue("");
      }
    } else if (state === "running") {
      // Queue the message (replace any existing queued message)
      setQueuedMessage(content);
      setValue("");
    }
  }, [value, state, onSend]);

  // Send queued message when state changes to waiting
  useEffect(() => {
    if (state === "waiting" && queuedMessage) {
      const sent = onSend(queuedMessage);
      if (sent) {
        setQueuedMessage(null);
      }
    }
  }, [state, queuedMessage, onSend]);

  // Keyboard shortcut to focus input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "i") {
        e.preventDefault();
        textareaRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  // Auto-resize textarea
  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value);
      const textarea = e.target;
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 150) + "px";
    },
    []
  );

  if (state === "ended") {
    return null;
  }

  const isMac =
    typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
  const shortcutKey = isMac ? "\u2318" : "Ctrl";

  return (
    <div className={`border-t border-bg-elevated p-4 ${className || ""}`}>
      <div className="flex gap-2">
        <div className="flex-1 flex items-center bg-bg-secondary border border-bg-elevated rounded-md px-4 py-2 focus-within:outline focus-within:outline-2 focus-within:outline-accent-primary focus-within:outline-offset-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            disabled={isDisabled}
            placeholder={placeholder}
            rows={1}
            className="flex-1 bg-transparent text-text-primary text-[15px] leading-relaxed placeholder:text-text-muted resize-none border-none outline-none focus-visible:outline-none py-1 min-h-[24px] max-h-[150px] disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-2 ml-3">
            <kbd className="hidden sm:inline-flex text-[11px] text-text-muted font-mono px-2 py-1 bg-bg-tertiary rounded">
              {shortcutKey}I
            </kbd>
            <button
              onClick={handleSubmit}
              disabled={isDisabled || !value.trim()}
              className="w-7 h-7 flex items-center justify-center rounded bg-text-muted text-bg-primary transition-all duration-150 hover:bg-text-primary hover:scale-105 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
              title={`Send (${shortcutKey}+Enter)`}
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

      {/* Queued message indicator */}
      {queuedMessage && (
        <div className="mt-2 text-sm text-text-muted flex items-center gap-2">
          <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
          <span>1 message queued - Will send when Claude finishes</span>
          <button
            onClick={() => setQueuedMessage(null)}
            className="text-text-muted hover:text-text-primary ml-2"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
