// ===================================================================
// Project Service (Improved)
// ===================================================================
//
// Project management + full/incremental pipeline operations.
//
// Aligned with all improved agents:
//   - Orchestrator  v4: routing, pipelineReport, agentErrors,
//                       architectureHint, layerMap, flagsSummary,
//                       keyFiles, testFrameworks, richer security
//   - Doc Writer    v2: componentRef, componentIndex, remediationReport
//   - Security      v2: categoryCounts, affectedFiles, remediationMarkdown
//   - Repo Scanner  v2: layerMap, flagsSummary, architectureHint,
//                       keyFiles, testFrameworks
//
// Pipeline lifecycle:
//   queued → running → done | error → (archived)
//   error | done → running  (via retryProject or syncProject)
//
// Operations:
//   createProject      — start full pipeline for a new repo
//   retryProject       — re-run full pipeline on an existing project
//   syncProject        — incremental or forced full re-run
//   listProjects       — paginated project list with filtering/sorting
//   getProjectById     — owner or shared-member access
//   getProjectEvents   — SSE event log
//   deleteProject      — owner-only hard delete
//   updateProject      — archive or soft update
//   editDocSection     — save user edit for one doc section
//   revertDocSection   — restore latest AI content, clear user edit
//   acceptAISection    — accept AI regeneration (clears stale flag)
//   listVersions       — paginated version history
//   getVersion         — single version with full content
//   restoreVersion     — restore a historical version as current edit
//   recoverOrphanedJobs — startup recovery for interrupted pipelines
// ===================================================================

import { randomUUID } from "crypto";

import { Project } from "../../models/Project.js";
import { DocumentVersion, SECTIONS } from "../../models/DocumentVersion.js";
import { ProjectShare } from "../../models/ProjectShare.js";
import { User } from "../../models/User.js";

import {
  registerJob,
  pushEvent,
  finishJob,
  failJob,
  recoverLostJob,
} from "../../services/job-registry.service.js";

// ─── All known output sections ────────────────────────────────────
// Superset of SECTIONS from the model — includes new sections added
// by the improved Doc Writer and Security Auditor.
// The model's SECTIONS constant is the source of truth for validation;
// this list is used for iteration in pipeline persistence.

const ALL_OUTPUT_SECTIONS = [
  "readme",
  "internalDocs",
  "apiReference",
  "schemaDocs",
  "componentRef", // new — LLM-written component reference
  "componentIndex", // new — static component index table
  "securityReport",
  "remediationReport", // new — prioritised remediation checklist
];

// ─── Lazy loaders ─────────────────────────────────────────────────
// Lazy imports avoid circular dependencies and reduce startup time.

let _orchestrate = null;
let _incrementalSync = null;

async function getOrchestrate() {
  if (_orchestrate) return _orchestrate;
  const m = await import("../../services/orchestrator.service.js");
  _orchestrate = m.orchestrate;
  return _orchestrate;
}

async function getIncrementalSync() {
  if (_incrementalSync) return _incrementalSync;
  const m = await import("../../services/incremental-sync.service.js");
  _incrementalSync = m.incrementalSync;
  return _incrementalSync;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Parse and normalise a GitHub repository URL.
 * Accepts: full HTTPS URL, SSH URL, or "owner/repo" shorthand.
 */
function parseGitHubUrl(raw) {
  const cleaned = raw
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  const https = cleaned.match(/github\.com[:/]([^/\s]+)\/([^/\s#?]+)/);
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

/**
 * Create a typed domain error with code and HTTP status.
 */
function domainError(msg, code, status = 400) {
  const e = new Error(msg);
  e.code = code;
  e.status = status;
  return e;
}

/**
 * Assert that userId is the owner of projectId.
 * Returns the project document or throws PROJECT_NOT_FOUND.
 */
async function assertOwnership(projectId, userId) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project)
    throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);
  return project;
}

/**
 * Assert that userId has at least the given role on the project.
 * Supports: owner, editor, viewer.
 */
async function assertAccess(projectId, userId, requiredRole = "viewer") {
  // Check owner first
  const ownedProject = await Project.findOne({ _id: projectId, userId });
  if (ownedProject) {
    ownedProject._shareRole = "owner";
    return ownedProject;
  }

  // Check shared access
  const project = await Project.findById(projectId);
  if (!project)
    throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);

  const user = await User.findById(userId).select("email").lean();
  const share = await ProjectShare.findOne({
    projectId,
    status: "accepted",
    $or: [
      { inviteeUserId: userId },
      ...(user?.email ? [{ inviteeEmail: user.email }] : []),
    ],
  }).lean();

  if (!share) throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);

  // Role hierarchy: owner > editor > viewer
  const ROLE_RANK = { owner: 3, editor: 2, viewer: 1 };
  if ((ROLE_RANK[share.role] ?? 0) < (ROLE_RANK[requiredRole] ?? 0)) {
    throw domainError(
      `This action requires ${requiredRole} access.`,
      "INSUFFICIENT_PERMISSIONS",
      403,
    );
  }

  project._shareRole = share.role;
  return project;
}

