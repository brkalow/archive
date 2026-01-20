/**
 * Authentication middleware for API routes.
 * Extracts and verifies Clerk tokens, provides user context.
 */

import { createClerkClient } from '@clerk/backend';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.PUBLIC_CLERK_PUBLISHABLE_KEY,
});

/**
 * Get authorized parties for CSRF protection.
 * These are the domains allowed to make authenticated requests.
 */
function getAuthorizedParties(req: Request): string[] {
  const parties = ['https://openctl.dev'];
  // Allow any in lower environments, might have multiple dev servers on different ports
  if (process.env.NODE_ENV !== 'production') {
    return []
  }
  return parties;
}

/**
 * Authentication context extracted from a request.
 */
export interface AuthContext {
  /** The authenticated user's ID (from Clerk), or null if not authenticated */
  userId: string | null;
  /** The client ID from the X-Openctl-Client-ID header */
  clientId: string | null;
  /** Whether the request is authenticated */
  isAuthenticated: boolean;
}

/**
 * Extract the client ID from request headers.
 */
export function getClientId(req: Request): string | null {
  return req.headers.get("X-Openctl-Client-ID");
}

/**
 * Extract authentication context from a request.
 * Verifies the Bearer token if present using Clerk.
 */
export async function extractAuth(req: Request): Promise<AuthContext> {
  const clientId = getClientId(req);
  let userId: string | null = null;

  const secretKey = process.env.CLERK_SECRET_KEY;

  if (secretKey) {
    try {
      const authState = await clerkClient.authenticateRequest(req, {
        acceptsToken: ['session_token', 'oauth_token'],
        authorizedParties: getAuthorizedParties(req),
      });

      userId = authState.isAuthenticated ? authState.toAuth().userId : null;
    } catch (error) {
      // Token verification failed
      // Log in development, but don't expose details
      if (process.env.NODE_ENV !== "production") {
        console.warn("Token verification failed:", error);
      }
    }
  } else {
    // Clerk not configured - cannot verify tokens
    // In production, this means auth is disabled
    // Log a warning so operators know auth is not working
    if (process.env.NODE_ENV !== "test") {
      console.warn("CLERK_SECRET_KEY not configured - Bearer token authentication disabled");
    }
  }

  return {
    userId,
    clientId,
    isAuthenticated: userId !== null,
  };
}

/**
 * Access control for sessions should use SessionRepository.verifyOwnership()
 * which performs the check at the database level for better efficiency.
 *
 * Usage:
 *   const { allowed, isOwner } = repo.verifyOwnership(sessionId, auth.userId, auth.clientId);
 */

/**
 * Require authentication middleware helper.
 * Returns an error response if not authenticated, or null if OK.
 */
export function requireAuth(auth: AuthContext): Response | null {
  if (!auth.isAuthenticated && !auth.clientId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

/**
 * Require a specific identity (either user or client).
 * Returns an error response if neither is present, or null if OK.
 */
export function requireIdentity(auth: AuthContext): Response | null {
  if (!auth.userId && !auth.clientId) {
    return new Response(JSON.stringify({ error: "Unauthorized - no identity" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}
