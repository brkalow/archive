# Phase 4: Browser UI - Session Initiation

> **Spec reference:** [specs/browser_initiated_sessions.md](../specs/browser_initiated_sessions.md)

## Overview

This plan implements the browser UI for initiating new sessions: the daemon status indicator in the header, the "New Session" button, and the session creation modal with startup progress.

## Dependencies

- **Phase 1:** Daemon WebSocket Infrastructure (daemon status API)
- **Phase 2:** Session Spawning Core
- **Phase 3:** Server Relay Layer (spawn API endpoint)

## Tasks

### 1. Create Daemon Status Hook

React hook to track daemon connection status.

**File:** `src/client/hooks/useDaemonStatus.ts`

```typescript
import { useState, useEffect, useCallback } from "react";

export interface DaemonStatus {
  connected: boolean;
  clientId?: string;
  capabilities?: {
    can_spawn_sessions: boolean;
    spawnable_harnesses: Array<{
      id: string;
      name: string;
      available: boolean;
      supports_permission_relay: boolean;
      supports_streaming: boolean;
      default_model?: string;
    }>;
  };
}

export function useDaemonStatus(pollInterval = 5000): DaemonStatus {
  const [status, setStatus] = useState<DaemonStatus>({ connected: false });

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/daemon/status");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      } else {
        setStatus({ connected: false });
      }
    } catch {
      setStatus({ connected: false });
    }
  }, []);

  useEffect(() => {
    fetchStatus();

    const interval = setInterval(fetchStatus, pollInterval);
    return () => clearInterval(interval);
  }, [fetchStatus, pollInterval]);

  return status;
}
```

### 2. Create DaemonStatusIndicator Component

Shows connection status in the header.

**File:** `src/client/components/DaemonStatusIndicator.tsx`

```typescript
import { useDaemonStatus } from "../hooks/useDaemonStatus";

interface DaemonStatusIndicatorProps {
  className?: string;
}

export function DaemonStatusIndicator({ className }: DaemonStatusIndicatorProps) {
  const status = useDaemonStatus();

  if (!status.connected) {
    return null; // Don't show anything when disconnected
  }

  const deviceName = status.clientId || "Unknown device";
  const truncatedName = deviceName.length > 20
    ? deviceName.slice(0, 20) + "..."
    : deviceName;

  return (
    <div
      className={`flex items-center gap-1.5 text-sm text-green-400 ${className || ""}`}
      title={`Connected to daemon on ${deviceName}`}
    >
      <span className="text-gray-500">@</span>
      <span>{truncatedName}</span>
    </div>
  );
}
```

### 3. Add DaemonStatusIndicator to Header

Integrate the indicator into the site header.

**Note:** The existing codebase uses `src/views/layout.ts` for server-rendered layouts. For client-side React, we need to create a new Header component or integrate into the existing client-side routing system in `src/client/views.ts`.

**File:** `src/client/components/Header.tsx` (create new)

```typescript
import { DaemonStatusIndicator } from "./DaemonStatusIndicator";

interface HeaderProps {
  currentPath?: string;
}

export function Header({ currentPath }: HeaderProps) {
  return (
    <header className="border-b border-gray-800 bg-gray-900">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a href="/" className="text-xl font-semibold text-white">
            openctl
          </a>
        </div>

        <div className="flex items-center gap-4">
          <DaemonStatusIndicator />
          <a
            href="/sessions"
            className={`text-sm ${currentPath === "/sessions" ? "text-white" : "text-gray-400 hover:text-white"}`}
          >
            Sessions
          </a>
        </div>
      </div>
    </header>
  );
}
```

**Integration note:** Update `src/client/views.ts` to use this new Header component in client-side rendered pages.

### 4. Create NewSessionButton Component

Button that appears when daemon is connected.

**File:** `src/client/components/NewSessionButton.tsx`

```typescript
import { useState } from "react";
import { useDaemonStatus } from "../hooks/useDaemonStatus";
import { NewSessionModal } from "./NewSessionModal";

interface NewSessionButtonProps {
  className?: string;
}

export function NewSessionButton({ className }: NewSessionButtonProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const status = useDaemonStatus();

  if (!status.connected || !status.capabilities?.can_spawn_sessions) {
    return null;
  }

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        className={`
          inline-flex items-center gap-2 px-4 py-2
          bg-cyan-600 hover:bg-cyan-500 text-white
          rounded-md font-medium text-sm
          transition-colors
          ${className || ""}
        `}
      >
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
            d="M12 4v16m8-8H4"
          />
        </svg>
        New Session
      </button>

      {isModalOpen && (
        <NewSessionModal
          daemonStatus={status}
          onClose={() => setIsModalOpen(false)}
        />
      )}
    </>
  );
}
```