/**
 * Parse a sort query string param into a Mongoose sort object.
 * Whitelists allowed fields to prevent injection.
 */
function parseSortParam(sort = "-createdAt") {
  const ALLOWED = new Set([
    "createdAt",
    "updatedAt",
    "repoName",
    "status",
    "security.score",
  ]);
  const desc = sort.startsWith("-");
  const field = desc ? sort.slice(1) : sort;
  if (!ALLOWED.has(field)) return { createdAt: -1 };
  return { [field]: desc ? -1 : 1 };
}

/**
 * Normalise the security object from the improved Security Auditor.
 * Handles both old schema (no categoryCounts) and new schema.
 */
function normaliseSecurity(security) {
  if (!security) return {};
  return {
    score: security.score ?? 100,
    grade: security.grade ?? "A",
    counts: security.counts ?? { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    categoryCounts: security.categoryCounts ?? {},
    affectedFiles: (security.affectedFiles ?? []).slice(0, 10),
    findings: (security.findings ?? []).slice(0, 50),
  };
}

/**
 * Normalise stats from the improved Orchestrator.
 * Handles both old schema (fewer fields) and new schema.
 */
function normaliseStats(stats, result) {
  return {
    filesAnalysed: stats?.filesAnalysed ?? 0,
    filesClassified: stats?.filesClassified ?? 0,
    endpoints: stats?.endpoints ?? 0,
    models: stats?.models ?? 0,
    relationships: stats?.relationships ?? 0,
    components: stats?.components ?? 0,
    securityFindings: stats?.securityFindings ?? 0,
    docsGenerated: stats?.docsGenerated ?? 0,
    totalDuration: stats?.totalDuration ?? null,
    lastFullRunAt: new Date(),
  };
}

/**
 * Build a file manifest from a tree + projectMap.
 * Used when full sync returns a fresh tree.
 */
function buildManifestFromTree(tree, projectMap) {
  const roleMap = new Map((projectMap || []).map((p) => [p.path, p.role]));
  const layerMap = new Map((projectMap || []).map((p) => [p.path, p.layer]));
  return (tree || []).map((f) => ({
    path: f.path,
    sha: f.sha || "",
    role: roleMap.get(f.path) || "",
    layer: layerMap.get(f.path) || "",
  }));
}

/**
 * Build the SSE progress handler.
 * Pushes events to the in-memory job registry AND persists
 * the last 200 events to MongoDB (capped slice).
 */
function makeProgressHandler(projectId, jobId) {
  return async (event) => {
    // Always push to in-memory registry (instant SSE delivery)
    pushEvent(jobId, event);

    // Persist to DB — non-critical, swallow errors
    try {
      await Project.updateOne(
        { _id: projectId },
        { $push: { events: { $each: [event], $slice: -200 } } },
      );
    } catch {
      /* non-critical — SSE still delivered via in-memory registry */
    }
  };
}

/**
 * Create initial DocumentVersion entries for all sections after
 * a full pipeline run. Runs in parallel for speed.
 */
async function createInitialVersions(projectId, output, commitSha) {
  const promises = ALL_OUTPUT_SECTIONS.map(async (section) => {
    const content = output?.[section];
    if (!content) return;
    try {
      await DocumentVersion.createVersion({
        projectId,
        section,
        content,
        source: "ai_full",
        meta: {
          commitSha,
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
    } catch (err) {
      // Version history failure is non-fatal
      console.warn(
        `[versions] Failed to create version for ${section}:`,
        err.message,
      );
    }
  });
  await Promise.all(promises);
}

/**
 * Build the full project update payload from a successful orchestrate result.
 * Centralises all field mapping in one place so runPipeline and runSync
 * (full fallback path) are consistent.
 */
function buildFullRunUpdate(result, commitSha, freshTree) {
  return {
    status: "done",
    techStack: result.techStack || [],
    testFrameworks: result.testFrameworks || [],
    architectureHint: result.architectureHint || "",
    entryPoints: result.entryPoints || [],
    keyFiles: result.keyFiles || [],
    stats: normaliseStats(result.stats, result),
    meta: result.meta || {},
    output: result.output || {},
    chatSessionId: result.chat?.sessionId || null,
    security: normaliseSecurity(result.security),
    lastDocumentedCommit: commitSha || result.lastDocumentedCommit || null,
    fileManifest: freshTree
      ? buildManifestFromTree(freshTree, result.agentOutputs?.projectMap || [])
      : result.fileManifest || [],
    agentOutputs: result.agentOutputs || {},
    // New fields from improved agents
    "agentOutputs.summaries": result.agentOutputs?.summaries || {},
    routing: result.routing || null,
    pipelineReport: result.pipelineReport?.markdown || null,
    agentErrors: result.agentErrors || [],
    search_language: "english",
  };
}

// ─── Startup Recovery ─────────────────────────────────────────────

/**
 * Called once at server startup.
 * Finds projects stuck in "running" or "queued" state (server crash),
 * marks them as "error", and registers synthetic lost jobs so that
 * SSE clients connecting after a restart receive a proper error event.
 */
export async function recoverOrphanedJobs() {
  try {
    const orphans = await Project.find({
      status: { $in: ["running", "queued"] },
    }).select("_id jobId status repoName");

    if (orphans.length === 0) return;

    const { jobs } = await import("../../services/job-registry.service.js");

    const RECOVERY_MSG = "Pipeline was interrupted. Please retry.";
    const orphanIds = [];

    for (const p of orphans) {
      // Skip if already registered — genuine in-flight pipeline
      if (p.jobId && jobs.has(p.jobId)) continue;
      if (p.jobId) recoverLostJob(p.jobId, RECOVERY_MSG);
      orphanIds.push(p._id);
    }

    if (orphanIds.length > 0) {
      await Project.updateMany(
        { _id: { $in: orphanIds } },
        {
          status: "error",
          errorMessage: RECOVERY_MSG,
        },
      );
      console.log(
        `[recovery] Marked ${orphanIds.length} orphaned project(s) as error.`,
        orphans
          .filter((p) => orphanIds.some((id) => id.equals(p._id)))
          .map((p) => `${p.repoName} (${p.jobId})`)
          .join(", "),
      );
    }
  } catch (err) {
    console.error("[recovery] Failed to recover orphaned jobs:", err.message);
  }
}

// ─── Project CRUD ─────────────────────────────────────────────────

/**
 * Create a new project and start the full documentation pipeline.
 * Returns immediately with the project document — pipeline runs async.
 */
export async function createProject({ userId, repoUrl }) {
  const { owner, repoName, normalised } = parseGitHubUrl(repoUrl);

  // Prevent duplicate pipelines for the same repo
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

  // Fire-and-forget — caller streams progress via SSE
  runPipeline({ project, normalised, jobId }).catch((err) =>
    console.error(`❌ Pipeline crash [${jobId}]:`, err.message),
  );

  return project;
}

/**
 * Retry a failed or errored project with a completely fresh full pipeline run.
 * Clears all stored outputs so the run starts from a clean state.
 */
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

  // Clear all outputs before retry to ensure a clean state
  await Project.findByIdAndUpdate(project._id, {
    $set: {
      jobId,
      status: "running",
      errorMessage: null,
      techStack: [],
      testFrameworks: [],
      architectureHint: "",
      entryPoints: [],
      keyFiles: [],
      stats: {},
      security: {},
      output: {},
      agentOutputs: {},
      routing: null,
      pipelineReport: null,
      agentErrors: [],
      chatSessionId: null,
      archivedAt: null,
      lastDocumentedCommit: null,
      fileManifest: [],
      events: [],
      editedSections: [],
      editedOutput: {},
    },
  });

  registerJob(jobId);

  runPipeline({ project, normalised: project.repoUrl, jobId }).catch((err) =>
    console.error(`❌ Retry crash [${jobId}]:`, err.message),
  );

  return Project.findById(project._id);
}

/**
 * List projects for a user with pagination, filtering, and sorting.
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
      // Exclude large fields from list queries
      .select(
        "-output -events -editedOutput -fileManifest -agentOutputs -pipelineReport",
      ),
    Project.countDocuments(query),
  ]);

  return {
    projects,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get a project by ID.
 * Accessible to the owner or any user with an accepted share invitation.
 * Attaches _shareRole to the document for downstream permission checks.
 */
export async function getProjectById({ projectId, userId }) {
  return assertAccess(projectId, userId, "viewer");
}

/**
 * Return the pipeline event log.
 * Accessible to owners and shared members (viewer+).
 */
export async function getProjectEvents({ projectId, userId }) {
  await assertAccess(projectId, userId, "viewer");

  const project = await Project.findById(projectId).select(
    "status jobId events",
  );
  if (!project)
    throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);

  return {
    events: project.events || [],
    status: project.status,
    jobId: project.jobId,
  };
}

/**
 * Hard-delete a project and all its version history.
 * Owner-only.
 */
export async function deleteProject({ projectId, userId }) {
  const project = await assertOwnership(projectId, userId);

  if (project.status === "running" || project.status === "queued")
    throw domainError(
      "Cannot delete a running project.",
      "PROJECT_RUNNING",
      409,
    );

  await Promise.all([
    Project.findByIdAndDelete(projectId),
    DocumentVersion.deleteMany({ projectId }),
  ]);
}

/**
 * Soft-update a project (currently: archive only).
 * Owner-only.
 */
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
    await project.save();
  }

  return project;
}

