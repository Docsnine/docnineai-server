// ===================================================================
// Purpose-built rate limiters for sensitive routes.
// Uses express-rate-limit (already in package.json).
//
// Separate limiters per route category so one doesn't pollute another.
// All return consistent JSON on block (no HTML).
// ===================================================================

import rateLimit from "express-rate-limit";

/** Shared error response handler — keeps response shape consistent */
const onLimitReached = (req, res) => {
  res.status(429).json({
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests. Please try again later.",
      retryAfter: res.getHeader("Retry-After"),
    },
  });
};

/**
 * Strict limiter for login / forgot-password.
 * 10 attempts per 15 minutes per IP.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: onLimitReached,
  skipSuccessfulRequests: true, // only count failed attempts
});

/**
 * Limiter for signup and email verification.
 * 20 per hour per IP — generous enough for normal use.
 */
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: onLimitReached,
});

/**
 * API-wide limiter — catch-all for authenticated routes.
 * 300 requests per 5 minutes per IP.
 */
export const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler: onLimitReached,
});
