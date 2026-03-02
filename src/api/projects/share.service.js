// =============================================================
// Exports:
//   inviteUsers          — send one or more email invites
//   listAccess           — all shares for a project (owner only)
//   changeRole           — owner updates a share's role
//   revokeAccess         — owner revokes a specific share
//   resendInvite         — resend a pending invite
//   cancelInvite         — delete a pending invite before acceptance
//   acceptInvite         — invitee clicks the accept link
//   getSharedProjects    — projects shared WITH the current user
//   assertProjectAccess  — throws 403/404 if user has no access
//   getShareRole         — returns the role of a user on a project (or null)
// =============================================================

import { randomUUID } from "crypto";
import { Project } from "../../models/Project.js";
import { ProjectShare } from "../../models/ProjectShare.js";
import { User } from "../../models/User.js";
import { sendProjectInviteEmail } from "../../config/email.js";

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

function forbidden(msg = "Access denied.") {
  const e = new Error(msg);
  e.status = 403;
  return e;
}
function notFound(msg = "Not found.") {
  const e = new Error(msg);
  e.status = 404;
  return e;
}
function conflict(msg) {
  const e = new Error(msg);
  e.status = 409;
  return e;
}

/** Return the project and throw 404 if missing, 403 if not owner. */
async function assertOwner(projectId, userId) {
  const project = await Project.findById(projectId).lean();
  if (!project) throw notFound("Project not found.");
  if (project.userId.toString() !== userId.toString())
    throw forbidden("Only the project owner can manage sharing.");
  return project;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Send invitations to a list of emails.
 * @param {string} projectId
 * @param {string} ownerId
 * @param {{ email: string, role: "viewer"|"editor" }[]} invites
 * @returns {object[]} array of created/existing share docs
 */
export async function inviteUsers(projectId, ownerId, invites) {
  const project = await assertOwner(projectId, ownerId);
  const owner = await User.findById(ownerId).select("name email").lean();

  const results = [];

  for (const { email, role } of invites) {
    const lc = email.toLowerCase().trim();

    // Cannot invite the owner themselves
    if (lc === owner.email) {
      results.push({
        email: lc,
        status: "skipped",
        reason: "You are the owner.",
      });
      continue;
    }

    // Check if an active invite (pending or accepted) already exists
    const existing = await ProjectShare.findOne({
      projectId,
      inviteeEmail: lc,
      status: { $in: ["pending", "accepted"] },
    });

    if (existing) {
      if (existing.status === "accepted") {
        results.push({
          email: lc,
          status: "skipped",
          reason: "Already has access.",
        });
        continue;
      }
      // Re-send existing pending invite with refreshed token + expiry
      existing.token = randomUUID();
      existing.role = role;
      existing.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await existing.save();
      await sendProjectInviteEmail({
        to: lc,
        inviterName: owner.name,
        projectName: project.meta?.name || project.repoName,
        role,
        token: existing.token,
      });
      results.push({
        email: lc,
        status: "resent",
        share: _serialize(existing),
      });
      continue;
    }

    // Check for a previously revoked invite — create fresh
    await ProjectShare.deleteOne({
      projectId,
      inviteeEmail: lc,
      status: "revoked",
    });

    // Look up if the invitee already has a Docnine account
    const inviteeUser = await User.findOne({ email: lc }).select("_id").lean();

    const share = await ProjectShare.create({
      projectId,
      ownerId,
      inviteeEmail: lc,
      inviteeUserId: inviteeUser?._id ?? null,
      role,
    });

    await sendProjectInviteEmail({
      to: lc,
      inviterName: owner.name,
      projectName: project.meta?.name || project.repoName,
      role,
      token: share.token,
    });

    results.push({ email: lc, status: "invited", share: _serialize(share) });
  }

  return results;
}

/**
 * List all access entries for a project (owner only).
 */
export async function listAccess(projectId, ownerId) {
  await assertOwner(projectId, ownerId);

  const shares = await ProjectShare.find({
    projectId,
    status: { $in: ["pending", "accepted"] },
  })
    .populate("inviteeUserId", "name email")
    .sort({ createdAt: -1 })
    .lean();

  return shares.map(_serialize);
}

/**
 * Change the role of a specific share (owner only).
 */
export async function changeRole(projectId, shareId, ownerId, newRole) {
  await assertOwner(projectId, ownerId);

  const share = await ProjectShare.findOne({
    _id: shareId,
    projectId,
    status: { $in: ["pending", "accepted"] },
  });
  if (!share) throw notFound("Share entry not found.");

  share.role = newRole;
  await share.save();
  return _serialize(share);
}

/**
 * Revoke access (owner only).
 */
export async function revokeAccess(projectId, shareId, ownerId) {
  await assertOwner(projectId, ownerId);

  const share = await ProjectShare.findOne({ _id: shareId, projectId });
  if (!share) throw notFound("Share entry not found.");

  share.status = "revoked";
  await share.save();
}

/**
 * Resend a pending invitation (owner only).
 */
export async function resendInvite(projectId, shareId, ownerId) {
  const project = await assertOwner(projectId, ownerId);
  const owner = await User.findById(ownerId).select("name email").lean();

  const share = await ProjectShare.findOne({
    _id: shareId,
    projectId,
    status: "pending",
  });
  if (!share) throw notFound("Pending invite not found.");

  share.token = randomUUID();
  share.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await share.save();

  await sendProjectInviteEmail({
    to: share.inviteeEmail,
    inviterName: owner.name,
    projectName: project.meta?.name || project.repoName,
    role: share.role,
    token: share.token,
  });

  return _serialize(share);
}

/**
 * Cancel a pending invite before it is accepted (owner only).
 */
export async function cancelInvite(projectId, shareId, ownerId) {
  await assertOwner(projectId, ownerId);

  const share = await ProjectShare.findOne({
    _id: shareId,
    projectId,
    status: "pending",
  });
  if (!share) throw notFound("Pending invite not found.");

  await share.deleteOne();
}

/**
 * Accept an invite via token (invitee calls this).
 * @param {string} token   — UUID from the invite link
 * @param {string|null} userId — logged-in user ID (null = not logged in)
 * @returns {{ projectId: string, role: string }}
 */
export async function acceptInvite(token, userId) {
  const share = await ProjectShare.findOne({ token, status: "pending" });
  if (!share) throw notFound("Invalid or expired invite link.");

  if (share.expiresAt < new Date()) {
    throw forbidden(
      "This invite link has expired. Ask the owner to resend it.",
    );
  }

  share.status = "accepted";
  if (userId) share.inviteeUserId = userId;
  share.token = randomUUID(); // invalidate token after use
  await share.save();

  return { projectId: share.projectId.toString(), role: share.role };
}

/**
 * Return all projects shared WITH the given user (accepted shares only).
 * Attaches a `shareRole` field to each project doc.
 */
export async function getSharedProjects(userId) {
  // Find by userId or by email if the user record exists
  const user = await User.findById(userId).select("email").lean();

  const query = user
    ? {
        status: "accepted",
        $or: [{ inviteeUserId: userId }, { inviteeEmail: user.email }],
      }
    : { inviteeUserId: userId, status: "accepted" };

  const shares = await ProjectShare.find(query).lean();
  if (shares.length === 0) return [];

  const projectIds = shares.map((s) => s.projectId);
  const projects = await Project.find({ _id: { $in: projectIds } }).lean();

  const roleMap = {};
  for (const s of shares) roleMap[s.projectId.toString()] = s.role;

  return projects.map((p) => ({ ...p, shareRole: roleMap[p._id.toString()] }));
}

/**
 * Assert that userId can access projectId.
 * Owners always pass. Accepted shared members pass with their role.
 * @returns {{ isOwner: boolean, role: "owner"|"viewer"|"editor" }}
 */
export async function assertProjectAccess(projectId, userId) {
  const project = await Project.findById(projectId).lean();
  if (!project) throw notFound("Project not found.");

  if (project.userId.toString() === userId.toString()) {
    return { isOwner: true, role: "owner", project };
  }

  // Check for accepted share
  const user = await User.findById(userId).select("email").lean();
  const share = await ProjectShare.findOne({
    projectId,
    status: "accepted",
    $or: [
      { inviteeUserId: userId },
      ...(user ? [{ inviteeEmail: user.email }] : []),
    ],
  }).lean();

  if (!share) throw forbidden("You do not have access to this project.");

  return { isOwner: false, role: share.role, project };
}

/**
 * Get the share role for a user on a given project.
 * Returns null if they have no access.
 */
export async function getShareRole(projectId, userId) {
  const project = await Project.findById(projectId).select("userId").lean();
  if (!project) return null;
  if (project.userId.toString() === userId.toString()) return "owner";

  const user = await User.findById(userId).select("email").lean();
  const share = await ProjectShare.findOne({
    projectId,
    status: "accepted",
    $or: [
      { inviteeUserId: userId },
      ...(user ? [{ inviteeEmail: user.email }] : []),
    ],
  }).lean();

  return share?.role ?? null;
}

// ─────────────────────────────────────────────────────────────
// Serializer — strips internal fields for API responses
// ─────────────────────────────────────────────────────────────

function _serialize(share) {
  const s = share.toObject ? share.toObject() : { ...share };
  delete s.token; // never expose the raw token in API responses
  return {
    _id: s._id,
    projectId: s.projectId,
    inviteeEmail: s.inviteeEmail,
    inviteeUser: s.inviteeUserId
      ? typeof s.inviteeUserId === "object" && s.inviteeUserId.name
        ? {
            _id: s.inviteeUserId._id,
            name: s.inviteeUserId.name,
            email: s.inviteeUserId.email,
          }
        : { _id: s.inviteeUserId }
      : null,
    role: s.role,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    expiresAt: s.expiresAt,
  };
}
