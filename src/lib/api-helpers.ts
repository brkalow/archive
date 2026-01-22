import {
  matchError,
  type ApiRouteError,
  NotFoundError,
  ValidationError,
  PayloadTooLargeError,
  UnauthorizedError,
  ForbiddenError,
  SessionNotLiveError,
  ConflictError,
  RateLimitError,
  DaemonNotConnectedError,
  DatabaseError,
  ConstraintViolationError,
  InvalidUrlError,
} from "./errors";

/**
 * Create a JSON response
 */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * Create a JSON error response
 */
export function jsonError(error: string, status: number): Response {
  return json({ error }, status);
}

/**
 * Convert a typed error to an HTTP response.
 * Uses exhaustive matching to ensure all error types are handled.
 */
export function errorToResponse(error: ApiRouteError): Response {
  return matchError(error, {
    NotFoundError: (e) => jsonError(`${capitalize(e.resource)} not found`, 404),
    ValidationError: (e) => jsonError(`${e.field}: ${e.message}`, 400),
    PayloadTooLargeError: (e) => jsonError(`Payload too large (max ${formatBytes(e.maxBytes)})`, 413),
    InvalidUrlError: (e) => jsonError(`Invalid URL: ${e.reason}`, 400),
    UnauthorizedError: () => jsonError("Unauthorized", 401),
    ForbiddenError: () => jsonError("Forbidden", 403),
    SessionNotLiveError: (e) => jsonError(`Session is not live (status: ${e.currentStatus})`, 409),
    ConflictError: (e) => jsonError(e.reason, 409),
    RateLimitError: (e) => json({ error: "Rate limit exceeded", retry_after_ms: e.retryAfterMs }, 429),
    DaemonNotConnectedError: (e) => jsonError(e.message || "No daemon connected", 503),
    DatabaseError: (e) => {
      // Log the actual error for debugging but don't expose details to client
      console.error("Database error:", e.operation, e.message, e.cause);
      return jsonError("Internal server error", 500);
    },
    ConstraintViolationError: (e) => {
      // Constraint violations are typically conflicts (e.g., duplicate key)
      if (e.constraint === "unique") {
        return jsonError(`${capitalize(e.table.replace(/_/g, " "))} already exists`, 409);
      }
      return jsonError("Conflict", 409);
    },
  });
}

/**
 * Capitalize first letter of a string
 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Format bytes as human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / 1024 / 1024)}MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${bytes}B`;
}
