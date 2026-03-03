// =============================================================
// Portal controller — thin HTTP layer.
// All business logic lives in portal.service.js.
// =============================================================

import { ok, fail, serverError } from "../../utils/response.util.js";
import * as portalService from "./portal.service.js";

// ── Owner routes (require auth + project ownership) ───────────

/**
 * GET /projects/:id/portal
 * Returns the portal config for the project owner.
 * Returns 200 with data:null if the portal has not been initialised yet
 * (so the UI can show a "Set up portal" CTA without an error state).
 */
export async function getOwnerPortal(req, res) {
  try {
    const portal = await portalService.getPortalForOwner(
      req.params.id,
      req.user.userId,
    );
    return ok(res, { portal }); // portal may be null
  } catch (err) {
    if (err.status) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "getOwnerPortal");
  }
}

/**
 * PUT /projects/:id/portal
 * Create-or-update portal settings.
 */
export async function upsertPortal(req, res) {
  try {
    const portal = await portalService.updatePortal(
      req.params.id,
      req.user.userId,
      req.body,
    );
    return ok(res, { portal }, "Portal settings saved.");
  } catch (err) {
    if (err.status) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "upsertPortal");
  }
}

/**
 * POST /projects/:id/portal/publish
 * Toggle isPublished.  Also lazy-creates the portal record.
 */
export async function togglePublish(req, res) {
  try {
    const portal = await portalService.togglePublish(
      req.params.id,
      req.user.userId,
    );
    const msg = portal.isPublished
      ? "Portal published."
      : "Portal unpublished.";
    return ok(res, { portal }, msg);
  } catch (err) {
    if (err.status) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "togglePublish");
  }
}

// ── Public routes (no auth) ───────────────────────────────────

/**
 * GET /portal/:slug
 * Returns portal metadata + published section content.
 * Password-protected portals return metadata only — the client must
 * call POST /portal/:slug/auth to get a session token, then re-fetch.
 *
 * Query param:  ?_pt=<token>  — portal password token (set by /auth endpoint)
 * For simplicity in this implementation we use a query param approach:
 * the client sends the raw password in the body of the auth endpoint,
 * and on success we return a short-lived signed indicator.
 *
 * Simpler: client sends password in Authorization header as Bearer <password>
 * for password-protected portals.  We verify it here.
 */
export async function getPublicPortal(req, res) {
  try {
    const data = await portalService.getPublicPortal(req.params.slug);

    // If password-protected, require verification before returning content
    if (data.portal.accessMode === "password") {
      const provided = req.headers["x-portal-password"] || req.query._pt;
      if (!provided) {
        // Return portal metadata but no content — client shows password gate
        return ok(res, {
          portal: data.portal,
          project: data.project,
          protected: true,
          content: null,
          sectionVisibility: null,
        });
      }
      const valid = await portalService.verifyPortalPassword(
        req.params.slug,
        provided,
      );
      if (!valid) {
        return fail(res, "INVALID_PASSWORD", "Incorrect portal password.", 401);
      }
    }

    return ok(res, { ...data, protected: false });
  } catch (err) {
    if (err.status) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "getPublicPortal");
  }
}

/**
 * POST /portal/:slug/auth
 * Verify a portal password.  Body: { password: string }
 * Returns { valid: boolean }.
 */
export async function authPortal(req, res) {
  try {
    const { password } = req.body;
    if (!password)
      return fail(res, "MISSING_PASSWORD", "Password is required.", 400);
    const valid = await portalService.verifyPortalPassword(
      req.params.slug,
      password,
    );
    if (!valid)
      return fail(res, "INVALID_PASSWORD", "Incorrect portal password.", 401);
    return ok(res, { valid: true }, "Password verified.");
  } catch (err) {
    if (err.status) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "authPortal");
  }
}
