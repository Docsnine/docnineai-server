// ===================================================================
// Controllers are thin: call service → format response.
// All business logic lives in auth.service.js.
// ===================================================================

import * as authService from "./auth.service.js";
import { ok, fail, serverError } from "../../utils/response.util.js";
import { getRefreshCookieOpts } from "../../utils/jwt.util.js";

// ── POST /auth/signup ─────────────────────────────────────────
export async function signup(req, res) {
  const { name, email, password } = req.body;
  try {
    const { user, accessToken, refreshToken } = await authService.signup({
      name,
      email,
      password,
    });
    res.cookie("refreshToken", refreshToken, getRefreshCookieOpts());
    return ok(
      res,
      { user, accessToken },
      "Account created. Check your email to verify.",
      201,
    );
  } catch (err) {
    if (err.code === "EMAIL_TAKEN")
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "signup");
  }
}

// ── POST /auth/login ──────────────────────────────────────────
export async function login(req, res) {
  const { email, password } = req.body;
  try {
    const { user, accessToken, refreshToken } = await authService.login({
      email,
      password,
    });
    res.cookie("refreshToken", refreshToken, getRefreshCookieOpts());
    return ok(res, { user, accessToken }, "Login successful");
  } catch (err) {
    if (err.code === "INVALID_CREDENTIALS")
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "login");
  }
}

// ── POST /auth/logout ─────────────────────────────────────────
export async function logout(req, res) {
  try {
    await authService.logout(req.user.userId);
    // Clear the cookie with the same options it was set with (except maxAge→0)
    res.clearCookie("refreshToken", { ...getRefreshCookieOpts(), maxAge: 0 });
    return ok(res, null, "Logged out successfully.");
  } catch (err) {
    return serverError(res, err, "logout");
  }
}

// ── POST /auth/refresh ────────────────────────────────────────
export async function refresh(req, res) {
  const token = req.cookies?.refreshToken;
  try {
    const { user, accessToken, refreshToken } =
      await authService.refreshSession(token);
    res.cookie("refreshToken", refreshToken, getRefreshCookieOpts());
    return ok(res, { user, accessToken }, "Token refreshed successfully.");
  } catch (err) {
    const KNOWN = [
      "NO_REFRESH_TOKEN",
      "INVALID_REFRESH_TOKEN",
      "REFRESH_TOKEN_REUSED",
    ];
    if (KNOWN.includes(err.code))
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "refresh");
  }
}

// ── POST /auth/verify-email ───────────────────────────────────
export async function verifyEmail(req, res) {
  const { token } = req.body;
  try {
    const user = await authService.verifyEmail(token);
    return ok(res, { email: user.email }, "Email verified successfully.");
  } catch (err) {
    if (err.code === "INVALID_VERIFICATION_TOKEN")
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "verifyEmail");
  }
}

// ── POST /auth/forgot-password ────────────────────────────────
export async function forgotPassword(req, res) {
  const { email } = req.body;
  try {
    // Always 200 — prevents email enumeration
    await authService.forgotPassword(email);
    return ok(
      res,
      null,
      "If that email is registered, a reset link has been sent.",
    );
  } catch (err) {
    return serverError(res, err, "forgotPassword");
  }
}

// ── POST /auth/reset-password ─────────────────────────────────
export async function resetPassword(req, res) {
  const { token, password } = req.body;
  try {
    await authService.resetPassword({ token, password });
    return ok(res, null, "Password reset successfully. Please log in again.");
  } catch (err) {
    if (err.code === "INVALID_RESET_TOKEN")
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "resetPassword");
  }
}

// ── GET /auth/me ──────────────────────────────────────────────
export async function getMe(req, res) {
  try {
    const user = await authService.getMe(req.user.userId);
    return ok(res, { user });
  } catch (err) {
    if (err.code === "USER_NOT_FOUND")
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "getMe");
  }
}

// ── PATCH /auth/profile ───────────────────────────────────────
export async function updateProfile(req, res) {
  const { name, email } = req.body;
  try {
    const user = await authService.updateProfile(req.user.userId, { name, email });
    return ok(res, { user }, "Profile updated successfully.");
  } catch (err) {
    if (["USER_NOT_FOUND", "EMAIL_TAKEN"].includes(err.code))
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "updateProfile");
  }
}

// ── POST /auth/change-password ────────────────────────────────
export async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  try {
    await authService.changePassword(req.user.userId, { currentPassword, newPassword });
    // Clear the refresh cookie — user must log in again with the new password.
    res.clearCookie("refreshToken", { ...getRefreshCookieOpts(), maxAge: 0 });
    return ok(res, null, "Password changed successfully. Please log in again.");
  } catch (err) {
    if (["USER_NOT_FOUND", "INVALID_CREDENTIALS"].includes(err.code))
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "changePassword");
  }
}

