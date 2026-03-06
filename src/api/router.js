// ===================================================================
// Central API router
//
// Route map:
//   /auth          — authentication & session management
//   /github        — GitHub OAuth + repository access
//   /projects      — project CRUD + pipeline + SSE stream + exports
//   /webhook       — per-project webhooks + flutterwave billing webhooks
//   /document      — legacy document processing (backward compatibility)
//   /stream        — SSE streaming for jobs (backward compatibility)
//   /chat          — chat service
//   /export        — pdf & notion exports (backward compatibility)
// ===================================================================

import { Router } from "express";
import authRoutes from "./auth/auth.routes.js";
import githubRoutes from "./github/github.routes.js";
import projectRoutes from "./projects/project.routes.js";
import portalRoutes from "./portal/portal.routes.js";
import billingRoutes from "./billing/billing.routes.js";
import { handleFlutterwaveWebhook } from "./billing/billing.webhook.js";
import adminRoutes from "./admin/admin.routes.js";

const router = Router();

router.use("/auth", authRoutes);
router.use("/github", githubRoutes);
router.use("/projects", projectRoutes);
router.use("/portal", portalRoutes); // public — no auth
router.use("/billing", billingRoutes);
router.use("/admin", adminRoutes);

// ── Service Status & Lazy Loading ──────────────────────────────────

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
let _handleProjectWebhook = null;
let _handleGlobalWebhook = null;
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

export async function loadServices() {
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
      _handleProjectWebhook = m.handleProjectWebhook;
      _handleGlobalWebhook = m.handleWebhook;
      _genWorkflow = m.generateWorkflowYAML;
    }),
  ]);

  const loaded = Object.entries(serviceStatus)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");
  console.log(`[services] Ready: ${loaded || "none"}`);
}

router.post("/webhook", async (req, res) => {
  if (!_handleGlobalWebhook) {
    return res.status(503).json({ error: "Webhook service unavailable" });
  }

  try {
    const payload = req.body;
    const signature = req.headers["x-hub-signature-256"] || "";
    const event = req.headers["x-github-event"] || "";

    const result = await _handleGlobalWebhook({
      payload,
      signature,
      event,
      secret: process.env.WEBHOOK_SECRET,
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[webhook] Unhandled error:", err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

router.post("/webhook/:projectId", async (req, res) => {
  if (!_handleProjectWebhook) {
    return res.status(503).json({ error: "Webhook service unavailable" });
  }

  try {
    const result = await _handleProjectWebhook({
      projectId: req.params.projectId,
      payload: req.body,
      signature: req.headers["x-hub-signature-256"] || "",
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[webhook] Unhandled error:", err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── Flutterwave Webhook ────────────────────────────────────────────
router.post("/webhook/flutterwave", handleFlutterwaveWebhook);

export default router;
