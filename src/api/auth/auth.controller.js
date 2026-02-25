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
