// =============================================================
// Project management + pipeline operations.
//
// v3.1 new operations:
//   syncProject        — incremental or full re-run via diffService
//   editDocSection     — save a user edit for one doc section
//   revertDocSection   — clear user edit, restore AI version
//   acceptAISection    — user accepts AI regeneration (clears stale flag)
//   listVersions       — paginated version history for a section
//   restoreVersion     — restore a specific historical version
//
// Pipeline lifecycle:
//   queued → running → done | error → (archived)
//   error / done → running  (via retryProject or syncProject)
// =============================================================

import { randomUUID } from "crypto";
import { Project } from "../../models/Project.js";
import { DocumentVersion, SECTIONS } from "../../models/DocumentVersion.js";

import {
  registerJob,
  pushEvent,
  finishJob,
  failJob,
} from "../../services/job-registry.service.js";

// ── Lazy loaders ──────────────────────────────────────────────
let _orchestrate = null;
async function getOrchestrate() {
  if (_orchestrate) return _orchestrate;
  const m = await import("../../services/orchestrator.service.js");
  _orchestrate = m.orchestrate;
  return _orchestrate;
}

let _incrementalSync = null;
async function getIncrementalSync() {
  if (_incrementalSync) return _incrementalSync;
  const m = await import("../../services/incremental-orchestrator.service.js");
  _incrementalSync = m.incrementalSync;
  return _incrementalSync;
}

// ── URL parser ────────────────────────────────────────────────
function parseGitHubUrl(raw) {
  const cleaned = raw
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const https = cleaned.match(/github\.com[:/]([^/\s]+)\/([^/\s]+)/);
  if (https)
    return {
      owner: https[1],
      repoName: https[2],
      normalised: `https://github.com/${https[1]}/${https[2]}`,
    };
  const short = cleaned.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (short)
    return {
      owner: short[1],
      repoName: short[2],
      normalised: `https://github.com/${short[1]}/${short[2]}`,
    };
  const err = new Error(`Cannot parse GitHub URL: "${raw}"`);
  err.code = "INVALID_REPO_URL";
  err.status = 400;
  throw err;
}

function domainError(msg, code, status = 400) {
  const e = new Error(msg);
  e.code = code;
  e.status = status;
  return e;
}

// ─────────────────────────────────────────────────────────────
// PROJECT CRUD
// ─────────────────────────────────────────────────────────────

export async function createProject({ userId, repoUrl }) {
  const { owner, repoName, normalised } = parseGitHubUrl(repoUrl);

  const active = await Project.findOne({
    userId,
    repoOwner: owner,
    repoName,
    status: { $in: ["queued", "running"] },
  });
  if (active)
    throw domainError(
      `A pipeline for ${owner}/${repoName} is already in progress.`,
      "DUPLICATE_PROJECT",
      409,
    );

  const jobId = randomUUID();

  const project = await Project.create({
    userId,
    repoUrl: normalised,
    repoOwner: owner,
    repoName,
    jobId,
    status: "running",
    search_language: "english", 
  });

  registerJob(jobId);
  runPipeline({ project, normalised, jobId }).catch((err) =>
    console.error(`❌ Pipeline crash [${jobId}]:`, err.message),
  );
  return project;
}

export async function retryProject({ projectId, userId }) {
  const project = await assertOwnership(projectId, userId);
  if (project.status === "running" || project.status === "queued")
    throw domainError("Pipeline is already running.", "PROJECT_RUNNING", 409);
  if (project.status === "archived")
    throw domainError(
      "Cannot retry an archived project.",
      "PROJECT_ARCHIVED",
      409,
    );

  const jobId = randomUUID();
  project.jobId = jobId;
  project.status = "running";
  project.errorMessage = undefined;
  project.techStack = [];
  project.stats = {};
  project.security = {};
  project.output = {};
  project.chatSessionId = undefined;
  project.archivedAt = undefined;
  await project.save();
  await Project.updateOne(
    { _id: project._id },
    { $set: { events: [], editedSections: [] } },
  );

  registerJob(jobId);
  runPipeline({ project, normalised: project.repoUrl, jobId }).catch((err) =>
    console.error(`❌ Retry crash [${jobId}]:`, err.message),
  );
  return project;
}

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
      .select("-output -events -editedOutput -fileManifest -agentOutputs"),
    Project.countDocuments(query),
  ]);
  return { projects, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getProjectById({ projectId, userId }) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project)
    throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);
  return project;
}

