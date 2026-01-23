/**
 * HomePage - Activity Feed
 *
 * Ultra-minimal, content-focused activity feed inspired by Linear/Notion.
 * - Full-width single column layout with generous whitespace
 * - Sessions displayed as compact rows for higher information density
 * - Sessions grouped by project/repository with collapsible sections
 * - Inline "New session" prompt at top
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useDaemonStatus } from '../hooks/useDaemonStatus';
import { useClipboard } from '../hooks';
import { stripSystemTags } from '../blocks';
import { StatsSection } from './StatsSection';
import type { Session } from '../../db/schema';

type PermissionMode = 'relay' | 'auto-safe' | 'auto';

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Helper to get the grouping key - prefer repo_url, fall back to project_path
function getGroupKey(session: Session): string {
  // Extract org/repo from repo_url if available
  if (session.repo_url) {
    const match = session.repo_url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    if (match?.[1]) return match[1];
  }
  return session.project_path ?? 'Unknown';
}

interface GroupedSessions {
  [groupKey: string]: {
    sessions: Session[];
    isRepository: boolean;
  };
}

type ViewMode = 'project' | 'timeline';

interface HomePageProps {
  sessions: Session[];
}

export function HomePage({ sessions }: HomePageProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [isNewSessionFocused, setIsNewSessionFocused] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('project');

  // For timeline view, sort all sessions chronologically
  const timelineSessions = useMemo(() => {
    return [...sessions].sort(
      (a, b) =>
        new Date(b.last_activity_at || b.created_at).getTime() -
        new Date(a.last_activity_at || a.created_at).getTime()
    );
  }, [sessions]);

  // Group sessions by repository (preferred) or project path (fallback)
  const groupedSessions = useMemo(() => {
    const groups: GroupedSessions = {};
    sessions.forEach((session) => {
      const key = getGroupKey(session);
      const isRepository = !!session.repo_url;
      if (!groups[key]) {
        groups[key] = { sessions: [], isRepository };
      }
      groups[key].sessions.push(session);
    });

    // Sort sessions within each group by last activity (newest first)
    Object.values(groups).forEach((group) => {
      group.sessions.sort(
        (a, b) =>
          new Date(b.last_activity_at || b.created_at).getTime() -
          new Date(a.last_activity_at || a.created_at).getTime()
      );
    });

    return groups;
  }, [sessions]);

  // Sort groups by most recent activity
  const sortedGroupKeys = useMemo(() => {
    return Object.keys(groupedSessions).sort((a, b) => {
      const aGroup = groupedSessions[a];
      const bGroup = groupedSessions[b];
      if (!aGroup?.sessions[0] || !bGroup?.sessions[0]) return 0;
      const aSession = aGroup.sessions[0];
      const bSession = bGroup.sessions[0];
      const aLatest = new Date(aSession.last_activity_at || aSession.created_at).getTime();
      const bLatest = new Date(bSession.last_activity_at || bSession.created_at).getTime();
      return bLatest - aLatest;
    });
  }, [groupedSessions]);

  const toggleGroup = useCallback((projectPath: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(projectPath)) {
        next.delete(projectPath);
      } else {
        next.add(projectPath);
      }
      return next;
    });
  }, []);

  const isLive = (session: Session): boolean => {
    if (session.status !== 'live') return false;
    const lastActivity = session.last_activity_at
      ? new Date(session.last_activity_at).getTime()
      : new Date(session.created_at).getTime();
    return Date.now() - lastActivity < 5 * 60 * 1000; // 5 minutes
  };

  // Handle "N" keyboard shortcut to focus new session input
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't trigger if user is typing in an input or contenteditable
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setIsNewSessionFocused(true);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="min-h-screen bg-bg-primary">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
        {/* New session prompt */}
        <div className="mb-16">
          <h2 className="text-2xl font-semibold text-text-primary tracking-tight mb-3">Ready to build...</h2>
          <NewSessionPrompt
            isFocused={isNewSessionFocused}
            onFocusChange={setIsNewSessionFocused}
          />
        </div>

        {/* Header */}
        <header className="mb-6">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold text-text-primary tracking-tight">
              Activity
            </h1>

            {/* View mode toggle */}
            <ViewModeToggle value={viewMode} onChange={setViewMode} />
          </div>
        </header>

        {/* Session list - project grouped or timeline view */}
        {sessions.length === 0 ? (
          <EmptyState />
        ) : viewMode === 'project' ? (
          <div className="space-y-6">
            {sortedGroupKeys.map((groupKey) => {
              const group = groupedSessions[groupKey];
              if (!group) return null;
              return (
                <ProjectGroup
                  key={groupKey}
                  groupKey={groupKey}
                  sessions={group.sessions}
                  isRepository={group.isRepository}
                  isCollapsed={collapsedGroups.has(groupKey)}
                  onToggle={() => toggleGroup(groupKey)}
                  isLive={isLive}
                />
              );
            })}
          </div>
        ) : (
          <div className="border-l border-bg-elevated ml-2.5">
            {timelineSessions.map((session, index) => (
              <SessionRow
                key={session.id}
                session={session}
                isLive={isLive(session)}
                isLast={index === timelineSessions.length - 1}
                showProject
              />
            ))}
          </div>
        )}

        {/* Stats section */}
        {sessions.length > 0 && <StatsSection />}

        {/* Keyboard hints footer */}
        <footer className="mt-12 pt-6 border-t border-bg-elevated">
          <div className="flex items-center justify-center gap-6 text-xs text-text-muted">
            <span className="flex items-center gap-1.5">
              <kbd className="px-1.5 py-0.5 bg-bg-secondary border border-bg-elevated rounded text-[10px]">
                N
              </kbd>
              <span>New session</span>
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}

