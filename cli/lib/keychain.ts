/**
 * Secure token storage abstraction for CLI authentication.
 * Supports macOS Keychain and encrypted file fallback.
 */

import { MacOSKeychain } from "./keychain-macos";
import { FileKeychain } from "./keychain-file";

/**
 * Stored authentication tokens for a server.
 */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

/**
 * Interface for secure token storage implementations.
 */
export interface TokenStore {
  /**
   * Get tokens for a server URL.
   * Returns null if no tokens are stored.
   */
  get(serverUrl: string): Promise<Tokens | null>;

  /**
   * Store tokens for a server URL.
   */
  set(serverUrl: string, tokens: Tokens): Promise<void>;

  /**
   * Delete tokens for a server URL.
   */
  delete(serverUrl: string): Promise<void>;

  /**
   * List all server URLs that have stored tokens.
   */
  list(): Promise<string[]>;
}

/**
 * Check if an access token is expired or about to expire.
 * Returns true if the token expires within the buffer period (default 5 minutes).
 */
export function isTokenExpired(tokens: Tokens, bufferMs: number = 5 * 60 * 1000): boolean {
  return Date.now() + bufferMs >= tokens.expiresAt;
}

/**
 * Get the appropriate keychain implementation for the current platform.
 */
export function getKeychain(): TokenStore {
  if (process.platform === "darwin") {
    return new MacOSKeychain();
  }

  // Linux and other platforms use encrypted file storage
  return new FileKeychain();
}
