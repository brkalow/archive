import { useState } from "react";

interface PermissionModalProps {
  tool: string;
  description: string;
  details: {
    command?: string;
    file_path?: string;
    content?: string;
  };
  onAllow: (remember?: boolean) => void;
  onDeny: () => void;
}

export function PermissionModal({
  tool,
  description,
  details,
  onAllow,
  onDeny,
}: PermissionModalProps) {
  const [rememberChoice, setRememberChoice] = useState(false);

  const getToolIcon = () => {
    switch (tool.toLowerCase()) {
      case "bash":
        return (
          <svg
            className="w-6 h-6"
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
      case "write":
      case "edit":
        return (
          <svg
            className="w-6 h-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
            />
          </svg>
        );
      default:
        return (
          <svg
            className="w-6 h-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </svg>
        );
    }
  };

  const getRememberLabel = () => {
    switch (tool.toLowerCase()) {
      case "bash":
        return "Allow all bash commands this session";
      case "write":
      case "edit":
        return "Allow writes to this directory";
      default:
        return "Remember this choice";
    }
  };

  const handleAllow = () => {
    onAllow(rememberChoice);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-secondary border border-bg-elevated rounded-lg w-full max-w-lg mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-bg-elevated">
          <div className="p-2 bg-yellow-900/50 rounded-lg text-yellow-500">
            {getToolIcon()}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              Permission Required
            </h2>
            <p className="text-sm text-text-secondary">{description}</p>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          {/* Bash command display */}
          {tool.toLowerCase() === "bash" && details.command && (
            <div className="mb-4">
              <p className="text-sm text-text-secondary mb-2">
                Claude wants to run a bash command:
              </p>
              <pre className="p-3 bg-bg-tertiary rounded-md text-sm text-text-primary overflow-x-auto font-mono whitespace-pre-wrap break-all">
                {details.command}
              </pre>
            </div>
          )}

          {/* File operation display */}
          {(tool.toLowerCase() === "write" ||
            tool.toLowerCase() === "edit") &&
            details.file_path && (
              <div className="mb-4">
                <p className="text-sm text-text-secondary mb-2">
                  Claude wants to{" "}
                  {tool.toLowerCase() === "write" ? "write to" : "edit"} a file:
                </p>
                <code className="block p-3 bg-bg-tertiary rounded-md text-sm text-accent-primary font-mono break-all">
                  {details.file_path}
                </code>
                {details.content && (
                  <div className="mt-2">
                    <p className="text-sm text-text-secondary mb-1">Preview:</p>
                    <pre className="p-3 bg-bg-tertiary rounded-md text-xs text-text-secondary overflow-x-auto max-h-32 font-mono">
                      {details.content}
                      {details.content.length >= 500 && "..."}
                    </pre>
                  </div>
                )}
              </div>
            )}

          {/* Remember checkbox */}
          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={rememberChoice}
              onChange={(e) => setRememberChoice(e.target.checked)}
              className="rounded border-bg-elevated bg-bg-tertiary text-accent-primary focus:ring-accent-primary"
            />
            {getRememberLabel()}
          </label>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-bg-elevated flex justify-end gap-3">
          <button
            onClick={onDeny}
            className="px-4 py-2 bg-bg-tertiary hover:bg-bg-hover text-text-primary rounded-md transition-colors"
          >
            Deny
          </button>
          <button
            onClick={handleAllow}
            className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white rounded-md transition-colors"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