interface ViewModeToggleProps {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
}

function ViewModeToggle({ value, onChange }: ViewModeToggleProps) {
  return (
    <div className="flex items-center bg-bg-secondary rounded-lg p-0.5 border border-bg-elevated">
      <button
        onClick={() => onChange('project')}
        aria-pressed={value === 'project'}
        className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
          value === 'project'
            ? 'bg-bg-tertiary text-text-primary'
            : 'text-text-muted hover:text-text-secondary'
        }`}
      >
        Project
      </button>
      <button
        onClick={() => onChange('timeline')}
        aria-pressed={value === 'timeline'}
        className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
          value === 'timeline'
            ? 'bg-bg-tertiary text-text-primary'
            : 'text-text-muted hover:text-text-secondary'
        }`}
      >
        Timeline
      </button>
    </div>
  );
}

interface AllowedRepo {
  path: string;
  name: string;
  recent?: boolean;
}

// Helper to extract folder name from path
function getFolderName(path: string): string {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

interface DirectoryDropdownProps {
  value: string;
  onChange: (path: string) => void;
  repos: AllowedRepo[];
  disabled?: boolean;
}

function DirectoryDropdown({ value, onChange, repos, disabled }: DirectoryDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const recentRepos = repos.filter(r => r.recent);
  const otherRepos = repos.filter(r => !r.recent);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus input when dropdown opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const handleSelect = (path: string) => {
    onChange(path);
    setIsOpen(false);
    setInputValue('');
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      handleSelect(inputValue.trim());
    }
    if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`
          flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors
          border border-bg-elevated
          ${value
            ? 'bg-bg-tertiary text-text-primary'
            : 'bg-bg-secondary text-text-muted'
          }
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-bg-tertiary hover:border-bg-hover'}
        `}
      >
        <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <span className="max-w-[120px] truncate">
          {value ? getFolderName(value) : 'Select...'}
        </span>
        <svg className={`w-3 h-3 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-1 z-20 w-72 bg-bg-tertiary border border-bg-elevated rounded-lg shadow-xl overflow-hidden">
          {/* Custom path input */}
          <div className="p-2 border-b border-bg-elevated">
            <div className="flex items-center gap-2 px-2 py-1.5 bg-bg-secondary rounded-md border border-bg-elevated focus-within:border-accent-primary/50">
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="/path/to/directory"
                className="flex-1 bg-transparent text-base sm:text-sm text-text-primary placeholder-text-muted outline-none font-mono"
              />
              {inputValue && (
                <span className="text-[10px] text-text-muted px-1 py-0.5 bg-bg-tertiary rounded">
                  Enter
                </span>
              )}
            </div>
          </div>

          {/* Repo list */}
          <div className="max-h-48 overflow-auto">
            {repos.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-text-muted">
                No repositories configured
              </div>
            ) : (
              <>
                {recentRepos.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wide bg-bg-secondary/50">
                      Recent
                    </div>
                    {recentRepos.map((repo) => (
                      <button
                        key={repo.path}
                        type="button"
                        onClick={() => handleSelect(repo.path)}
                        className="w-full px-3 py-2 text-left hover:bg-bg-hover transition-colors flex items-center gap-2"
                        title={repo.path}
                      >
                        <svg className="w-3.5 h-3.5 text-text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                        </svg>
                        <span className="text-sm text-text-primary truncate">{getFolderName(repo.path)}</span>
                      </button>
                    ))}
                  </>
                )}
                {otherRepos.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 text-[10px] text-text-muted uppercase tracking-wide bg-bg-secondary/50 border-t border-bg-elevated">
                      {recentRepos.length > 0 ? 'All Repositories' : 'Repositories'}
                    </div>
                    {otherRepos.map((repo) => (
                      <button
                        key={repo.path}
                        type="button"
                        onClick={() => handleSelect(repo.path)}
                        className="w-full px-3 py-2 text-left hover:bg-bg-hover transition-colors flex items-center gap-2"
                        title={repo.path}
                      >
                        <svg className="w-3.5 h-3.5 text-text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                        </svg>
                        <span className="text-sm text-text-primary truncate">{getFolderName(repo.path)}</span>
                      </button>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface NewSessionPromptProps {
  isFocused: boolean;
  onFocusChange: (focused: boolean) => void;
}

function NewSessionPrompt({ isFocused, onFocusChange }: NewSessionPromptProps) {
  const navigate = useNavigate();
  const [inputValue, setInputValue] = useState('');
  const [cwd, setCwd] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('relay');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowedRepos, setAllowedRepos] = useState<AllowedRepo[]>([]);

  const daemonStatus = useDaemonStatus();
  const { copy, copied } = useClipboard();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isDaemonConnected = daemonStatus.connected && daemonStatus.capabilities?.can_spawn_sessions;

  // Focus input when isFocused becomes true (e.g., from keyboard shortcut)
  useEffect(() => {
    if (isFocused && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isFocused]);

  // Fetch allowed repos on mount when daemon is connected
  useEffect(() => {
    if (isDaemonConnected) {
      fetch('/api/daemon/repos')
        .then(res => res.ok ? res.json() : { repos: [] })
        .then(data => setAllowedRepos(data.repos || []))
        .catch((err) => {
          console.warn('Failed to fetch repos:', err);
          setAllowedRepos([]);
        });
    }
  }, [isDaemonConnected]);

  // Close expanded state when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onFocusChange(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onFocusChange]);

  const handleSubmit = useCallback(async () => {
    if (!inputValue.trim()) {
      setError('Please enter an initial prompt');
      return;
    }
    if (!cwd.trim()) {
      setError('Please select a working directory');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/sessions/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          prompt: inputValue,
          cwd: cwd,
          permission_mode: permissionMode,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start session');
      }

      const data = await res.json();
      navigate(`/sessions/${data.session_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setIsSubmitting(false);
    }
  }, [inputValue, cwd, permissionMode, navigate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && inputValue.trim() && cwd.trim()) {
      e.preventDefault();
      handleSubmit();
    }
  }, [inputValue, cwd, handleSubmit]);

  // Show daemon instructions when not connected
  if (!isDaemonConnected) {
    return (
      <div className="rounded-lg border border-bg-elevated bg-bg-secondary/50">
        <div className="flex items-center gap-3 px-4 py-3">
          {/* Terminal icon */}
          <div className="w-6 h-6 rounded-md bg-bg-tertiary flex items-center justify-center">
            <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>

          <div className="flex-1">
            <p className="text-sm text-text-secondary">
              Start the daemon to create new sessions
            </p>
          </div>

          <button
            onClick={() => copy('openctl daemon start')}
            className="flex items-center gap-2 px-3 py-1.5 bg-bg-tertiary hover:bg-bg-elevated border border-bg-elevated rounded-md text-xs font-mono transition-colors"
          >
            <span className="text-text-muted">$</span>
            <span className="text-text-primary">openctl daemon start</span>
            {copied ? (
              <svg className="w-3.5 h-3.5 text-diff-add" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`
        relative rounded-lg border transition-all duration-200
        ${isFocused
          ? 'bg-bg-secondary border-accent-primary/50 shadow-lg shadow-accent-primary/5'
          : 'bg-bg-secondary/50 border-bg-elevated hover:border-bg-hover hover:bg-bg-secondary'
        }
      `}
    >
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
        {/* Input row */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {/* Plus icon */}
          <div
            className={`
              w-6 h-6 rounded-md flex items-center justify-center transition-colors shrink-0
              ${isFocused ? 'bg-accent-primary/20 text-accent-primary' : 'bg-bg-tertiary text-text-muted'}
            `}
          >
            {isSubmitting ? (
              <div className="w-4 h-4 border-2 border-accent-primary border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            )}
          </div>

          {/* Input - text-base (16px) prevents iOS zoom */}
          <input
            ref={inputRef}
            type="text"
            placeholder="Start a new session..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onFocus={() => onFocusChange(true)}
            onKeyDown={handleKeyDown}
            disabled={isSubmitting}
            className="flex-1 min-w-0 bg-transparent text-base sm:text-sm text-text-primary placeholder:text-text-muted disabled:opacity-50 outline-none"
          />
        </div>

        {/* Action row - directory + button */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Directory dropdown */}
          <DirectoryDropdown
            value={cwd}
            onChange={setCwd}
            repos={allowedRepos}
            disabled={isSubmitting}
          />

          {/* Start button or keyboard hint */}
          {inputValue && cwd ? (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="px-3 py-1 bg-accent-primary text-bg-primary text-xs font-medium rounded-md hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
            >
              {isSubmitting ? 'Starting...' : 'Start'}
            </button>
          ) : (
            <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] text-text-muted bg-bg-tertiary border border-bg-elevated rounded">
              N
            </kbd>
          )}
        </div>
      </div>

      {/* Expanded state - show options with smooth animation */}
      <div
        className={`grid transition-all duration-300 ease-out ${
          isFocused ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <div className="px-4 pb-4 pt-3 border-t border-bg-elevated/50 space-y-3">
          {/* Error message */}
          {error && (
            <div className="p-3 bg-diff-del/20 border border-diff-del/30 rounded-md text-diff-del text-sm">
              {error}
            </div>
          )}

          {/* Advanced options */}
          <div className="flex">
            {/* Arrow column - fixed width */}
            <div className="w-4 flex flex-col items-center">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-text-muted hover:text-text-primary transition-colors h-4 flex items-center justify-center"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              {showAdvanced && (
                <div className="flex-1 w-px bg-bg-elevated mt-2" />
              )}
            </div>

            {/* Content column */}
            <div className="flex-1 pl-2">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-xs text-text-muted hover:text-text-primary transition-colors h-4 flex items-center"
              >
                Advanced options
              </button>

              {showAdvanced && (
                <div className="mt-3 space-y-3">
                  {/* Permission Mode */}
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-2">
                      Permission mode
                    </label>
                    <div className="space-y-2">
                      <label className="flex items-start gap-2 text-sm text-text-secondary cursor-pointer">
                        <input
                          type="radio"
                          name="permissionMode"
                          value="relay"
                          checked={permissionMode === 'relay'}
                          onChange={() => setPermissionMode('relay')}
                          className="mt-0.5 text-accent-primary"
                        />
                        <div>
                          <span className="font-medium text-text-primary text-xs">Ask for each permission</span>
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
                          checked={permissionMode === 'auto-safe'}
                          onChange={() => setPermissionMode('auto-safe')}
                          className="mt-0.5 text-accent-primary"
                        />
                        <div>
                          <span className="font-medium text-text-primary text-xs">Auto-approve safe operations</span>
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
                          checked={permissionMode === 'auto'}
                          onChange={() => setPermissionMode('auto')}
                          className="mt-0.5 text-accent-primary"
                        />
                        <div>
                          <span className="font-medium text-text-primary text-xs">Auto-approve all</span>
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
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ProjectGroupProps {
  groupKey: string;
  sessions: Session[];
  isRepository: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
  isLive: (session: Session) => boolean;
}

function ProjectGroup({
  groupKey,
  sessions,
  isRepository,
  isCollapsed,
  onToggle,
  isLive,
}: ProjectGroupProps) {
  const liveCount = sessions.filter(isLive).length;

  return (
    <div>
      {/* Group header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 py-2 text-left group"
      >
        <svg
          className={`w-3 h-3 text-text-muted transition-transform ${
            isCollapsed ? '' : 'rotate-90'
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        </svg>
        {isRepository ? (
          <span className="flex items-center gap-1.5 text-xs text-text-secondary group-hover:text-text-primary transition-colors">
            <svg className="w-3.5 h-3.5 text-text-muted" fill="currentColor" viewBox="0 0 16 16">
              <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
            </svg>
            <span className="font-medium">{groupKey}</span>
          </span>
        ) : (
          <span className="font-mono text-xs text-text-secondary group-hover:text-text-primary transition-colors">
            {groupKey}
          </span>
        )}
        <span className="text-xs text-text-muted">
          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        </span>
        {liveCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-status-live">
            <span className="w-1.5 h-1.5 rounded-full bg-status-live animate-pulse" />
            {liveCount} live
          </span>
        )}
      </button>

      {/* Session rows */}
      {!isCollapsed && (
        <div className="ml-5 border-l border-bg-elevated">
          {sessions.map((session, index) => (
            <SessionRow
              key={session.id}
              session={session}
              isLive={isLive(session)}
              isLast={index === sessions.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface SessionRowProps {
  session: Session;
  isLive: boolean;
  isLast: boolean;
  showProject?: boolean; // Show project/repo name in timeline view
}

function SessionRow({ session, isLive, isLast, showProject }: SessionRowProps) {
  const projectDisplay = getGroupKey(session);

  return (
    <Link
      to={`/sessions/${encodeURIComponent(session.id)}`}
      className={`flex items-center gap-3 py-2.5 px-4 hover:bg-bg-secondary transition-colors group ${
        !isLast ? 'border-b border-bg-elevated/50' : ''
      }`}
    >
      {/* Status dot */}
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${
          isLive
            ? 'bg-status-live animate-pulse'
            : session.status === 'complete'
            ? 'bg-diff-add'
            : 'bg-text-muted'
        }`}
      />

      {/* Title and optional project */}
      <div className="flex-1 min-w-0">
        <span className="text-sm text-text-primary group-hover:text-accent-primary transition-colors truncate block">
          {stripSystemTags(session.title)}
        </span>
        {showProject && (
          <span className="text-xs text-text-muted truncate block mt-0.5">
            {session.repo_url ? (
              <span className="flex items-center gap-1">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
                  <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
                </svg>
                {projectDisplay}
              </span>
            ) : (
              <span className="font-mono">{projectDisplay}</span>
            )}
          </span>
        )}
      </div>

      {/* PR indicator */}
      {session.pr_url && <PrIndicator prUrl={session.pr_url} />}

      {/* Session type badges */}
      {session.remote && (
        <span className="shrink-0 px-1.5 py-0.5 bg-purple-900/50 text-purple-300 text-[10px] font-medium rounded">
          Remote
        </span>
      )}
      {session.interactive && !session.remote && (
        <span className="shrink-0 px-1.5 py-0.5 bg-accent-secondary/20 text-accent-secondary text-[10px] font-medium rounded">
          Interactive
        </span>
      )}

      {/* Relative time */}
      <span className="text-xs text-text-muted shrink-0">
        {formatRelativeTime(session.last_activity_at || session.created_at)}
      </span>
    </Link>
  );
}

interface PrIndicatorProps {
  prUrl: string;
}

function PrIndicator({ prUrl }: PrIndicatorProps) {
  // Extract PR number from URL
  const prMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prMatch ? prMatch[1] : null;

  return (
    <span
      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-diff-add/15 text-diff-add"
      title={`PR ${prNumber ? `#${prNumber}` : ''}`}
    >
      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16">
        <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
      </svg>
      {prNumber && <span>#{prNumber}</span>}
    </span>
  );
}

function EmptyState() {
  const daemonStatus = useDaemonStatus();
  const { copy, copied } = useClipboard();

  return (
    <div className="py-16 text-center">
      <div className="w-12 h-12 mx-auto mb-4 rounded-md bg-bg-secondary flex items-center justify-center">
        <svg
          className="w-6 h-6 text-text-muted"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
      </div>
      <h2 className="text-base font-medium text-text-secondary mb-2">No sessions yet</h2>
      {daemonStatus.connected ? (
        <p className="text-sm text-text-muted max-w-xs mx-auto">
          Start a new session above to begin tracking your Claude Code conversations.
        </p>
      ) : (
        <div className="text-sm text-text-muted max-w-md mx-auto">
          <p className="mb-4">
            Start the daemon to stream and create sessions.
          </p>
          <button
            onClick={() => copy('openctl daemon start')}
            className="inline-flex items-center gap-2 px-4 py-2 bg-bg-secondary border border-bg-elevated rounded-md font-mono text-sm"
          >
            <span className="text-text-muted">$</span>
            <code className="text-text-primary">openctl daemon start</code>
            {copied ? (
              <svg className="w-4 h-4 text-diff-add" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-text-muted hover:text-text-primary transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