### 5. Create NewSessionModal Component

Modal for configuring and starting a new session.

**File:** `src/client/components/NewSessionModal.tsx`

```typescript
import { useState, useCallback } from "react";
import type { DaemonStatus } from "../hooks/useDaemonStatus";

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
  // Note: "relay" = ask for each, "auto-safe" = auto-approve reads, "auto" = auto-approve all
}

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
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape" && state === "form") {
      onClose();
    }
  }, [onClose, state]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => e.target === e.currentTarget && state === "form" && onClose()}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-white">
            {state === "starting" ? "Starting Session..." : "New Session"}
          </h2>
          {state === "form" && (
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white"
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
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Working Directory
                </label>
                <input
                  type="text"
                  value={formData.cwd}
                  onChange={(e) => setFormData({ ...formData, cwd: e.target.value })}
                  placeholder="/Users/me/myproject"
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
              </div>

              {/* Initial Prompt */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Initial Prompt
                </label>
                <textarea
                  value={formData.prompt}
                  onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
                  placeholder="Help me implement..."
                  rows={4}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"
                />
              </div>

              {/* Advanced Options Toggle */}
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 text-sm text-gray-400 hover:text-white"
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
                <div className="space-y-4 pl-4 border-l border-gray-800">
                  {/* Agent Selection */}
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">
                      Agent
                    </label>
                    <select
                      value={formData.harness}
                      onChange={(e) => setFormData({ ...formData, harness: e.target.value })}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
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
                    <label className="block text-sm font-medium text-gray-300 mb-1">
                      Model (optional)
                    </label>
                    <input
                      type="text"
                      value={formData.model}
                      onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                      placeholder="claude-sonnet-4-20250514"
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    />
                  </div>

                  {/* Permission Mode */}
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Permission mode
                    </label>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-sm text-gray-300">
                        <input
                          type="radio"
                          name="permissionMode"
                          value="relay"
                          checked={formData.permissionMode === "relay"}
                          onChange={() => setFormData({ ...formData, permissionMode: "relay" })}
                          className="text-cyan-500"
                        />
                        Ask for each permission
                      </label>
                      <label className="flex items-center gap-2 text-sm text-gray-300">
                        <input
                          type="radio"
                          name="permissionMode"
                          value="auto"
                          checked={formData.permissionMode === "auto"}
                          onChange={() => setFormData({ ...formData, permissionMode: "auto" })}
                          className="text-cyan-500"
                        />
                        Auto-approve all (trust this session)
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* Error message */}
              {error && (
                <div className="p-3 bg-red-900/50 border border-red-700 rounded-md text-red-300 text-sm">
                  {error}
                </div>
              )}

              {/* Footer */}
              <div className="flex justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-gray-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-md font-medium"
                >
                  Start Session
                </button>
              </div>
            </form>
          )}

          {state === "starting" && (
            <div className="py-8 text-center">
              <div className="mb-4">
                <div className="inline-block w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
              </div>
              <p className="text-gray-300">{startupStep}</p>
            </div>
          )}

          {state === "error" && (
            <div className="py-4">
              <div className="p-4 bg-red-900/50 border border-red-700 rounded-md mb-4">
                <h3 className="font-medium text-red-300 mb-1">Failed to Start Session</h3>
                <p className="text-red-400 text-sm">{error}</p>
              </div>
              <div className="flex justify-end gap-3">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-gray-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setState("form");
                    setError(null);
                  }}
                  className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-md font-medium"
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
```

### 6. Update NewSessionModal to use DirectoryPicker

Once DirectoryPicker is created (Task 7), update NewSessionModal to use it.

**File:** `src/client/components/NewSessionModal.tsx` (modify)

```typescript
// Replace the plain input with DirectoryPicker:
import { DirectoryPicker } from "./DirectoryPicker";

// In the form, replace the input field for cwd with:
<DirectoryPicker
  value={formData.cwd}
  onChange={(cwd) => setFormData({ ...formData, cwd })}
/>
```

### 7. Update Session List Page

Add NewSessionButton and empty state guidance.

**Note:** The existing codebase has `src/client/components/SessionListPage.tsx`, not `src/client/pages/SessionListPage.tsx`.

