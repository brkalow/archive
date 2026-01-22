import { TaggedError, matchError } from "better-result";

// ============================================================================
// Database Errors
// ============================================================================

/**
 * Resource not found in database
 */
export class NotFoundError extends TaggedError("NotFoundError")<{
  resource: "session" | "message" | "diff" | "review" | "annotation" | "feedback";
  id: string;
}>() {}

/**
 * General database operation failure
 */
export class DatabaseError extends TaggedError("DatabaseError")<{
  operation: string;
  message: string;
  cause?: unknown;
}>() {}

/**
 * Database constraint violation (unique, foreign key, etc.)
 */
export class ConstraintViolationError extends TaggedError("ConstraintViolationError")<{
  constraint: "unique" | "foreign_key" | "check";
  table: string;
  details: string;
}>() {}

// ============================================================================
// Validation Errors
// ============================================================================

/**
 * Input validation failure
 */
export class ValidationError extends TaggedError("ValidationError")<{
  field: string;
  message: string;
  value?: unknown;
}>() {}

/**
 * Request payload exceeds size limit
 */
export class PayloadTooLargeError extends TaggedError("PayloadTooLargeError")<{
  maxBytes: number;
  actualBytes?: number;
}>() {}

/**
 * Invalid URL format
 */
export class InvalidUrlError extends TaggedError("InvalidUrlError")<{
  url: string;
  reason: string;
}>() {}

// ============================================================================
// Auth Errors
// ============================================================================

/**
 * Authentication failure
 */
export class UnauthorizedError extends TaggedError("UnauthorizedError")<{
  reason: "missing_token" | "invalid_token" | "expired_token" | "no_identity";
}>() {}

/**
 * Access denied to resource
 */
export class ForbiddenError extends TaggedError("ForbiddenError")<{
  sessionId: string;
  userId?: string | null;
  clientId?: string | null;
}>() {}

// ============================================================================
// Session Errors
// ============================================================================

/**
 * Session is not in live state when live is required
 */
export class SessionNotLiveError extends TaggedError("SessionNotLiveError")<{
  sessionId: string;
  currentStatus: string;
}>() {}

/**
 * State conflict (e.g., resource already exists)
 */
export class ConflictError extends TaggedError("ConflictError")<{
  resource: string;
  reason: string;
}>() {}

// ============================================================================
// External Service Errors
// ============================================================================

/**
 * No daemon connected to the server
 */
export class DaemonNotConnectedError extends TaggedError("DaemonNotConnectedError")<{
  message: string;
}>() {}

/**
 * Rate limit exceeded
 */
export class RateLimitError extends TaggedError("RateLimitError")<{
  retryAfterMs: number;
}>() {}

/**
 * Network/fetch failure
 */
export class NetworkError extends TaggedError("NetworkError")<{
  url: string;
  message: string;
  cause?: unknown;
}>() {}

// ============================================================================
// Client-Side Errors
// ============================================================================

/**
 * Generic API response error (for client-side use)
 */
export class ApiError extends TaggedError("ApiError")<{
  status: number;
  message: string;
  details?: unknown;
}>() {}

// ============================================================================
// Union Types
// ============================================================================

/**
 * All database layer errors
 */
export type DbError = NotFoundError | DatabaseError | ConstraintViolationError;

/**
 * All API route errors
 */
export type ApiRouteError =
  | DbError
  | ValidationError
  | PayloadTooLargeError
  | InvalidUrlError
  | UnauthorizedError
  | ForbiddenError
  | SessionNotLiveError
  | ConflictError
  | DaemonNotConnectedError
  | RateLimitError;

/**
 * All client-side errors
 */
export type ClientError = ApiError | NetworkError;

// Re-export matchError for convenience
export { matchError };