export async function deleteProject({ projectId, userId }) {
  const project = await assertOwnership(projectId, userId);
  if (project.status === "running" || project.status === "queued")
    throw domainError(
      "Cannot delete a running project.",
      "PROJECT_RUNNING",
      409,
    );
  await Project.findByIdAndDelete(projectId);
  // Clean up version history
  await DocumentVersion.deleteMany({ projectId });
}

export async function updateProject({ projectId, userId, updates }) {
  const project = await assertOwnership(projectId, userId);
  if (updates.status === "archived") {
    if (project.status === "running" || project.status === "queued")
      throw domainError(
        "Cannot archive a running project.",
        "PROJECT_RUNNING",
        409,
      );
    project.status = "archived";
    project.archivedAt = new Date();
  }
  await project.save();
  return project;
}

// ─────────────────────────────────────────────────────────────
// INCREMENTAL SYNC
// ─────────────────────────────────────────────────────────────

/**
 * Check for new commits and run only the affected pipeline segments.
 * Falls back to full run if no baseline is stored.
 *
 * @param {{ projectId, userId, forceFullRun, webhookChangedFiles }}
 * @returns {{ project, syncResult }}
 */
export async function syncProject({
  projectId,
  userId,
  forceFullRun = false,
  webhookChangedFiles = null,
}) {
  // Load project with the extra fields needed for incremental sync
  const project = await Project.findOne({ _id: projectId, userId }).select(
    "+agentOutputs +fileManifest +events",
  );

  if (!project)
    throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);

  if (project.status === "running" || project.status === "queued")
    throw domainError("A pipeline is already running.", "PROJECT_RUNNING", 409);
  if (project.status === "archived")
    throw domainError(
      "Cannot sync an archived project.",
      "PROJECT_ARCHIVED",
      409,
    );
  if (project.status !== "done" && project.status !== "error")
    throw domainError(
      "Project must be in done or error state to sync.",
      "PROJECT_NOT_READY",
      409,
    );

  const jobId = randomUUID();
  project.jobId = jobId;
  project.status = "running";
  await project.save();

  registerJob(jobId);

  // Run async — caller gets the job ID immediately
  runSync({ project, jobId, forceFullRun, webhookChangedFiles }).catch((err) =>
    console.error(`❌ Sync crash [${jobId}]:`, err.message),
  );

  return { project, streamUrl: `/projects/${project._id}/stream` };
}

// ─────────────────────────────────────────────────────────────
// DOCUMENT EDITING
// ─────────────────────────────────────────────────────────────

/**
 * Save a user edit for one documentation section.
 * The AI content in `output` is untouched; the edit is stored in
 * `editedOutput`. A version entry is created before applying.
 *
 * @param {{ projectId, userId, section, content }}
 */
export async function editDocSection({ projectId, userId, section, content }) {
  if (!SECTIONS.includes(section))
    throw domainError(
      `Invalid section. Must be one of: ${SECTIONS.join(", ")}`,
      "INVALID_SECTION",
      400,
    );

  const project = await assertOwnership(projectId, userId);
  if (project.status !== "done")
    throw domainError(
      "Can only edit documentation for completed projects.",
      "PROJECT_NOT_READY",
      409,
    );

  // Save version of the CURRENT effective content before overwriting
  const currentContent =
    project.editedOutput?.[section] || project.output?.[section] || "";
  if (currentContent) {
    await DocumentVersion.createVersion({
      projectId: project._id,
      section,
      content: currentContent,
      source: project.editedSections?.some((s) => s.section === section)
        ? "user"
        : "ai_full",
      meta: { changeSummary: "Snapshot before user edit" },
    });
  }

  // Apply the user edit
  const editedSections = (project.editedSections || []).filter(
    (s) => s.section !== section,
  );
  editedSections.push({ section, editedAt: new Date(), stale: false });

  await Project.findByIdAndUpdate(project._id, {
    [`editedOutput.${section}`]: content,
    editedSections,
  });

  // Save a version of the new edit
  await DocumentVersion.createVersion({
    projectId: project._id,
    section,
    content,
    source: "user",
    meta: { changeSummary: "User edit" },
  });

  return getProjectById({ projectId, userId });
}

/**
 * Revert a section to its latest AI-generated content.
 * Clears the user edit from editedOutput and editedSections.
 */
