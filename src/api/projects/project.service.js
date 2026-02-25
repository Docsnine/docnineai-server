// src/api/projects/project.service.js
// ─────────────────────────────────────────────────────────────
// Project management — full CRUD + pipeline orchestration.
//
// Project lifecycle:
//   queued → running → done | error → (archived)
//   error  → running  (via retryProject)
//
// Pipeline integration:
//   createProject / retryProject both call runPipeline() async.
//   runPipeline wraps orchestrate() with MongoDB persistence:
//     - every onProgress event is appended to Project.events (last 200)
//     - final result is persisted to Project document on completion
//     - finishJob / failJob close SSE connections via jobRegistry
// ─────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";
import { Project } from "../../models/Project.js";
import {
  registerJob,
  pushEvent,
  finishJob,
  failJob,
} from "../../services/jobRegistry.js";

// ── Lazy orchestrate loader ───────────────────────────────────
// Mirrors the pattern in index.js — lets the server start even if
// the orchestrator fails to load (missing env vars, bad imports).
let _orchestrate = null;

async function getOrchestrate() {
  if (_orchestrate) return _orchestrate;
  const m = await import("../../services/orchestrator.js");
  _orchestrate = m.orchestrate;
  return _orchestrate;
}

// ── URL parser ────────────────────────────────────────────────

/**
 * Parse a GitHub repo URL into { owner, repoName, normalised }.
 * Accepts: full HTTPS URL, SSH URL (git@github.com:owner/repo), or "owner/repo".
 */
function parseGitHubUrl(raw) {
  const cleaned = raw
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  // Full HTTPS URL
  const https = cleaned.match(/github\.com[:/]([^/\s]+)\/([^/\s]+)/);
  if (https) {
    return {
      owner: https[1],
      repoName: https[2],
      normalised: `https://github.com/${https[1]}/${https[2]}`,
    };
  }

  // Short "owner/repo"
  const short = cleaned.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (short) {
    return {
      owner: short[1],
      repoName: short[2],
      normalised: `https://github.com/${short[1]}/${short[2]}`,
    };
  }

  const err = new Error(`Cannot parse GitHub URL: "${raw}"`);
  err.code = "INVALID_REPO_URL";
  err.status = 400;
  throw err;
}

// ── Create project + auto-start pipeline ─────────────────────

/**
 * Create a project document, register the SSE job, and kick off the
 * AI documentation pipeline asynchronously.
 *
 * @param {{ userId: string, repoUrl: string }}
 * @returns {Project}
 */
export async function createProject({ userId, repoUrl }) {
  const { owner, repoName, normalised } = parseGitHubUrl(repoUrl);

  // Prevent duplicate active runs for the same repo per user
  const active = await Project.findOne({
    userId,
    repoOwner: owner,
    repoName,
    status: { $in: ["queued", "running"] },
  });
  if (active) {
    const err = new Error(
      `A pipeline for ${owner}/${repoName} is already in progress.`,
    );
    err.code = "DUPLICATE_PROJECT";
    err.status = 409;
    throw err;
  }

  const jobId = randomUUID();

  const project = await Project.create({
    userId,
    repoUrl: normalised,
    repoOwner: owner,
    repoName,
    jobId,
    status: "running",
  });

  registerJob(jobId);

  runPipeline({ project, normalised, jobId }).catch((err) => {
    console.error(`❌ Pipeline crash [${jobId}]:`, err.message);
  });

  return project;
}

// ── Retry a failed / completed project ───────────────────────

/**
 * Re-run the documentation pipeline for an existing project.
 * Resets all output fields and starts a fresh job.
 * Only allowed for projects in "error" or "done" status.
 *
 * @param {{ projectId: string, userId: string }}
 * @returns {Project}
 */
export async function retryProject({ projectId, userId }) {
  const project = await Project.findOne({ _id: projectId, userId });

  if (!project) {
    const err = new Error("Project not found.");
    err.code = "PROJECT_NOT_FOUND";
    err.status = 404;
    throw err;
  }

  if (project.status === "running" || project.status === "queued") {
    const err = new Error("Pipeline is already running for this project.");
    err.code = "PROJECT_RUNNING";
    err.status = 409;
    throw err;
  }

  if (project.status === "archived") {
    const err = new Error(
      "Cannot retry an archived project. Restore it first.",
    );
    err.code = "PROJECT_ARCHIVED";
    err.status = 409;
    throw err;
  }

  const jobId = randomUUID();

  // Reset all pipeline state; keep identity (repoUrl, userId, meta)
  project.jobId = jobId;
  project.status = "running";
  project.errorMessage = undefined;
  project.techStack = [];
  project.stats = {};
  project.security = {};
  project.output = {};
  project.chatSessionId = undefined;
  project.archivedAt = undefined;
  project.events = []; // requires events to not be select:false for save — use updateOne
  await project.save();

  // Clear events array via updateOne (events field has select:false)
  await Project.updateOne({ _id: project._id }, { $set: { events: [] } });

  registerJob(jobId);

  runPipeline({ project, normalised: project.repoUrl, jobId }).catch((err) => {
    console.error(`❌ Retry pipeline crash [${jobId}]:`, err.message);
  });

  return project;
}