// ─── Incremental Sync ─────────────────────────────────────────────

/**
 * Check for new commits and run only the affected pipeline segments.
 * Falls back to a full run if:
 *   - No stored baseline exists
 *   - A manifest file changed
 *   - forceFullRun = true
 *   - Changed file count exceeds FULL_RUN_THRESHOLD
 *
 * Accessible to owner only — sync mutates project state.
 *
 * @param {{ projectId, userId, forceFullRun, webhookChangedFiles }}
 * @returns {{ project, streamUrl }}
 */
export async function syncProject({
  projectId,
  userId,
  forceFullRun = false,
  webhookChangedFiles = null,
}) {
  // Load with extra fields needed for incremental sync
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
  project.errorMessage = null;
  await project.save();

  registerJob(jobId);

  // Fire-and-forget — caller streams progress via SSE
  runSync({ project, jobId, forceFullRun, webhookChangedFiles }).catch((err) =>
    console.error(`❌ Sync crash [${jobId}]:`, err.message),
  );

  return {
    project,
    streamUrl: `/projects/${project._id}/stream`,
  };
}

// ─── Document Editing ─────────────────────────────────────────────

/**
 * Save a user edit for one documentation section.
 * Requires editor or owner access.
 *
 * Flow:
 *   1. Snapshot current effective content as a version
 *   2. Write new content to editedOutput
 *   3. Mark section in editedSections
 *   4. Create version entry for the new edit
 */
