// src/config/db.js
// ─────────────────────────────────────────────────────────────
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
// ─────────────────────────────────────────────────────────────

import mongoose from "mongoose";

/**
 * Open the MongoDB connection.
 * Call once at app startup. Mongoose queues operations until connected.
 */
export async function connectDB() {
  // Lazy env check — runs after dotenv.config() has been called
  const URI = process.env.MONGODB_URI;
  if (!URI) {
    throw new Error(
      "MONGODB_URI is required in .env\n" +
        "  Local:  mongodb://localhost:27017/project-documentor\n" +
        "  Atlas:  mongodb+srv://user:pass@cluster.mongodb.net/project-documentor",
    );
  }

  // Already connected — no-op
  if (mongoose.connection.readyState === 1) return;

  await mongoose.connect(URI, {
    serverSelectionTimeoutMS: 5000, // fail fast if DB unreachable
    socketTimeoutMS: 45000,
  });

  console.log(
    `✅ MongoDB → ${mongoose.connection.host}/${mongoose.connection.name}`,
  );
}

// Surface connection lifecycle events in server log
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
