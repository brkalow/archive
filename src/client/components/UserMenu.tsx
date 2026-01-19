import { Show, SignInButton, UserButton, useAuth } from '@clerk/react';
import { useClerkConfigured } from './AuthContext';

/**
 * User menu component that shows sign-in button or user avatar.
 * Gracefully handles cases where Clerk is not configured.
 */
export function UserMenu() {
  const isClerkConfigured = useClerkConfigured();

  if (!isClerkConfigured) {
    // Clerk not configured - don't show anything
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <Show when='signed-out'>
        <SignInButton mode="modal">
          <button className="px-3 py-1.5 text-sm font-medium text-text-secondary hover:text-text-primary bg-surface-secondary hover:bg-surface-tertiary border border-border-subtle rounded-md transition-colors">
            Sign in
          </button>
        </SignInButton>
      </Show>
      <Show when='signed-in'>
        <UserButton
          appearance={{
            elements: {
              avatarBox: 'w-8 h-8',
              userButtonPopoverCard: 'bg-surface-secondary border border-border-subtle',
              userButtonPopoverActionButton: 'hover:bg-surface-tertiary',
              userButtonPopoverActionButtonText: 'text-text-secondary',
              userButtonPopoverFooter: 'hidden',
            },
          }}
        />
      </Show>
    </div>
  );
}

/**
 * Inner component that uses Clerk hooks (only rendered when Clerk is configured).
 */
function AuthOnlyWithClerk({ children }: { children: React.ReactNode }) {
  const { isSignedIn } = useAuth();

  if (!isSignedIn) {
    return null;
  }

  return <>{children}</>;
}

/**
 * Wrapper that only renders children if user is signed in.
 * Used to conditionally show UI elements for authenticated users only.
 */
export function AuthOnly({ children }: { children: React.ReactNode }) {
  const isClerkConfigured = useClerkConfigured();

  if (!isClerkConfigured) {
    // Clerk not configured - show children anyway (no auth enforcement)
    return <>{children}</>;
  }

  return <AuthOnlyWithClerk>{children}</AuthOnlyWithClerk>;
}
