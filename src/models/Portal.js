// =============================================================
// Portal — public documentation portal settings for a project.
//
// One portal per project (unique projectId index).
// The slug is a URL-safe identifier auto-generated from the
// repo owner + name on first creation. Guaranteed unique.
//
// accessMode:
//   "public"   — anyone with the URL can read
//   "password" — visitors must enter the portal password
//
// sections[]:
//   Overrides per-section visibility. Sections not listed here
//   default to "public" when the portal is published.
//   visibility:
//     "public"       — visible to everyone
//     "internal"     — excluded from the portal output
//     "coming_soon"  — shown in nav but content is a placeholder card
//
// branding:
//   All fields optional — sensible defaults applied by the public
//   portal page when not set.
// =============================================================

import mongoose from "mongoose";
const { Schema, model } = mongoose;

// ── Sub-schemas ───────────────────────────────────────────────

const FooterLinkSchema = new Schema(
  {
    label: { type: String, required: true },
    href: { type: String, required: true },
  },
  { _id: false },
);

const BrandingSchema = new Schema(
  {
    logo: String, // absolute URL to logo image
    favicon: String, // absolute URL to favicon
    primaryColor: String, // hex e.g. "#6366f1"
    bgColor: String, // hex e.g. "#0f172a"
    accentColor: String, // hex
    headerText: String, // custom portal header/tagline
    footerText: String, // copyright / footer copy
    footerLinks: { type: [FooterLinkSchema], default: [] },
  },
  { _id: false },
);

const PortalSectionSchema = new Schema(
  {
    sectionKey: {
      type: String,
      required: true,
      enum: [
        "readme",
        "internalDocs",
        "apiReference",
        "schemaDocs",
        "securityReport",
      ],
    },
    visibility: {
      type: String,
      enum: ["public", "internal", "coming_soon"],
      default: "public",
    },
  },
  { _id: false },
);

// ── Main schema ───────────────────────────────────────────────

const PortalSchema = new Schema(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      unique: true,
      index: true,
    },

    // URL slug — e.g. "acme-my-api" → docnine.com/docs/acme-my-api
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9][a-z0-9-]*$/,
    },

    isPublished: { type: Boolean, default: false },

    accessMode: {
      type: String,
      enum: ["public", "password"],
      default: "public",
    },

    // bcrypt hash of the portal password (only when accessMode === "password")
    // select: false — never returned to clients
    passwordHash: { type: String, select: false },

    branding: { type: BrandingSchema, default: () => ({}) },

    // Per-section visibility overrides. Sections not listed → treated as "public"
    sections: { type: [PortalSectionSchema], default: [] },

    seoTitle: String,
    seoDescription: String,

    // Custom domain — informational only (DNS is managed externally)
    customDomain: { type: String, trim: true, lowercase: true },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export const Portal = model("Portal", PortalSchema);