// ── Internal: pipeline runner ─────────────────────────────────

async function runPipeline({ project, normalised, jobId }) {
  const orchestrate = await getOrchestrate();

  // Persist events to MongoDB in real-time (capped at 200)
  const onProgress = async (event) => {
    pushEvent(jobId, event);
    try {
      await Project.updateOne(
        { _id: project._id },
        { $push: { events: { $each: [event], $slice: -200 } } },
      );
    } catch {
      /* non-critical — don't let a DB write stall SSE */
    }
  };

  try {
    const result = await orchestrate(normalised, onProgress);

    const update = { status: result.success ? "done" : "error" };

    if (result.success) {
      update.techStack = result.techStack || [];
      update.stats = result.stats || {};
      update.meta = result.meta || {};
      update.output = result.output || {};
      update.chatSessionId = result.chat?.sessionId || null;
      update.security = normaliseSecurity(result.security);
    } else {
      update.errorMessage = result.error || "Unknown pipeline error";
    }

    await Project.findByIdAndUpdate(project._id, update);
    finishJob(jobId, result);
  } catch (err) {
    await Project.findByIdAndUpdate(project._id, {
      status: "error",
      errorMessage: err.message,
    });
    failJob(jobId, err);
  }
}

/** Normalise the security object from the pipeline result. */
function normaliseSecurity(security) {
  if (!security) return {};
  return {
    score: security.score,
    grade: security.grade,
    counts: security.counts,
    findings: (security.findings || []).slice(0, 50), // cap to prevent document bloat
  };
}

// ── List projects ─────────────────────────────────────────────

/**
 * Paginated, filterable list — strips heavy output/events fields.
 * @param {{ userId, page, limit, status, sort, search }}
 * @returns {{ projects, total, page, limit, totalPages }}
 */
export async function listProjects({
  userId,
  page = 1,
  limit = 20,
  status,
  sort = "-createdAt",
  search,
}) {
  const query = { userId };
  if (status) query.status = status;
  if (search) query.$text = { $search: search };

  const sortObj = parseSortParam(sort);

  const [projects, total] = await Promise.all([
    Project.find(query)
      .sort(sortObj)
      .skip((page - 1) * limit)
      .limit(limit)
      .select("-output -events"),
    Project.countDocuments(query),
  ]);

  return { projects, total, page, limit, totalPages: Math.ceil(total / limit) };
}

// ── Get one project ───────────────────────────────────────────

/**
 * Fetch a single project, enforcing ownership.
 * Returns the full document (including output) — good for detail view.
 * Events have select:false so they're excluded automatically.
 * @param {{ projectId, userId }}
 */
export async function getProjectById({ projectId, userId }) {
  const project = await Project.findOne({ _id: projectId, userId });

  if (!project) {
    const err = new Error("Project not found.");
    err.code = "PROJECT_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  return project;
}

// ── Delete project ────────────────────────────────────────────

/**
 * Hard-delete a project. Blocked while pipeline is running.
 * @param {{ projectId, userId }}
 */
export async function deleteProject({ projectId, userId }) {
  const project = await assertProjectOwnership(projectId, userId);

  if (project.status === "running" || project.status === "queued") {
    const err = new Error(
      "Cannot delete a project while its pipeline is running.",
    );
    err.code = "PROJECT_RUNNING";
    err.status = 409;
    throw err;
  }

  await Project.findByIdAndDelete(projectId);
}

// ── Update / archive project ──────────────────────────────────

/**
 * Update mutable project fields.
 * Currently supports: status → "archived".
 * @param {{ projectId, userId, updates }}
 */
export async function updateProject({ projectId, userId, updates }) {
  const project = await assertProjectOwnership(projectId, userId);

  if (updates.status === "archived") {
    if (project.status === "running" || project.status === "queued") {
      const err = new Error(
        "Cannot archive a project while its pipeline is running.",
      );
      err.code = "PROJECT_RUNNING";
      err.status = 409;
      throw err;
    }
    project.status = "archived";
    project.archivedAt = new Date();
  }

  await project.save();
  return project;
}

// ── Internal helpers ──────────────────────────────────────────
async function assertProjectOwnership(projectId, userId) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) {
    const err = new Error("Project not found.");
    err.code = "PROJECT_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  return project;
}

function parseSortParam(sort = "-createdAt") {
  const desc = sort.startsWith("-");
  const field = desc ? sort.slice(1) : sort;
  const ALLOWED = ["createdAt", "updatedAt", "repoName", "status"];
  if (!ALLOWED.includes(field)) return { createdAt: -1 };
  return { [field]: desc ? -1 : 1 };
}
