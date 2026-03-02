// =============================================================
// Attachment controller
//
// Routes (mounted under /projects/:id/attachments):
//   GET    /                   listAttachments
//   POST   /                   uploadAttachment
//   GET    /:attachmentId      downloadAttachment (inline or download)
//   PATCH  /:attachmentId      updateAttachment (description)
//   DELETE /:attachmentId      deleteAttachment
// =============================================================

import { Attachment } from "../../models/Attachment.js";
import { User } from "../../models/User.js";
import { ok, fail, serverError } from "../../utils/response.util.js";
import { getShareRole } from "./share.service.js";

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// MIME types where inline preview makes sense in the browser
const INLINE_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

function domainError(msg, code, status = 400) {
  const e = new Error(msg);
  e.code = code;
  e.status = status;
  return e;
}

/** Any access level (owner, editor, viewer) — just needs to be a member */
async function assertReadAccess(projectId, userId) {
  const role = await getShareRole(projectId, userId);
  if (!role) throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);
  return role;
}

/** Write operations require owner or editor */
async function assertWriteAccess(projectId, userId) {
  const role = await getShareRole(projectId, userId);
  if (!role) throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);
  if (role === "viewer")
    throw domainError("Viewers cannot modify attachments.", "FORBIDDEN", 403);
  return role;
}

// ─────────────────────────────────────────────────────────────
// GET /projects/:id/attachments
// List all attachments for a project (no file data).
// ─────────────────────────────────────────────────────────────
export async function listAttachments(req, res) {
  try {
    await assertReadAccess(req.params.id, req.user.userId);

    const attachments = await Attachment.find({ projectId: req.params.id })
      .sort({ createdAt: -1 })
      .select("-data"); // exclude binary payload

    return ok(res, { attachments });
  } catch (err) {
    if (err.code === "PROJECT_NOT_FOUND") return fail(res, err.code, err.message, 404);
    if (err.code === "FORBIDDEN") return fail(res, err.code, err.message, 403);
    return serverError(res, err, "listAttachments");
  }
}

// ─────────────────────────────────────────────────────────────
// POST /projects/:id/attachments
// Upload a new attachment (multipart/form-data, field: "file").
// Optional body field: description (string).
// ─────────────────────────────────────────────────────────────
export async function uploadAttachment(req, res) {
  try {
    await assertWriteAccess(req.params.id, req.user.userId);

    if (!req.file) {
      return fail(res, "NO_FILE", "No file was uploaded. Use multipart/form-data with field 'file'.", 400);
    }

    if (req.file.size > MAX_SIZE_BYTES) {
      return fail(res, "FILE_TOO_LARGE", `File exceeds the 10 MB limit (got ${(req.file.size / 1024 / 1024).toFixed(2)} MB).`, 413);
    }

    // Resolve uploader display name
    const user = await User.findById(req.user.userId).select("name email");
    const uploaderName = user?.name || user?.email || "Unknown";

    const attachment = await Attachment.create({
      projectId: req.params.id,
      userId: req.user.userId,
      uploaderName,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      description: (req.body.description || "").trim().slice(0, 500),
      data: req.file.buffer,
    });

    // Return metadata only (no data buffer)
    const { data: _omit, ...meta } = attachment.toObject();
    return ok(res, { attachment: meta }, "File uploaded.", 201);
  } catch (err) {
    if (err.code === "PROJECT_NOT_FOUND") return fail(res, err.code, err.message, 404);
    if (err.code === "FORBIDDEN") return fail(res, err.code, err.message, 403);
    return serverError(res, err, "uploadAttachment");
  }
}

// ─────────────────────────────────────────────────────────────
// GET /projects/:id/attachments/:attachmentId
// Stream the file. PDFs and images are sent inline for preview;
// all other types are sent as attachment (triggers download).
// ─────────────────────────────────────────────────────────────
export async function downloadAttachment(req, res) {
  try {
    await assertReadAccess(req.params.id, req.user.userId);

    const attachment = await Attachment.findOne({
      _id: req.params.attachmentId,
      projectId: req.params.id,
    }).select("+data");

    if (!attachment) {
      return fail(res, "ATTACHMENT_NOT_FOUND", "Attachment not found.", 404);
    }

    const inline = INLINE_MIME_TYPES.has(attachment.mimeType)
      ? "inline"
      : "attachment";

    // Encode filename for Content-Disposition (handles spaces & non-ASCII)
    const encoded = encodeURIComponent(attachment.fileName).replace(/'/g, "%27");

    res.setHeader("Content-Type", attachment.mimeType);
    res.setHeader(
      "Content-Disposition",
      `${inline}; filename*=UTF-8''${encoded}`,
    );
    res.setHeader("Content-Length", attachment.size);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(attachment.data);
  } catch (err) {
    if (err.code === "PROJECT_NOT_FOUND") return fail(res, err.code, err.message, 404);
    if (err.code === "FORBIDDEN") return fail(res, err.code, err.message, 403);
    return serverError(res, err, "downloadAttachment");
  }
}

// ─────────────────────────────────────────────────────────────
// PATCH /projects/:id/attachments/:attachmentId
// Update the description of an attachment.
// ─────────────────────────────────────────────────────────────
export async function updateAttachment(req, res) {
  try {
    await assertWriteAccess(req.params.id, req.user.userId);

    const { description } = req.body;
    if (typeof description !== "string") {
      return fail(res, "VALIDATION_ERROR", "description must be a string.", 422);
    }

    const attachment = await Attachment.findOneAndUpdate(
      { _id: req.params.attachmentId, projectId: req.params.id },
      { description: description.trim().slice(0, 500) },
      { new: true, select: "-data" },
    );

    if (!attachment) {
      return fail(res, "ATTACHMENT_NOT_FOUND", "Attachment not found.", 404);
    }

    return ok(res, { attachment }, "Description updated.");
  } catch (err) {
    if (err.code === "PROJECT_NOT_FOUND") return fail(res, err.code, err.message, 404);
    if (err.code === "FORBIDDEN") return fail(res, err.code, err.message, 403);
    return serverError(res, err, "updateAttachment");
  }
}

// ─────────────────────────────────────────────────────────────
// DELETE /projects/:id/attachments/:attachmentId
// Only the project owner can delete.
// ─────────────────────────────────────────────────────────────
export async function deleteAttachment(req, res) {
  try {
    await assertWriteAccess(req.params.id, req.user.userId);

    const deleted = await Attachment.findOneAndDelete({
      _id: req.params.attachmentId,
      projectId: req.params.id,
    });

    if (!deleted) {
      return fail(res, "ATTACHMENT_NOT_FOUND", "Attachment not found.", 404);
    }

    return ok(res, null, "Attachment deleted.");
  } catch (err) {
    if (err.code === "PROJECT_NOT_FOUND") return fail(res, err.code, err.message, 404);
    if (err.code === "FORBIDDEN") return fail(res, err.code, err.message, 403);
    return serverError(res, err, "deleteAttachment");
  }
}
