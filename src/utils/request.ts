/**
 * Extract client ID from request header.
 * Used for per-client analytics filtering.
 */
export function getClientId(req: Request): string | null {
  return req.headers.get("X-Openctl-Client-ID");
}

/**
 * Extract client IP address from request.
 * Checks common proxy headers first, then falls back to connection info.
 */
export function getClientIP(req: Request): string {
  // Check for forwarded headers (when behind proxy)
  const forwarded = req.headers.get("X-Forwarded-For");
  if (forwarded) {
    // X-Forwarded-For can contain multiple IPs, first one is client
    const firstIP = forwarded.split(",")[0].trim();
    if (firstIP) return firstIP;
  }

  const realIP = req.headers.get("X-Real-IP");
  if (realIP) return realIP;

  // In Bun, we don't have direct access to socket IP from Request
  // Return a default for rate limiting purposes
  return "unknown";
}
