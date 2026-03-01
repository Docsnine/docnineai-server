// ===================================================================
// Mongoose connection — connect once, reuse everywhere.
//
// FIX: MONGODB_URI check is now INSIDE connectDB(), not at module
// load time. In ESM, top-level module code runs before dotenv.config()
// fires in index.js, so env vars from .env are invisible at load time.
// Moving checks inside functions means they run at call time, after
// dotenv.config() has populated process.env.
//
// Required env:
//   MONGODB_URI — full connection string
//   e.g. mongodb://localhost:27017/project-documentor
//   e.g. mongodb+srv://user:pass@cluster.mongodb.net/project-documentor
// ===================================================================

import mongoose from "mongoose";

// Cached connection promise — reused across hot invocations on Vercel
let _connectionPromise = null;

export async function connectDB() {
  const URI = process.env.MONGODB_URI;
  if (!URI) {
    throw new Error("MONGODB_URI is required in environment variables.\n");
  }

  // Already fully connected — reuse
  if (mongoose.connection.readyState === 1) return;

  // Already connecting — wait for the same promise (handles concurrent requests)
  if (_connectionPromise) return _connectionPromise;

  _connectionPromise = _connect(URI).finally(() => {
    _connectionPromise = null;
  });

  return _connectionPromise;
}

async function _connect(URI) {
  // bufferCommands:false makes Mongoose throw immediately if a query is
  // executed before the connection is ready, instead of buffering for
  // serverSelectionTimeoutMS (10s). This surfaces the real error fast
  // instead of timing out silently with "buffering timed out after 10000ms".
  mongoose.set("bufferCommands", false);

  await mongoose.connect(URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 1,
  });

  // Wait for the connection to be fully open before proceeding.
  // On Vercel/serverless, connect() can resolve slightly before
  // connection.db and connection.host are populated.
  if (mongoose.connection.readyState !== 1) {
    await new Promise((resolve, reject) => {
      mongoose.connection.once("open", resolve);
      mongoose.connection.once("error", reject);
    });
  }

  const host = mongoose.connection.host || "atlas";
  const name = mongoose.connection.name || "db";
  console.log(`✅ MongoDB → ${host}/${name}`);

  await migrateIndexes();
}

// ── Index migration ───────────────────────────────────────────
// Drops the project_search text index if it was created without
// language_override, preventing "language override unsupported: TypeScript".
async function migrateIndexes() {
  try {
    // connection.db can be undefined on serverless if accessed too early.
    // Wait up to 3s for it to become available.
    let db = mongoose.connection.db;
    if (!db) {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error("db not ready after 3s")),
          3000,
        );
        mongoose.connection.once("connected", () => {
          clearTimeout(deadline);
          resolve();
        });
        // If already in connected state the event won't fire — check again
        if (mongoose.connection.readyState === 1) {
          clearTimeout(deadline);
          resolve();
        }
      });
      db = mongoose.connection.db;
    }

    if (!db) {
      console.warn("⚠️  Skipping index migration — connection.db unavailable");
      return;
    }

    const collection = db.collection("projects");
    const indexes = await collection.indexes();
    const textIdx = indexes.find((idx) => idx.name === "project_search");

    if (!textIdx) {
      // Not yet created — Mongoose will create it correctly on first use
      return;
    }

    if (textIdx.language_override === "search_language") {
      // Already fixed — nothing to do
      return;
    }

    console.log(
      "🔧 Dropping stale project_search index (missing language_override)…",
    );
    await collection.dropIndex("project_search");
    console.log(
      "✅ Stale index dropped — will be recreated with language_override",
    );

    const { Project } = await import("../models/Project.js");
    await Project.ensureIndexes();
    console.log("✅ project_search index recreated");
  } catch (err) {
    // Non-fatal — server keeps running, index will be fixed on next deploy
    console.warn("⚠️  Index migration skipped:", err.message);
  }
}

mongoose.connection.on("disconnected", () =>
  console.warn("⚠️  MongoDB disconnected — will reconnect on next request"),
);

mongoose.connection.on("reconnected", () =>
  console.log("✅ MongoDB reconnected"),
);

mongoose.connection.on("error", (err) =>
  console.error("❌ MongoDB error:", err.message),
);

export default mongoose;
