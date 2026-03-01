// =============================================================
// Thin HTTP layer.
// v3.1 additions: sync, doc-editing, version history handlers.
// =============================================================

import * as projectService from "./project.service.js";
import { ok, fail, serverError } from "../../utils/response.util.js";
import { jobs, streams } from "../../services/job-registry.service.js";
import { SECTIONS } from "../../models/DocumentVersion.js";

// ── Lazy export services ──────────────────────────────────────
let _exportToPDF = null;
let _exportToNotion = null;
let _genWorkflow = null;

async function getExportToPDF() {
  if (_exportToPDF) return _exportToPDF;

  try {
    const m = await import("../../services/export.service.js");
    _exportToPDF = m.exportToPDF;
  } catch (e) {
    console.error("Failed to load exportToPDF:", e);
  }

  return _exportToPDF;
}

async function getExportToNotion() {
  if (_exportToNotion) return _exportToNotion;
  
  try {
    const m = await import("../../services/export.service.js");
    _exportToNotion = m.exportToNotion;
  } catch (e) {
    console.error("Failed to load exportToNotion:", e);
  }

  return _exportToNotion;
}

async function getGenWorkflow() {
  if (_genWorkflow) return _genWorkflow;

  try {
    const m = await import("../../services/webhook.service.js");
    _genWorkflow = m.generateGitHubActionsWorkflow;
  } catch (e) {
    console.error("Failed to load generateGitHubActionsWorkflow:", e);
  }

  return _genWorkflow;
}

// ── Domain error handler ──────────────────────────────────────
const DOMAIN_CODES = new Set([
  "INVALID_REPO_URL",
  "DUPLICATE_PROJECT",
  "PROJECT_NOT_FOUND",
  "PROJECT_RUNNING",
  "PROJECT_ARCHIVED",
  "PROJECT_NOT_READY",
  "INVALID_SECTION",
  "VERSION_NOT_FOUND",
]);

function handleErr(res, err, ctx) {
  if (DOMAIN_CODES.has(err.code))
    return fail(res, err.code, err.message, err.status || 400);
  return serverError(res, err, ctx);
}

// ─────────────────────────────────────────────────────────────
// PROJECT CRUD
// ─────────────────────────────────────────────────────────────
export async function createProject(req, res) {
  try {
    const project = await projectService.createProject({
      userId: req.user.userId,
      repoUrl: req.body.repoUrl,
    });
    return ok(
      res,
      { project, streamUrl: `/projects/${project._id}/stream` },
      "Pipeline started.",
      201,
    );
  } catch (err) {
    return handleErr(res, err, "createProject");
  }
}

export async function listProjects(req, res) {
  const { page = "1", limit = "20", status, sort, search } = req.query;
  try {
    const result = await projectService.listProjects({
      userId: req.user.userId,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      status,
      sort,
      search,
    });
    return ok(res, result);
  } catch (err) {
    return serverError(res, err, "listProjects");
  }
}

export async function getProject(req, res) {
  try {
    const project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    // Return the effectiveOutput (merges user edits on top of AI output)
    return ok(res, {
      project,
      effectiveOutput: project.effectiveOutput,
      editedSections: project.editedSections,
      lastSyncedCommit: project.lastDocumentedCommit,
    });
  } catch (err) {
    return handleErr(res, err, "getProject");
  }
}

