import { describe, test, expect, beforeEach } from "bun:test";
import { RateLimiter } from "../../src/lib/rate-limiter";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ windowMs: 1000, maxRequests: 3 });
  });

  test("allows requests under limit", () => {
    expect(limiter.check("test").allowed).toBe(true);
    expect(limiter.check("test").allowed).toBe(true);
    expect(limiter.check("test").allowed).toBe(true);
  });

  test("blocks requests over limit", () => {
    // Use up all requests
    limiter.check("test");
    limiter.check("test");
    limiter.check("test");

    // Next request should be blocked
    const result = limiter.check("test");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("tracks remaining requests correctly", () => {
    const first = limiter.check("test");
    expect(first.remaining).toBe(2);

    const second = limiter.check("test");
    expect(second.remaining).toBe(1);

    const third = limiter.check("test");
    expect(third.remaining).toBe(0);
  });

  test("resets after window expires", async () => {
    const shortLimiter = new RateLimiter({ windowMs: 100, maxRequests: 1 });

    shortLimiter.check("test");
    expect(shortLimiter.check("test").allowed).toBe(false);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 150));

    expect(shortLimiter.check("test").allowed).toBe(true);
  });

  test("tracks different keys independently", () => {
    limiter.check("key1");
    limiter.check("key1");
    limiter.check("key1");

    // key1 is exhausted
    expect(limiter.check("key1").allowed).toBe(false);

    // key2 is fresh
    expect(limiter.check("key2").allowed).toBe(true);
  });

  test("provides resetIn time", () => {
    const result = limiter.check("test");
    expect(result.resetIn).toBeGreaterThan(0);
    expect(result.resetIn).toBeLessThanOrEqual(1000);
  });

  test("cleanup removes expired entries", async () => {
    const shortLimiter = new RateLimiter({ windowMs: 50, maxRequests: 3 });

    shortLimiter.check("test1");
    shortLimiter.check("test2");

    // Wait for entries to expire
    await new Promise((r) => setTimeout(r, 100));

    // Run cleanup
    shortLimiter.cleanup();

    // Entries should be removed - new check should start fresh
    expect(shortLimiter.getStatus("test1")).toBeNull();
    expect(shortLimiter.getStatus("test2")).toBeNull();
  });

  test("getStatus returns null for unknown or expired keys", () => {
    expect(limiter.getStatus("unknown")).toBeNull();
  });

  test("getStatus returns correct info for active keys", () => {
    limiter.check("test");
    limiter.check("test");

    const status = limiter.getStatus("test");
    expect(status).not.toBeNull();
    expect(status!.count).toBe(2);
    expect(status!.remaining).toBe(1);
    expect(status!.resetIn).toBeGreaterThan(0);
  });

  test("clear removes all entries", () => {
    limiter.check("test1");
    limiter.check("test2");

    limiter.clear();

    expect(limiter.getStatus("test1")).toBeNull();
    expect(limiter.getStatus("test2")).toBeNull();
  });
});
