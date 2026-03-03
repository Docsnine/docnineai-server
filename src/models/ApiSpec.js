// =============================================================
// ApiSpec model
//
// One document per project. Stores both the raw imported spec
// and a normalised, framework-agnostic representation that the
// frontend can consume without further parsing.
// =============================================================

import mongoose from "mongoose";

const { Schema, model } = mongoose;
const Mixed = Schema.Types.Mixed;

// ── Per-parameter shape (OAS-style) ──────────────────────────
const ParameterSchema = new Schema(
  {
    in: { type: String }, // "path" | "query" | "header" | "cookie" | "body"
    name: { type: String },
    required: { type: Boolean, default: false },
    description: { type: String },
    schema: { type: Mixed }, // JSON Schema fragment
    example: { type: Mixed },
  },
  { _id: false },
);

// ── Normalised endpoint ───────────────────────────────────────
const EndpointSchema = new Schema(
  {
    id: { type: String }, // "<METHOD> <path>"  – stable reference key
    method: { type: String }, // uppercase: GET, POST, ...
    path: { type: String },
    summary: { type: String },
    description: { type: String },
    tags: [String],
    operationId: { type: String },
    parameters: [ParameterSchema],
    requestBody: { type: Mixed }, // { required, description, content: { mediaType: { schema } } }
    responses: { type: Mixed }, // { "200": { description, content } }
    security: { type: Mixed },
    deprecated: { type: Boolean, default: false },
    customNote: { type: String }, // user-editable note not touching the spec
  },
  { _id: false },
);

// ── Top-level spec document ───────────────────────────────────
const ApiSpecSchema = new Schema(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      unique: true,
      index: true,
    },

    // How the spec was imported
    source: { type: String, enum: ["file", "url", "raw"], required: true },
    sourceUrl: { type: String }, // only for "url" source

    // Detected spec flavour
    specVersion: {
      type: String,
      enum: ["2.0", "3.0", "3.1", "postman", "unknown"],
      default: "unknown",
    },

    // Original text — excluded from default projection to avoid size issues
    rawContent: { type: String, select: false },

    // Normalised metadata from info block
    info: {
      title: { type: String },
      version: { type: String },
      description: { type: String },
      contact: { type: Mixed },
      license: { type: Mixed },
      termsOfService: { type: String },
    },

    // OAS servers / Postman root URL
    servers: [
      {
        url: { type: String },
        description: { type: String },
        _id: false,
      },
    ],

    // Tag groups (for sidebar grouping)
    tags: [
      {
        name: { type: String },
        description: { type: String },
        _id: false,
      },
    ],

    // Flat list of all endpoints
    endpoints: [EndpointSchema],

    // Definitions / $defs / components.schemas
    schemas: { type: Mixed, default: {} },

    // components.securitySchemes / securityDefinitions
    securitySchemes: { type: Mixed, default: {} },

    // Auto-sync options (URL source only)
    autoSync: { type: Boolean, default: false },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true },
);

export const ApiSpec = model("ApiSpec", ApiSpecSchema);
