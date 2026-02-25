// ===================================================================
// Stores GitHub OAuth tokens for a user.
// One document per user — upserted on each OAuth callback.
//
// Security: accessToken is AES-256-GCM encrypted before storage.
// The decrypt() call happens in github.service.js — never here.
// ===================================================================

import mongoose from "mongoose";

const { Schema, model } = mongoose;

const GitHubTokenSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // one GitHub connection per user
      index: true,
    },

    // Encrypted GitHub access token (AES-256-GCM via crypto.util)
    accessTokenEncrypted: {
      type: String,
      required: true,
      select: false, // never returned without explicit .select("+...")
    },

    // GitHub scopes granted (e.g. ["repo", "read:user"])
    scopes: {
      type: [String],
      default: [],
    },

    // GitHub user data cached at OAuth time
    githubUserId: String,
    githubUsername: String,
    githubEmail: String,

    // When the token was obtained / last refreshed
    connectedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export const GitHubToken = model("GitHubToken", GitHubTokenSchema);