export async function editDocSection({ projectId, userId, section, content }) {
  if (!SECTIONS.includes(section))
    throw domainError(
      `Invalid section. Must be one of: ${SECTIONS.join(", ")}`,
      "INVALID_SECTION",
      400,
    );

  const project = await assertAccess(projectId, userId, "editor");

  if (project.status !== "done")
    throw domainError(
      "Can only edit documentation for completed projects.",
      "PROJECT_NOT_READY",
      409,
    );

  // Snapshot current content before overwriting
  const currentContent =
    project.editedOutput?.[section] || project.output?.[section] || "";

  const snapshotSource = project.editedSections?.some(
    (s) => s.section === section,
  )
    ? "user"
    : "ai_full";

  if (currentContent) {
    await DocumentVersion.createVersion({
      projectId: project._id,
      section,
      content: currentContent,
      source: snapshotSource,
      meta: { changeSummary: "Snapshot before user edit" },
    }).catch((err) => console.warn("[versions] Snapshot failed:", err.message));
  }

  // Apply the edit
  const editedSections = (project.editedSections || []).filter(
    (s) => s.section !== section,
  );
  editedSections.push({ section, editedAt: new Date(), stale: false });

  await Project.findByIdAndUpdate(project._id, {
    [`editedOutput.${section}`]: content,
    editedSections,
  });

  // Record the new edit as a version
  await DocumentVersion.createVersion({
    projectId: project._id,
    section,
    content,
    source: "user",
    meta: { changeSummary: "User edit" },
  }).catch((err) =>
    console.warn("[versions] Version save failed:", err.message),
  );

  return getProjectById({ projectId, userId });
}

