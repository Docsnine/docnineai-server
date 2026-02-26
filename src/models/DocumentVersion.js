// =============================================================
// Immutable version history for a single documentation section.
//
// Every write to a project's documentation (AI or user) creates
// a DocumentVersion entry BEFORE overwriting. This gives users a
// full audit trail and the ability to restore any previous state.
//
// Sections: readme | internalDocs | apiReference | schemaDocs | securityReport
// Sources:
//   ai_full          — complete pipeline run (first run or full retry)
//   ai_incremental   — only the section was re-generated during a sync
//   user             — user manually edited the section in the UI
//
// Capped at MAX_VERSIONS_PER_SECTION per section per project.
// Oldest versions are pruned synchronously after every write.
// =============================================================

import mongoose from "mongoose";

const { Schema, model } = mongoose;

export const SECTIONS = [
  "readme",
  "internalDocs",
  "apiReference",
  "schemaDocs",
  "securityReport",
];
export const MAX_VERSIONS_PER_SECTION = 20;

const DocumentVersionSchema = new Schema(
  {
    // ── Ownership ─────────────────────────────────────────────
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },

    // ── Which doc section this version is for ─────────────────
    section: {
      type: String,
      enum: SECTIONS,
      required: true,
    },

    // ── The content snapshot ──────────────────────────────────
    content: {
      type: String,
      required: true,
    },

    // ── How this version was created ──────────────────────────
    source: {
      type: String,
      enum: ["ai_full", "ai_incremental", "user"],
      required: true,
    },

    // ── Optional metadata for traceability ───────────────────
    meta: {
      // For AI versions: which git commit was the repo at
      commitSha: String,
      // For incremental versions: which files triggered the regen
      changedFiles: [String],
      // Which agents ran and produced this content
      agentsRun: [String],
      // Human-readable summary of what changed (for the UI timeline)
      changeSummary: String,
    },
  },
  {
    timestamps: true, // createdAt is the version timestamp
    versionKey: false,
  },
);

// ── Indexes ───────────────────────────────────────────────────
// List versions for a section: newest first
DocumentVersionSchema.index({ projectId: 1, section: 1, createdAt: -1 });

// ── Static helper: create a version + prune old ones ─────────
DocumentVersionSchema.statics.createVersion = async function ({
  projectId,
  section,
  content,
  source,
  meta = {},
}) {
  await this.create({ projectId, section, content, source, meta });

  // Prune: keep only the newest MAX_VERSIONS_PER_SECTION
  const versions = await this.find({ projectId, section })
    .sort({ createdAt: -1 })
    .select("_id")
    .lean();

  if (versions.length > MAX_VERSIONS_PER_SECTION) {
    const toDelete = versions.slice(MAX_VERSIONS_PER_SECTION).map((v) => v._id);
    await this.deleteMany({ _id: { $in: toDelete } });
  }
};

export const DocumentVersion = model("DocumentVersion", DocumentVersionSchema);
