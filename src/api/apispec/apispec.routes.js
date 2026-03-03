// =============================================================
// apispec.routes.js
//
// Mounted under /projects/:id/apispec (nested router).
// All routes require the caller to already be authenticated
// via the parent project router's `protect + apiLimiter`.
// =============================================================

import { Router } from "express";
import { body, param } from "express-validator";
import multer from "multer";
import * as ctrl from "./apispec.controller.js";
import { validate } from "../../middleware/validate.middleware.js";
import { wrap } from "../../utils/response.util.js";

const router = Router({ mergeParams: true }); // gives access to :id from parent

// Multer: memory storage, 5 MB, only accept JSON / YAML / text
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowed = [
      "application/json",
      "application/x-yaml",
      "application/yaml",
      "text/yaml",
      "text/plain",
      "text/x-yaml",
    ];
    const ok =
      allowed.includes(file.mimetype) ||
      /\.(json|yaml|yml)$/i.test(file.originalname);
    cb(ok ? null : new Error("Only JSON / YAML files are accepted."), ok);
  },
});

// ── GET /projects/:id/apispec ─────────────────────────────────
router.get("/", wrap(ctrl.getSpec));

// ── POST /projects/:id/apispec/import ─────────────────────────
// Accepts multipart (file upload) OR JSON body { method, raw|url, autoSync }
router.post(
  "/import",
  upload.single("file"),
  [
    body("method")
      .optional()
      .isIn(["file", "url", "raw"])
      .withMessage("method must be file, url, or raw"),
    body("url")
      .optional()
      .isURL({ require_protocol: true })
      .withMessage("url must be a valid URL starting with http(s)"),
    validate,
  ],
  wrap(ctrl.importSpec),
);

// ── POST /projects/:id/apispec/sync ──────────────────────────
router.post("/sync", wrap(ctrl.syncSpec));

// ── DELETE /projects/:id/apispec ─────────────────────────────
router.delete("/", wrap(ctrl.deleteSpec));

// ── PATCH /projects/:id/apispec/endpoint ─────────────────────
router.patch(
  "/endpoint",
  [
    body("endpointId")
      .isString()
      .notEmpty()
      .withMessage("endpointId is required"),
    body("note").optional().isString(),
    validate,
  ],
  wrap(ctrl.updateEndpointNote),
);

// ── POST /projects/:id/apispec/try ───────────────────────────
router.post(
  "/try",
  [
    body("method").isString().notEmpty().withMessage("method is required"),
    body("baseUrl")
      .isURL({ require_protocol: true })
      .withMessage("baseUrl must be a valid URL"),
    body("path").isString().notEmpty().withMessage("path is required"),
    validate,
  ],
  wrap(ctrl.tryRequest),
);

export default router;
