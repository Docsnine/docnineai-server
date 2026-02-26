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

export async function connectDB() {
  const URI = process.env.MONGODB_URI;
  if (!URI) {
    throw new Error(
      "MONGODB_URI is required in .env\n" +
        "  Local:  mongodb://localhost:27017/docnine\n" +
        "  Atlas:  mongodb+srv://user:pass@cluster.mongodb.net/project-documentor",
    );
  }

  if (mongoose.connection.readyState === 1) return;

  await mongoose.connect(URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });

  console.log(
    `✅ MongoDB → ${mongoose.connection.host}/${mongoose.connection.name}`,
  );

  // Drop and recreate the broken text index automatically
  await migrateIndexes();
}

// ── Index migration ───────────────────────────────────────────
// Drops the project_search text index if it was created without
// language_override. Mongoose will recreate it correctly on next
// ensureIndexes() call (happens automatically after this function).
async function migrateIndexes() {
  try {
    const db = mongoose.connection.db;
    const collection = db.collection("projects");

    // List existing indexes on the projects collection
    const indexes = await collection.indexes();
    const textIdx = indexes.find((idx) => idx.name === "project_search");

    if (!textIdx) {
      // Index doesn't exist yet — Mongoose will create it fresh (correctly)
      console.log(
        "ℹ️  project_search index not found — will be created on startup",
      );
      return;
    }

    // Check if language_override is already set correctly
    if (textIdx.language_override === "search_language") {
      // Already fixed — nothing to do
      return;
    }

    // Index exists but is missing language_override — drop it so
    // Mongoose recreates it with the correct options from Project.js
    console.log(
      "🔧 Dropping stale project_search index (missing language_override)…",
    );
    await collection.dropIndex("project_search");
    console.log("✅ Stale index dropped — Mongoose will recreate it correctly");

    // Trigger ensureIndexes so Mongoose rebuilds the index now, not lazily
    const { Project } = await import("../models/Project.js");
    await Project.ensureIndexes();
    console.log("✅ project_search index recreated with language_override");
  } catch (err) {
    // Non-fatal — log and continue. The first project write may still fail
    // if the index exists in the broken state, but the server will keep running.
    console.error("⚠️  Index migration warning:", err.message);
  }
}

mongoose.connection.on("disconnected", () =>
  console.warn("⚠️  MongoDB disconnected — reconnecting…"),
);
mongoose.connection.on("reconnected", () =>
  console.log("✅ MongoDB reconnected"),
);
mongoose.connection.on("error", (err) =>
  console.error("❌ MongoDB error:", err.message),
);

export default mongoose;
