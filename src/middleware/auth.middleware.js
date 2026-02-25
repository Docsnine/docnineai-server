// ===================================================================
// Protect routes by verifying the Bearer access token.
// Attaches req.user = { userId, email } on success.
//
// The verifyAccessToken function reads JWT_ACCESS_SECRET lazily
// (inside the function), so there is no module-load dotenv race.
// ===================================================================

import { verifyAccessToken } from "../utils/jwt.util.js";
import { fail } from "../utils/response.util.js";

/**
 * Hard auth guard — 401 if Bearer token is missing, expired, or invalid.
 * Attaches req.user = { userId, email } on success.
 */
export function protect(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return fail(
      res,
      "NO_TOKEN",
      "Authentication required. Provide a Bearer token.",
      401,
    );
  }

  const token = header.slice(7).trim();

  try {
    const payload = verifyAccessToken(token);
    req.user = { userId: payload.sub, email: payload.email };
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return fail(
        res,
        "TOKEN_EXPIRED",
        "Access token has expired. Use POST /auth/refresh.",
        401,
      );
    }
    return fail(
      res,
      "INVALID_TOKEN",
      "Access token is invalid or malformed.",
      401,
    );
  }
}

/**
 * Soft auth guard — attaches req.user if token is valid, otherwise continues
 * as unauthenticated. Never returns a 401.
 */
export function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return next();

  const token = header.slice(7).trim();
  try {
    const payload = verifyAccessToken(token);
    req.user = { userId: payload.sub, email: payload.email };
  } catch {
    // Invalid or expired — treat as anonymous
  }
  next();
}
