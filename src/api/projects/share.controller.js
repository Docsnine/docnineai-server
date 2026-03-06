// =============================================================
// Share Controller — HTTP handlers for project sharing endpoints.
// All routes require the `protect` middleware (req.user.userId set).
// =============================================================

import * as shareService from "./share.service.js";
import { ok, fail, serverError } from "../../utils/response.util.js";

// ── POST /projects/:id/share ──────────────────────────────────
// Body: { invites: [{ email, role }] }   role = "viewer" | "editor"
export async function inviteUsers(req, res) {
  try {
    const { invites } = req.body;
    if (!Array.isArray(invites) || invites.length === 0) {
      return fail(
        res,
        "INVALID_BODY",
        "invites must be a non-empty array.",
        400,
      );
    }
    // Basic per-invite validation
    for (const inv of invites) {
      if (!inv.email || typeof inv.email !== "string") {
        return fail(
          res,
          "INVALID_BODY",
          "Each invite must have an email field.",
          400,
        );
      }
      if (!["viewer", "editor"].includes(inv.role)) {
        return fail(
          res,
          "INVALID_BODY",
          `Invalid role "${inv.role}". Use viewer or editor.`,
          400,
        );
      }
    }
    const results = await shareService.inviteUsers(
      req.params.id,
      req.user.userId,
      invites,
    );
    return ok(res, { results }, "Invites processed.", 200);
  } catch (err) {
    if (err.status) return fail(res, "SHARE_ERROR", err.message, err.status);
    return serverError(res, err, "inviteUsers");
  }
}

// ── GET /projects/:id/share ───────────────────────────────────
export async function listAccess(req, res) {
  try {
    const shares = await shareService.listAccess(
      req.params.id,
      req.user.userId,
    );
    return ok(res, { shares });
  } catch (err) {
    if (err.status) return fail(res, "SHARE_ERROR", err.message, err.status);
    return serverError(res, err, "listAccess");
  }
}

// ── PATCH /projects/:id/share/:shareId ───────────────────────
// Body: { role: "viewer" | "editor" }
export async function changeRole(req, res) {
  try {
    const { role } = req.body;
    if (!["viewer", "editor"].includes(role)) {
      return fail(res, "INVALID_BODY", `Invalid role "${role}".`, 400);
    }
    const share = await shareService.changeRole(
      req.params.id,
      req.params.shareId,
      req.user.userId,
      role,
    );
    return ok(res, { share }, "Role updated.");
  } catch (err) {
    if (err.status) return fail(res, "SHARE_ERROR", err.message, err.status);
    return serverError(res, err, "changeRole");
  }
}

// ── DELETE /projects/:id/share/:shareId ──────────────────────
export async function revokeAccess(req, res) {
  try {
    await shareService.revokeAccess(
      req.params.id,
      req.params.shareId,
      req.user.userId,
    );
    return ok(res, null, "Access revoked.");
  } catch (err) {
    if (err.status) return fail(res, "SHARE_ERROR", err.message, err.status);
    return serverError(res, err, "revokeAccess");
  }
}

// ── POST /projects/:id/share/:shareId/resend ─────────────────
export async function resendInvite(req, res) {
  try {
    const share = await shareService.resendInvite(
      req.params.id,
      req.params.shareId,
      req.user.userId,
    );
    return ok(res, { share }, "Invite resent.");
  } catch (err) {
    if (err.status) return fail(res, "SHARE_ERROR", err.message, err.status);
    return serverError(res, err, "resendInvite");
  }
}

// ── DELETE /projects/:id/share/:shareId/cancel ───────────────
export async function cancelInvite(req, res) {
  try {
    await shareService.cancelInvite(
      req.params.id,
      req.params.shareId,
      req.user.userId,
    );
    return ok(res, null, "Invite cancelled.");
  } catch (err) {
    if (err.status) return fail(res, "SHARE_ERROR", err.message, err.status);
    return serverError(res, err, "cancelInvite");
  }
}

// ── GET /share/accept/:token ──────────────────────────────────
// Public (no auth required) — but we attach userId if logged in.
export async function acceptInvite(req, res) {
  try {
    const result = await shareService.acceptInvite(
      req.params.token,
      req.user?.userId ?? null,
    );
    return ok(res, result, "Invite accepted.");
  } catch (err) {
    if (err.status) return fail(res, "SHARE_ERROR", err.message, err.status);
    return serverError(res, err, "acceptInvite");
  }
}

// ── GET /projects/shared ─────────────────────────────────────
// Returns projects that others have shared with the current user.
export async function getSharedProjects(req, res) {
  try {
    const projects = await shareService.getSharedProjects(req.user.userId);
    return ok(res, { projects });
  } catch (err) {
    if (err.status) return fail(res, "SHARE_ERROR", err.message, err.status);
    return serverError(res, err, "getSharedProjects");
  }
}
