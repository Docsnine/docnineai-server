// ===================================================================
// Central API router
//
// Route map:
//   /auth          — authentication & session management
//   /github        — GitHub OAuth + repository access
//   /projects      — project CRUD + pipeline + SSE stream + exports
//   /webhook       — user-level GitHub webhooks + billing webhooks
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
import adminRoutes from "./admin/admin.routes.js";
import {
  handleWebhook,
  handleFlutterwaveWebhook,
  registerWebhookHandlers,
} from "./webhook/webhook.controller.js";

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
  "billing-webhook": false,
};

let _orchestrate = null;
let _chat = null;
let _exportToPDF = null;
let _exportToNotion = null;
let _handleGlobalWebhook = null;
let _handleFlutterwaveWebhook = null;
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
      _handleGlobalWebhook = m.handleWebhook;
      _genWorkflow = m.generateGitHubActionsWorkflow;
    }),
    load("billing-webhook", async () => {
      const m = await import("./billing/billing.webhook.js");
      _handleFlutterwaveWebhook = m.handleFlutterwaveWebhook;
    }),
  ]);

  const loaded = Object.entries(serviceStatus)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");
  console.log(`[services] Ready: ${loaded || "none"}`);

  // Register loaded webhook service handlers with controller
  if (_handleGlobalWebhook && _handleFlutterwaveWebhook) {
    registerWebhookHandlers(_handleGlobalWebhook, _handleFlutterwaveWebhook);
  }
}

router.post("/webhook/github", handleWebhook);

// ── Flutterwave Webhook ────────────────────────────────────────────
router.post("/webhook/flutterwave", handleFlutterwaveWebhook);

export default router;
