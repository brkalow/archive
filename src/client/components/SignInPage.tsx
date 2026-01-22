import { SignIn } from '@clerk/react';

/**
 * Sign-in page using Clerk's pre-built SignIn component.
 */
export function SignInPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen py-16 px-4">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-semibold mb-2">Sign in to openctl</h1>
        <p className="text-text-muted">Access your sessions from any device</p>
      </div>
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        fallbackRedirectUrl="/sessions"
        appearance={{
          elements: {
            rootBox: 'mx-auto',
            card: 'bg-surface-secondary border border-border-subtle shadow-lg',
            headerTitle: 'text-text-primary',
            headerSubtitle: 'text-text-muted',
            socialButtonsBlockButton: 'bg-surface-tertiary hover:bg-surface-hover border-border-subtle',
            socialButtonsBlockButtonText: 'text-text-primary',
            formFieldLabel: 'text-text-secondary',
            formFieldInput: 'bg-surface-tertiary border-border-subtle text-text-primary',
            footerActionLink: 'text-accent-primary hover:text-accent-hover',
          },
        }}
      />
    </div>
  );
}

/**
 * Sign-up page using Clerk's pre-built SignUp component.
 */
export function SignUpPage() {
  // Note: For this implementation, we're only using Google OAuth
  // so users don't need a separate sign-up flow
  return (
    <div className="flex flex-col items-center justify-center min-h-screen py-16 px-4">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-semibold mb-2">Create an account</h1>
        <p className="text-text-muted">Sign in with Google to get started</p>
      </div>
      <a
        href="/sign-in"
        className="px-6 py-3 bg-accent-primary text-white rounded-lg hover:bg-accent-hover transition-colors"
      >
        Sign in with Google
      </a>
    </div>
  );
}
