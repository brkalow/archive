/**
 * PKCE (Proof Key for Code Exchange) helpers for OAuth 2.0 CLI authentication.
 * RFC 7636 compliant implementation.
 */

import { createHash, randomBytes } from "crypto";

/**
 * Generate a cryptographically random code verifier.
 * RFC 7636: 43-128 characters, using [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"
 */
export function generateCodeVerifier(): string {
  // 32 bytes -> 43 base64url characters
  return base64url(randomBytes(32));
}

/**
 * Generate a code challenge from a code verifier using S256 method.
 * RFC 7636: BASE64URL(SHA256(code_verifier))
 */
export function generateCodeChallenge(verifier: string): string {
  const hash = createHash("sha256").update(verifier).digest();
  return base64url(hash);
}

/**
 * Encode a buffer as base64url (URL-safe base64 without padding).
 * RFC 4648 Section 5
 */
export function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode a base64url string to a buffer.
 */
export function base64urlDecode(str: string): Buffer {
  // Add back padding
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  // Convert URL-safe characters back
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}
