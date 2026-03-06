// =============================================================
// Webhook Handler Controller
// =============================================================
// Processes incoming GitHub webhooks at the user account level.
//
// Architecture:
//   - One shared webhook secret per user (stored in User document)
//   - Server-side repo URL matching to identify project
//   - Single global endpoint for all user webhooks
//
// Routes:
//   POST /webhook             — GitHub push webhook (user-level)
//   POST /webhook/flutterwave — Flutterwave billing webhook
// =============================================================

import { serverError } from "../../utils/response.util.js";

let _handleGlobalWebhook = null;
let _handleFlutterwaveWebhook = null;

/**
 * Register webhook service handlers
 * Called during service initialization
 */
export function registerWebhookHandlers(globalHook, flutterwaveHook) {
  _handleGlobalWebhook = globalHook;
  _handleFlutterwaveWebhook = flutterwaveHook;
}

/**
 * POST /webhook
 *
 * Handle incoming GitHub webhook from user's repositories.
 * Validates HMAC signature using the user's webhook secret.
 * Extracts repo URL from payload and identifies matching project.
 * Triggers incremental sync for the matched project.
 *
 * Headers:
 *   x-hub-signature-256: SHA256 HMAC signature
 *
 * Flow:
 *   1. Validate signature using user's webhook secret
 *   2. Extract repository URL from payload
 *   3. Find user's project matching the repo URL
 *   4. Trigger incremental sync for matched project
 *   5. Return 200 OK
 */
export async function handleWebhook(req, res) {
  if (!_handleGlobalWebhook) {
    return res.status(503).json({
      error: "Webhook service unavailable",
      status: "offline",
    });
  }

  try {
    const payload = req.body;
    const rawSig = req.headers["x-hub-signature-256"];
    const signature = Array.isArray(rawSig) ? rawSig[0] : rawSig || "";

    const result = await _handleGlobalWebhook({
      payload,
      signature,
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[webhook] Unhandled error:", err.message, err.stack);
    return serverError(res, err, "handleWebhook", "Failed to process webhook");
  }
}

/**
 * POST /webhook/flutterwave
 *
 * Handle incoming Flutterwave billing webhook.
 * Validates webhook signature and processes payment events.
 */
export async function handleFlutterwaveWebhook(req, res) {
  if (!_handleFlutterwaveWebhook) {
    return res.status(503).json({
      error: "Billing webhook service unavailable",
      status: "offline",
    });
  }

  try {
    await _handleFlutterwaveWebhook(req, res);
  } catch (err) {
    console.error(
      "[webhook:flutterwave] Unhandled error:",
      err.message,
      err.stack,
    );
    return serverError(
      res,
      err,
      "handleFlutterwaveWebhook",
      "Failed to process billing webhook",
    );
  }
}
