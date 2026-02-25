// src/server.js
// ─────────────────────────────────────────────────────────────
// Project Documentor v3 — unified entry point
//
// Route map:
//   /auth/*      — authentication (signup, login, refresh, etc.)
//   /github/*    — GitHub OAuth + repo picker
//   /projects/*  — project CRUD + pipeline + SSE + exports
//   /api/*       — legacy unauthenticated pipeline (v2 compatible)
//   /health      — liveness probe
//
// src/index.js is intentionally untouched.
// Run it standalone with `npm run start:legacy` if needed.
//
// WHY import "dotenv/config" first:
//   In ESM all imports are hoisted and evaluated before the module
//   body runs. Placing `import "dotenv/config"` as the very first
//   statement guarantees .env is populated before any other module
//   reads process.env — including jwt.util.js, crypto.util.js, etc.
// ─────────────────────────────────────────────────────────────

import "dotenv/config"; // MUST be first import — populates process.env from .env

import express from "express";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { connectDB } from "./config/db.js";
import apiRouter from "./api/router.js";
import { loadLegacyServices, serviceStatus } from "./api/legacy.router.js";

// ── App ───────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
const ENV = process.env.NODE_ENV || "development";

// ── CORS ──────────────────────────────────────────────────────
// credentials:true is required for the browser to send the
// httpOnly refresh-token cookie on /auth/* requests.
app.use(
  cors({
    origin: process.env.FRONTEND_URL || true, // reflect Origin in dev; lock down in prod
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  }),
);

// ── Body parsing ──────────────────────────────────────────────
// ORDER MATTERS:
//   /api/webhook needs the raw Buffer intact for HMAC-SHA256
//   verification. The raw() override must come BEFORE express.json().
app.use("/api/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// ── Request logging & static assets ──────────────────────────
app.use(morgan(ENV === "production" ? "combined" : "dev"));
app.use(express.static("public"));

// ── Health check — no auth, for monitoring tools ──────────────
app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    version: "3.0.0",
    env: ENV,
    uptime: Math.floor(process.uptime()),
    services: { ...serviceStatus }, // populated by loadLegacyServices()
  }),
);

// ── API routes ────────────────────────────────────────────────
// api/router.js is the single source of truth; it mounts:
//   /auth, /github, /projects, /api (legacy)
app.use("/", apiRouter);

// ── 404 — must be after all routes ───────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: `Route ${req.method} ${req.path} does not exist.`,
    },
  });
});

// ── Global error boundary ─────────────────────────────────────
// Must come after all routes. 4-parameter signature is required —
// do not remove `next` even if unused.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;

  const status = err.status || err.statusCode || 500;
  const isKnown = Boolean(err.isOperational || err.code);
  const message =
    isKnown || ENV !== "production"
      ? err.message
      : "An unexpected error occurred.";

  if (!isKnown) console.error("❌  Unhandled route error:", err.stack || err);

  res.status(status).json({
    success: false,
    error: { code: err.code || "INTERNAL_ERROR", message },
  });
});

// ── Startup ───────────────────────────────────────────────────
async function start() {
  console.log("\n⚙️   Project Documentor v3 — starting…\n");

  // 1. MongoDB — required; hard-exit on failure
  try {
    await connectDB();
  } catch (err) {
    console.error("❌  MongoDB connection failed:", err.message);
    console.error("    Ensure MONGODB_URI is set correctly in .env.");
    process.exit(1);
  }

  // 2. Pipeline services — optional; warn but don't abort
  console.log("\n📦  Loading pipeline services…");
  await loadLegacyServices();

  // 3. Bind HTTP server
  app.listen(PORT, () => {
    console.log(`\n✅  Ready → http://localhost:${PORT}  (${ENV})\n`);

    const r = (method, path, note = "") =>
      console.log(`    ${method.padEnd(7)}${path}${note ? "  — " + note : ""}`);

    console.log("    ── Auth ─────────────────────────────────────────");
    r("POST", "/auth/signup");
    r("POST", "/auth/login");
    r("POST", "/auth/refresh", "reads httpOnly cookie");
    r("POST", "/auth/logout");
    r("POST", "/auth/verify-email");
    r("POST", "/auth/forgot-password");
    r("POST", "/auth/reset-password");
    r("GET", "/auth/me");

    console.log("\n    ── GitHub ───────────────────────────────────────");
    r("GET", "/github/oauth/start", "returns JSON { url }");
    r("GET", "/github/oauth/callback", "browser redirect from GitHub");
    r("GET", "/github/repos");
    r("GET", "/github/status");
    r("DELETE", "/github/disconnect");

    console.log("\n    ── Projects ─────────────────────────────────────");
    r("POST", "/projects", "create + start pipeline");
    r("GET", "/projects", "list, paginated + filtered");
    r("GET", "/projects/:id");
    r("PATCH", "/projects/:id", "archive");
    r("DELETE", "/projects/:id");
    r("POST", "/projects/:id/retry", "re-run pipeline");
    r("GET", "/projects/:id/stream", "SSE live events");
    r("GET", "/projects/:id/export/pdf");
    r("GET", "/projects/:id/export/yaml", "GitHub Actions workflow");
    r("POST", "/projects/:id/export/notion");

    console.log("\n    ── Legacy API (v2 compatible, no auth) ──────────");
    r("POST", "/api/document");
    r("GET", "/api/stream/:jobId", "SSE");
    r("POST", "/api/chat");
    r("GET", "/api/export/pdf/:jobId");
    r("POST", "/api/export/notion/:jobId");
    r("GET", "/api/export/workflow/:jobId");
    r("POST", "/api/webhook");

    console.log("\n    ── Misc ─────────────────────────────────────────");
    r("GET", "/health");

    // Service status summary
    console.log("\n    Pipeline services:");
    Object.entries(serviceStatus).forEach(([k, ok]) =>
      console.log(`      ${ok ? "✅" : "⚠️ "} ${k}`),
    );
    console.log("");
  });
}

start();

process.on("unhandledRejection", (reason) =>
  console.error("❌  Unhandled rejection:", reason),
);
process.on("uncaughtException", (err) => {
  console.error("❌  Uncaught exception:", err.stack);
  process.exit(1);
});
