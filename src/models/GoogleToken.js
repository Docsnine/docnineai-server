// ===================================================================
// GoogleToken — stores encrypted Google OAuth tokens per user.
// Used for Google Docs export (scope: drive.file + documents).
//
// Unlike GitHub tokens, Google tokens expire — so we store both
// the access token and refresh token (encrypted).
// The googleapis library handles auto-refresh; we persist the
// latest tokens via the token event handler.
// ===================================================================

import mongoose from "mongoose";

const googleTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    // AES-256-GCM encrypted — use crypto.util.js encrypt()/decrypt()
    accessTokenEncrypted: {
      type: String,
      required: true,
      select: false,
    },
    refreshTokenEncrypted: {
      type: String,
      required: true,
      select: false,
    },
    // Token expiry as Unix ms timestamp (from Google's expires_in)
    expiryDate: {
      type: Number,
      required: true,
    },
    scopes: [String],
    googleUserId: String,
    googleEmail: String,
    googleName: String,
    connectedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

export default mongoose.model("GoogleToken", googleTokenSchema);
