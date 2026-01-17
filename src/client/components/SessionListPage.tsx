import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { stripSystemTags } from '../blocks';
import type { Session } from '../../db/schema';

interface SessionListPageProps {
  sessions: Session[];
}

export function SessionListPage({ sessions }: SessionListPageProps) {
  const [searchQuery, setSearchQuery] = useState('');

  // Derive filtered sessions from search query (Vercel: rerender-derived-state)
  const filteredSessions = useMemo(() => {
    const q = searchQuery.toLowerCase();
    if (!q) return sessions;

    return sessions.filter((session) => {
      const title = (session.title || '').toLowerCase();
      const description = (session.description || '').toLowerCase();
      const project = (session.project_path || '').toLowerCase();
      return title.includes(q) || description.includes(q) || project.includes(q);
    });
  }, [sessions, searchQuery]);

  const isRecentlyActive = (session: Session, thresholdMs = 5 * 60 * 1000): boolean => {
    if (!session.last_activity_at) return false;
    const lastActivity = new Date(session.last_activity_at).getTime();
    return Date.now() - lastActivity < thresholdMs;
  };

  return (
    <div className="session-list-page max-w-[1400px] mx-auto px-6 lg:px-10 py-8">
      <div className="flex items-center justify-between gap-6 mb-8">
        <h1 className="text-xl font-semibold text-text-primary tracking-tight">Sessions</h1>
        <div className="w-full max-w-sm">
          <input
            type="search"
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-bg-secondary border border-bg-elevated rounded-md px-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline focus:outline-2 focus:outline-accent-primary focus:outline-offset-2 transition-all"
          />
        </div>
      </div>

      {sessions.length === 0 ? (
        <EmptyState />
      ) : filteredSessions.length === 0 ? (
        <NoResults />
      ) : (
        <div className="sessions-grid grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredSessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              isLive={session.status === 'live' && isRecentlyActive(session)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-16 h-16 mb-4 rounded-md bg-bg-secondary flex items-center justify-center">
        <svg className="w-8 h-8 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
      </div>
      <h2 className="text-lg font-medium text-text-secondary mb-2">No sessions yet</h2>
      <p className="text-sm text-text-muted max-w-sm">
        Sessions can be uploaded via the API at{' '}
        <code className="bg-bg-tertiary px-1.5 py-0.5 rounded text-accent-primary">POST /api/sessions</code>
      </p>
    </div>
  );
}

function NoResults() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <p className="text-sm text-text-muted">No sessions match your search</p>
    </div>
  );
}

interface SessionCardProps {
  session: Session;
  isLive: boolean;
}

function SessionCard({ session, isLive }: SessionCardProps) {
  const date = new Date(session.created_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <Link
      to={`/sessions/${encodeURIComponent(session.id)}`}
      className={`session-card block bg-bg-secondary border border-bg-elevated rounded-md p-4 hover:bg-bg-tertiary hover:border-bg-hover transition-colors group ${isLive ? 'border-l-2 border-l-green-500' : ''}`}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="text-sm font-medium text-text-primary group-hover:text-accent-primary transition-colors line-clamp-2">
          {stripSystemTags(session.title)}
        </h3>
        <div className="flex items-center gap-1.5 shrink-0">
          {isLive && <LiveBadge />}
          {session.interactive && <InteractiveBadge />}
          {session.pr_url && <PrBadge />}
        </div>
      </div>
      {session.description && (
        <p className="text-sm text-text-secondary mb-2 line-clamp-2">{session.description}</p>
      )}
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span>{date}</span>
        {session.project_path && (
          <span className="truncate font-mono text-[11px]">{session.project_path}</span>
        )}
      </div>
    </Link>
  );
}

function LiveBadge() {
  return (
    <span className="px-1.5 py-0.5 bg-green-500/20 text-green-400 text-xs font-medium rounded flex items-center gap-1">
      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
      LIVE
    </span>
  );
}

function InteractiveBadge() {
  return (
    <span className="shrink-0 px-1.5 py-0.5 bg-accent-secondary/20 text-accent-secondary text-xs font-medium rounded flex items-center gap-1">
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
        />
      </svg>
      Interactive
    </span>
  );
}

function PrBadge() {
  return (
    <span className="px-1.5 py-0.5 bg-accent-primary/10 text-accent-primary text-xs font-medium rounded">
      PR
    </span>
  );
}
