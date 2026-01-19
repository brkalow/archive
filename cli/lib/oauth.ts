/**
 * OAuth 2.0 authentication flow for CLI.
 * Implements Authorization Code flow with PKCE.
 */

import { generateCodeVerifier, generateCodeChallenge } from "./pkce";
import { findAvailablePort, createCallbackServer, signState, validateState } from "./callback-server";
import { getKeychain, type Tokens } from "./keychain";
import { getServerUrl } from "./config";

/**
 * OAuth configuration.
 */
export interface OAuthConfig {
  /** The server URL (e.g., https://openctl.dev) */
  serverUrl: string;
  /** Clerk OAuth client ID */
  clientId: string;
  /** Clerk OAuth authorization endpoint */
  authorizationEndpoint: string;
  /** Clerk OAuth token endpoint */
  tokenEndpoint: string;
  /** OIDC userinfo endpoint (fetched from discovery) */
  userinfoEndpoint: string;
}

// Cache for OIDC discovery documents
const discoveryCache = new Map<string, { config: OAuthConfig; fetchedAt: number }>();
const DISCOVERY_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch OIDC discovery document and extract endpoints.
 */
async function fetchOIDCDiscovery(issuer: string): Promise<{
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}> {
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const response = await fetch(discoveryUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch OIDC discovery: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Get the OAuth configuration, fetching OIDC discovery if needed.
 */
export async function getOAuthConfig(serverUrl?: string): Promise<OAuthConfig> {
  const server = serverUrl || getServerUrl();
  const clerkDomain = process.env.CLERK_OAUTH_DOMAIN || "clerk.openctl.dev";
  const issuer = `https://${clerkDomain}`;

  // Check cache
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_CACHE_TTL) {
    return { ...cached.config, serverUrl: server };
  }

  try {
    // Fetch OIDC discovery document
    const discovery = await fetchOIDCDiscovery(issuer);

    const config: OAuthConfig = {
      serverUrl: server,
      clientId: process.env.CLERK_OAUTH_CLIENT_ID || "cli_openctl",
      authorizationEndpoint: discovery.authorization_endpoint,
      tokenEndpoint: discovery.token_endpoint,
      userinfoEndpoint: discovery.userinfo_endpoint,
    };

    // Cache the result
    discoveryCache.set(issuer, { config, fetchedAt: Date.now() });

    return config;
  } catch (error) {
    // Fall back to constructed URLs if discovery fails
    console.warn("OIDC discovery failed, using fallback URLs:", error);

    return {
      serverUrl: server,
      clientId: process.env.CLERK_OAUTH_CLIENT_ID || "cli_openctl",
      authorizationEndpoint: `${issuer}/oauth/authorize`,
      tokenEndpoint: `${issuer}/oauth/token`,
      userinfoEndpoint: `${issuer}/oauth/userinfo`,
    };
  }
}

/**
 * Build the authorization URL for the OAuth flow.
 */
export function buildAuthUrl(options: {
  config: OAuthConfig;
  codeChallenge: string;
  state: string;
  redirectUri: string;
}): string {
  const { config, codeChallenge, state, redirectUri } = options;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    scope: "openid profile email",
  });

  return `${config.authorizationEndpoint}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCodeForTokens(options: {
  config: OAuthConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<Tokens> {
  const { config, code, codeVerifier, redirectUri } = options;

  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      client_id: config.clientId,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMessage = errorData.error_description || errorData.error || response.statusText;
    throw new Error(`Token exchange failed: ${errorMessage}`);
  }

  const data = await response.json();

  // Calculate expiration time (access_token typically has expires_in in seconds)
  const expiresIn = data.expires_in || 3600; // Default 1 hour
  const expiresAt = Date.now() + expiresIn * 1000;

  // Get user info from ID token or userinfo endpoint
  const userInfo = await getUserInfo(data.access_token, config);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    userId: userInfo.userId,
    email: userInfo.email,
    expiresAt,
  };
}

/**
 * Refresh an access token using a refresh token.
 */
export async function refreshAccessToken(
  refreshToken: string,
  config: OAuthConfig
): Promise<Tokens> {
  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMessage = errorData.error_description || errorData.error || response.statusText;
    throw new Error(`Token refresh failed: ${errorMessage}`);
  }

  const data = await response.json();

  const expiresIn = data.expires_in || 3600;
  const expiresAt = Date.now() + expiresIn * 1000;

  const userInfo = await getUserInfo(data.access_token, config);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken, // Some providers don't return new refresh token
    userId: userInfo.userId,
    email: userInfo.email,
    expiresAt,
  };
}

/**
 * Get user info from the access token.
 */
async function getUserInfo(accessToken: string, config: OAuthConfig): Promise<{ userId: string; email: string }> {
  // Try to decode the access token if it's a JWT (Clerk tokens are JWTs)
  try {
    const parts = accessToken.split(".");
    const payloadPart = parts[1];
    if (parts.length === 3 && payloadPart) {
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString());
      if (payload.sub && payload.email) {
        return { userId: payload.sub, email: payload.email };
      }
    }
  } catch {
    // Not a JWT or couldn't parse, fall through to userinfo endpoint
  }

  // Fall back to userinfo endpoint (from OIDC discovery)
  const response = await fetch(config.userinfoEndpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error("Failed to get user info");
  }

  const data = await response.json();
  return { userId: data.sub, email: data.email };
}

/**
 * Open a URL in the default browser.
 */
export async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
    ? ["cmd", "/c", "start", url]
    : ["xdg-open", url];

  const proc = Bun.spawn(command, {
    stdout: "ignore",
    stderr: "ignore",
  });

  await proc.exited;
}

/**
 * Start the OAuth flow and return the tokens.
 */
export async function startOAuthFlow(serverUrl?: string): Promise<Tokens> {
  const config = await getOAuthConfig(serverUrl);

  // Generate PKCE values
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Find an available port and start the callback server
  const port = await findAvailablePort();

  // Generate signed state
  const nonce = crypto.randomUUID();
  const state = signState({ port, nonce, timestamp: Date.now() });

  // Build redirect URI - goes through our server first, then to localhost
  const redirectUri = `${config.serverUrl}/auth/cli/callback`;

  // Start the local callback server
  const { promise, stop } = createCallbackServer(port, { timeout: 5 * 60 * 1000 });

  // Build and open authorization URL
  const authUrl = buildAuthUrl({ config, codeChallenge, state, redirectUri });

  console.log("Opening browser for authentication...");
  console.log("If the browser doesn't open, visit this URL:");
  console.log(authUrl);
  console.log();

  await openBrowser(authUrl);

  try {
    // Wait for the callback
    const result = await promise;

    // Validate the state
    const stateData = validateState(result.state);
    if (stateData.port !== port || stateData.nonce !== nonce) {
      throw new Error("State mismatch - possible CSRF attack");
    }

    // Exchange code for tokens (must use same redirect_uri as authorization request)
    const tokens = await exchangeCodeForTokens({
      config,
      code: result.code,
      codeVerifier,
      redirectUri,
    });

    return tokens;
  } finally {
    stop();
  }
}

/**
 * Get authenticated tokens from the keychain, refreshing if needed.
 */
export async function getAuthenticatedTokens(serverUrl?: string): Promise<Tokens> {
  const server = serverUrl || getServerUrl();
  const keychain = getKeychain();
  let tokens = await keychain.get(server);

  if (!tokens) {
    throw new Error("Not authenticated. Run `openctl auth login` first.");
  }

  // Check if access token is expired or about to expire (5 minute buffer)
  if (Date.now() + 5 * 60 * 1000 >= tokens.expiresAt) {
    try {
      const config = await getOAuthConfig(server);
      tokens = await refreshAccessToken(tokens.refreshToken, config);
      await keychain.set(server, tokens);
    } catch (error) {
      // Refresh failed, need to re-authenticate
      throw new Error("Session expired. Run `openctl auth login` to re-authenticate.");
    }
  }

  return tokens;
}

/**
 * Get the access token if authenticated, or null if not.
 * Unlike getAuthenticatedTokens, this does not throw if not logged in.
 * Used for optional auth in CLI commands.
 */
export async function getAccessTokenIfAuthenticated(serverUrl?: string): Promise<string | null> {
  try {
    const tokens = await getAuthenticatedTokens(serverUrl);
    return tokens.accessToken;
  } catch {
    // Not authenticated or token refresh failed - return null
    return null;
  }
}
