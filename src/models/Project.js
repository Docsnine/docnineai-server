// =============================================================
// Represents one documentation project for a GitHub repository.
//
// v3.1 additions:
//
//   editedOutput     — user overrides per section. Sparse: only
//                      set sections are stored. The API merges
//                      editedOutput on top of AI output when reading.
//
//   editedSections   — tracks which sections have user edits +
//                      whether each edit is stale (AI has newer
//                      content the user hasn't reviewed yet).
//
//   lastDocumentedCommit — git SHA at the time of last successful
//                      full or incremental pipeline run.
//
//   fileManifest     — [{path, sha, role}] snapshot of the repo
//                      tree as of lastDocumentedCommit. Used for
//                      SHA-based diffing without GitHub compare API.
//
//   agentOutputs     — raw structured outputs from each agent.
//                      select:false — not returned in queries.
//                      Stored so incremental sync can surgically
//                      remove/merge changed-file entries without
//                      re-running agents on the whole repo.
// =============================================================

import mongoose from "mongoose";

const { Schema, model } = mongoose;

// ── Security sub-schemas ──────────────────────────────────────

const SecurityFindingSchema = new Schema(
  {
    id: String,
    severity: { type: String, enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
    title: String,
    file: String,
    line: String,
    advice: String,
    source: { type: String, enum: ["static", "llm"] },
  },
  { _id: false },
);

const SecuritySchema = new Schema(
  {
    score: Number,
    grade: String,
    counts: {
      CRITICAL: { type: Number, default: 0 },
      HIGH: { type: Number, default: 0 },
      MEDIUM: { type: Number, default: 0 },
      LOW: { type: Number, default: 0 },
    },
    findings: { type: [SecurityFindingSchema], default: [] },
  },
  { _id: false },
);

// ── Stats sub-schema ──────────────────────────────────────────

const StatsSchema = new Schema(
  {
    filesAnalysed: { type: Number, default: 0 },
    endpoints: { type: Number, default: 0 },
    models: { type: Number, default: 0 },
    relationships: { type: Number, default: 0 },
    components: { type: Number, default: 0 },
  },
  { _id: false },
);

// ── Output sub-schema — AI-generated documentation ────────────
// This always holds the latest AI content.
// Do not write user edits here — use editedOutput.

const OutputSchema = new Schema(
  {
    readme: { type: String, default: "" },
    internalDocs: { type: String, default: "" },
    apiReference: { type: String, default: "" },
    schemaDocs: { type: String, default: "" },
    securityReport: { type: String, default: "" },
  },
  { _id: false },
);

// ── Edited sections tracking ──────────────────────────────────

const EditedSectionSchema = new Schema(
  {
    section: { type: String, required: true },
    editedAt: { type: Date, required: true },
    // stale: true when AI has regenerated the section since the user
    // last edited it. The user should review and decide: keep their
    // edit or accept the new AI content.
    stale: { type: Boolean, default: false },
  },
  { _id: false },
);

// ── File manifest entry — for incremental diff ────────────────

const FileManifestEntrySchema = new Schema(
  {
    path: { type: String, required: true },
    sha: { type: String, required: true }, // Git blob SHA
    role: { type: String }, // from repoScannerAgent classification
  },
  { _id: false },
);

// ── Agent outputs — raw structured data for incremental merge ─
// Each entry has a `file` field so stale entries can be removed
// when that file changes, without touching entries from other files.

const AgentOutputsSchema = new Schema(
  {
    // From apiExtractorAgent: [{method, path, description, file, ...}]
    endpoints: { type: [Schema.Types.Mixed], default: [] },
    // From schemaAnalyserAgent: [{name, fields, description, file, ...}]
    models: { type: [Schema.Types.Mixed], default: [] },
    // From schemaAnalyserAgent: [{from, to, type, through}]
    relationships: { type: [Schema.Types.Mixed], default: [] },
    // From componentMapperAgent: [{name, file, type, description, ...}]
    components: { type: [Schema.Types.Mixed], default: [] },
    // From securityAuditorAgent: [{id, severity, title, file, ...}]
    findings: { type: [Schema.Types.Mixed], default: [] },
    // From repoScannerAgent: [{path, role, summary}]
    projectMap: { type: [Schema.Types.Mixed], default: [] },
  },
  { _id: false },
);

// ── Main schema ───────────────────────────────────────────────

const ProjectSchema = new Schema(
  {
    // ── Ownership ─────────────────────────────────────────────
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ── Repository identity ───────────────────────────────────
    repoUrl: { type: String, required: true, trim: true },
    repoOwner: { type: String, required: true, trim: true },
    repoName: { type: String, required: true, trim: true },

    // ── Pipeline state ────────────────────────────────────────
    jobId: {
      type: String,
      unique: true,
      sparse: true,
    },

    status: {
      type: String,
      enum: ["queued", "running", "done", "error", "archived"],
      default: "queued",
      index: true,
    },

    errorMessage: String,

    // ── GitHub repo metadata ──────────────────────────────────
    meta: {
      name: String,
      description: String,
      language: String,
      stars: Number,
      defaultBranch: String,
      isPrivate: Boolean,
      topics: [String],
    },

    techStack: [String],

    // ── Pipeline results ──────────────────────────────────────
    stats: { type: StatsSchema, default: () => ({}) },
    security: { type: SecuritySchema, default: () => ({}) },

    // AI-generated documentation (always latest AI version)
    output: { type: OutputSchema, default: () => ({}) },

    // ── User edits (v3.1) ─────────────────────────────────────
    // Sparse — only sections the user has edited are set.
    // The API merges this on top of `output` when reading.
    editedOutput: {
      type: OutputSchema,
      default: () => ({}),
    },

    // Tracks which sections have user edits and their staleness.
    editedSections: {
      type: [EditedSectionSchema],
      default: [],
    },

    // ── Incremental sync state (v3.1) ─────────────────────────
    // Git SHA of the commit that `output` was generated from.
    // null = never synced or full run happened without capturing SHA.
    lastDocumentedCommit: { type: String, default: null },

    // File tree snapshot as of lastDocumentedCommit.
    // Used to compute diffs via SHA comparison — no compare API needed.
    fileManifest: {
      type: [FileManifestEntrySchema],
      default: [],
      select: false, // large array — only fetched when needed
    },

    // Raw structured agent outputs — needed for incremental merging.
    agentOutputs: {
      type: AgentOutputsSchema,
      default: () => ({}),
      select: false, // only fetched during sync operations
    },

    // ── Chat session ──────────────────────────────────────────
    chatSessionId: String,

    // ── Soft delete / archive ─────────────────────────────────
    archivedAt: Date,

    // ── Pipeline event log (last 200 events) ──────────────────
    events: {
      type: [Schema.Types.Mixed],
      default: [],
      select: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ── Compound indexes ──────────────────────────────────────────
ProjectSchema.index({ userId: 1, createdAt: -1 });
ProjectSchema.index({ userId: 1, status: 1 });
ProjectSchema.index({ userId: 1, repoOwner: 1, repoName: 1 });

// ── Text index for search ─────────────────────────────────────
// language_override points to a non-existent field ("search_language")
// so MongoDB never reads meta.language (e.g. "TypeScript", "Python")
// as a text stemming language override. Without this, storing a project
// whose repo language is anything other than a valid ISO 639-1 name
// causes: "language override unsupported: TypeScript" on findAndModify.
ProjectSchema.index(
  { repoName: "text", repoOwner: "text", "meta.description": "text" },
  { name: "project_search", language_override: "search_language" },
);

// ── Virtual: merged output ────────────────────────────────────
// Returns editedOutput where set, falls back to AI output.
// Used by the API to give the client the "effective" content.
ProjectSchema.virtual("effectiveOutput").get(function () {
  const sections = [
    "readme",
    "internalDocs",
    "apiReference",
    "schemaDocs",
    "securityReport",
  ];
  const merged = {};
  for (const s of sections) {
    merged[s] = this.editedOutput?.[s] || this.output?.[s] || "";
  }
  return merged;
});

export const Project = model("Project", ProjectSchema);