/**
 * Revert a section to its latest AI-generated content.
 * Clears editedOutput and editedSections entry for this section.
 * Requires editor or owner access.
 */
export async function revertDocSection({ projectId, userId, section }) {
  if (!SECTIONS.includes(section))
    throw domainError(
      `Invalid section. Must be one of: ${SECTIONS.join(", ")}`,
      "INVALID_SECTION",
      400,
    );

  await assertAccess(projectId, userId, "editor");

  const editedSections =
    (
      await Project.findById(projectId).select("editedSections").lean()
    )?.editedSections?.filter((s) => s.section !== section) || [];

  await Project.findByIdAndUpdate(projectId, {
    [`editedOutput.${section}`]: "",
    editedSections,
  });

  return getProjectById({ projectId, userId });
}

/**
 * Accept the new AI-generated content for a stale section.
 * Semantically identical to revertDocSection — clears the user edit
 * and the stale flag, making the AI version the active content.
 * Requires editor or owner access.
 */
export async function acceptAISection({ projectId, userId, section }) {
  if (!SECTIONS.includes(section))
    throw domainError(
      `Invalid section. Must be one of: ${SECTIONS.join(", ")}`,
      "INVALID_SECTION",
      400,
    );

  // Save a version of the user's content before discarding it
  const project = await assertAccess(projectId, userId, "editor");
  const userContent = project.editedOutput?.[section];

  if (userContent) {
    await DocumentVersion.createVersion({
      projectId: project._id,
      section,
      content: userContent,
      source: "user",
      meta: { changeSummary: "Snapshot before accepting AI regeneration" },
    }).catch((err) => console.warn("[versions] Snapshot failed:", err.message));
  }

  return revertDocSection({ projectId, userId, section });
}

// ─── Version History ──────────────────────────────────────────────

/**
 * List version history for a section — newest first.
 * Content is excluded from list results (too large); use getVersion for full content.
 * Accessible to owner and shared members (viewer+).
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

  await assertAccess(projectId, userId, "viewer");

  const [versions, total] = await Promise.all([
    DocumentVersion.find({ projectId, section })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("-content"),
    DocumentVersion.countDocuments({ projectId, section }),
  ]);

  return { versions, total, page, limit, totalPages: Math.ceil(total / limit) };
}

/**
 * Fetch a single version with full content.
 * Accessible to owner and shared members (viewer+).
 */
export async function getVersion({ projectId, userId, versionId }) {
  await assertAccess(projectId, userId, "viewer");

  const version = await DocumentVersion.findOne({ _id: versionId, projectId });
  if (!version)
    throw domainError("Version not found.", "VERSION_NOT_FOUND", 404);

  return version;
}

