import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useParams } from 'react-router-dom';
import { GettingStartedPage } from './components/GettingStartedPage';
import { SessionListPage } from './components/SessionListPage';
import { SessionDetailPage } from './components/SessionDetailPage';
import { UserMenu } from './components/UserMenu';
import { ProtectedRoute } from './components/ProtectedRoute';
import { SpawnedSessionView } from './components/SpawnedSessionView';
import { renderComponentsShowcase } from './views';
import type { Session, Message, Diff, Review, Annotation } from '../db/schema';

// API types
interface ReviewWithCount extends Review {
  annotation_count: number;
}

interface SessionDetailData {
  session: Session;
  messages: Message[];
  diffs: Diff[];
  shareUrl: string | null;
  review?: ReviewWithCount | null;
}

interface AnnotationsData {
  review: Review | null;
  annotations_by_diff: Record<number, Annotation[]>;
}

// Session info response for detecting spawned vs archived sessions
interface SessionInfoResponse {
  id: string;
  type: "spawned" | "archived";
  status: string;
  cwd?: string;
  harness?: string;
  model?: string;
  title?: string;
  created_at?: string;
}

// API helpers
async function fetchSessions(): Promise<Session[]> {
  const res = await fetch('/api/sessions');
  if (!res.ok) return [];
  const data = await res.json();
  return data.sessions || [];
}

async function fetchSessionDetail(id: string): Promise<SessionDetailData | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchSharedSession(shareToken: string): Promise<SessionDetailData | null> {
  const res = await fetch(`/api/s/${encodeURIComponent(shareToken)}`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchAnnotations(sessionId: string): Promise<AnnotationsData | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/annotations`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchSessionInfo(sessionId: string): Promise<SessionInfoResponse | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/info`);
  if (!res.ok) return null;
  return res.json();
}

// Loading spinner component
function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="flex items-center gap-2 text-text-muted">
        <div className="w-5 h-5 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
        <span>Loading...</span>
      </div>
    </div>
  );
}

// Session list loader
function SessionListLoader() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSessions()
      .then(setSessions)
      .catch(() => setError('Failed to load sessions'));
  }, []);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-diff-del">{error}</p>
      </div>
    );
  }

  if (sessions === null) {
    return <LoadingSpinner />;
  }

  return <SessionListPage sessions={sessions} />;
}

// Session detail loader - handles both spawned and archived sessions
function SessionDetailLoader() {
  const { id } = useParams<{ id: string }>();
  const [sessionInfo, setSessionInfo] = useState<SessionInfoResponse | null>(null);
  const [data, setData] = useState<{
    session: Session;
    messages: Message[];
    diffs: Diff[];
    shareUrl: string | null;
    review: Review | null;
    annotationsByDiff: Record<number, Annotation[]>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;

    // First, fetch session info to determine if it's spawned or archived
    fetchSessionInfo(id)
      .then((info) => {
        if (!info) {
          setError('Session not found');
          setLoading(false);
          return;
        }

        setSessionInfo(info);

        // If spawned, we don't need to fetch archived session data
        if (info.type === 'spawned') {
          setLoading(false);
          return;
        }

        // For archived sessions, fetch full session data and annotations in parallel
        return Promise.all([
          fetchSessionDetail(id),
          fetchAnnotations(id),
        ]).then(([sessionData, annotationsData]) => {
          if (!sessionData) {
            setError('Session not found');
            return;
          }
          setData({
            session: sessionData.session,
            messages: sessionData.messages,
            diffs: sessionData.diffs,
            shareUrl: sessionData.shareUrl,
            review: annotationsData?.review || null,
            annotationsByDiff: annotationsData?.annotations_by_diff || {},
          });
        });
      })
      .catch(() => setError('Failed to load session'))
      .finally(() => setLoading(false));
  }, [id]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <h1 className="text-2xl font-semibold mb-2">Session Not Found</h1>
        <p className="text-text-muted mb-4">{error}</p>
        <a href="/" className="text-accent-primary hover:underline">Go Home</a>
      </div>
    );
  }

  if (loading) {
    return <LoadingSpinner />;
  }

  // Render SpawnedSessionView for spawned sessions
  if (sessionInfo?.type === 'spawned' && id) {
    return (
      <SpawnedSessionView
        sessionId={id}
        cwd={sessionInfo.cwd || ''}
        harness={sessionInfo.harness || 'claude-code'}
        model={sessionInfo.model}
        createdAt={sessionInfo.created_at}
      />
    );
  }

  // Render archived session view
  if (data) {
    return (
      <SessionDetailPage
        session={data.session}
        messages={data.messages}
        diffs={data.diffs}
        shareUrl={data.shareUrl}
        review={data.review}
        annotationsByDiff={data.annotationsByDiff}
      />
    );
  }

  return <LoadingSpinner />;
}

// Shared session loader
function SharedSessionLoader() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const [data, setData] = useState<{
    session: Session;
    messages: Message[];
    diffs: Diff[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shareToken) return;

    fetchSharedSession(shareToken)
      .then(sessionData => {
        if (!sessionData) {
          setError('Shared session not found');
          return;
        }
        setData({
          session: sessionData.session,
          messages: sessionData.messages,
          diffs: sessionData.diffs,
        });
      })
      .catch(() => setError('Failed to load shared session'));
  }, [shareToken]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <h1 className="text-2xl font-semibold mb-2">Session Not Found</h1>
        <p className="text-text-muted mb-4">{error}</p>
        <a href="/" className="text-accent-primary hover:underline">Go Home</a>
      </div>
    );
  }

  if (data === null) {
    return <LoadingSpinner />;
  }

  return (
    <SessionDetailPage
      session={data.session}
      messages={data.messages}
      diffs={data.diffs}
      shareUrl={null}
      review={null}
      annotationsByDiff={{}}
    />
  );
}

// Components showcase page
function ComponentsShowcasePage() {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    // Render the showcase HTML
    setHtml(renderComponentsShowcase());
  }, []);

  if (html === null) {
    return <LoadingSpinner />;
  }

  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

// Not found page
function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <h1 className="text-2xl font-semibold mb-2">Page Not Found</h1>
      <p className="text-text-muted mb-4">The page you're looking for doesn't exist.</p>
      <a href="/" className="text-accent-primary hover:underline">Go Home</a>
    </div>
  );
}

// Header component
function Header() {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-sm border-b border-transparent transition-colors">
      <nav className="max-w-[1400px] mx-auto px-6 lg:px-10 flex items-center justify-between h-14 transition-[max-width]">
        <a href="/" className="group text-2xl font-mono font-medium text-text-primary hover:text-accent-primary transition-colors">
          <span className="text-[14px] inline-flex gap-[2px] group-hover:gap-[6px] transition-all -translate-y-[2px]"><span>[</span><span>]</span></span>penctl
        </a>
        <UserMenu />
      </nav>
    </header>
  );
}

// Layout wrapper with header
function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Header />
      <main className="flex-1">
        {children}
      </main>
    </>
  );
}

// Main App component with router
export function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<GettingStartedPage />} />
          <Route path="/sessions" element={<ProtectedRoute><SessionListLoader /></ProtectedRoute>} />
          <Route path="/sessions/:id" element={<ProtectedRoute><SessionDetailLoader /></ProtectedRoute>} />
          <Route path="/s/:shareToken" element={<ProtectedRoute><SharedSessionLoader /></ProtectedRoute>} />
          <Route path="/_components" element={<ProtectedRoute><ComponentsShowcasePage /></ProtectedRoute>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
