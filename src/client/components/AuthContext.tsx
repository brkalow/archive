import { createContext, useContext, type ReactNode } from 'react';

/**
 * Context to track whether Clerk authentication is configured.
 * This allows child components to know if they can use Clerk hooks.
 */
interface AuthContextValue {
  isClerkConfigured: boolean;
}

const AuthContext = createContext<AuthContextValue>({ isClerkConfigured: false });

/**
 * Provider that wraps the app and indicates whether Clerk is available.
 */
export function AuthContextProvider({
  children,
  isClerkConfigured,
}: {
  children: ReactNode;
  isClerkConfigured: boolean;
}) {
  return (
    <AuthContext.Provider value={{ isClerkConfigured }}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Hook to check if Clerk is configured.
 */
export function useClerkConfigured(): boolean {
  const context = useContext(AuthContext);
  return context.isClerkConfigured;
}
