// =============================================================
// Webhook Settings Controller
// =============================================================
// Per-project webhook management.
//
// Routes:
//   GET  /projects/:id/webhook          — fetch settings + YAML
//   POST /projects/:id/webhook/rotate   — regenerate secret
//   PATCH /projects/:id/webhook         — enable/disable
// =============================================================

import * as webhookService from "./webhook.service.js";
import { ok, fail, serverError } from "../../utils/response.util.js";

// ── Domain error handler ──────────────────────────────────────
const DOMAIN_CODES = new Set([
  "PROJECT_NOT_FOUND",
  "INSUFFICIENT_PERMISSIONS",
]);

function handleErr(res, err, ctx) {
  if (DOMAIN_CODES.has(err.code))
    return fail(res, err.code, err.message, err.status || 400);
  return serverError(res, err, ctx);
}

// ─────────────────────────────────────────────────────────────
// WEBHOOK SETTINGS
// ─────────────────────────────────────────────────────────────

/**
 * GET /projects/:id/webhook
 *
 * Return webhook settings including:
 *   - webhookUrl (constructed)
 *   - secret (visible here only)
 *   - YAML (generated workflow file)
 *   - lastWebhookAt (timestamp)
 *   - lastWebhookStatus ("success" | "failed" | "skipped")
 *   - webhookEnabled (boolean)
 *
 * Owner-only.
 */
export async function getWebhookSettings(req, res) {
  try {
    const settings = await webhookService.getWebhookSettings({
      projectId: req.params.id,
      userId: req.user.userId,
      apiBaseUrl: req.headers["x-api-base-url"] || process.env.API_BASE_URL || req.protocol + "://" + req.get("host"),
    });

    ok(res, settings, 200);
  } catch (err) {
    handleErr(res, err, "getWebhookSettings");
  }
}

/**
 * POST /projects/:id/webhook/rotate
 *
 * Regenerate the webhook secret and return the new YAML.
 * Useful when the user suspects the secret was compromised or
 * wants to update their GitHub Actions workflow.
 *
 * Owner-only.
 */
export async function rotateWebhookSecret(req, res) {
  try {
    const result = await webhookService.rotateWebhookSecret({
      projectId: req.params.id,
      userId: req.user.userId,
      apiBaseUrl: req.headers["x-api-base-url"] || process.env.API_BASE_URL || req.protocol + "://" + req.get("host"),
    });

    ok(res, result, 200);
  } catch (err) {
    handleErr(res, err, "rotateWebhookSecret");
  }
}

/**
 * PATCH /projects/:id/webhook
 *
 * Update webhook settings: enable/disable webhook delivery.
 *
 * Body:
 *   { webhookEnabled: boolean }
 *
 * Owner-only.
 */
export async function updateWebhookSettings(req, res) {
  try {
    const { webhookEnabled } = req.body;

    const result = await webhookService.updateWebhookSettings({
      projectId: req.params.id,
      userId: req.user.userId,
      webhookEnabled,
    });

    ok(res, result, 200);
  } catch (err) {
    handleErr(res, err, "updateWebhookSettings");
  }
}
