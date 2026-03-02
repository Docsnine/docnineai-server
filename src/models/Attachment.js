// =============================================================
// Attachment — supplementary document files uploaded to a project.
//
// Files are stored as binary Buffer data directly in MongoDB
// (self-contained; no external storage dependency).
// Max practical size: 10 MB per file (enforced in multer config).
//
// The `data` field is select:false — only fetched when streaming
// a download, keeping list queries lightweight.
// =============================================================

import mongoose from "mongoose";

const { Schema, model } = mongoose;

const AttachmentSchema = new Schema(
  {
    // ── Ownership / association ───────────────────────────────
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    uploaderName: { type: String, default: "Unknown" },

    // ── File metadata ─────────────────────────────────────────
    fileName: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true }, // bytes

    // ── Optional context ──────────────────────────────────────
    description: { type: String, default: "", trim: true },

    // ── Binary content ────────────────────────────────────────
    // select:false — never returned in list queries.
    data: { type: Buffer, required: true, select: false },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

AttachmentSchema.index({ projectId: 1, createdAt: -1 });

export const Attachment = model("Attachment", AttachmentSchema);