// ── GET /auth/github/start ────────────────────────────────────
export function githubLoginStart(req, res) {
  try {
    const url = authService.getGithubLoginUrl();
    return res.redirect(url);
  } catch (err) {
    if (err.code === "GITHUB_LOGIN_NOT_CONFIGURED")
      return fail(res, err.code, err.message, 503);
    return serverError(res, err, "githubLoginStart");
  }
}

// ── GET /auth/github/callback ─────────────────────────────────
export async function githubLoginCallback(req, res) {
  const { code, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  if (error || !code) {
    return res.redirect(`${frontendUrl}/auth/callback?error=access_denied`);
  }

  try {
    const { user, accessToken, refreshToken } = await authService.githubSocialLogin(code);
    res.cookie("refreshToken", refreshToken, getRefreshCookieOpts());
    // Pass access token to frontend via URL so it can store in memory
    return res.redirect(
      `${frontendUrl}/auth/callback?accessToken=${encodeURIComponent(accessToken)}&userId=${user._id}`,
    );
  } catch (err) {
    const knownCodes = ["GITHUB_CODE_INVALID", "GITHUB_NO_EMAIL", "GITHUB_LOGIN_NOT_CONFIGURED"];
    const code_ = knownCodes.includes(err.code) ? err.code : "OAUTH_ERROR";
    return res.redirect(`${frontendUrl}/auth/callback?error=${code_}`);
  }
}

// ── GET /auth/google/start ────────────────────────────────────
export function googleLoginStart(req, res) {
  try {
    const url = authService.getGoogleLoginUrl();
    return res.redirect(url);
  } catch (err) {
    if (err.code === "GOOGLE_LOGIN_NOT_CONFIGURED")
      return fail(res, err.code, err.message, 503);
    return serverError(res, err, "googleLoginStart");
  }
}

// ── GET /auth/google/callback ─────────────────────────────────
export async function googleLoginCallback(req, res) {
  const { code, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  if (error || !code) {
    return res.redirect(`${frontendUrl}/auth/callback?error=access_denied`);
  }

  try {
    const { user, accessToken, refreshToken } = await authService.googleSocialLogin(code);
    res.cookie("refreshToken", refreshToken, getRefreshCookieOpts());
    return res.redirect(
      `${frontendUrl}/auth/callback?accessToken=${encodeURIComponent(accessToken)}&userId=${user._id}`,
    );
  } catch (err) {
    const knownCodes = ["GOOGLE_CODE_INVALID", "GOOGLE_NO_EMAIL", "GOOGLE_LOGIN_NOT_CONFIGURED"];
    const code_ = knownCodes.includes(err.code) ? err.code : "OAUTH_ERROR";
    return res.redirect(`${frontendUrl}/auth/callback?error=${code_}`);
  }
}

// ── GET /auth/google-docs/callback ───────────────────────────
// Called after user grants Google Drive / Docs access via project export flow
export async function googleDocsCallback(req, res) {
  const { code, state: userId, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  if (error || !code || !userId) {
    return res.redirect(`${frontendUrl}/settings?googleDocs=error`);
  }

  try {
    const { handleGoogleDocsCallback } = await import("../../services/googleDocs.service.js");
    await handleGoogleDocsCallback(code, userId);
    return res.redirect(`${frontendUrl}/settings?googleDocs=connected`);
  } catch (err) {
    console.error("Google Docs callback error:", err.message);
    return res.redirect(`${frontendUrl}/settings?googleDocs=error`);
  }
}

// ── GET /auth/google-docs/status ──────────────────────────────
export async function googleDocsStatusForUser(req, res) {
  try {
    const { getGoogleDocsConnectionStatus } = await import("../../services/googleDocs.service.js");
    const status = await getGoogleDocsConnectionStatus(req.user.userId);
    return ok(res, status);
  } catch (err) {
    return serverError(res, err, "googleDocsStatusForUser");
  }
}

// ── GET /auth/google-docs/start ───────────────────────────────
export async function googleDocsStart(req, res) {
  try {
    const { getGoogleDocsOAuthUrl } = await import("../../services/googleDocs.service.js");
    const url = getGoogleDocsOAuthUrl(req.user.userId);
    return ok(res, { url }, "Redirect to Google to grant Drive/Docs access.");
  } catch (err) {
    if (err.message?.includes("GOOGLE_DOCS_CLIENT_ID"))
      return fail(res, "GOOGLE_DOCS_NOT_CONFIGURED", err.message, 503);
    return serverError(res, err, "googleDocsStart");
  }
}

// ── DELETE /auth/google-docs ──────────────────────────────────
export async function googleDocsDisconnectForUser(req, res) {
  try {
    const { disconnectGoogleDocs } = await import("../../services/googleDocs.service.js");
    await disconnectGoogleDocs(req.user.userId);
    return ok(res, null, "Google Drive disconnected.");
  } catch (err) {
    return serverError(res, err, "googleDocsDisconnectForUser");
  }
}
