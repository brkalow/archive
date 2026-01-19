import { useAuth, RedirectToSignIn } from '@clerk/react';
import type { ReactNode } from 'react';
import { useClerkConfigured } from './AuthContext';

interface ProtectedRouteProps {
  children: ReactNode;
}

/**
 * Loading spinner while checking auth state.
 */
function LoadingAuth() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="flex items-center gap-2 text-text-muted">
        <div className="w-5 h-5 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
        <span>Checking authentication...</span>
      </div>
    </div>
  );
}

/**
 * Inner component that uses Clerk hooks (only rendered when Clerk is configured).
 */
function ProtectedRouteWithClerk({ children }: ProtectedRouteProps) {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) {
    return <LoadingAuth />;
  }

  if (!isSignedIn) {
    return <RedirectToSignIn />;
  }

  return <>{children}</>;
}

/**
 * Wrapper component that requires authentication.
 * Redirects to sign-in if not authenticated.
 * Falls back to showing content if Clerk is not configured.
 */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const isClerkConfigured = useClerkConfigured();

  if (!isClerkConfigured) {
    // Clerk not configured - allow access (development mode)
    return <>{children}</>;
  }

  return <ProtectedRouteWithClerk>{children}</ProtectedRouteWithClerk>;
}