/**
 * Restore a historical version as the current user edit.
 * Snapshots current content first, then applies restore.
 * Requires editor or owner access.
 */
export async function restoreVersion({ projectId, userId, versionId }) {
  const project = await assertAccess(projectId, userId, "editor");
  const version = await DocumentVersion.findOne({ _id: versionId, projectId });
  if (!version)
    throw domainError("Version not found.", "VERSION_NOT_FOUND", 404);

  if (project.status !== "done")
    throw domainError(
      "Can only restore versions for completed projects.",
      "PROJECT_NOT_READY",
      409,
    );

  // Snapshot current effective content before restore
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
      meta: {
        changeSummary: `Snapshot before restore to version ${version._id}`,
      },
    }).catch((err) => console.warn("[versions] Snapshot failed:", err.message));
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

  // Record the restore as a version
  await DocumentVersion.createVersion({
    projectId: project._id,
    section: version.section,
    content: version.content,
    source: "user",
    meta: {
      changeSummary: `Restored from version ${version._id} (${version.source} · ${version.createdAt.toISOString()})`,
    },
  }).catch((err) =>
    console.warn("[versions] Restore version save failed:", err.message),
  );

  return getProjectById({ projectId, userId });
}

// ─── Internal Pipeline Runners ────────────────────────────────────

/**
 * Run the full 6-agent documentation pipeline.
 * Called by createProject and retryProject.
 * Persists the complete result to MongoDB and finishes the job.
 */
async function runPipeline({ project, normalised, jobId }) {
  const orchestrate = await getOrchestrate();
  const onProgress = makeProgressHandler(project._id, jobId);

  try {
    const result = await orchestrate(normalised, onProgress);

    if (!result.success) {
      await Project.findByIdAndUpdate(project._id, {
        status: "error",
        errorMessage: result.error || "Unknown pipeline error",
      });
      failJob(jobId, new Error(result.error || "Unknown pipeline error"));
      return;
    }

    // Build and persist the full update
    const update = buildFullRunUpdate(
      result,
      result.lastDocumentedCommit,
      null,
    );
    await Project.findByIdAndUpdate(project._id, { $set: update });

    // Create version history for all generated sections (parallel)
    await createInitialVersions(
      project._id,
      result.output,
      result.lastDocumentedCommit,
    );

    // Log non-fatal agent errors to console (they're also stored in agentErrors field)
    if (result.agentErrors?.length) {
      console.warn(
        `[pipeline:${jobId}] ${result.agentErrors.length} non-fatal agent error(s):`,
        result.agentErrors.map((e) => `${e.agent}: ${e.error}`).join("; "),
      );
    }

    finishJob(jobId, {
      success: true,
      stats: result.stats,
      security: result.security,
      agentErrors: result.agentErrors,
      routing: result.routing,
    });
  } catch (err) {
    console.error(`[pipeline:${jobId}] Fatal error:`, err);
    await Project.findByIdAndUpdate(project._id, {
      status: "error",
      errorMessage: err.message,
    });
    failJob(jobId, err);
  }
}

/**
 * Run the incremental sync pipeline.
 * Called by syncProject.
 * Handles three outcomes: skipped, full run fallback, incremental success.
 */