export async function revertDocSection({ projectId, userId, section }) {
  if (!SECTIONS.includes(section))
    throw domainError(
      `Invalid section. Must be one of: ${SECTIONS.join(", ")}`,
      "INVALID_SECTION",
      400,
    );

  const project = await assertOwnership(projectId, userId);

  const editedSections = (project.editedSections || []).filter(
    (s) => s.section !== section,
  );

  await Project.findByIdAndUpdate(project._id, {
    [`editedOutput.${section}`]: "",
    editedSections,
  });

  return getProjectById({ projectId, userId });
}

/**
 * Accept the new AI-generated content for a stale section.
 * This clears the user edit (if any) and removes the stale flag.
 */
export async function acceptAISection({ projectId, userId, section }) {
  if (!SECTIONS.includes(section))
    throw domainError(
      `Invalid section. Must be one of: ${SECTIONS.join(", ")}`,
      "INVALID_SECTION",
      400,
    );

  return revertDocSection({ projectId, userId, section });
}

// ─────────────────────────────────────────────────────────────
// VERSION HISTORY
// ─────────────────────────────────────────────────────────────

/**
 * List version history for a documentation section.
 * Returns newest first, max 20.
 */
export async function listVersions({
  projectId,
  userId,
  section,
  page = 1,
  limit = 20,
}) {
  if (!SECTIONS.includes(section))
    throw domainError(
      `Invalid section. Must be one of: ${SECTIONS.join(", ")}`,
      "INVALID_SECTION",
      400,
    );

  await assertOwnership(projectId, userId);

  const [versions, total] = await Promise.all([
    DocumentVersion.find({ projectId, section })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("-content"), // content omitted in list — too large; include in individual fetch
    DocumentVersion.countDocuments({ projectId, section }),
  ]);

  return { versions, total, page, limit };
}

/**
 * Fetch a single version including its full content.
 */
export async function getVersion({ projectId, userId, versionId }) {
  await assertOwnership(projectId, userId);
  const version = await DocumentVersion.findOne({ _id: versionId, projectId });
  if (!version)
    throw domainError("Version not found.", "VERSION_NOT_FOUND", 404);
  return version;
}

/**
 * Restore a historical version as the current user edit.
 * Creates a new version entry recording the restore action.
 */
export async function restoreVersion({ projectId, userId, versionId }) {
  const project = await assertOwnership(projectId, userId);
  const version = await DocumentVersion.findOne({ _id: versionId, projectId });
  if (!version)
    throw domainError("Version not found.", "VERSION_NOT_FOUND", 404);

  if (project.status !== "done")
    throw domainError(
      "Can only restore versions for completed projects.",
      "PROJECT_NOT_READY",
      409,
    );

  // Save current as a version before restoring
  const currentContent =
    project.editedOutput?.[version.section] ||
    project.output?.[version.section] ||
    "";
  if (currentContent) {
    await DocumentVersion.createVersion({
      projectId: project._id,
      section: version.section,
      content: currentContent,
      source: "user",
      meta: { changeSummary: `Snapshot before restore to ${version._id}` },
    });
  }

  // Apply the restored content as a user edit
  const editedSections = (project.editedSections || []).filter(
    (s) => s.section !== version.section,
  );
  editedSections.push({
    section: version.section,
    editedAt: new Date(),
    stale: false,
  });

  await Project.findByIdAndUpdate(project._id, {
    [`editedOutput.${version.section}`]: version.content,
    editedSections,
  });

  // Record the restore action as a version
  await DocumentVersion.createVersion({
    projectId: project._id,
    section: version.section,
    content: version.content,
    source: "user",
    meta: {
      changeSummary: `Restored from version ${version._id} (${version.source} — ${version.createdAt.toISOString()})`,
    },
  });

  return getProjectById({ projectId, userId });
}

// ─────────────────────────────────────────────────────────────
// INTERNAL PIPELINE RUNNERS
// ─────────────────────────────────────────────────────────────

