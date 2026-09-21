/**
 * Small in-memory sliding-window rate limiter. Appropriate for a single-process
 * personal deployment; swap for Redis if you ever run multiple instances.
 */
interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

export interface RateResult {
  allowed: boolean;
  retryAfterSec: number;
  remaining: number;
}

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateResult {
  if (now - lastSweep > 60_000) {
    for (const [k, b] of buckets) {
      b.hits = b.hits.filter((t) => now - t < windowMs * 2);
      if (!b.hits.length) buckets.delete(k);
    }
    lastSweep = now;
  }
  const b = buckets.get(key) ?? { hits: [] };
  b.hits = b.hits.filter((t) => now - t < windowMs);
  if (b.hits.length >= limit) {
    const retry = Math.ceil((windowMs - (now - b.hits[0])) / 1000);
    buckets.set(key, b);
    return { allowed: false, retryAfterSec: Math.max(1, retry), remaining: 0 };
  }
  b.hits.push(now);
  buckets.set(key, b);
  return { allowed: true, retryAfterSec: 0, remaining: limit - b.hits.length };
}

export function resetRateLimit(key: string) {
  buckets.delete(key);
}

export function clientIp(headers: Headers): string {
  // Only trust forwarding headers when explicitly behind a proxy you control.
  if (process.env.TRUST_PROXY === "true") {
    const xff = headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  return headers.get("x-real-ip") || "local";
}
