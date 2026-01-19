import { useState } from "react";
import type { ControlRequestPrompt as ControlRequestPromptType } from "../hooks/useSpawnedSession";

interface ControlRequestPromptProps {
  request: ControlRequestPromptType;
  onAllow: () => void;
  onDeny: (message: string) => void;
  disabled?: boolean;
}

/**
 * Inline permission prompt component for SDK control requests.
 * Renders in the conversation stream (not as a modal) to show
 * pending permission requests from Claude Code.
 */
export function ControlRequestPrompt({
  request,
  onAllow,
  onDeny,
  disabled = false,
}: ControlRequestPromptProps) {
  const [responded, setResponded] = useState(false);
  const [response, setResponse] = useState<"allowed" | "denied" | null>(null);

  const handleAllow = () => {
    setResponded(true);
    setResponse("allowed");
    onAllow();
  };

  const handleDeny = () => {
    setResponded(true);
    setResponse("denied");
    onDeny("User denied the action");
  };

  const isDisabled = disabled || responded;

  // Format the tool input for display
  const formatInput = (input: Record<string, unknown>): string => {
    // For Bash commands, show the command
    if (typeof input.command === "string") {
      return input.command;
    }
    // For file operations, show the file path
    if (typeof input.file_path === "string") {
      return input.file_path;
    }
    // For other tools, show a summary
    return JSON.stringify(input, null, 2);
  };

  // Get a friendly display name for the tool
  const getToolDisplayName = (toolName: string): string => {
    const displayNames: Record<string, string> = {
      Bash: "Run Command",
      Write: "Write File",
      Edit: "Edit File",
      Read: "Read File",
      Glob: "Search Files",
      Grep: "Search Content",
    };
    return displayNames[toolName] || toolName;
  };

  return (
    <div
      className={`
        my-3 rounded-lg border overflow-hidden transition-opacity
        ${responded ? "opacity-60" : ""}
        ${response === "allowed" ? "border-diff-add/50 bg-diff-add/5" : ""}
        ${response === "denied" ? "border-diff-del/50 bg-diff-del/5" : ""}
        ${!responded ? "border-amber-500/50 bg-amber-900/10" : ""}
      `}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-bg-tertiary/50 border-b border-bg-elevated">
        <div className="w-8 h-8 rounded-full bg-amber-900/50 flex items-center justify-center flex-shrink-0">
          <ToolIcon toolName={request.toolName} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary">
            {getToolDisplayName(request.toolName)}
          </p>
          {request.decisionReason && (
            <p className="text-xs text-text-muted truncate">
              {request.decisionReason}
            </p>
          )}
        </div>
        {responded && (
          <span
            className={`
              text-xs font-medium px-2 py-1 rounded
              ${response === "allowed" ? "bg-diff-add/20 text-diff-add" : ""}
              ${response === "denied" ? "bg-diff-del/20 text-diff-del" : ""}
            `}
          >
            {response === "allowed" ? "Allowed" : "Denied"}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="px-4 py-3">
        <pre className="text-sm text-text-secondary font-mono whitespace-pre-wrap break-words bg-bg-tertiary rounded p-2 max-h-40 overflow-y-auto">
          {formatInput(request.input)}
        </pre>
      </div>

      {/* Actions */}
      {!responded && (
        <div className="px-4 py-3 border-t border-bg-elevated flex items-center gap-2">
          <button
            onClick={handleAllow}
            disabled={isDisabled}
            className="px-4 py-2 bg-diff-add hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md text-sm font-medium transition-colors"
          >
            Accept
          </button>
          <button
            onClick={handleDeny}
            disabled={isDisabled}
            className="px-4 py-2 bg-diff-del hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md text-sm font-medium transition-colors"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Icon component for different tool types
 */
function ToolIcon({ toolName }: { toolName: string }) {
  // Terminal icon for Bash
  if (toolName === "Bash") {
    return (
      <svg
        className="w-4 h-4 text-amber-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
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

  // File icon for Write/Edit
  if (toolName === "Write" || toolName === "Edit") {
    return (
      <svg
        className="w-4 h-4 text-amber-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
        />
      </svg>
    );
  }

  // Default wrench icon
  return (
    <svg
      className="w-4 h-4 text-amber-500"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  );
}
