import express from "express";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { connectDB } from "./config/db.js";
import apiRouter from "./api/router.js";
import { recoverOrphanedJobs } from "./api/projects/project.service.js";

const app = express();

// ── Trust proxy ────────────────────────────
// Required on Vercel — without this, express-rate-limit throws
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR because Vercel's edge injects
// X-Forwarded-For but Express "trust proxy" is false by default.
// Setting to 1 means trust the first hop (Vercel's edge proxy).
app.set("trust proxy", 1);

let initialized = false;

/**
 * Initialize once per cold start (serverless-safe).
 * After DB connects, recover any projects that were left in
 * "running"/"queued" state from a previous server instance.
 */
async function initOnce() {
  if (initialized) return;

  await connectDB();

  // Best-effort recovery — don't block the request if it fails
  await recoverOrphanedJobs();

  initialized = true;
}

// ── Init middleware ────────────────────────
app.use(async (req, res, next) => {
  try {
    await initOnce();
    next();
  } catch (err) {
    next(err);
  }
});

// ── CORS ───────────────────────────────────
// In production, restrict to the known frontend origin so the browser
// receives a concrete Access-Control-Allow-Origin (not "*"), which is
// required for credentialed cross-origin requests (cookies).
// In development, reflect the request origin for convenience.
const FRONTEND_ORIGIN = process.env.FRONTEND_URL || "";
app.use(
  cors({
    origin: (incomingOrigin, callback) => {
      // Allow requests with no origin (curl, Postman, server-to-server)
      if (!incomingOrigin) return callback(null, true);

      // Always allow the configured frontend origin
      if (incomingOrigin === FRONTEND_ORIGIN) return callback(null, true);

      // In development also allow any localhost origin
      if (
        process.env.NODE_ENV !== "production" &&
        incomingOrigin.startsWith("http://localhost")
      ) {
        return callback(null, true);
      }

      callback(new Error(`CORS: origin ${incomingOrigin} not allowed`));
    },
    credentials: true,
  }),
);

// ── Body parsing ───────────────────────────
// Webhook routes need the raw Buffer for signature verification —
// must be registered BEFORE express.json() consumes the body.
// The /api/webhook prefix covers both GitHub and Flutterwave webhooks,
// including per-project endpoints (/api/webhook/:projectId).
app.use("/api/webhook", express.raw({ type: "*/*", limit: "10mb" }));

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(morgan("dev"));

// ── Health ─────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Diagnostic (non-sensitive) ─────────────
// Returns which required env vars are set (true/false, no values).
// Useful for quickly spotting missing Vercel environment variables.
app.get("/health/check", (_req, res) => {
  const check = (v) => !!process.env[v];
  res.json({
    env: process.env.NODE_ENV || "(not set)",
    frontend_url: process.env.FRONTEND_URL || "(not set)",
    vars: {
      MONGODB_URI: check("MONGODB_URI"),
      JWT_ACCESS_SECRET: check("JWT_ACCESS_SECRET"),
      JWT_REFRESH_SECRET: check("JWT_REFRESH_SECRET"),
      ENCRYPTION_KEY: check("ENCRYPTION_KEY"),
      GITHUB_CLIENT_ID: check("GITHUB_CLIENT_ID"),
      GITHUB_CLIENT_SECRET: check("GITHUB_CLIENT_SECRET"),
      GITHUB_REDIRECT_URI: check("GITHUB_REDIRECT_URI"),
      FRONTEND_URL: check("FRONTEND_URL"),
      GROQ_API_KEY: check("GROQ_API_KEY"),
    },
  });
});

// ── API ────────────────────────────────────
// Root route returns welcome message
app.get("/", (_req, res) => {
  res.json({
    success: true,
    error: "Welcome to docnine AI server",
  });
});

app.use("/", apiRouter);

// ── 404 ────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "NOT_FOUND",
  });
});

// ── Error handler ──────────────────────────
app.use((err, req, res, _next) => {
  console.error("[Error]: ", err);
  res.status(500).json({
    success: false,
    error: err.message || "Internal error",
  });
});

export default app;
