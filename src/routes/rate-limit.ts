/**
 * Rate limiting for feedback messages in interactive sessions.
 *
 * Uses a simple sliding window algorithm with per-session, per-type buckets.
 */

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

// Map of "sessionId:type" -> bucket
const buckets = new Map<string, RateLimitBucket>();

// Rate limits for different feedback types
const LIMITS = {
  message: { max: 100, windowMs: 60 * 60 * 1000 }, // 100/hour
  diff_comment: { max: 50, windowMs: 60 * 60 * 1000 }, // 50/hour
  suggested_edit: { max: 20, windowMs: 60 * 60 * 1000 }, // 20/hour
} as const;

type FeedbackType = keyof typeof LIMITS;

/**
 * Check if a feedback message is allowed under rate limits.
 */
export function checkRateLimit(
  sessionId: string,
  type: FeedbackType
): { allowed: boolean; retryAfter?: number } {
  const key = `${sessionId}:${type}`;
  const limit = LIMITS[type];
  const now = Date.now();

  let bucket = buckets.get(key);

  // Create or reset bucket if window has expired
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + limit.windowMs };
    buckets.set(key, bucket);
  }

  // Check if limit exceeded
  if (bucket.count >= limit.max) {
    return {
      allowed: false,
      retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
    };
  }

  // Increment counter and allow
  bucket.count++;
  return { allowed: true };
}

/**
 * Reset rate limit for a session (used for testing).
 */
export function resetRateLimit(sessionId: string, type?: FeedbackType): void {
  if (type) {
    buckets.delete(`${sessionId}:${type}`);
  } else {
    // Reset all types for this session
    for (const t of Object.keys(LIMITS) as FeedbackType[]) {
      buckets.delete(`${sessionId}:${t}`);
    }
  }
}

/**
 * Clear all rate limit buckets (used for testing or shutdown).
 */
export function clearAllRateLimits(): void {
  buckets.clear();
}

/**
 * Get current rate limit status for a session (for debugging/monitoring).
 */
export function getRateLimitStatus(sessionId: string): Record<FeedbackType, { remaining: number; resetAt: Date }> {
  const now = Date.now();
  const status = {} as Record<FeedbackType, { remaining: number; resetAt: Date }>;

  for (const [type, limit] of Object.entries(LIMITS) as [FeedbackType, typeof LIMITS[FeedbackType]][]) {
    const key = `${sessionId}:${type}`;
    const bucket = buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      // No bucket or expired - full capacity available
      status[type] = {
        remaining: limit.max,
        resetAt: new Date(now + limit.windowMs),
      };
    } else {
      status[type] = {
        remaining: Math.max(0, limit.max - bucket.count),
        resetAt: new Date(bucket.resetAt),
      };
    }
  }

  return status;
}