export async function deleteProject(req, res) {
  try {
    await projectService.deleteProject({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    return ok(res, null, "Project deleted.");
  } catch (err) {
    return handleErr(res, err, "deleteProject");
  }
}

export async function updateProject(req, res) {
  try {
    const project = await projectService.updateProject({
      projectId: req.params.id,
      userId: req.user.userId,
      updates: req.body,
    });
    return ok(res, { project }, "Project updated.");
  } catch (err) {
    return handleErr(res, err, "updateProject");
  }
}

export async function retryProject(req, res) {
  try {
    const project = await projectService.retryProject({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    return ok(
      res,
      { project, streamUrl: `/projects/${project._id}/stream` },
      "Pipeline restarted.",
      202,
    );
  } catch (err) {
    return handleErr(res, err, "retryProject");
  }
}

// ─────────────────────────────────────────────────────────────
// INCREMENTAL SYNC
// ─────────────────────────────────────────────────────────────

/**
 * POST /projects/:id/sync
 * Check for new commits and re-document only what changed.
 * Uses forceFullRun=true query param to bypass incremental logic.
 */
export async function syncProject(req, res) {
  const forceFullRun = req.query.force === "true";
  try {
    const result = await projectService.syncProject({
      projectId: req.params.id,
      userId: req.user.userId,
      forceFullRun,
    });
    return ok(
      res,
      { project: result.project, streamUrl: result.streamUrl },
      forceFullRun ? "Full re-run started." : "Incremental sync started.",
      202,
    );
  } catch (err) {
    return handleErr(res, err, "syncProject");
  }
}

// ─────────────────────────────────────────────────────────────
// SSE STREAM
// ─────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────
// PIPELINE EVENTS (persisted log)
// ───────────────────────────────────────────────────────────────

/**
 * GET /projects/:id/events
 * Returns the persisted pipeline event log for a project.
 * Events are stored per-project in MongoDB (last 200, select:false).
 */
export async function getProjectEvents(req, res) {
  try {
    const result = await projectService.getProjectEvents({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    return ok(res, result);
  } catch (err) {
    return handleErr(res, err, "getProjectEvents");
  }
}

export async function streamProject(req, res) {
  const projectId = req.params.id;

  let project;
  try {
    project = await projectService.getProjectById({
      projectId,
      userId: req.user.userId,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      error: { code: err.code || "INTERNAL_ERROR", message: err.message },
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const jobId = project.jobId;
  const job = jobs.get(jobId);

  if (!job) {
    const syntheticResult = {
      success: project.status === "done",
      output: project.effectiveOutput, // serve merged (user edits + AI)
      stats: project.stats,
      security: project.security,
      techStack: project.techStack,
      meta: project.meta,
      chat: project.chatSessionId ? { sessionId: project.chatSessionId } : null,
      error: project.errorMessage || null,
    };
    if (project.status === "done" || project.status === "error") {
      res.write(
        `data: ${JSON.stringify({ step: "done", result: syntheticResult })}\n\n`,
      );
    } else {
      res.write(
        `data: ${JSON.stringify({
          step: "error",
          status: "error",
          msg: "Pipeline state lost (server restarted). Use POST /projects/:id/retry or /sync to re-run.",
        })}\n\n`,
      );
    }
    return res.end();
  }

  for (const e of job.events) {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }

  if (job.status !== "running") {
    res.write(
      `data: ${JSON.stringify({ step: "done", result: job.result })}\n\n`,
    );
    return res.end();
  }

  const clients = streams.get(jobId) || new Set();
  clients.add(res);
  streams.set(jobId, clients);

  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      /* gone */
    }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    const s = streams.get(jobId);
    if (s) s.delete(res);
  });
}

// ─────────────────────────────────────────────────────────────
// DOCUMENT EDITING
// ─────────────────────────────────────────────────────────────

/**
 * PATCH /projects/:id/docs/:section
 * Save a user edit for one documentation section.
 */
export async function editDocSection(req, res) {
  const { section } = req.params;
  const { content } = req.body;
  if (typeof content !== "string" || content.trim().length === 0)
    return fail(
      res,
      "VALIDATION_ERROR",
      "content must be a non-empty string.",
      422,
    );
  try {
    const project = await projectService.editDocSection({
      projectId: req.params.id,
      userId: req.user.userId,
      section,
      content: content.trim(),
    });
    return ok(
      res,
      {
        project,
        effectiveOutput: project.effectiveOutput,
        editedSections: project.editedSections,
      },
      `Section "${section}" saved.`,
    );
  } catch (err) {
    return handleErr(res, err, "editDocSection");
  }
}

/**
 * DELETE /projects/:id/docs/:section/edit
 * Revert to AI-generated content (clear the user edit).
 */
export async function revertDocSection(req, res) {
  const { section } = req.params;
  try {
    const project = await projectService.revertDocSection({
      projectId: req.params.id,
      userId: req.user.userId,
      section,
    });
    return ok(
      res,
      {
        project,
        effectiveOutput: project.effectiveOutput,
        editedSections: project.editedSections,
      },
      `Section "${section}" reverted to AI version.`,
    );
  } catch (err) {
    return handleErr(res, err, "revertDocSection");
  }
}

/**
 * POST /projects/:id/docs/:section/accept-ai
 * User accepts the new AI-generated content for a stale section.
 * Equivalent to revert but semantically clearer when invoked after a sync.
 */
export async function acceptAISection(req, res) {
  const { section } = req.params;
  try {
    const project = await projectService.acceptAISection({
      projectId: req.params.id,
      userId: req.user.userId,
      section,
    });
    return ok(
      res,
      {
        project,
        effectiveOutput: project.effectiveOutput,
        editedSections: project.editedSections,
      },
      `Accepted new AI content for "${section}".`,
    );
  } catch (err) {
    return handleErr(res, err, "acceptAISection");
  }
}

// ─────────────────────────────────────────────────────────────
// VERSION HISTORY
// ─────────────────────────────────────────────────────────────

export async function listVersions(req, res) {
  const { section } = req.params;
  const { page = "1", limit = "20" } = req.query;
  try {
    const result = await projectService.listVersions({
      projectId: req.params.id,
      userId: req.user.userId,
      section,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
    return ok(res, result);
  } catch (err) {
    return handleErr(res, err, "listVersions");
  }
}

export async function getVersion(req, res) {
  try {
    const version = await projectService.getVersion({
      projectId: req.params.id,
      userId: req.user.userId,
      versionId: req.params.versionId,
    });
    return ok(res, { version });
  } catch (err) {
    return handleErr(res, err, "getVersion");
  }
}

export async function restoreVersion(req, res) {
  try {
    const project = await projectService.restoreVersion({
      projectId: req.params.id,
      userId: req.user.userId,
      versionId: req.params.versionId,
    });
    return ok(
      res,
      {
        project,
        effectiveOutput: project.effectiveOutput,
        editedSections: project.editedSections,
      },
      "Version restored.",
    );
  } catch (err) {
    return handleErr(res, err, "restoreVersion");
  }
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

export async function exportPdf(req, res) {
  const exportToPDF = await getExportToPDF();
  if (!exportToPDF)
    return fail(
      res,
      "SERVICE_UNAVAILABLE",
      "PDF export requires pdfkit. Run: npm install pdfkit",
      503,
    );
  try {
    const project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    if (project.status !== "done")
      return fail(res, "PROJECT_NOT_READY", "Pipeline has not completed.", 409);
    exportToPDF(res, {
      meta: project.meta || {},
      output: project.effectiveOutput, // serve merged content
      stats: project.stats || {},
      securityScore: project.security?.score ?? null,
    });
  } catch (err) {
    return handleErr(res, err, "exportPdf");
  }
}

export async function exportYaml(req, res) {
  const genWorkflow = await getGenWorkflow();
  if (!genWorkflow)
    return fail(
      res,
      "SERVICE_UNAVAILABLE",
      "Workflow generator unavailable.",
      503,
    );
  try {
    await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    const yml = genWorkflow(`${req.protocol}://${req.get("host")}`);
    res.setHeader("Content-Type", "text/yaml");
    res.setHeader("Content-Disposition", "attachment; filename=document.yml");
    res.send(yml);
  } catch (err) {
    return handleErr(res, err, "exportYaml");
  }
}

export async function exportNotion(req, res) {
  const exportToNotion = await getExportToNotion();
  
  if (!exportToNotion)
    return fail(
      res,
      "SERVICE_UNAVAILABLE",
      "Notion export requires @notionhq/client.",
      503,
    );
  try {
    const project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    if (project.status !== "done")
      return fail(res, "PROJECT_NOT_READY", "Pipeline has not completed.", 409);
    const result = await exportToNotion({
      meta: project.meta || {},
      output: project.effectiveOutput,
      stats: project.stats || {},
      securityScore: project.security?.score ?? null,
    });
    return ok(res, result, "Documentation pushed to Notion.");
  } catch (err) {
    if (err.message?.includes("NOTION_API_KEY"))
      return fail(res, "NOTION_NOT_CONFIGURED", err.message, 503);
    return handleErr(res, err, "exportNotion");
  }
}
