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
//
//   ── Attachments (Other Docs) ─────────────────────────────────
//   GET    /projects/:id/attachments
//   POST   /projects/:id/attachments          (multipart/form-data, field: file)
//   GET    /projects/:id/attachments/:attachmentId   (stream / download)
//   PATCH  /projects/:id/attachments/:attachmentId   (update description)
//   DELETE /projects/:id/attachments/:attachmentId
//

//
//   ── API Spec (OpenAPI / Postman importer) ────────────────────
//   GET    /projects/:id/apispec
//   POST   /projects/:id/apispec/import          (file | url | raw)
//   POST   /projects/:id/apispec/sync            (URL source only)
//   DELETE /projects/:id/apispec
//   PATCH  /projects/:id/apispec/endpoint        (custom note)
//   POST   /projects/:id/apispec/try             (Try It proxy)
// =============================================================

import { Router } from "express";
import { param, body } from "express-validator";
import multer from "multer";
import * as ctrl from "./project.controller.js";
import * as attachmentCtrl from "./attachment.controller.js";
import * as shareCtrl from "./share.controller.js";
import * as portalCtrl from "../portal/portal.controller.js";
import apispecRoutes from "../apispec/apispec.routes.js";
import { protect } from "../../middleware/auth.middleware.js";
import { rules, validate } from "../../middleware/validate.middleware.js";
import { apiLimiter } from "../../middleware/rateLimiter.middleware.js";
import { checkProjectLimit, checkPortalPublishLimit } from "../../middleware/plan-gate.middleware.js";
import { wrap } from "../../utils/response.util.js";
import { SECTIONS } from "../../models/DocumentVersion.js";

const router = Router();
router.use(protect, apiLimiter);

// ── Multer — in-memory storage for file uploads ───────────────
// 10 MB limit; all file types accepted (content-type checked in controller).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

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

// ── Shared-with-me (must come before /:id to avoid param collision) ──────────
router.get("/shared", wrap(shareCtrl.getSharedProjects));

// ── Collection ────────────────────────────────────────────────
router.post("/", rules.createProject, validate, checkProjectLimit, wrap(ctrl.createProject));
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

// Google Docs export
router.get("/:id/export/google-docs/connect", validateMongoId, wrap(ctrl.googleDocsConnect));
router.get("/:id/export/google-docs/status", validateMongoId, wrap(ctrl.googleDocsStatus));
router.delete("/:id/export/google-docs", validateMongoId, wrap(ctrl.googleDocsDisconnect));
router.post("/:id/export/google-docs", validateMongoId, wrap(ctrl.exportGoogleDocs));

// ── Chat (streaming SSE — chatHandler not wrapped; resetChat is wrapped) ──────
router.post("/:id/chat", validateMongoId, ctrl.chatHandler);
router.delete("/:id/chat", validateMongoId, wrap(ctrl.resetChat));

// ── Sharing ───────────────────────────────────────────────────
const validateShareId = [
  param("shareId").isMongoId().withMessage("Invalid share ID"),
  validate,
];

// Accept an invite — requires the user be logged in
router.post("/share/accept/:token", wrap(shareCtrl.acceptInvite));

router.post("/:id/share", validateMongoId, wrap(shareCtrl.inviteUsers));
router.get("/:id/share", validateMongoId, wrap(shareCtrl.listAccess));
router.patch("/:id/share/:shareId", validateMongoId, validateShareId, wrap(shareCtrl.changeRole));
router.delete("/:id/share/:shareId", validateMongoId, validateShareId, wrap(shareCtrl.revokeAccess));
router.post("/:id/share/:shareId/resend", validateMongoId, validateShareId, wrap(shareCtrl.resendInvite));
router.delete("/:id/share/:shareId/cancel", validateMongoId, validateShareId, wrap(shareCtrl.cancelInvite));

// ── Attachments (Other Docs) ──────────────────────────────────
const validateAttachmentId = [
  param("attachmentId").isMongoId().withMessage("Invalid attachment ID"),
  validate,
];

router.get(
  "/:id/attachments",
  validateMongoId,
  wrap(attachmentCtrl.listAttachments),
);
router.post(
  "/:id/attachments",
  validateMongoId,
  upload.single("file"),
  wrap(attachmentCtrl.uploadAttachment),
);
// Download / preview — not wrapped (binary streaming response)
router.get(
  "/:id/attachments/:attachmentId",
  validateMongoId,
  validateAttachmentId,
  attachmentCtrl.downloadAttachment,
);
router.patch(
  "/:id/attachments/:attachmentId",
  validateMongoId,
  validateAttachmentId,
  [
    body("description").isString().withMessage("description must be a string"),
    validate,
  ],
  wrap(attachmentCtrl.updateAttachment),
);
router.delete(
  "/:id/attachments/:attachmentId",
  validateMongoId,
  validateAttachmentId,
  wrap(attachmentCtrl.deleteAttachment),
);

// ── Portal (owner only) ───────────────────────────────────────
// GET    /projects/:id/portal          — get portal settings
// PUT    /projects/:id/portal          — upsert portal settings
// POST   /projects/:id/portal/publish  — toggle isPublished

router.get("/:id/portal", validateMongoId, wrap(portalCtrl.getOwnerPortal));
router.put("/:id/portal", validateMongoId, wrap(portalCtrl.upsertPortal));
router.post("/:id/portal/publish", validateMongoId, checkPortalPublishLimit, wrap(portalCtrl.togglePublish));


// ── API Spec (OpenAPI / Postman importer) ─────────────────────
// GET    /projects/:id/apispec          — get imported spec
// POST   /projects/:id/apispec/import   — import (file | url | raw)
// POST   /projects/:id/apispec/sync     — re-fetch URL source
// DELETE /projects/:id/apispec          — remove spec
// PATCH  /projects/:id/apispec/endpoint — update endpoint custom note
// POST   /projects/:id/apispec/try      — Try-It proxy

router.use("/:id/apispec", validateMongoId, apispecRoutes);

export default router;
