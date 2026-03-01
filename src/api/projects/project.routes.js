// =============================================================
// Full route map:
//
//   POST   /projects                          create + start pipeline
//   GET    /projects                          list (paginated, filtered)
//   GET    /projects/:id                      detail + effectiveOutput
//   PATCH  /projects/:id                      archive
//   DELETE /projects/:id                      hard delete
//   POST   /projects/:id/retry                full re-run
//   POST   /projects/:id/sync                 incremental sync (?force=true for full)
//   GET    /projects/:id/stream               SSE live events
//
//   ── Document editing ────────────────────────────────────────
//   PATCH  /projects/:id/docs/:section        save user edit
//   DELETE /projects/:id/docs/:section/edit   revert to AI version
//   POST   /projects/:id/docs/:section/accept-ai  accept new AI after stale sync
//
//   ── Version history ─────────────────────────────────────────
//   GET    /projects/:id/docs/:section/versions             list (no content)
//   GET    /projects/:id/docs/:section/versions/:versionId  full content
//   POST   /projects/:id/docs/:section/versions/:versionId/restore
//
//   ── Exports (read from MongoDB — survive server restarts) ───
//   GET    /projects/:id/export/pdf
//   GET    /projects/:id/export/yaml
//   POST   /projects/:id/export/notion
// =============================================================

import { Router } from "express";
import { param, body } from "express-validator";
import * as ctrl from "./project.controller.js";
import { protect } from "../../middleware/auth.middleware.js";
import { rules, validate } from "../../middleware/validate.middleware.js";
import { apiLimiter } from "../../middleware/rateLimiter.middleware.js";
import { wrap } from "../../utils/response.util.js";
import { SECTIONS } from "../../models/DocumentVersion.js";

const router = Router();
router.use(protect, apiLimiter);

// ── Param validators ──────────────────────────────────────────
const validateMongoId = [
  param("id").isMongoId().withMessage("Invalid project ID"),
  validate,
];
const validatePatchBody = [...rules.updateProject, validate];
const validateSection = [
  param("section")
    .isIn(SECTIONS)
    .withMessage(`section must be one of: ${SECTIONS.join(", ")}`),
  validate,
];
const validateVersionId = [
  param("versionId").isMongoId().withMessage("Invalid version ID"),
  validate,
];

// ── Collection ────────────────────────────────────────────────
router.post("/", rules.createProject, validate, wrap(ctrl.createProject));
router.get("/", rules.listProjects, validate, wrap(ctrl.listProjects));

// ── Item ──────────────────────────────────────────────────────
router.get("/:id", validateMongoId, wrap(ctrl.getProject));
router.delete("/:id", validateMongoId, wrap(ctrl.deleteProject));
router.patch(
  "/:id",
  validateMongoId,
  validatePatchBody,
  wrap(ctrl.updateProject),
);

// ── Pipeline actions ──────────────────────────────────────────
router.post("/:id/retry", validateMongoId, wrap(ctrl.retryProject));
router.post("/:id/sync", validateMongoId, wrap(ctrl.syncProject));

// SSE (not wrapped — streaming response)
router.get("/:id/stream", validateMongoId, ctrl.streamProject);
// Persisted event log
router.get("/:id/events", validateMongoId, wrap(ctrl.getProjectEvents));
// ── Document editing ──────────────────────────────────────────
router.patch(
  "/:id/docs/:section",
  validateMongoId,
  validateSection,
  [
    body("content").isString().notEmpty().withMessage("content is required"),
    validate,
  ],
  wrap(ctrl.editDocSection),
);

router.delete(
  "/:id/docs/:section/edit",
  validateMongoId,
  validateSection,
  wrap(ctrl.revertDocSection),
);

router.post(
  "/:id/docs/:section/accept-ai",
  validateMongoId,
  validateSection,
  wrap(ctrl.acceptAISection),
);

// ── Version history ───────────────────────────────────────────
router.get(
  "/:id/docs/:section/versions",
  validateMongoId,
  validateSection,
  wrap(ctrl.listVersions),
);

router.get(
  "/:id/docs/:section/versions/:versionId",
  validateMongoId,
  validateSection,
  validateVersionId,
  wrap(ctrl.getVersion),
);

router.post(
  "/:id/docs/:section/versions/:versionId/restore",
  validateMongoId,
  validateSection,
  validateVersionId,
  wrap(ctrl.restoreVersion),
);

// ── Exports ───────────────────────────────────────────────────
router.get("/:id/export/pdf", validateMongoId, wrap(ctrl.exportPdf));
router.get("/:id/export/yaml", validateMongoId, wrap(ctrl.exportYaml));
router.post("/:id/export/notion", validateMongoId, wrap(ctrl.exportNotion));

export default router;
