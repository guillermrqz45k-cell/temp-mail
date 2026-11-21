'use strict';

/**
 * Tiny fixed-window in-memory rate limiter.
 * - per-IP when `global` is false (key = req.ip)
 * - a single shared bucket when `global` is true
 * Responds 429 when the limit is exceeded.
 */

function createRateLimiter({ windowMs, max, global = false }) {
  const buckets = new Map(); // key -> { count, resetAt }

  return function rateLimit(req, res, next) {
    const key = global ? 'global' : (req.ip || 'unknown');
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({
        ok: false,
        error: 'rate_limited',
        retryAfterMs: bucket.resetAt - now,
      });
    }
    next();
  };
}

module.exports = { createRateLimiter };
