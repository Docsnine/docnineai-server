// ===================================================================
// Admin routes — all protected by protect + requireRole('super-admin')
// ===================================================================

import { Router } from "express";
import { protect } from "../../middleware/auth.middleware.js";
import { requireRole } from "../../middleware/auth.middleware.js";
import * as adminCtrl from "./admin.controller.js";

const router = Router();

// All admin routes require authentication + super-admin role
router.use(protect, requireRole("super-admin"));

// ── Stats ─────────────────────────────────────────────────────
router.get("/stats", adminCtrl.getStats);

// ── Users ─────────────────────────────────────────────────────
router.get("/users", adminCtrl.listUsers);
router.delete("/users/:id", adminCtrl.deleteUser);

// ── Projects ──────────────────────────────────────────────────
router.get("/projects", adminCtrl.listProjects);
router.delete("/projects/:id", adminCtrl.deleteProject);

// ── Subscriptions ─────────────────────────────────────────────
router.get("/subscriptions", adminCtrl.listSubscriptions);

export default router;
