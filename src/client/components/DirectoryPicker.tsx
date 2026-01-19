import { useState, useEffect, useRef } from "react";

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

/**
 * Directory selection dropdown with allowed repos and custom path input.
 * Fetches available directories from /api/daemon/repos on mount.
 */
export function DirectoryPicker({ value, onChange, className }: DirectoryPickerProps) {
  const [allowedRepos, setAllowedRepos] = useState<AllowedRepo[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [customPath, setCustomPath] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
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

  const recentRepos = allowedRepos.filter(r => r.recent);
  const otherRepos = allowedRepos.filter(r => !r.recent);

  return (
    <div className={`relative ${className || ""}`} ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-3 py-2 bg-bg-tertiary border border-bg-elevated rounded-md text-left text-text-primary flex items-center justify-between hover:border-bg-hover transition-colors"
      >
        <span className={value ? "text-text-primary" : "text-text-muted"}>
          {value || "Select directory..."}
        </span>
        <svg
          className={`w-4 h-4 text-text-muted transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute z-10 w-full mt-1 bg-bg-tertiary border border-bg-elevated rounded-md shadow-lg max-h-64 overflow-auto">
          {/* Recent repos */}
          {recentRepos.length > 0 && (
            <>
              <div className="px-3 py-1.5 text-xs text-text-muted uppercase tracking-wide border-b border-bg-elevated">
                Recent
              </div>
              {recentRepos.map((repo) => (
                <button
                  key={repo.path}
                  type="button"
                  onClick={() => handleSelect(repo.path)}
                  className="w-full px-3 py-2 text-left text-text-primary hover:bg-bg-hover flex items-center justify-between transition-colors"
                >
                  <span className="truncate font-mono text-sm">{repo.path}</span>
                </button>
              ))}
            </>
          )}

          {/* Other repos */}
          {otherRepos.length > 0 && (
            <>
              {recentRepos.length > 0 && (
                <div className="px-3 py-1.5 text-xs text-text-muted uppercase tracking-wide border-t border-b border-bg-elevated">
                  Other
                </div>
              )}
              {otherRepos.map((repo) => (
                <button
                  key={repo.path}
                  type="button"
                  onClick={() => handleSelect(repo.path)}
                  className="w-full px-3 py-2 text-left text-text-primary hover:bg-bg-hover transition-colors"
                >
                  <span className="truncate font-mono text-sm">{repo.path}</span>
                </button>
              ))}
            </>
          )}

          {/* Separator if there are repos */}
          {allowedRepos.length > 0 && (
            <div className="border-t border-bg-elevated" />
          )}

          {/* Custom path input */}
          <div className="p-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleCustomSubmit())}
                placeholder="Type a custom path..."
                className="flex-1 px-2 py-1.5 bg-bg-secondary border border-bg-elevated rounded text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-primary"
              />
              <button
                type="button"
                onClick={handleCustomSubmit}
                disabled={!customPath.trim()}
                className="px-3 py-1.5 bg-bg-elevated hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed text-text-primary rounded text-sm transition-colors"
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
