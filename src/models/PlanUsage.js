// ===================================================================
// PlanUsage — per-user, per-cycle usage counters.
//
// One document per user (upserted). Counters reset by cron on
// the user's billing cycle reset date (ai_reset_at).
//
// Why not use Subscription for this?
//   Subscription tracks billing state. Usage is operational data
//   that resets independently — keeping them separate avoids race
//   conditions when cron jobs update both on the same midnight run.
// ===================================================================

import mongoose from "mongoose";

const { Schema, model } = mongoose;

const PlanUsageSchema = new Schema(
  {
    // ── Identity ──────────────────────────────────────────────
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    // ── AI chats ──────────────────────────────────────────────
    aiChatsUsed: {
      type: Number,
      default: 0,
      min: 0,
    },
    aiChatsResetAt: {
      type: Date,
      default: null, // null = reset never set up (free tier)
      index: true, // queried by reset_ai_usage cron
    },

    // ── Project count ─────────────────────────────────────────
    // Cached to avoid a Project.countDocuments() on every gate check.
    // Updated on project create/delete.
    projectCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ── Portal count ──────────────────────────────────────────
    portalCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ── Active share links ────────────────────────────────────
    activeShareCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

/**
 * Upsert usage for a user. Creates the document if it doesn't exist.
 * @param {string} userId
 * @param {Object} delta  - e.g. { aiChatsUsed: 1 } or { projectCount: -1 }
 */
PlanUsageSchema.statics.increment = async function (userId, delta) {
  const inc = {};
  for (const [key, val] of Object.entries(delta)) {
    inc[key] = val;
  }
  return this.findOneAndUpdate(
    { userId },
    { $inc: inc },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

export const PlanUsage = model("PlanUsage", PlanUsageSchema);
