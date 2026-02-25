// ===================================================================
// Thin controllers — parse request, call service, send response.
// Export handlers are also here: they reconstruct export data from
// MongoDB so they work after server restarts (not just while the
// in-memory job exists).
// ===================================================================

import * as projectService from "./project.service.js";
import { ok, fail, serverError } from "../../utils/response.util.js";
import { jobs, streams } from "../../services/jobRegistry.js";

// ── Lazy-load export services ────────────────────────────────
let _exportToPDF = null;
let _exportToNotion = null;
let _genWorkflow = null;

async function getExportToPDF() {
  if (_exportToPDF) return _exportToPDF;
  try {
    const m = await import("../../services/exportService.js");
    _exportToPDF = m.exportToPDF;
    return _exportToPDF;
  } catch {
    return null;
  }
}

async function getExportToNotion() {
  if (_exportToNotion) return _exportToNotion;
  try {
    const m = await import("../../services/exportService.js");
    _exportToNotion = m.exportToNotion;
    return _exportToNotion;
  } catch {
    return null;
  }
}

async function getGenWorkflow() {
  if (_genWorkflow) return _genWorkflow;
  try {
    const m = await import("../../services/webhookService.js");
    _genWorkflow = m.generateGitHubActionsWorkflow;
    return _genWorkflow;
  } catch {
    return null;
  }
}

// ── Error handling ────────────────────────────────────────────
const DOMAIN_CODES = new Set([
  "INVALID_REPO_URL",
  "DUPLICATE_PROJECT",
  "PROJECT_NOT_FOUND",
  "PROJECT_RUNNING",
  "PROJECT_ARCHIVED",
]);

function handleServiceError(res, err, context) {
  if (DOMAIN_CODES.has(err.code)) {
    return fail(res, err.code, err.message, err.status || 400);
  }
  return serverError(res, err, context);
}

// ── POST /projects ────────────────────────────────────────────
export async function createProject(req, res) {
  try {
    const project = await projectService.createProject({
      userId: req.user.userId,
      repoUrl: req.body.repoUrl,
    });
    return ok(
      res,
      { project, streamUrl: `/projects/${project._id}/stream` },
      "Project created. Documentation pipeline started.",
      201,
    );
  } catch (err) {
    return handleServiceError(res, err, "createProject");
  }
}

// ── GET /projects ─────────────────────────────────────────────
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

// ── GET /projects/:id ─────────────────────────────────────────
export async function getProject(req, res) {
  try {
    const project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    return ok(res, { project });
  } catch (err) {
    return handleServiceError(res, err, "getProject");
  }
}

// ── DELETE /projects/:id ──────────────────────────────────────
export async function deleteProject(req, res) {
  try {
    await projectService.deleteProject({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    return ok(res, null, "Project deleted.");
  } catch (err) {
    return handleServiceError(res, err, "deleteProject");
  }
}

// ── PATCH /projects/:id ───────────────────────────────────────
export async function updateProject(req, res) {
  try {
    const project = await projectService.updateProject({
      projectId: req.params.id,
      userId: req.user.userId,
      updates: req.body,
    });
    return ok(res, { project }, "Project updated.");
  } catch (err) {
    return handleServiceError(res, err, "updateProject");
  }
}

// ── POST /projects/:id/retry ──────────────────────────────────
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
    return handleServiceError(res, err, "retryProject");
  }
}

// ── GET /projects/:id/stream — SSE ───────────────────────────
// Not wrapped with wrap() — long-lived streaming response.
// Ownership is verified before opening the stream.
export async function streamProject(req, res) {
  const projectId = req.params.id;

  let project;
  
  try {
    project = await projectService.getProjectById({
      projectId,
      userId: req.user.userId,
    });
  } catch (err) {
    const status = err.code === "PROJECT_NOT_FOUND" ? 404 : 500;
    return res.status(status).json({
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

  // ── Job not in memory: reconstruct from MongoDB ──────────────
  if (!job) {
    const syntheticResult = {
      success: project.status === "done",
      output: project.output,
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
          msg: "Pipeline state lost (server restarted). Use POST /projects/:id/retry to re-run.",
        })}\n\n`,
      );
    }
    return res.end();
  }

  // ── Replay buffered events ───────────────────────────────────
  for (const e of job.events) {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }

  // ── Already done in memory ───────────────────────────────────
  if (job.status !== "running") {
    res.write(
      `data: ${JSON.stringify({ step: "done", result: job.result })}\n\n`,
    );
    return res.end();
  }

  // ── Still running — register as SSE client ───────────────────
  const clients = streams.get(jobId) || new Set();
  clients.add(res);
  streams.set(jobId, clients);

  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      /* client gone */
    }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    const s = streams.get(jobId);
    if (s) s.delete(res);
  });
}

// ── GET /projects/:id/export/pdf ─────────────────────────────
export async function exportPdf(req, res) {
  const exportToPDF = await getExportToPDF();
  if (!exportToPDF) {
    return fail(
      res,
      "SERVICE_UNAVAILABLE",
      "PDF export requires pdfkit. Run: npm install pdfkit",
      503,
    );
  }

  try {
    const project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });

    if (project.status !== "done") {
      return fail(
        res,
        "PROJECT_NOT_READY",
        "Documentation pipeline has not completed successfully.",
        409,
      );
    }

    exportToPDF(res, {
      meta: project.meta || {},
      output: project.output || {},
      stats: project.stats || {},
      securityScore: project.security?.score ?? null,
    });
  } catch (err) {
    return handleServiceError(res, err, "exportPdf");
  }
}

// ── GET /projects/:id/export/yaml ────────────────────────────
export async function exportYaml(req, res) {
  const genWorkflow = await getGenWorkflow();
  if (!genWorkflow) {
    return fail(
      res,
      "SERVICE_UNAVAILABLE",
      "Workflow generator unavailable.",
      503,
    );
  }

  try {
    // Ownership check
    await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });

    const yml = genWorkflow(`${req.protocol}://${req.get("host")}`);
    res.setHeader("Content-Type", "text/yaml");
    res.setHeader("Content-Disposition", "attachment; filename=document.yml");
    res.send(yml);
  } catch (err) {
    return handleServiceError(res, err, "exportYaml");
  }
}

// ── POST /projects/:id/export/notion ─────────────────────────
export async function exportNotion(req, res) {
  const exportToNotion = await getExportToNotion();
  if (!exportToNotion) {
    return fail(
      res,
      "SERVICE_UNAVAILABLE",
      "Notion export requires @notionhq/client. Run: npm install @notionhq/client",
      503,
    );
  }

  try {
    const project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });

    if (project.status !== "done") {
      return fail(
        res,
        "PROJECT_NOT_READY",
        "Documentation pipeline has not completed successfully.",
        409,
      );
    }

    const result = await exportToNotion({
      meta: project.meta || {},
      output: project.output || {},
      stats: project.stats || {},
      securityScore: project.security?.score ?? null,
    });

    return ok(res, result, "Documentation pushed to Notion.");
  } catch (err) {
    if (err.message?.includes("NOTION_API_KEY")) {
      return fail(res, "NOTION_NOT_CONFIGURED", err.message, 503);
    }
    return handleServiceError(res, err, "exportNotion");
  }
}