**File:** `src/client/components/SessionListPage.tsx` (modify existing)

```typescript
import { NewSessionButton } from "../components/NewSessionButton";
import { useDaemonStatus } from "../hooks/useDaemonStatus";

export function SessionListPage() {
  const status = useDaemonStatus();
  // ... existing session list state

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-white">Sessions</h1>
        <div className="flex items-center gap-4">
          <NewSessionButton />
          {/* Search input */}
          <input
            type="text"
            placeholder="Search..."
            className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-white"
          />
        </div>
      </div>

      {/* Session list or empty state */}
      {sessions.length === 0 ? (
        <EmptyState daemonConnected={status.connected} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sessions.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ daemonConnected }: { daemonConnected: boolean }) {
  return (
    <div className="border border-gray-800 rounded-lg p-8 text-center">
      <h3 className="text-lg font-medium text-gray-300 mb-2">
        No active sessions
      </h3>

      {daemonConnected ? (
        <p className="text-gray-500 mb-4">
          Your daemon is connected. Start a new session from here.
        </p>
      ) : (
        <div className="text-gray-500">
          <p className="mb-4">
            Start the daemon to stream and create sessions from here.
          </p>
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-gray-800 rounded-md font-mono text-sm">
            <code>$ openctl daemon start</code>
            <button
              onClick={() => navigator.clipboard.writeText("openctl daemon start")}
              className="text-gray-400 hover:text-white"
              title="Copy"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

### 8. Add Directory Picker Dropdown

Enhanced directory selection with allowed repos.

**File:** `src/client/components/DirectoryPicker.tsx`

```typescript
import { useState, useEffect } from "react";

interface DirectoryPickerProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

interface AllowedRepo {
  path: string;
  name: string;
  recent?: boolean;
}

