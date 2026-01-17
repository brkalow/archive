/**
 * Extract client ID from request header.
 * Used for per-client analytics filtering.
 */
export function getClientId(req: Request): string | null {
  return req.headers.get("X-Openctl-Client-ID");
}
