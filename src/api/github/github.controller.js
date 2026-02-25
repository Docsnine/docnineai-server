// ===================================================================
// Thin HTTP layer — calls github.service.js, formats responses.
// ===================================================================

import * as githubService from "./github.service.js";
import { ok, fail, serverError } from "../../utils/response.util.js";

// ── GET /github/oauth/start ───────────────────────────────────
// Returns the GitHub authorization URL as JSON.
//
// WHY NOT res.redirect():
//   This endpoint is called via the browser's fetch() API with a Bearer
//   token in the Authorization header. A redirect response to
//   github.com would be followed by fetch(), which would then make a
//   CORS-blocked request to GitHub — the browser never navigates away.
//   Instead, we return the URL in JSON and let the client do:
//     window.location.href = data.url
export async function oauthStart(req, res) {
  try {
    const url = githubService.buildOAuthUrl(req.user.userId);
    return ok(res, { url }, "Redirect to this URL to authorise GitHub access.");
  } catch (err) {
    if (err.message?.includes("GITHUB_CLIENT_ID")) {
      return fail(res, "GITHUB_NOT_CONFIGURED", err.message, 503);
    }
    return serverError(res, err, "oauthStart");
  }
}

// ── GET /github/oauth/callback ────────────────────────────────
// GitHub redirects the browser here after the user grants permission.
// This is a BROWSER navigation, not a fetch() call — no Bearer token.
// User identity comes from the signed `state` JWT set in oauthStart.
//
// On success/failure, redirect to the SPA's root with query params that
// handleOAuthReturn() in the frontend reads and clears from the URL bar.
export async function oauthCallback(req, res) {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    const msg = encodeURIComponent(`GitHub denied access: ${oauthError}`);
    return res.redirect(`${frontendUrl}/?github=error&msg=${msg}`);
  }

  if (!code || !state) {
    const msg = encodeURIComponent("Missing code or state — please try again.");
    return res.redirect(`${frontendUrl}/?github=error&msg=${msg}`);
  }

  try {
    const { githubUsername } = await githubService.handleOAuthCallback({
      code,
      state,
    });
    const user = encodeURIComponent(githubUsername);
    return res.redirect(`${frontendUrl}/?github=connected&user=${user}`);
  } catch (err) {
    const msg = encodeURIComponent(err.message || "GitHub connection failed.");
    return res.redirect(`${frontendUrl}/?github=error&msg=${msg}`);
  }
}

// ── GET /github/repos ─────────────────────────────────────────
export async function listRepos(req, res) {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const perPage = Math.min(
    100,
    Math.max(1, parseInt(req.query.perPage || "30", 10)),
  );
  const type = req.query.type || "all"; // all | owner | member | public | private
  const sort = req.query.sort || "updated"; // created | updated | pushed | full_name

  try {
    const result = await githubService.getUserRepos(req.user.userId, {
      page,
      perPage,
      type,
      sort,
    });
    return ok(res, result);
  } catch (err) {
    if (err.code === "GITHUB_NOT_CONNECTED")
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "listRepos");
  }
}

// ── GET /github/status ────────────────────────────────────────
export async function connectionStatus(req, res) {
  try {
    const status = await githubService.getConnectionStatus(req.user.userId);
    if (!status) return ok(res, { connected: false });
    return ok(res, status);
  } catch (err) {
    return serverError(res, err, "connectionStatus");
  }
}

// ── DELETE /github/disconnect ─────────────────────────────────
export async function disconnect(req, res) {
  try {
    await githubService.disconnectGitHub(req.user.userId);
    return ok(res, null, "GitHub account disconnected.");
  } catch (err) {
    return serverError(res, err, "disconnect");
  }
}