export function DirectoryPicker({ value, onChange, className }: DirectoryPickerProps) {
  const [allowedRepos, setAllowedRepos] = useState<AllowedRepo[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [customPath, setCustomPath] = useState("");

  // Fetch allowed repos on mount
  useEffect(() => {
    async function fetchRepos() {
      try {
        const res = await fetch("/api/daemon/repos");
        if (res.ok) {
          const data = await res.json();
          setAllowedRepos(data.repos || []);
        }
      } catch {
        // Ignore errors, user can type custom path
      }
    }
    fetchRepos();
  }, []);

  const handleSelect = (path: string) => {
    onChange(path);
    setIsOpen(false);
  };

  const handleCustomSubmit = () => {
    if (customPath.trim()) {
      onChange(customPath.trim());
      setIsOpen(false);
      setCustomPath("");
    }
  };

  return (
    <div className={`relative ${className || ""}`}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-md text-left text-white flex items-center justify-between"
      >
        <span className={value ? "text-white" : "text-gray-500"}>
          {value || "Select directory..."}
        </span>
        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute z-10 w-full mt-1 bg-gray-800 border border-gray-700 rounded-md shadow-lg max-h-64 overflow-auto">
          {/* Allowed repos */}
          {allowedRepos.length > 0 && (
            <>
              {allowedRepos.filter(r => r.recent).map((repo) => (
                <button
                  key={repo.path}
                  type="button"
                  onClick={() => handleSelect(repo.path)}
                  className="w-full px-3 py-2 text-left text-white hover:bg-gray-700 flex items-center justify-between"
                >
                  <span>{repo.path}</span>
                  <span className="text-xs text-gray-500">recent</span>
                </button>
              ))}

              {allowedRepos.filter(r => r.recent).length > 0 && (
                <div className="border-t border-gray-700" />
              )}

              {allowedRepos.filter(r => !r.recent).map((repo) => (
                <button
                  key={repo.path}
                  type="button"
                  onClick={() => handleSelect(repo.path)}
                  className="w-full px-3 py-2 text-left text-white hover:bg-gray-700"
                >
                  {repo.path}
                </button>
              ))}

              <div className="border-t border-gray-700" />
            </>
          )}

          {/* Custom path input */}
          <div className="p-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCustomSubmit()}
                placeholder="Type a custom path..."
                className="flex-1 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white text-sm placeholder-gray-500"
              />
              <button
                type="button"
                onClick={handleCustomSubmit}
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm"
              >
                Use
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

### 9. Add Allowed Repos API Endpoint

Server endpoint to list allowed directories.

**File:** `src/routes/api.ts` (add)

```typescript
// GET /api/daemon/repos
// Returns list of allowed repositories for spawning sessions
getDaemonRepos(): Response {
  // For v1, this could be:
  // 1. Hard-coded list from config
  // 2. Fetched from connected daemon
  // 3. User's configured repo allowlist

  // Placeholder implementation - would be enhanced based on auth/config
  const repos = [
    // Could be populated from daemon capabilities or user settings
  ];

  return json({ repos });
}
```

## Testing

### Component Tests

**File:** `tests/client/NewSessionModal.test.tsx`

```typescript
import { render, screen, fireEvent } from "@testing-library/react";
import { NewSessionModal } from "../../src/client/components/NewSessionModal";

describe("NewSessionModal", () => {
  const mockDaemonStatus = {
    connected: true,
    clientId: "test-daemon",
    capabilities: {
      can_spawn_sessions: true,
      spawnable_harnesses: [
        {
          id: "claude-code",
          name: "Claude Code",
          available: true,
          supports_permission_relay: true,
          supports_streaming: true,
        },
      ],
    },
  };

  test("renders form fields", () => {
    render(<NewSessionModal daemonStatus={mockDaemonStatus} onClose={() => {}} />);

    expect(screen.getByLabelText(/working directory/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/initial prompt/i)).toBeInTheDocument();
    expect(screen.getByText(/start session/i)).toBeInTheDocument();
  });

  test("validates required fields", async () => {
    render(<NewSessionModal daemonStatus={mockDaemonStatus} onClose={() => {}} />);

    const submitButton = screen.getByText(/start session/i);
    fireEvent.click(submitButton);

    expect(await screen.findByText(/please enter an initial prompt/i)).toBeInTheDocument();
  });

  test("shows advanced options when toggled", () => {
    render(<NewSessionModal daemonStatus={mockDaemonStatus} onClose={() => {}} />);

    const advancedToggle = screen.getByText(/advanced options/i);
    fireEvent.click(advancedToggle);

    expect(screen.getByLabelText(/agent/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
  });
});
```

### Integration Tests

**File:** `tests/client/session-initiation.test.tsx`

```typescript
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionListPage } from "../../src/client/pages/SessionListPage";

// Mock fetch
global.fetch = jest.fn();

describe("Session Initiation Flow", () => {
  beforeEach(() => {
    (fetch as jest.Mock).mockReset();
  });

  test("shows New Session button when daemon connected", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ connected: true, client_id: "test", capabilities: { can_spawn_sessions: true, spawnable_harnesses: [] } }),
    });

    render(<SessionListPage />);

    await waitFor(() => {
      expect(screen.getByText(/new session/i)).toBeInTheDocument();
    });
  });

  test("hides New Session button when daemon disconnected", async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ connected: false }),
    });

    render(<SessionListPage />);

    await waitFor(() => {
      expect(screen.queryByText(/new session/i)).not.toBeInTheDocument();
    });
  });
});
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/client/hooks/useDaemonStatus.ts` | Create | Hook for daemon status polling |
| `src/client/components/DaemonStatusIndicator.tsx` | Create | Header daemon status display |
| `src/client/components/NewSessionButton.tsx` | Create | New session CTA button |
| `src/client/components/NewSessionModal.tsx` | Create | Session configuration modal |
| `src/client/components/DirectoryPicker.tsx` | Create | Directory selection dropdown |
| `src/client/components/Header.tsx` | Modify | Add daemon status indicator |
| `src/client/pages/SessionListPage.tsx` | Modify | Add new session button and empty state |
| `src/routes/api.ts` | Modify | Add repos endpoint |
| `tests/client/NewSessionModal.test.tsx` | Create | Component tests |
| `tests/client/session-initiation.test.tsx` | Create | Integration tests |

## Acceptance Criteria

- [ ] Daemon status indicator shows in header when connected
- [ ] Indicator is hidden when daemon is disconnected
- [ ] "New Session" button appears when daemon connected and can spawn
- [ ] "New Session" button is hidden when daemon disconnected
- [ ] Modal opens on button click
- [ ] Modal has fields for directory and prompt
- [ ] Advanced options are collapsed by default
- [ ] Advanced options include agent, model, and permission mode
- [ ] Form validates required fields
- [ ] Submit shows progress spinner
- [ ] Successful spawn redirects to session page
- [ ] Errors are displayed in modal
- [ ] Modal can be closed with X button or Escape key
- [ ] Empty state shows when no sessions and provides guidance
- [ ] All tests pass
