// src/index.js — Docnine v2 — SaaS Edition
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { randomUUID } from "crypto";
import dotenv from "dotenv";

dotenv.config();

import { orchestrate } from "./services/orchestrator.service.js";
import { chat } from "./services/chatService.js";
import { exportToPDF, exportToNotion } from "./services/exportService.js";
import {
  handleWebhook,
  generateGitHubActionsWorkflow,
} from "./services/webhook.service.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(morgan("dev"));
app.use(express.static("public"));

// Raw body needed for webhook signature verification
app.use("/api/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ── In-memory job store ───────────────────────────────────────
const jobs = new Map(); // jobId → { status, result, events[] }
const streams = new Map(); // jobId → [res, ...]

// ── Health ────────────────────────────────────────────────────
app.get("/health", (_, res) =>
  res.json({ status: "ok", version: "2.0", uptime: process.uptime() }),
);

// ── POST /api/document — start pipeline ───────────────────────
app.post("/api/document", async (req, res) => {
  const { repoUrl } = req.body;
  if (!repoUrl?.includes("github.com")) {
    return res.status(400).json({ error: "Valid GitHub URL required" });
  }

  const jobId = randomUUID();
  jobs.set(jobId, { status: "running", events: [], result: null });
  streams.set(jobId, []);

  res
    .status(202)
    .json({ jobId, status: "running", streamUrl: `/api/stream/${jobId}` });

  // Run pipeline async
  orchestrate(repoUrl, (event) => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.events.push(event);
    const data = `data: ${JSON.stringify(event)}\n\n`;
    (streams.get(jobId) || []).forEach((client) => {
      try {
        client.write(data);
      } catch {}
    });
  }).then((result) => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = result.success ? "done" : "error";
      job.result = result;
    }
    const doneData = `data: ${JSON.stringify({ step: "done", result })}\n\n`;
    (streams.get(jobId) || []).forEach((c) => {
      try {
        c.write(doneData);
        c.end();
      } catch {}
    });
    streams.delete(jobId);
  });
});

// ── GET /api/document/:jobId — poll result ────────────────────
app.get("/api/document/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ status: job.status, result: job.result, events: job.events });
});

// ── GET /api/stream/:jobId — SSE live progress ────────────────
app.get("/api/stream/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  job.events.forEach((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));

  if (job.status !== "running") {
    res.write(
      `data: ${JSON.stringify({ step: "done", result: job.result })}\n\n`,
    );
    return res.end();
  }

  const clients = streams.get(jobId) || [];
  clients.push(res);
  streams.set(jobId, clients);
  req.on("close", () => {
    streams.set(
      jobId,
      (streams.get(jobId) || []).filter((c) => c !== res),
    );
  });
});

// ── POST /api/chat — chat with codebase ──────────────────────
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: "sessionId and message required" });
  }
  try {
    const result = await chat({ jobId: sessionId, message });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/export/pdf/:jobId — download PDF ────────────────
app.get("/api/export/pdf/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.result?.success)
    return res.status(404).json({ error: "Job not ready" });
  const { meta, output, stats, security } = job.result;
  exportToPDF(res, { meta, output, stats, securityScore: security?.score });
});

// ── POST /api/export/notion/:jobId — push to Notion ──────────
app.post("/api/export/notion/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.result?.success)
    return res.status(404).json({ error: "Job not ready" });
  try {
    const { meta, output, stats, security } = job.result;
    const result = await exportToNotion({
      output,
      meta,
      stats,
      securityScore: security?.score,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/export/workflow/:jobId — download GH Actions yml ─
app.get("/api/export/workflow/:jobId", (req, res) => {
  const host = `${req.protocol}://${req.get("host")}`;
  const yml = generateGitHubActionsWorkflow(host);
  res.setHeader("Content-Type", "text/yaml");
  res.setHeader("Content-Disposition", "attachment; filename=document.yml");
  res.send(yml);
});

// ── POST /api/webhook — GitHub push webhook ───────────────────
app.post("/api/webhook", async (req, res) => {
  const signature = req.headers["x-hub-signature-256"] || "";
  const result = await handleWebhook({
    payload: req.body,
    signature,
    secret: process.env.WEBHOOK_SECRET,
    jobs,
    streams,
  });
  res.status(result.status).json(result.body);
});

app.listen(PORT, () => {
  console.log(`\n🚀 Docnine v2 → http://localhost:${PORT}`);
  console.log("   Endpoints:");
  console.log("   POST /api/document          — Generate docs");
  console.log("   GET  /api/stream/:id        — Live SSE progress");
  console.log("   POST /api/chat              — Chat with codebase");
  console.log("   GET  /api/export/pdf/:id    — Download PDF");
  console.log("   POST /api/export/notion/:id — Push to Notion");
  console.log("   GET  /api/export/workflow/:id — GitHub Actions yml");
  console.log("   POST /api/webhook           — GitHub push hook\n");
});
