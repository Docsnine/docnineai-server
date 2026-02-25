// ===================================================================
// Backward-compatible /api/* pipeline routes.
// Mounted at /api in src/api/router.js.
//
// WHY THIS EXISTS:
//   The original src/index.js manages its own job Maps and calls
//   app.listen() — we can't import routes from it without starting
//   a second server. This router re-implements the same /api/* surface
//   using the shared jobRegistry so both the unauthenticated legacy flow
//   AND the authenticated /projects flow share SSE infrastructure.
//
//   src/index.js is left completely untouched.
//
// Services status is exported for the /health endpoint.
// ===================================================================

import { Router } from "express";
import { randomUUID } from "crypto";
import {
  jobs,
  streams,
  registerJob,
  pushEvent,
  finishJob,
  failJob,
} from "../services/job-registry.service.js";

const router = Router();

// ── Lazy service loader ───────────────────────────────────────

export const serviceStatus = {
  orchestrator: false,
  chat: false,
  pdf: false,
  notion: false,
  webhook: false,
};

let _orchestrate = null;
let _chat = null;
let _exportToPDF = null;
let _exportToNotion = null;
let _handleWebhook = null;
let _genWorkflow = null;

async function load(label, fn) {
  try {
    await fn();
    serviceStatus[label] = true;
  } catch (e) {
    console.warn(`⚠️  ${label}: ${e.message}`);
  }
}

export async function loadLegacyServices() {
  await load("orchestrator", async () => {
    const m = await import("../services/orchestrator.js");
    _orchestrate = m.orchestrate;
  });
  await load("chat", async () => {
    const m = await import("../services/chatService.js");
    _chat = m.chat;
  });
  await load("pdf", async () => {
    const m = await import("../services/exportService.js");
    _exportToPDF = m.exportToPDF;
    _exportToNotion = m.exportToNotion;
    serviceStatus["notion"] = true;
  });
  await load("webhook", async () => {
    const m = await import("../services/webhookService.js");
    _handleWebhook = m.handleWebhook;
    _genWorkflow = m.generateGitHubActionsWorkflow;
  });
}

// ── POST /api/document ────────────────────────────────────────
router.post("/document", (req, res) => {
  if (!_orchestrate) {
    return res.status(503).json({
      error:
        "Orchestration service unavailable. Check server logs for import errors.",
    });
  }

  const { repoUrl } = req.body || {};
  if (!repoUrl || typeof repoUrl !== "string") {
    return res.status(400).json({ error: "repoUrl (string) is required" });
  }
  if (!repoUrl.includes("github.com")) {
    return res.status(400).json({ error: "Only GitHub URLs are supported" });
  }

  const jobId = randomUUID();
  registerJob(jobId);

  res
    .status(202)
    .json({ jobId, status: "running", streamUrl: `/api/stream/${jobId}` });

  _orchestrate(repoUrl, (event) => pushEvent(jobId, event))
    .then((result) => finishJob(jobId, result))
    .catch((err) => failJob(jobId, err));
});

// ── GET /api/stream/:jobId — SSE ─────────────────────────────
router.get("/stream/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) return res.status(404).json({ error: "Job not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  for (const event of job.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
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
      clearInterval(heartbeat);
    }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    const s = streams.get(jobId);
    if (s) s.delete(res);
  });
});

// ── POST /api/chat ────────────────────────────────────────────
router.post("/chat", async (req, res) => {
  if (!_chat)
    return res.status(503).json({ error: "Chat service unavailable" });

  const { sessionId, message } = req.body || {};
  if (!sessionId || !message) {
    return res
      .status(400)
      .json({ error: "sessionId and message are required" });
  }
  try {
    res.json(await _chat({ jobId: sessionId, message }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/export/pdf/:jobId ────────────────────────────────
router.get("/export/pdf/:jobId", (req, res) => {
  if (!_exportToPDF) {
    return res
      .status(503)
      .json({ error: "PDF export unavailable. Run: npm install pdfkit" });
  }
  const job = jobs.get(req.params.jobId);
  if (!job?.result?.success) {
    return res.status(404).json({ error: "Job not found or not complete" });
  }
  _exportToPDF(res, job.result);
});

// ── POST /api/export/notion/:jobId ───────────────────────────
router.post("/export/notion/:jobId", async (req, res) => {
  if (!_exportToNotion) {
    return res
      .status(503)
      .json({
        error: "Notion export unavailable. Run: npm install @notionhq/client",
      });
  }
  const job = jobs.get(req.params.jobId);
  if (!job?.result?.success) {
    return res.status(404).json({ error: "Job not found or not complete" });
  }
  try {
    const result = await _exportToNotion(job.result);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/export/workflow/:jobId ──────────────────────────
router.get("/export/workflow/:jobId", (req, res) => {
  if (!_genWorkflow) {
    return res.status(503).json({ error: "Webhook service unavailable" });
  }
  const yml = _genWorkflow(`${req.protocol}://${req.get("host")}`);
  res.setHeader("Content-Type", "text/yaml");
  res.setHeader("Content-Disposition", "attachment; filename=document.yml");
  res.send(yml);
});

// ── POST /api/webhook ─────────────────────────────────────────
// Raw body was parsed before express.json() in server.js
router.post("/webhook", async (req, res) => {
  if (!_handleWebhook) {
    return res.status(503).json({ error: "Webhook service unavailable" });
  }
  try {
    const result = await _handleWebhook({
      payload: req.body,
      signature: req.headers["x-hub-signature-256"] || "",
      secret: process.env.WEBHOOK_SECRET,
      jobs,
      streams,
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
