import express from "express";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { connectDB } from "./config/db.js";
import apiRouter from "./api/router.js";

const app = express();

// ── Trust proxy ────────────────────────────
// Required on Vercel — without this, express-rate-limit throws
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR because Vercel's edge injects
// X-Forwarded-For but Express "trust proxy" is false by default.
// Setting to 1 means trust the first hop (Vercel's edge proxy).
app.set("trust proxy", 1);

let initialized = false;

/**
 * Initialize once per cold start
 * (serverless-safe)
 */
async function initOnce() {
  if (initialized) return;
  await connectDB();
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
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

// ── Body parsing ───────────────────────────
// Webhook route needs the raw Buffer for HMAC-SHA256 verification —
// must be registered BEFORE express.json() consumes the body.
app.use("/api/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(morgan("dev"));

// ── Health ─────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── API ────────────────────────────────────
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
  console.error("❌ Error:", err);
  res.status(500).json({
    success: false,
    error: err.message || "Internal error",
  });
});

export default app;