async function runPipeline({ project, normalised, jobId }) {
  const orchestrate = await getOrchestrate();
  const onProgress = makeProgressHandler(project._id, jobId);

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
      // v3.1: store incremental sync baseline
      update.lastDocumentedCommit = result.lastDocumentedCommit || null;
      update.fileManifest = result.fileManifest || [];
      update.agentOutputs = result.agentOutputs || {};

      // Create initial version entries for all sections
      for (const section of SECTIONS) {
        const content = result.output?.[section];
        if (content) {
          await DocumentVersion.createVersion({
            projectId: project._id,
            section,
            content,
            source: "ai_full",
            meta: {
              commitSha: result.lastDocumentedCommit,
              agentsRun: [
                "repoScanner",
                "apiExtractor",
                "schemaAnalyser",
                "componentMapper",
                "securityAuditor",
                "docWriter",
              ],
              changeSummary: "Initial full pipeline run",
            },
          });
        }
      }
    } else {
      update.errorMessage = result.error || "Unknown pipeline error";
    }

    await Project.findByIdAndUpdate(project._id, { ...update, search_language: "english" });
    
    finishJob(jobId, result);
  } catch (err) {
    await Project.findByIdAndUpdate(project._id, {
      status: "error",
      errorMessage: err.message,
    });
    failJob(jobId, err);
  }
}

async function runSync({ project, jobId, forceFullRun, webhookChangedFiles }) {
  const incrementalSync = await getIncrementalSync();
  const onProgress = makeProgressHandler(project._id, jobId);

  try {
    const syncResult = await incrementalSync(project, onProgress, {
      forceFullRun,
      webhookChangedFiles,
    });

    if (!syncResult.success) {
      await Project.findByIdAndUpdate(project._id, {
        status: "error",
        errorMessage: syncResult.error,
      });
      failJob(jobId, new Error(syncResult.error));
      return;
    }

    if (syncResult.skipped) {
      // No changes — just mark done again
      await Project.findByIdAndUpdate(project._id, {
        status: "done",
        lastDocumentedCommit: syncResult.currentCommit,
      });
      finishJob(jobId, {
        success: true,
        skipped: true,
        reason: syncResult.reason,
      });
      return;
    }

    if (syncResult.isFullRun) {
      // Full fallback — store the complete orchestrate result
      const result = syncResult._fullResult;
      const update = {
        status: result.success ? "done" : "error",
        techStack: result.techStack || [],
        stats: result.stats || {},
        meta: result.meta || {},
        output: result.output || {},
        chatSessionId: result.chat?.sessionId || null,
        security: normaliseSecurity(result.security),
        lastDocumentedCommit: syncResult.currentCommit,
        fileManifest: syncResult._freshTree
          ? updateManifestFromTree(
              syncResult._freshTree,
              result.agentOutputs?.projectMap || [],
            )
          : [],
        agentOutputs: result.agentOutputs || {},
      };
      if (!result.success) update.errorMessage = result.error;

      await Project.findByIdAndUpdate(project._id, { ...update, search_language: "english" });
      finishJob(jobId, result);
      return;
    }

    // Incremental success — apply the prepared update
    const update = { ...syncResult._update, status: "done" };
    await Project.findByIdAndUpdate(project._id, { ...update, search_language: "english" });
    finishJob(jobId, { success: true, ...syncResult });
  } catch (err) {
    await Project.findByIdAndUpdate(project._id, {
      status: "error",
      errorMessage: err.message,
    });
    failJob(jobId, err);
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function makeProgressHandler(projectId, jobId) {
  return async (event) => {
    pushEvent(jobId, event);
    try {
      await Project.updateOne(
        { _id: projectId },
        { $push: { events: { $each: [event], $slice: -200 } } },
      );
    } catch {
      /* non-critical */
    }
  };
}

async function assertOwnership(projectId, userId) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project)
    throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);
  return project;
}

function parseSortParam(sort = "-createdAt") {
  const desc = sort.startsWith("-");
  const field = desc ? sort.slice(1) : sort;
  const ALLOWED = ["createdAt", "updatedAt", "repoName", "status"];
  if (!ALLOWED.includes(field)) return { createdAt: -1 };
  return { [field]: desc ? -1 : 1 };
}

function normaliseSecurity(security) {
  if (!security) return {};
  return {
    score: security.score,
    grade: security.grade,
    counts: security.counts,
    findings: (security.findings || []).slice(0, 50),
  };
}

function updateManifestFromTree(tree, projectMap) {
  const roleMap = new Map((projectMap || []).map((p) => [p.path, p.role]));
  return tree.map((f) => ({
    path: f.path,
    sha: f.sha || "",
    role: roleMap.get(f.path) || "",
  }));
}
