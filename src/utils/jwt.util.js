// ===================================================================
// Two-token strategy:
//   Access token  — 15 min, signed with JWT_ACCESS_SECRET
//                   sent in response body, stored in memory by client
//   Refresh token — 7 days, signed with JWT_REFRESH_SECRET
//                   sent as httpOnly Secure cookie
//                   hash stored in User.refreshTokenHash for revocation
//
// WHY lazy env reads (no module-level constants for secrets):
//   In ESM, every `import` is resolved and evaluated BEFORE the calling
//   module's body runs. This means dotenv.config() in server.js fires
//   AFTER this module is evaluated — so module-level process.env reads
//   always see undefined for .env file values.
//   Reading inside functions defers evaluation to call-time, after dotenv.
//
// Required env:
//   JWT_ACCESS_SECRET   — 32+ random chars
//   JWT_REFRESH_SECRET  — 32+ random chars (different from access)
// ===================================================================

import jwt from "jsonwebtoken";

const ACCESS_TTL = "15m";
const REFRESH_TTL = "7d";

// ── Internal helpers ──────────────────────────────────────────

/** Read and validate JWT secrets at call-time (after dotenv.config). */
function getSecrets() {
  const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
  const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

  if (!ACCESS_SECRET || !REFRESH_SECRET) {
    throw new Error(
      "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set in .env\n" +
        "Generate: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"",
    );
  }

  return { ACCESS_SECRET, REFRESH_SECRET };
}

// ── Public API ────────────────────────────────────────────────

/**
 * Sign an access token.
 * @param {{ userId: string, email: string }} payload
 * @returns {string} signed JWT
 */
export function signAccessToken(payload) {
  const { ACCESS_SECRET } = getSecrets();
  return jwt.sign(
    { sub: payload.userId, email: payload.email },
    ACCESS_SECRET,
    { expiresIn: ACCESS_TTL },
  );
}

/**
 * Sign a refresh token.
 * @param {{ userId: string }} payload
 * @returns {string} signed JWT
 */
export function signRefreshToken(payload) {
  const { REFRESH_SECRET } = getSecrets();
  return jwt.sign({ sub: payload.userId }, REFRESH_SECRET, {
    expiresIn: REFRESH_TTL,
  });
}

/**
 * Verify an access token.
 * @param {string} token
 * @returns {{ sub: string, email: string, iat: number, exp: number }}
 * @throws {jwt.JsonWebTokenError | jwt.TokenExpiredError}
 */
export function verifyAccessToken(token) {
  const { ACCESS_SECRET } = getSecrets();
  return jwt.verify(token, ACCESS_SECRET);
}

/**
 * Verify a refresh token.
 * @param {string} token
 * @returns {{ sub: string, iat: number, exp: number }}
 * @throws {jwt.JsonWebTokenError | jwt.TokenExpiredError}
 */
export function verifyRefreshToken(token) {
  const { REFRESH_SECRET } = getSecrets();
  return jwt.verify(token, REFRESH_SECRET);
}

/**
 * Cookie options for the refresh token.
 * Returns a new object each time so callers can safely mutate (e.g. clearCookie).
 * `secure` is read at call-time so NODE_ENV works correctly after dotenv.
 */
export function getRefreshCookieOpts() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    path: "/auth", // cookie only sent to /auth/* routes
  };
}

/**
 * @deprecated Use getRefreshCookieOpts() — kept for any code referencing this name.
 * Will be removed in a future cleanup.
 */
export const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: false, // conservative default; getRefreshCookieOpts() reads env correctly
  sameSite: "strict",
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/auth",
};
