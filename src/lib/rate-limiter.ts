/**
 * General-purpose Rate Limiter
 *
 * Provides rate limiting using a sliding window algorithm.
 * Used to prevent abuse of session spawning and input endpoints.
 */

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;
}

export class RateLimiter {
  private limits = new Map<string, RateLimitEntry>();

  constructor(private config: RateLimitConfig) {}

  check(key: string): RateLimitResult {
    const now = Date.now();
    const entry = this.limits.get(key);

    // If no entry or window expired, allow and reset
    if (!entry || now >= entry.resetAt) {
      this.limits.set(key, {
        count: 1,
        resetAt: now + this.config.windowMs,
      });
      return {
        allowed: true,
        remaining: this.config.maxRequests - 1,
        resetIn: this.config.windowMs,
      };
    }

    // Check if under limit
    if (entry.count < this.config.maxRequests) {
      entry.count++;
      return {
        allowed: true,
        remaining: this.config.maxRequests - entry.count,
        resetIn: entry.resetAt - now,
      };
    }

    // Over limit
    return {
      allowed: false,
      remaining: 0,
      resetIn: entry.resetAt - now,
    };
  }

  /**
   * Clean up expired entries to prevent memory leaks.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.limits) {
      if (now >= entry.resetAt) {
        this.limits.delete(key);
      }
    }
  }

  /**
   * Get current status for a key (for debugging/monitoring).
   */
  getStatus(key: string): { count: number; remaining: number; resetIn: number } | null {
    const now = Date.now();
    const entry = this.limits.get(key);

    if (!entry || now >= entry.resetAt) {
      return null;
    }

    return {
      count: entry.count,
      remaining: Math.max(0, this.config.maxRequests - entry.count),
      resetIn: entry.resetAt - now,
    };
  }

  /**
   * Clear all entries. Used for testing.
   */
  clear(): void {
    this.limits.clear();
  }
}

// Rate limit configurations for spawned sessions
export const spawnSessionLimiter = new RateLimiter({
  windowMs: 60_000, // 1 minute
  maxRequests: 5, // 5 spawns per minute
});

export const sendInputLimiter = new RateLimiter({
  windowMs: 60_000, // 1 minute
  maxRequests: 60, // 60 inputs per minute per session
});

// Cleanup interval - run every minute to remove expired entries
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startCleanupInterval(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    spawnSessionLimiter.cleanup();
    sendInputLimiter.cleanup();
  }, 60_000);
}

export function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Start cleanup on module load
startCleanupInterval();
