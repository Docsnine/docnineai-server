// ===================================================================
// All project routes require authentication + API rate limiting.
//
// Full route map:
//   POST   /projects                  Create + start pipeline
//   GET    /projects                  List (paginated, filtered, searched)
//   GET    /projects/:id              Project detail (includes output)
//   DELETE /projects/:id              Hard-delete (blocked while running)
//   PATCH  /projects/:id              Archive (blocked while running)
//   POST   /projects/:id/retry        Re-run pipeline (error or done only)
//   GET    /projects/:id/stream       SSE live pipeline events
//   GET    /projects/:id/export/pdf   Download PDF from MongoDB data
//   GET    /projects/:id/export/yaml  Download GitHub Actions YAML
//   POST   /projects/:id/export/notion Push to Notion
//
// Validation strategy:
//   mongoId  — validates :id param, calls validate() ONCE
//   Body rules are in separate arrays and get their own validate() call.
//   Never compose mongoId + body-rule validate in a single spread —
//   that would fire validate() twice and short-circuit on param errors
//   before body rules run.
// ===================================================================

import { Router } from "express";
import { param } from "express-validator";
import * as ctrl from "./project.controller.js";
import { protect } from "../../middleware/auth.middleware.js";
import { rules, validate } from "../../middleware/validate.middleware.js";
import { apiLimiter } from "../../middleware/rateLimiter.middleware.js";
import { wrap } from "../../utils/response.util.js";

const router = Router();
router.use(protect, apiLimiter);

// ── Param validators ─────────────────────────────────────────
// validateMongoId: validate :id param, call validate() ONCE.
// validatePatchBody: validate request body ONLY (param done by mongoId).
const validateMongoId = [
  param("id").isMongoId().withMessage("Invalid project ID"),
  validate,
];
const validatePatchBody = [...rules.updateProject, validate];

// ── Collection routes ─────────────────────────────────────────
router.post("/", rules.createProject, validate, wrap(ctrl.createProject));
router.get("/", rules.listProjects, validate, wrap(ctrl.listProjects));

// ── Item routes ───────────────────────────────────────────────
router.get("/:id", validateMongoId, wrap(ctrl.getProject));
router.delete("/:id", validateMongoId, wrap(ctrl.deleteProject));
router.patch(
  "/:id",
  validateMongoId,
  validatePatchBody,
  wrap(ctrl.updateProject),
);

// ── Pipeline actions ──────────────────────────────────────────
// Re-run pipeline for error or done projects
router.post("/:id/retry", validateMongoId, wrap(ctrl.retryProject));

// SSE stream — no wrap() (long-lived streaming, not JSON response)
router.get("/:id/stream", validateMongoId, ctrl.streamProject);

// ── Export routes — work from MongoDB (survive server restarts) ──
router.get("/:id/export/pdf", validateMongoId, wrap(ctrl.exportPdf));
router.get("/:id/export/yaml", validateMongoId, wrap(ctrl.exportYaml));
router.post("/:id/export/notion", validateMongoId, wrap(ctrl.exportNotion));

export default router;
