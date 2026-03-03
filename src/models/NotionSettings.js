// ===================================================================
// Stores per-user Notion integration settings.
// One document per user — upserted on connect.
//
// Security: apiKey is AES-256-GCM encrypted before storage.
// The decrypt() call happens in notion.service.js — never here.
// ===================================================================

import mongoose from "mongoose";

const { Schema, model } = mongoose;

const NotionSettingsSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // one Notion connection per user
      index: true,
    },

    // Encrypted Notion internal integration token (AES-256-GCM via crypto.util)
    apiKeyEncrypted: {
      type: String,
      required: true,
      select: false, // never returned without explicit .select("+...")
    },

    // The Notion page ID to use as parent for exported docs
    parentPageId: {
      type: String,
      required: true,
    },

    // Optional: workspace / page name shown in UI
    workspaceName: {
      type: String,
      default: null,
    },

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

export const NotionSettings = model("NotionSettings", NotionSettingsSchema);
