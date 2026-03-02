// =============================================================
// ProjectShare — tracks every share invitation for a project.
//
// Lifecycle:
//   pending  — invite sent, user hasn't accepted yet
//   accepted — user clicked the accept link
//   revoked  — owner explicitly removed access
//
// Roles:
//   viewer — can read docs / attachments, cannot edit
//   editor — can edit docs and upload attachments
// =============================================================

import mongoose from "mongoose";
import { randomUUID } from "crypto";

const ProjectShareSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Who the invite is for
    inviteeEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    // Populated once the invitee accepts (they may not be registered yet)
    inviteeUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    role: {
      type: String,
      enum: ["viewer", "editor"],
      default: "viewer",
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "revoked"],
      default: "pending",
    },
    // Secure token embedded in the accept link (one-time use)
    token: {
      type: String,
      default: () => randomUUID(),
      index: true,
    },
    // Link expires after 7 days if not accepted
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true }
);

// Prevent duplicate pending invites for the same project + email
ProjectShareSchema.index(
  { projectId: 1, inviteeEmail: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["pending", "accepted"] } },
  }
);

// Fast lookup: "which projects is this user a member of?"
ProjectShareSchema.index({ inviteeUserId: 1, status: 1 });

export const ProjectShare = mongoose.model("ProjectShare", ProjectShareSchema);
