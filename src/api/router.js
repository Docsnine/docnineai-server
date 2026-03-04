// ===================================================================
// Central API router
//
// Route map:
//   /auth          — authentication & session management
//   /github        — GitHub OAuth + repository access
//   /projects      — project CRUD + pipeline + SSE stream + exports
//   /api           — legacy pipeline routes (backward-compatible)
//                    unchanged from v2; uses shared jobRegistry
// ===================================================================

import { Router } from "express";
import authRoutes from "./auth/auth.routes.js";
import githubRoutes from "./github/github.routes.js";
import projectRoutes from "./projects/project.routes.js";
import portalRoutes from "./portal/portal.routes.js";
import billingRoutes from "./billing/billing.routes.js";
import legacyRoutes from "./legacy.router.js";
import { handleFlutterwaveWebhook } from "./billing/billing.webhook.js";

const router = Router();

router.use("/auth", authRoutes);
router.use("/github", githubRoutes);
router.use("/projects", projectRoutes);
router.use("/portal", portalRoutes); // public — no auth
router.use("/billing", billingRoutes);

// Flutterwave webhook — raw body verified inside handler.
// Path must stay under /api/webhook/* so the express.raw() middleware
// in app.js buffers the body before express.json() can consume it.
router.post("/webhook/flutterwave", handleFlutterwaveWebhook);

// backward-compatible legacy API
router.use("/api", legacyRoutes);

export default router;
