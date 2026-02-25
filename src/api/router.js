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
import legacyRoutes from "./legacy.router.js";

const router = Router();

router.use("/auth", authRoutes);
router.use("/github", githubRoutes);
router.use("/projects", projectRoutes);

// backward-compatible legacy API
router.use("/api", legacyRoutes);

export default router;
