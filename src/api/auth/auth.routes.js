// src/api/auth/auth.routes.js
// ─────────────────────────────────────────────────────────────
// Auth router — mounted at /auth in server.js
//
// Middleware chain per route:
//   [rateLimiter?] → [validation rules] → validate → controller
// ─────────────────────────────────────────────────────────────

import { Router } from "express";
import * as ctrl from "./auth.controller.js";
import { rules, validate } from "../../middleware/validate.middleware.js";
import { protect } from "../../middleware/auth.middleware.js";
import {
  authLimiter,
  signupLimiter,
} from "../../middleware/rateLimiter.middleware.js";
import { wrap } from "../../utils/response.util.js";

const router = Router();

// ── Public ────────────────────────────────────────────────────
router.post(
  "/signup",
  signupLimiter,
  rules.signup,
  validate,
  wrap(ctrl.signup),
);
router.post("/login", authLimiter, rules.login, validate, wrap(ctrl.login));
router.post(
  "/verify-email",
  rules.verifyEmail,
  validate,
  wrap(ctrl.verifyEmail),
);
router.post(
  "/forgot-password",
  authLimiter,
  rules.forgotPassword,
  validate,
  wrap(ctrl.forgotPassword),
);
router.post(
  "/reset-password",
  rules.resetPassword,
  validate,
  wrap(ctrl.resetPassword),
);

// Uses httpOnly refresh token cookie — no Bearer token needed
router.post("/refresh", wrap(ctrl.refresh));

// ── Protected ─────────────────────────────────────────────────
router.post("/logout", protect, wrap(ctrl.logout));
router.get("/me", protect, wrap(ctrl.getMe));

export default router;
