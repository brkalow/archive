import { useState, useCallback, useEffect } from "react";
import type { DaemonStatus } from "../hooks/useDaemonStatus";
import { DirectoryPicker } from "./DirectoryPicker";

interface NewSessionModalProps {
  daemonStatus: DaemonStatus;
  onClose: () => void;
}

type ModalState = "form" | "starting" | "error";

interface FormData {
  prompt: string;
  cwd: string;
  harness: string;
  model: string;
  permissionMode: "relay" | "auto-safe" | "auto";
}

/**
 * Modal for configuring and starting a new session.
 * Includes fields for working directory, prompt, and advanced options.
 */
export function NewSessionModal({ daemonStatus, onClose }: NewSessionModalProps) {
  const [state, setState] = useState<ModalState>("form");
  const [error, setError] = useState<string | null>(null);
  const [startupStep, setStartupStep] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const harnesses = daemonStatus.capabilities?.spawnable_harnesses || [];
  const defaultHarness = harnesses.find((h) => h.available)?.id || "claude-code";

  const [formData, setFormData] = useState<FormData>({
    prompt: "",
    cwd: "",
    harness: defaultHarness,
    model: "",
    permissionMode: "relay",
  });

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.prompt.trim()) {
      setError("Please enter an initial prompt");
      return;
    }

    if (!formData.cwd.trim()) {
      setError("Please select a working directory");
      return;
    }

    setState("starting");
    setStartupStep("Connecting to daemon...");
    setError(null);

    try {
      const res = await fetch("/api/sessions/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: formData.prompt,
          cwd: formData.cwd,
          harness: formData.harness,
          model: formData.model || undefined,
          permission_mode: formData.permissionMode,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to start session");
      }

      setStartupStep("Spawning Claude Code...");

      const data = await res.json();

      // Redirect to session page
      setStartupStep("Redirecting...");
      window.location.href = `/sessions/${data.session_id}`;
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [formData]);

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state === "form") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, state]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => e.target === e.currentTarget && state === "form" && onClose()}
    >
      <div className="bg-bg-secondary border border-bg-elevated rounded-lg w-full max-w-lg mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-bg-elevated">
          <h2 className="text-lg font-semibold text-text-primary">
            {state === "starting" ? "Starting Session..." : "New Session"}
          </h2>
          {state === "form" && (
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text-primary transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          {state === "form" && (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Working Directory */}
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">
                  Working Directory
                </label>
                <DirectoryPicker
                  value={formData.cwd}
                  onChange={(cwd) => setFormData({ ...formData, cwd })}
                />
              </div>

              {/* Initial Prompt */}
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">
                  Initial Prompt
                </label>
                <textarea
                  value={formData.prompt}
                  onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
                  placeholder="Help me implement..."
                  rows={4}
                  className="w-full px-3 py-2 bg-bg-tertiary border border-bg-elevated rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary resize-none"
                />
              </div>

              {/* Advanced Options Toggle */}
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 text-sm text-text-muted hover:text-text-primary transition-colors"
              >
                <svg
                  className={`w-4 h-4 transition-transform ${showAdvanced ? "rotate-90" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                Advanced options
              </button>

              {showAdvanced && (
                <div className="space-y-4 pl-4 border-l border-bg-elevated">
                  {/* Agent Selection */}
                  <div>
                    <label className="block text-sm font-medium text-text-secondary mb-1">
                      Agent
                    </label>
                    <select
                      value={formData.harness}
                      onChange={(e) => setFormData({ ...formData, harness: e.target.value })}
                      className="w-full px-3 py-2 bg-bg-tertiary border border-bg-elevated rounded-md text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary"
                    >
                      {harnesses.map((h) => (
                        <option key={h.id} value={h.id} disabled={!h.available}>
                          {h.name} {!h.available && "(not available)"}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Model */}
                  <div>
                    <label className="block text-sm font-medium text-text-secondary mb-1">
                      Model (optional)
                    </label>
                    <input
                      type="text"
                      value={formData.model}
                      onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                      placeholder="claude-sonnet-4-20250514"
                      className="w-full px-3 py-2 bg-bg-tertiary border border-bg-elevated rounded-md text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary"
                    />
                  </div>

                  {/* Permission Mode */}
                  <div>
                    <label className="block text-sm font-medium text-text-secondary mb-2">
                      Permission mode
                    </label>
                    <div className="space-y-2">
                      <label className="flex items-start gap-2 text-sm text-text-secondary cursor-pointer">
                        <input
                          type="radio"
                          name="permissionMode"
                          value="relay"
                          checked={formData.permissionMode === "relay"}
                          onChange={() => setFormData({ ...formData, permissionMode: "relay" })}
                          className="mt-1 text-accent-primary"
                        />
                        <div>
                          <span className="font-medium text-text-primary">Ask for each permission</span>
                          <p className="text-text-muted text-xs mt-0.5">
                            Most secure. You'll approve each file write and bash command.
                          </p>
                        </div>
                      </label>
                      <label className="flex items-start gap-2 text-sm text-text-secondary cursor-pointer">
                        <input
                          type="radio"
                          name="permissionMode"
                          value="auto-safe"
                          checked={formData.permissionMode === "auto-safe"}
                          onChange={() => setFormData({ ...formData, permissionMode: "auto-safe" })}
                          className="mt-1 text-accent-primary"
                        />
                        <div>
                          <span className="font-medium text-text-primary">Auto-approve safe operations</span>
                          <p className="text-text-muted text-xs mt-0.5">
                            Auto-approve file reads. Ask for writes and bash commands.
                          </p>
                        </div>
                      </label>
                      <label className="flex items-start gap-2 text-sm text-text-secondary cursor-pointer">
                        <input
                          type="radio"
                          name="permissionMode"
                          value="auto"
                          checked={formData.permissionMode === "auto"}
                          onChange={() => setFormData({ ...formData, permissionMode: "auto" })}
                          className="mt-1 text-accent-primary"
                        />
                        <div>
                          <span className="font-medium text-text-primary">Auto-approve all</span>
                          <p className="text-text-muted text-xs mt-0.5">
                            Trust this session fully. No permission prompts.
                          </p>
                          <p className="text-yellow-500 text-xs">
                            Not recommended for untrusted prompts
                          </p>
                        </div>
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* Error message */}
              {error && (
                <div className="p-3 bg-diff-del/20 border border-diff-del/30 rounded-md text-diff-del text-sm">
                  {error}
                </div>
              )}

              {/* Footer */}
              <div className="flex justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-text-muted hover:text-text-primary transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/90 text-bg-primary rounded-md font-medium transition-colors"
                >
                  Start Session
                </button>
              </div>
            </form>
          )}

          {state === "starting" && (
            <div className="py-8 text-center">
              <div className="mb-4">
                <div className="inline-block w-8 h-8 border-2 border-accent-primary border-t-transparent rounded-full animate-spin" />
              </div>
              <p className="text-text-secondary">{startupStep}</p>
            </div>
          )}

          {state === "error" && (
            <div className="py-4">
              <div className="p-4 bg-diff-del/20 border border-diff-del/30 rounded-md mb-4">
                <h3 className="font-medium text-diff-del mb-1">Failed to Start Session</h3>
                <p className="text-diff-del/80 text-sm">{error}</p>
              </div>
              <div className="flex justify-end gap-3">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-text-muted hover:text-text-primary transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setState("form");
                    setError(null);
                  }}
                  className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/90 text-bg-primary rounded-md font-medium transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
