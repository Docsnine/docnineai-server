// =============================================================//
// HTTP layer for OpenAPI / PostMan spec import & viewer.
//
// Routes (mounted under /projects/:id/apispec):
//   GET    /          — get imported spec (metadata + endpoints)
//   POST   /import    — import spec (file | url | raw)
//   POST   /sync      — re-fetch from source URL
//   DELETE /          — delete spec
//   PATCH  /endpoint  — update custom note on an endpoint
//   POST   /try       — proxy Try-It request
// =============================================================

import * as svc from "./apispec.service.js";
import { ok, fail, serverError } from "../../utils/response.util.js";

// ── Error dispatcher ──────────────────────────────────────────

const KNOWN_CODES = new Set([
  "PROJECT_NOT_FOUND",
  "FORBIDDEN",
  "NO_CONTENT",
  "NO_URL",
  "FETCH_FAILED",
  "BAD_METHOD",
  "PARSE_FAILED",
  "NO_SPEC",
  "NOT_FOUND",
  "SYNC_NOT_AVAILABLE",
  "BAD_REQUEST",
  "BAD_URL",
  "PRIVATE_URL",
  "PROXY_ERROR",
]);

function dispatch(res, err, context) {
  if (KNOWN_CODES.has(err.code)) {
    return fail(res, err.code, err.message, err.status ?? 400);
  }
  return serverError(res, err, context);
}

// ── GET /projects/:id/apispec ─────────────────────────────────

export async function getSpec(req, res) {
  try {
    const spec = await svc.getSpec(req.params.id, req.user.userId);
    return ok(res, { spec }); // spec may be null
  } catch (err) {
    return dispatch(res, err, "getSpec");
  }
}

// ── POST /projects/:id/apispec/import ─────────────────────────

export async function importSpec(req, res) {
  try {
    const { method, url, raw, autoSync } = req.body ?? {};

    // Resolve text content: from multipart file OR raw body field
    let content;
    if (req.file) {
      content = req.file.buffer.toString("utf8");
    } else if (raw) {
      content = raw;
    }

    const spec = await svc.importSpec(req.params.id, req.user.userId, {
      method: method ?? (req.file ? "file" : content ? "raw" : "url"),
      content,
      url,
      autoSync: autoSync === true || autoSync === "true",
    });

    return ok(res, { spec }, "API spec imported successfully.");
  } catch (err) {
    return dispatch(res, err, "importSpec");
  }
}

// ── POST /projects/:id/apispec/sync ──────────────────────────

export async function syncSpec(req, res) {
  try {
    const spec = await svc.syncSpec(req.params.id, req.user.userId);
    return ok(res, { spec }, "Spec synced successfully.");
  } catch (err) {
    return dispatch(res, err, "syncSpec");
  }
}

// ── DELETE /projects/:id/apispec ─────────────────────────────

export async function deleteSpec(req, res) {
  try {
    await svc.deleteSpec(req.params.id, req.user.userId);
    return ok(res, null, "Spec deleted.");
  } catch (err) {
    return dispatch(res, err, "deleteSpec");
  }
}

// ── PATCH /projects/:id/apispec/endpoint ─────────────────────

export async function updateEndpointNote(req, res) {
  try {
    const { endpointId, note } = req.body ?? {};
    if (!endpointId)
      return fail(res, "BAD_REQUEST", "endpointId is required.", 400);

    const spec = await svc.updateEndpointNote(
      req.params.id,
      req.user.userId,
      endpointId,
      note ?? "",
    );
    return ok(res, { spec }, "Note updated.");
  } catch (err) {
    return dispatch(res, err, "updateEndpointNote");
  }
}

// ── POST /projects/:id/apispec/try ───────────────────────────

export async function tryRequest(req, res) {
  try {
    const { method, baseUrl, path, headers, queryParams, body } =
      req.body ?? {};
    const result = await svc.tryRequest(req.params.id, req.user.userId, {
      method,
      baseUrl,
      path,
      headers,
      queryParams,
      body,
    });
    return ok(res, result);
  } catch (err) {
    return dispatch(res, err, "tryRequest");
  }
}
