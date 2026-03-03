// =============================================================
// apispec.service.js
//
// Business logic for importing, fetching, syncing, and
// proxying OpenAPI / Postman specs.
// =============================================================

import axios from "axios";
import { ApiSpec } from "../../models/ApiSpec.js";
import { parseSpec } from "./apispec.parser.js";
import { getShareRole } from "../projects/share.service.js";

// ── Permission helpers ────────────────────────────────────────

function makeError(msg, code, status = 400) {
  const e = new Error(msg);
  e.code = code;
  e.status = status;
  return e;
}

async function assertRead(projectId, userId) {
  const role = await getShareRole(projectId, userId);
  if (!role) throw makeError("Project not found.", "PROJECT_NOT_FOUND", 404);
  return role;
}

async function assertWrite(projectId, userId) {
  const role = await getShareRole(projectId, userId);
  if (!role) throw makeError("Project not found.", "PROJECT_NOT_FOUND", 404);
  if (role === "viewer")
    throw makeError("Viewers cannot modify the API spec.", "FORBIDDEN", 403);
  return role;
}

// ── Import ────────────────────────────────────────────────────

/**
 * Import a spec from one of three sources.
 *
 * @param {string} projectId
 * @param {string} userId
 * @param {{ method: "file"|"url"|"raw", content?: string, url?: string, autoSync?: boolean }} opts
 * @returns {Promise<ApiSpec>}
 */
export async function importSpec(projectId, userId, opts) {
  await assertWrite(projectId, userId);

  const { method, content, url, autoSync = false } = opts;

  let rawText;
  let sourceUrl;

  if (method === "file" || method === "raw") {
    if (!content || !content.trim()) {
      throw makeError("No spec content provided.", "NO_CONTENT", 400);
    }
    rawText = content.trim();
    sourceUrl = undefined;
  } else if (method === "url") {
    if (!url || !url.trim()) {
      throw makeError("No URL provided.", "NO_URL", 400);
    }
    try {
      const resp = await axios.get(url.trim(), {
        timeout: 15_000,
        maxContentLength: 5 * 1024 * 1024, // 5 MB
        responseType: "text",
        headers: {
          Accept: "application/json, application/yaml, text/yaml, text/plain",
        },
      });
      rawText =
        typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
      sourceUrl = url.trim();
    } catch (err) {
      throw makeError(
        `Failed to fetch spec from URL: ${err.message}`,
        "FETCH_FAILED",
        422,
      );
    }
  } else {
    throw makeError(
      "Invalid import method. Use file, url, or raw.",
      "BAD_METHOD",
      400,
    );
  }

  // Parse
  let parsed;
  try {
    parsed = parseSpec(rawText);
  } catch (err) {
    throw makeError(err.message, "PARSE_FAILED", 422);
  }

  // Upsert
  const doc = await ApiSpec.findOneAndUpdate(
    { projectId },
    {
      $set: {
        projectId,
        source: method,
        sourceUrl,
        rawContent: rawText,
        autoSync: method === "url" ? autoSync : false,
        lastSyncedAt: new Date(),
        ...parsed,
      },
    },
    { upsert: true, new: true, runValidators: false },
  );

  return doc;
}

// ── Get spec (no raw content) ─────────────────────────────────

export async function getSpec(projectId, userId) {
  await assertRead(projectId, userId);

  const spec = await ApiSpec.findOne({ projectId });
  return spec; // null if never imported
}

// ── Sync (URL source only) ────────────────────────────────────

export async function syncSpec(projectId, userId) {
  await assertWrite(projectId, userId);

  const existing = await ApiSpec.findOne({ projectId });
  if (!existing) throw makeError("No spec imported yet.", "NO_SPEC", 404);
  if (existing.source !== "url" || !existing.sourceUrl) {
    throw makeError(
      "Spec was not imported from a URL; cannot sync.",
      "SYNC_NOT_AVAILABLE",
      400,
    );
  }

  // Re-import from the same URL
  return importSpec(projectId, userId, {
    method: "url",
    url: existing.sourceUrl,
    autoSync: existing.autoSync,
  });
}

// ── Delete spec ───────────────────────────────────────────────

export async function deleteSpec(projectId, userId) {
  await assertWrite(projectId, userId);
  await ApiSpec.deleteOne({ projectId });
}

// ── Update custom note on a single endpoint ───────────────────

export async function updateEndpointNote(projectId, userId, endpointId, note) {
  await assertWrite(projectId, userId);

  const spec = await ApiSpec.findOne({ projectId });
  if (!spec) throw makeError("No spec imported yet.", "NO_SPEC", 404);

  const ep = spec.endpoints.find((e) => e.id === endpointId);
  if (!ep) throw makeError("Endpoint not found.", "NOT_FOUND", 404);

  ep.customNote = note ?? "";
  await spec.save();
  return spec;
}

// ── Try It proxy ──────────────────────────────────────────────

/**
 * Proxy a request to the target API so the browser avoids CORS.
 * The endpoint URL is constructed from the spec's first server
 * base-url + the endpoint path.
 *
 * @param {string} projectId
 * @param {string} userId
 * @param {{ method, baseUrl, path, headers, queryParams, body }} opts
 */
export async function tryRequest(projectId, userId, opts) {
  await assertRead(projectId, userId);

  const {
    method,
    baseUrl,
    path: epPath,
    headers = {},
    queryParams = {},
    body,
  } = opts;

  if (!baseUrl) throw makeError("baseUrl is required.", "BAD_REQUEST", 400);
  if (!epPath) throw makeError("path is required.", "BAD_REQUEST", 400);

  // Sanitise: do not allow internal/private network calls
  let targetUrl;
  try {
    targetUrl = new URL(
      epPath.startsWith("http") ? epPath : baseUrl.replace(/\/$/, "") + epPath,
    );
  } catch {
    throw makeError("Invalid endpoint URL.", "BAD_URL", 400);
  }

  const hostname = targetUrl.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    /^127\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^10\./.test(hostname) ||
    hostname === "0.0.0.0"
  ) {
    throw makeError(
      "Proxying to localhost or private network addresses is not allowed.",
      "PRIVATE_URL",
      403,
    );
  }

  try {
    const resp = await axios.request({
      method: (method ?? "GET").toUpperCase(),
      url: targetUrl.toString(),
      params: queryParams,
      headers: { "User-Agent": "DocNine-TryIt/1.0", ...headers },
      data: body ?? undefined,
      timeout: 20_000,
      maxContentLength: 2 * 1024 * 1024, // 2 MB response cap
      validateStatus: () => true, // forward non-2xx as-is
      decompress: true,
    });

    return {
      status: resp.status,
      headers: resp.headers,
      body:
        typeof resp.data === "string"
          ? resp.data
          : JSON.stringify(resp.data, null, 2),
    };
  } catch (err) {
    throw makeError(`Proxy request failed: ${err.message}`, "PROXY_ERROR", 502);
  }
}
