// src/api/github/github.routes.js
// ─────────────────────────────────────────────────────────────
// Route ordering is critical here:
//
//   /oauth/callback — PUBLIC, no Bearer token.
//     GitHub redirects the browser here. User identity is carried in
//     the signed `state` JWT embedded at flow-start, not an auth header.
//     Must come BEFORE router.use(protect) or it will 401.
//
//   All other routes — require valid Bearer access token + API rate limit.
// ─────────────────────────────────────────────────────────────

import { Router } from "express";
import * as ctrl from "./github.controller.js";
import { protect } from "../../middleware/auth.middleware.js";
import { apiLimiter } from "../../middleware/rateLimiter.middleware.js";
import { wrap } from "../../utils/response.util.js";

const router = Router();

// ── Public (no auth) — identity via state JWT ─────────────────
router.get("/oauth/callback", wrap(ctrl.oauthCallback));

// ── Protected — access token + rate limit ─────────────────────
router.use(protect, apiLimiter);

router.get("/oauth/start", wrap(ctrl.oauthStart));
router.get("/repos", wrap(ctrl.listRepos));
router.get("/status", wrap(ctrl.connectionStatus));
router.delete("/disconnect", wrap(ctrl.disconnect));

export default router;
