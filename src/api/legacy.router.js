// ===================================================================
// CRITICAL FIX: The /api/webhook route MUST receive the raw request
// body bytes — not the parsed JSON object — so that HMAC signature
// verification works correctly.
//
// express.json() calls JSON.parse() and replaces req.body with a
// plain object. JSON.stringify(parsedObject) !== originalRawBytes
// because whitespace, key ordering, and unicode escapes may differ.
// This causes the HMAC to be computed over different bytes than what
// GitHub (or the Actions workflow) signed, producing a permanent
// "Invalid webhook signature" error.
//
// The fix: mount express.raw() ONLY on the /webhook route BEFORE
// the router is registered, so all other routes still get parsed JSON.
// ===================================================================

import { Router } from "express";
import express from "express";
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

// ── Raw body middleware for webhook route ─────────────────────────
//
// This MUST be declared before express.json() is applied globally.
// Mount it directly on the route so it only affects /api/webhook.
//
// In your main server setup (server.js / app.js), ensure the order is:
//   1. app.use('/api/webhook', express.raw({ type: '*/*' }))  ← raw bytes
//   2. app.use(express.json())                                 ← everything else
//   3. app.use('/api', apiRouter)
//
// OR use the router-level middleware below (works if apiRouter is
// mounted AFTER global express.json() — the router-level middleware
// overrides req.body for this specific route).

router.post(
  "/webhook",
  // Re-parse the body as raw Buffer, overriding whatever express.json() did.
  // If express.json() already consumed the stream, this won't re-read it.
  // The correct fix is in server.js — see note above. This is a belt-and-
  // suspenders guard for environments where order is hard to control.
  express.raw({ type: "*/*", limit: "10mb" }),
  async (req, res) => {
    if (!_handleWebhook) {
      return res.status(503).json({ error: "Webhook service unavailable" });
    }

    try {
      // req.body is a Buffer when express.raw() is applied correctly.
      // If it's still a parsed object, signature validation will fail with
      // a clear error message explaining the raw body middleware issue.
      const payload = req.body;
      const signature = req.headers["x-hub-signature-256"] || "";
      const event = req.headers["x-github-event"] || "";

      console.log(
        `[webhook] Incoming — event: ${event || "unknown"}, signature: ${signature.slice(0, 20)}...`,
      );
      console.log(
        `[webhook] Body type: ${Buffer.isBuffer(payload) ? "Buffer ✓" : typeof payload + " ✗ — raw body middleware may not be applied"}`,
      );
      console.log(
        `[webhook] Payload size: ${Buffer.isBuffer(payload) ? payload.length : (JSON.stringify(payload)?.length ?? 0)} bytes`,
      );

      const result = await _handleWebhook({
        payload,
        signature,
        event,
        secret: process.env.WEBHOOK_SECRET,
      });

      console.log(
        `[webhook] → ${result.status} · triggered: ${result.body.triggered?.length ?? 0}`,
      );
      res.status(result.status).json(result.body);
    } catch (err) {
      console.error("[webhook] ✗ Unhandled error:", err.message, err.stack);
      res.status(500).json({ error: err.message });
    }
  },
);

// api-router.js — add this temporarily
router.get("/webhook-test", (req, res) => {
  const secret = process.env.WEBHOOK_SECRET || "";
  const payload = Buffer.from('{"test":true}', "utf8");
  const computed =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(payload).digest("hex");

  res.json({
    secretLength: secret.length,
    secretFirst4: secret.slice(0, 4),
    secretLast4: secret.slice(-4),
    testSignature: computed,
    hasNewline: secret.includes("\n"),
    hasSpace: secret.includes(" "),
  });
});

// ── Service status tracker ────────────────────────────────────────

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
    console.log(`[services] ✓ ${label} loaded`);
  } catch (err) {
    console.warn(`[services] ⚠️  ${label} unavailable: ${err.message}`);
  }
}

export async function loadLegacyServices() {
  await Promise.all([
    load("orchestrator", async () => {
      const m = await import("../services/orchestrator.service.js");
      _orchestrate = m.orchestrate;
    }),
    load("chat", async () => {
      const m = await import("../services/chat.service.js");
      _chat = m.chat;
    }),
    load("pdf", async () => {
      const m = await import("../services/export.service.js");
      _exportToPDF = m.exportToPDF;
      _exportToNotion = m.exportToNotion;
      serviceStatus.notion = true;
    }),
    load("webhook", async () => {
      const m = await import("../services/webhook.service.js");
      _handleWebhook = m.handleWebhook;
      _genWorkflow = m.generateGitHubActionsWorkflow;
    }),
  ]);

  const loaded = Object.entries(serviceStatus)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");
  console.log(`[services] Ready: ${loaded || "none"}`);
}

// ── POST /api/document ────────────────────────────────────────────

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
    return res
      .status(400)
      .json({ error: "Only GitHub URLs are currently supported" });
  }

  const jobId = randomUUID();
  registerJob(jobId);

  res.status(202).json({
    jobId,
    status: "running",
    streamUrl: `/api/stream/${jobId}`,
  });

  _orchestrate(repoUrl, (event) => pushEvent(jobId, event))
    .then((result) => finishJob(jobId, result))
    .catch((err) => failJob(jobId, err));
});

// ── GET /api/stream/:jobId — SSE ──────────────────────────────────

router.get("/stream/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) return res.status(404).json({ error: "Job not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Replay all buffered events to the new client
  for (const event of job.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  // If job is already finished, send final result and close
  if (job.status !== "running") {
    res.write(
      `data: ${JSON.stringify({ step: "done", result: job.result })}\n\n`,
    );
    return res.end();
  }

  // Register this response as a live SSE client
  const clients = streams.get(jobId) || new Set();
  clients.add(res);
  streams.set(jobId, clients);

  // Heartbeat to prevent proxy/load balancer timeouts
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
    if (s) {
      s.delete(res);
      if (s.size === 0) streams.delete(jobId);
    }
  });
});

// ── POST /api/chat ────────────────────────────────────────────────

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

// ── GET /api/export/pdf/:jobId ────────────────────────────────────

router.get("/export/pdf/:jobId", (req, res) => {
  if (!_exportToPDF) {
    return res.status(503).json({
      error: "PDF export unavailable. Run: npm install pdfkit",
    });
  }
  const job = jobs.get(req.params.jobId);
  if (!job?.result?.success) {
    return res.status(404).json({ error: "Job not found or not complete" });
  }
  _exportToPDF(res, job.result);
});

// ── POST /api/export/notion/:jobId ───────────────────────────────

router.post("/export/notion/:jobId", async (req, res) => {
  if (!_exportToNotion) {
    return res.status(503).json({
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

// ── GET /api/export/workflow ──────────────────────────────────────

router.get("/export/workflow", (req, res) => {
  if (!_genWorkflow) {
    return res.status(503).json({ error: "Webhook service unavailable" });
  }
  const yml = _genWorkflow(`${req.protocol}://${req.get("host")}`);
  res.setHeader("Content-Type", "text/yaml; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="document.yml"');
  res.send(yml);
});

export default router;
