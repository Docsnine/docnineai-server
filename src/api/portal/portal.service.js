// =============================================================
// Portal service — business logic for the public docs portal.
//
// Functions:
//   getOrCreate(projectId, userId)      — load/init portal record
//   getPortalForOwner(projectId, userId)— gate-checked read for owner
//   updatePortal(projectId, userId, body) — gate-checked mutation
//   togglePublish(projectId, userId)    — flip isPublished
//   getPublicPortal(slug, password?)    — public read, content included
//   verifyPortalPassword(slug, attempt) — check portal password
// =============================================================

import bcrypt from "bcryptjs";
import { Portal } from "../../models/Portal.js";
import { Project } from "../../models/Project.js";

// ── Section keys and their display labels ─────────────────────
export const SECTION_KEYS = [
  "readme",
  "internalDocs",
  "apiReference",
  "schemaDocs",
  "securityReport",
];

export const SECTION_LABELS = {
  readme: "README",
  internalDocs: "Internal Docs",
  apiReference: "API Reference",
  schemaDocs: "Schema Docs",
  securityReport: "Security Report",
};

// ── Slug helpers ──────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function generateUniqueSlug(repoOwner, repoName) {
  const base = slugify(`${repoOwner}-${repoName}`);
  // First try the clean slug
  let candidate = base;
  let attempt = 0;
  while (await Portal.exists({ slug: candidate })) {
    attempt++;
    candidate = `${base}-${attempt}`;
  }
  return candidate;
}

// ── Ownership check ───────────────────────────────────────────

async function requireOwner(projectId, userId) {
  const project = await Project.findById(projectId)
    .select("userId repoOwner repoName")
    .lean();
  if (!project)
    throw Object.assign(new Error("Project not found."), {
      status: 404,
      code: "NOT_FOUND",
    });
  if (String(project.userId) !== String(userId))
    throw Object.assign(
      new Error("Only the project owner can manage the portal."),
      { status: 403, code: "FORBIDDEN" },
    );
  return project;
}

// ── Merge effective section output ────────────────────────────
// Returns the same merged content as the project 'effectiveOutput' virtual.

function mergeOutput(project) {
  const merged = {};
  for (const key of SECTION_KEYS) {
    merged[key] = project.editedOutput?.[key] || project.output?.[key] || "";
  }
  return merged;
}

// ── Public exports ────────────────────────────────────────────

/**
 * Get the portal record for a project, creating it (unpublished) if it
 * doesn't exist yet.  Returns the plain portal object (no passwordHash).
 */
export async function getOrCreate(projectId, userId) {
  const project = await requireOwner(projectId, userId);
  let portal = await Portal.findOne({ projectId });
  if (!portal) {
    const slug = await generateUniqueSlug(project.repoOwner, project.repoName);
    portal = await Portal.create({ projectId, slug });
  }
  return portal.toObject();
}

/**
 * Get portal settings for the project owner (includes full config).
 */
export async function getPortalForOwner(projectId, userId) {
  await requireOwner(projectId, userId);
  let portal = await Portal.findOne({ projectId });
  if (!portal) return null; // not yet initialised
  return portal.toObject();
}

/**
 * Update portal settings.  Body fields accepted:
 *   branding, sections, seoTitle, seoDescription, customDomain,
 *   accessMode, password (raw — will be hashed)
 */
export async function updatePortal(projectId, userId, body) {
  await requireOwner(projectId, userId);

  let portal = await Portal.findOne({ projectId });
  if (!portal) {
    // Lazy-create on first save so owners don't need a separate init step
    const proj = await Project.findById(projectId)
      .select("repoOwner repoName")
      .lean();
    const slug = await generateUniqueSlug(proj.repoOwner, proj.repoName);
    portal = new Portal({ projectId, slug });
  }

  const allowed = [
    "branding",
    "sections",
    "seoTitle",
    "seoDescription",
    "customDomain",
    "accessMode",
  ];
  for (const key of allowed) {
    if (body[key] !== undefined) portal[key] = body[key];
  }

  // Handle password update
  if (body.password !== undefined) {
    if (body.password === null || body.password === "") {
      // Clear password
      portal.passwordHash = undefined;
      portal.accessMode = "public";
    } else {
      portal.passwordHash = await bcrypt.hash(String(body.password), 10);
      portal.accessMode = "password";
    }
  }

  await portal.save();
  return portal.toObject();
}

/**
 * Toggle isPublished for a project's portal.
 * Creates the portal record if it doesn't exist.
 */
export async function togglePublish(projectId, userId) {
  const project = await requireOwner(projectId, userId);
  let portal = await Portal.findOne({ projectId });
  if (!portal) {
    const slug = await generateUniqueSlug(project.repoOwner, project.repoName);
    portal = await Portal.create({ projectId, slug, isPublished: true });
    return portal.toObject();
  }
  portal.isPublished = !portal.isPublished;
  await portal.save();
  return portal.toObject();
}

/**
 * Public read — returns portal metadata + published section content.
 * Throws if the portal is not found or not published.
 * Does NOT check the password here — password checking is separate.
 */
export async function getPublicPortal(slug) {
  const portal = await Portal.findOne({ slug });
  if (!portal)
    throw Object.assign(new Error("Portal not found."), {
      status: 404,
      code: "NOT_FOUND",
    });
  if (!portal.isPublished)
    throw Object.assign(new Error("This portal is not public."), {
      status: 404,
      code: "NOT_FOUND",
    });

  // Load project (need to compute effectiveOutput)
  const project = await Project.findById(portal.projectId)
    .select("repoOwner repoName meta techStack output editedOutput")
    .lean();
  if (!project)
    throw Object.assign(new Error("Project not found."), {
      status: 404,
      code: "NOT_FOUND",
    });

  // Build per-section visibility map from portal.sections array
  const sectionVisMap = {};
  for (const s of SECTION_KEYS) sectionVisMap[s] = "public"; // default
  for (const entry of portal.sections)
    sectionVisMap[entry.sectionKey] = entry.visibility;

  // Merge effective content
  const effectiveOutput = mergeOutput(project);

  // Build content object — only non-internal sections
  const content = {};
  for (const key of SECTION_KEYS) {
    if (sectionVisMap[key] === "internal") continue;
    content[key] =
      sectionVisMap[key] === "coming_soon" ? null : effectiveOutput[key] || "";
  }

  return {
    portal: {
      slug: portal.slug,
      isPublished: portal.isPublished,
      accessMode: portal.accessMode,
      branding: portal.branding,
      sections: portal.sections,
      seoTitle: portal.seoTitle,
      seoDescription: portal.seoDescription,
      customDomain: portal.customDomain,
    },
    project: {
      repoOwner: project.repoOwner,
      repoName: project.repoName,
      meta: project.meta,
      techStack: project.techStack,
    },
    sectionVisibility: sectionVisMap,
    content,
  };
}

/**
 * Verify a portal password.  Returns true/false.
 */
export async function verifyPortalPassword(slug, attempt) {
  const portal = await Portal.findOne({ slug }).select("+passwordHash");
  if (!portal || !portal.isPublished) return false;
  if (portal.accessMode !== "password" || !portal.passwordHash) return false;
  return bcrypt.compare(String(attempt), portal.passwordHash);
}
