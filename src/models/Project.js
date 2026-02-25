// src/models/Project.js
// ─────────────────────────────────────────────────────────────
// Represents one documentation run for a GitHub repository.
// Lifecycle: queued → running → done | error → (archived)
//
// The jobId field is the UUID used by the SSE job registry,
// making it trivial to wire MongoDB persistence to the existing
// /api/stream/:jobId endpoint without any changes to that code.
// ─────────────────────────────────────────────────────────────

import mongoose from "mongoose";

const { Schema, model } = mongoose;

// ── Reusable sub-schemas ──────────────────────────────────────

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
    // jobId links this document to the SSE job registry
    jobId: {
      type: String,
      unique: true,
      sparse: true, // only set once pipeline starts
    },

    status: {
      type: String,
      enum: ["queued", "running", "done", "error", "archived"],
      default: "queued",
      index: true,
    },

    errorMessage: String, // populated only on status === "error"

    // ── GitHub repo metadata (from GitHub API) ────────────────
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
    output: { type: OutputSchema, default: () => ({}) },

    // ── Chat session ──────────────────────────────────────────
    chatSessionId: String, // matches jobId in chatService sessions

    // ── Soft delete / archive ─────────────────────────────────
    archivedAt: Date,

    // ── Pipeline event log (last 200 events) ─────────────────
    // Stored so users can replay progress after page refresh.
    events: {
      type: [Schema.Types.Mixed],
      default: [],
      select: false, // not returned in list queries — only on .select("+events")
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ── Compound indexes ──────────────────────────────────────────
ProjectSchema.index({ userId: 1, createdAt: -1 }); // list projects, newest first
ProjectSchema.index({ userId: 1, status: 1 }); // filter by status
ProjectSchema.index({ userId: 1, repoOwner: 1, repoName: 1 }); // duplicate check

// ── Text index for search ─────────────────────────────────────
ProjectSchema.index(
  { repoName: "text", repoOwner: "text", "meta.description": "text" },
  { name: "project_search" },
);

export const Project = model("Project", ProjectSchema);
