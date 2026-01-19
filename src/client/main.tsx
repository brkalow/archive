import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/react';
import { App } from './App';
import { AuthContextProvider } from './components/AuthContext';
import { setupGlobals } from './globals';

// Set up global utilities (toast, clipboard) for backwards compatibility
setupGlobals();

// Clerk publishable key from environment
// This gets injected at build time or from the server
const CLERK_PUBLISHABLE_KEY = process.env.PUBLIC_CLERK_PUBLISHABLE_KEY

const isClerkConfigured = Boolean(CLERK_PUBLISHABLE_KEY);

// Mount React app
const container = document.getElementById('app');
if (container) {
  const root = createRoot(container);

  // Always wrap with AuthContextProvider to let components know if Clerk is available
  if (isClerkConfigured) {
    root.render(
      <AuthContextProvider isClerkConfigured={true}>
        <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
          <App />
        </ClerkProvider>
      </AuthContextProvider>
    );
  } else {
    // Fallback for development without Clerk
    root.render(
      <AuthContextProvider isClerkConfigured={false}>
        <App />
      </AuthContextProvider>
    );
  }
}
