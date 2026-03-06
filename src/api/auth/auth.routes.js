// ===================================================================
// Auth router — mounted at /auth in server.js
//
// Middleware chain per route:
//   [rateLimiter?] → [validation rules] → validate → controller
// ===================================================================

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

// ── OAuth — Social Login (GitHub) ─────────────────────────────
// The callbacks use redirect so they must NOT be JSON-wrapped.
router.get("/github/start", ctrl.githubLoginStart);
router.get("/github/callback", wrap(ctrl.githubLoginCallback));

// ── OAuth — Social Login (Google) ────────────────────────────
router.get("/google/start", ctrl.googleLoginStart);
router.get("/google/callback", wrap(ctrl.googleLoginCallback));

// ── OAuth — Google Docs export ────────────────────────────────
router.get("/google-docs/callback", wrap(ctrl.googleDocsCallback));
// Settings page endpoints (protected — require JWT)
router.get("/google-docs/status", protect, wrap(ctrl.googleDocsStatusForUser));
router.get("/google-docs/start", protect, wrap(ctrl.googleDocsStart));
router.delete("/google-docs", protect, wrap(ctrl.googleDocsDisconnectForUser));

// ── Notion integration (per-user API key) ────────────────────
router.post("/notion/connect", protect, wrap(ctrl.notionConnect));
router.get("/notion/status", protect, wrap(ctrl.notionStatus));
router.delete("/notion", protect, wrap(ctrl.notionDisconnect));

// ── Webhook Integration (settings-level, global) ──────────────
router.get("/webhook/status", protect, wrap(ctrl.webhookStatus));
router.post("/webhook/init", protect, wrap(ctrl.initWebhook));
router.post("/webhook/rotate", protect, wrap(ctrl.rotateWebhookSecret));
router.patch("/webhook", protect, wrap(ctrl.updateWebhookSettings));

// ── Protected ─────────────────────────────────────────────────
router.post("/logout", protect, wrap(ctrl.logout));
router.get("/me", protect, wrap(ctrl.getMe));
router.patch(
  "/profile",
  protect,
  rules.updateProfile,
  validate,
  wrap(ctrl.updateProfile),
);
router.post(
  "/change-password",
  protect,
  rules.changePassword,
  validate,
  wrap(ctrl.changePassword),
);

export default router;