async function runSync({ project, jobId, forceFullRun, webhookChangedFiles }) {
  const incrementalSync = await getIncrementalSync();
  const onProgress = makeProgressHandler(project._id, jobId);

  try {
    console.log(
      `[sync:${jobId}] Starting incremental sync for ${project.repoUrl} · forceFullRun=${forceFullRun} · webhookFiles=${webhookChangedFiles?.length || 0}`,
    );

    const syncResult = await incrementalSync(project, onProgress, {
      forceFullRun,
      webhookChangedFiles,
    });

    console.log(`[sync:${jobId}] Sync result: `, {
      success: syncResult.success,
      skipped: syncResult.skipped,
      isFullRun: syncResult.isFullRun,
      error: syncResult.error,
    });

    // ── Outcome: sync failed ──────────────────────────────────
    if (!syncResult.success) {
      const errorMsg = syncResult.error || "Sync failed";
      console.error(`[sync:${jobId}] Sync failed: ${errorMsg}`);
      await Project.findByIdAndUpdate(project._id, {
        status: "error",
        errorMessage: errorMsg,
      });
      failJob(jobId, new Error(errorMsg));
      return;
    }

    // ── Outcome: skipped (no changes / already up-to-date) ────
    if (syncResult.skipped) {
      console.log(
        `[sync:${jobId}] Sync skipped (${syncResult.reason}), marking done`,
      );
      await Project.findByIdAndUpdate(project._id, {
        status: "done",
        lastDocumentedCommit: syncResult.currentCommit,
        "stats.lastChecked": new Date(),
      });
      finishJob(jobId, {
        success: true,
        skipped: true,
        reason: syncResult.reason,
      });
      return;
    }

    // ── Outcome: full run fallback ────────────────────────────
    if (syncResult.isFullRun) {
      console.log(
        `[sync:${jobId}] Fell back to full run — applying full pipeline result`,
      );
      const result = syncResult._fullResult;

      if (!result?.success) {
        const errorMsg = result?.error || "Full sync failed";
        console.error(`[sync:${jobId}] Full sync failed: ${errorMsg}`);
        await Project.findByIdAndUpdate(project._id, {
          status: "error",
          errorMessage: errorMsg,
        });
        failJob(jobId, new Error(errorMsg));
        return;
      }

      const update = buildFullRunUpdate(
        result,
        syncResult.currentCommit || result.lastDocumentedCommit,
        syncResult._freshTree,
      );

      await Project.findByIdAndUpdate(project._id, { $set: update });

      // Create version history for all sections (parallel)
      await createInitialVersions(
        project._id,
        result.output,
        syncResult.currentCommit,
      );

      finishJob(jobId, {
        success: true,
        isFullRun: true,
        stats: result.stats,
        security: result.security,
        agentErrors: result.agentErrors || syncResult.errors,
      });
      return;
    }

    // ── Outcome: incremental success ──────────────────────────
    // The incremental sync returns a pre-built _update object ready
    // for direct MongoDB application.

    const { _update, ...syncMeta } = syncResult;

    if (!_update) {
      // Shouldn't happen — guard against malformed sync result
      const errorMsg = "Sync returned no update payload";
      console.error(`[sync:${jobId}] ${errorMsg}`);
      await Project.findByIdAndUpdate(project._id, {
        status: "error",
        errorMessage: errorMsg,
      });
      failJob(jobId, new Error(errorMsg));
      return;
    }

    console.log(
      `[sync:${jobId}] Incremental sync successful · ${syncResult.sectionsRegenerated?.length || 0} sections updated`,
    );

    await Project.findByIdAndUpdate(project._id, {
      $set: {
        ..._update,
        status: "done",
        search_language: "english",
        // Carry forward non-mutated fields from original result
        techStack: project.techStack || _update.techStack || [],
        testFrameworks: project.testFrameworks || [],
        architectureHint:
          project.architectureHint || _update.architectureHint || "",
      },
    });

    // Log non-fatal errors
    if (syncResult.errors?.length) {
      console.warn(
        `[sync:${jobId}] ${syncResult.errors.length} non-fatal error(s):`,
        syncResult.errors
          .map((e) => `${e.agent ?? e.phase}: ${e.error}`)
          .join("; "),
      );
    }

    finishJob(jobId, {
      success: true,
      isFullRun: false,
      sectionsRegenerated: syncMeta.sectionsRegenerated,
      sectionsSkipped: syncMeta.sectionsSkipped,
      agentsRun: syncMeta.agentsRun,
      changedFileCount: syncMeta.changedFileCount,
      removedFileCount: syncMeta.removedFileCount,
      totalDuration: syncMeta.totalDuration,
      errors: syncResult.errors,
    });
  } catch (err) {
    console.error(`[sync:${jobId}] Fatal error:`, err);
    await Project.findByIdAndUpdate(project._id, {
      status: "error",
      errorMessage: err.message,
    });
    failJob(jobId, err);
  }
}
