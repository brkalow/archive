import { useCallback } from 'react';
import { useClipboard } from '../hooks';

export function GettingStartedPage() {
  const { copy } = useClipboard();

  const handleCopyInstall = useCallback(() => {
    copy('curl -fsSL https://openctl.dev/setup/install.sh | bash');
  }, [copy]);

  return (
    <div className="min-h-[calc(100vh-3.5rem)] flex flex-col items-center justify-start pt-16 pb-24 px-6">
      {/* Hero: Two column layout */}
      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-8 items-center mb-20">
        {/* Left: Animated brackets */}
        <div className="flex items-center justify-center font-mono text-[clamp(6rem,15vw,12rem)] font-light text-white/20">
          <div className="flex items-center justify-center animate-brackets">
            <span className="inline-block">[</span>
            <span className="inline-block w-[0.08em] animate-gap-pulse" />
            <span className="inline-block">]</span>
          </div>
        </div>

        {/* Right: Logo + description */}
        <div className="flex flex-col items-center md:items-start">
          <h1 className="text-3xl font-mono font-medium text-text-primary hover:text-accent-primary transition-colors mb-4">
            <span className="text-[18px] inline-flex gap-[3px] -translate-y-[2.5px]">
              <span>[</span>
              <span>]</span>
            </span>
            penctl
          </h1>
          <p className="text-text-secondary text-center md:text-left font-mono text-sm leading-relaxed">
            Share, collaborate, and review your agent sessions.
          </p>
        </div>
      </div>

      {/* Install command */}
      <div className="flex items-center gap-3 px-6 py-4 border border-bg-elevated rounded bg-bg-secondary/50 backdrop-blur mb-20 max-w-xl w-full">
        <span className="text-text-muted font-mono">$</span>
        <code className="flex-1 min-w-0 overflow-x-auto font-mono text-text-primary text-sm">
          curl -fsSL https://openctl.dev/setup/install.sh | bash
        </code>
        <button
          onClick={handleCopyInstall}
          className="text-text-muted hover:text-text-primary transition-colors"
          title="Copy to clipboard"
        >
          <CopyIcon />
        </button>
      </div>

      {/* Commands section */}
      <div className="w-full max-w-xl">
        <div className="text-xs uppercase tracking-[0.2em] text-text-muted text-center mb-6 font-mono">
          Commands
        </div>
        <div className="border border-bg-elevated rounded bg-bg-secondary/30 backdrop-blur divide-y divide-bg-elevated font-mono text-sm">
          <div className="flex items-center justify-between px-5 py-3">
            <span>
              <span className="text-text-primary">openctl</span>{' '}
              <span className="text-accent-primary">upload</span>
            </span>
            <span className="text-text-muted">upload a session</span>
          </div>
          <div className="flex items-center justify-between px-5 py-3">
            <span>
              <span className="text-text-primary">openctl</span>{' '}
              <span className="text-accent-primary">daemon start</span>
            </span>
            <span className="text-text-muted">live stream sessions</span>
          </div>
          <div className="flex items-center justify-between px-5 py-3">
            <span>
              <span className="text-text-primary">openctl</span>{' '}
              <span className="text-accent-primary">list</span>
            </span>
            <span className="text-text-muted">view all sessions</span>
          </div>
        </div>
      </div>

      {/* Browse link */}
      <a
        href="/sessions"
        className="mt-16 text-accent-primary hover:text-accent-primary/80 transition-colors font-mono text-sm flex items-center gap-2"
      >
        <span>browse sessions</span>
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 8l4 4m0 0l-4 4m4-4H3" />
        </svg>
      </a>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
      />
    </svg>
  );
}
