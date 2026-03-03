// =============================================================
// apispec.parser.js
//
// Parses OpenAPI 2.0 / 3.0.x / 3.1.x and Postman Collection
// v2.x into the normalised ApiSpec shape stored in MongoDB.
//
// Returns: { specVersion, info, servers, tags, endpoints,
//            schemas, securitySchemes }
// Throws:  Error with human-readable message on parse failure.
// =============================================================

import yaml from "js-yaml";

// ── Text → raw object ─────────────────────────────────────────
function parseRaw(text) {
  const trimmed = text.trim();
  // JSON starts with { or [
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`Invalid JSON: ${e.message}`);
    }
  }
  // Try YAML
  try {
    const doc = yaml.load(trimmed);
    if (typeof doc !== "object" || doc === null) {
      throw new Error("YAML parsed to a non-object value.");
    }
    return doc;
  } catch (e) {
    throw new Error(`Could not parse spec as JSON or YAML: ${e.message}`);
  }
}

// ── Version detection ─────────────────────────────────────────
function detectVersion(doc) {
  if (doc.openapi) {
    const v = String(doc.openapi);
    if (v.startsWith("3.1")) return "3.1";
    if (v.startsWith("3.0")) return "3.0";
    return "3.0"; // best guess for future 3.x
  }
  if (doc.swagger && String(doc.swagger).startsWith("2")) return "2.0";
  if (doc.info?.schema && String(doc.info.schema).includes("postman"))
    return "postman";
  if (doc.item) return "postman"; // Postman collection root
  return "unknown";
}

// ── OAS 3.x parsing ──────────────────────────────────────────

function parseOas3(doc, version) {
  const info = {
    title: doc.info?.title ?? "Untitled API",
    version: doc.info?.version ?? "",
    description: doc.info?.description ?? "",
    contact: doc.info?.contact ?? null,
    license: doc.info?.license ?? null,
    termsOfService: doc.info?.termsOfService ?? "",
  };

  const servers = (doc.servers ?? [{ url: "/" }]).map((s) => ({
    url: s.url ?? "/",
    description: s.description ?? "",
  }));

  const tags = (doc.tags ?? []).map((t) => ({
    name: t.name ?? "",
    description: t.description ?? "",
  }));

  const schemas = doc.components?.schemas ?? {};
  const securitySchemes = doc.components?.securitySchemes ?? {};

  const endpoints = [];
  const paths = doc.paths ?? {};

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    // Shared params at path level
    const pathParams = pathItem.parameters ?? [];

    const HTTP_METHODS = [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "options",
      "head",
      "trace",
    ];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const allParams = mergeParams(pathParams, op.parameters ?? []);

      endpoints.push({
        id: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? "",
        description: op.description ?? "",
        tags: op.tags ?? [],
        operationId: op.operationId ?? "",
        parameters: allParams.map(normaliseOas3Param),
        requestBody: op.requestBody
          ? normaliseRequestBody3(op.requestBody)
          : null,
        responses: normaliseResponses3(op.responses ?? {}),
        security: op.security ?? doc.security ?? [],
        deprecated: op.deprecated ?? false,
        customNote: "",
      });
    }
  }

  return {
    specVersion: version,
    info,
    servers,
    tags,
    endpoints,
    schemas,
    securitySchemes,
  };
}

function mergeParams(pathParams, opParams) {
  // Operation-level params override path-level by (in + name)
  const opKeys = new Set(opParams.map((p) => `${p.in}:${p.name}`));
  const merged = pathParams.filter((p) => !opKeys.has(`${p.in}:${p.name}`));
  return [...merged, ...opParams];
}

function normaliseOas3Param(p) {
  if (!p) return {};
  return {
    in: p.in ?? "query",
    name: p.name ?? "",
    required: p.required ?? p.in === "path",
    description: p.description ?? "",
    schema:
      p.schema ??
      (p.content ? (Object.values(p.content)[0]?.schema ?? {}) : {}),
    example: p.example ?? p.schema?.example ?? null,
  };
}

function normaliseRequestBody3(rb) {
  if (!rb) return null;
  return {
    required: rb.required ?? false,
    description: rb.description ?? "",
    content: Object.fromEntries(
      Object.entries(rb.content ?? {}).map(([mt, mc]) => [
        mt,
        {
          schema: mc.schema ?? {},
          example: mc.example ?? mc.examples ?? null,
        },
      ]),
    ),
  };
}

function normaliseResponses3(responses) {
  return Object.fromEntries(
    Object.entries(responses).map(([code, r]) => [
      code,
      {
        description: r.description ?? "",
        content: Object.fromEntries(
          Object.entries(r.content ?? {}).map(([mt, mc]) => [
            mt,
            {
              schema: mc.schema ?? {},
              example: mc.example ?? mc.examples ?? null,
            },
          ]),
        ),
      },
    ]),
  );
}

// ── OAS 2.0 (Swagger) parsing ─────────────────────────────────

function parseSwagger2(doc) {
  const info = {
    title: doc.info?.title ?? "Untitled API",
    version: doc.info?.version ?? "",
    description: doc.info?.description ?? "",
    contact: doc.info?.contact ?? null,
    license: doc.info?.license ?? null,
    termsOfService: doc.info?.termsOfService ?? "",
  };

  // Build base URL from host + basePath + schemes
  let baseUrl = "";
  if (doc.host) {
    const scheme = (doc.schemes ?? ["https"])[0];
    baseUrl = `${scheme}://${doc.host}${doc.basePath ?? ""}`;
  } else {
    baseUrl = doc.basePath ?? "/";
  }
  const servers = [{ url: baseUrl, description: "Base URL" }];

  const tags = (doc.tags ?? []).map((t) => ({
    name: t.name ?? "",
    description: t.description ?? "",
  }));

  const schemas = doc.definitions ?? {};
  const securitySchemes = doc.securityDefinitions ?? {};

  const endpoints = [];
  const paths = doc.paths ?? {};

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    const pathParams = pathItem.parameters ?? [];
    const HTTP_METHODS = [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "options",
      "head",
    ];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const allParams = mergeParams(pathParams, op.parameters ?? []);

      // Swagger 2 has body param and formData inline
      const bodyParam = allParams.find((p) => p.in === "body");
      const formParams = allParams.filter((p) => p.in === "formData");
      const regularParams = allParams.filter(
        (p) => p.in !== "body" && p.in !== "formData",
      );

      let requestBody = null;
      if (bodyParam) {
        const consumes = op.consumes ?? doc.consumes ?? ["application/json"];
        requestBody = {
          required: bodyParam.required ?? false,
          description: bodyParam.description ?? "",
          content: Object.fromEntries(
            consumes.map((ct) => [
              ct,
              { schema: bodyParam.schema ?? {}, example: null },
            ]),
          ),
        };
      } else if (formParams.length > 0) {
        const ct = op.consumes?.includes("multipart/form-data")
          ? "multipart/form-data"
          : "application/x-www-form-urlencoded";
        requestBody = {
          required: false,
          description: "Form data",
          content: {
            [ct]: {
              schema: {
                type: "object",
                properties: Object.fromEntries(
                  formParams.map((fp) => [
                    fp.name,
                    fp.schema ?? { type: fp.type ?? "string" },
                  ]),
                ),
              },
              example: null,
            },
          },
        };
      }

      // Responses
      const produces = op.produces ?? doc.produces ?? ["application/json"];
      const responses = {};
      for (const [code, r] of Object.entries(op.responses ?? {})) {
        responses[code] = {
          description: r.description ?? "",
          content: r.schema
            ? Object.fromEntries(
                produces.map((ct) => [ct, { schema: r.schema, example: null }]),
              )
            : {},
        };
      }

      endpoints.push({
        id: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? "",
        description: op.description ?? "",
        tags: op.tags ?? [],
        operationId: op.operationId ?? "",
        parameters: regularParams.map((p) => ({
          in: p.in,
          name: p.name ?? "",
          required: p.required ?? p.in === "path",
          description: p.description ?? "",
          schema: p.schema ?? { type: p.type ?? "string", format: p.format },
          example: p.example ?? null,
        })),
        requestBody,
        responses,
        security: op.security ?? doc.security ?? [],
        deprecated: op.deprecated ?? false,
        customNote: "",
      });
    }
  }

  return {
    specVersion: "2.0",
    info,
    servers,
    tags,
    endpoints,
    schemas,
    securitySchemes,
  };
}

// ── Postman Collection v2.x parsing ──────────────────────────

function parsePostman(doc) {
  const colInfo = doc.info ?? {};
  const info = {
    title: colInfo.name ?? "Postman Collection",
    version: "",
    description:
      typeof colInfo.description === "string"
        ? colInfo.description
        : (colInfo.description?.content ?? ""),
    contact: null,
    license: null,
    termsOfService: "",
  };

  // Detect a common baseUrl from the first request if available
  const servers = [];
  const allItems = flattenPostmanItems(doc.item ?? []);
  const firstUrl = allItems[0]?.request?.url;
  if (firstUrl) {
    const rawUrl =
      typeof firstUrl === "string" ? firstUrl : (firstUrl.raw ?? "");
    try {
      const u = new URL(rawUrl.replace(/{{[^}]+}}/g, "placeholder"));
      servers.push({
        url: `${u.protocol}//${u.host}`,
        description: "Inferred from first request",
      });
    } catch {
      // ignore
    }
  }
  if (servers.length === 0) servers.push({ url: "/", description: "" });

  // Derive tags from folder names
  const folderTags = (doc.item ?? [])
    .filter((i) => Array.isArray(i.item))
    .map((f) => ({
      name: f.name ?? "",
      description: typeof f.description === "string" ? f.description : "",
    }));
  const tags = folderTags;

  const endpoints = allItems.map((item) => {
    const req = item.request ?? {};
    const rawUrl = typeof req.url === "string" ? req.url : (req.url?.raw ?? "");
    const methodStr = (req.method ?? "GET").toUpperCase();

    // Extract path from URL
    let path = "/";
    try {
      const urlObj = req.url;
      if (typeof urlObj === "object" && urlObj.path) {
        path = "/" + (urlObj.path ?? []).join("/");
      } else {
        path = new URL(rawUrl.replace(/{{[^}]+}}/g, "x")).pathname;
      }
    } catch {
      path = rawUrl.replace(/https?:\/\/[^/]+/, "") || "/";
    }

    // Parameters from URL variables and query
    const parameters = [];
    const urlObj = typeof req.url === "object" ? req.url : {};
    for (const v of urlObj.variable ?? []) {
      parameters.push({
        in: "path",
        name: v.key ?? v.id ?? "",
        required: true,
        description: v.description ?? "",
        schema: { type: "string" },
        example: v.value ?? null,
      });
    }
    for (const q of urlObj.query ?? []) {
      parameters.push({
        in: "query",
        name: q.key ?? "",
        required: false,
        description: q.description ?? "",
        schema: { type: "string" },
        example: q.value ?? null,
      });
    }
    for (const h of req.header ?? []) {
      parameters.push({
        in: "header",
        name: h.key ?? "",
        required: false,
        description: h.description ?? "",
        schema: { type: "string" },
        example: h.value ?? null,
      });
    }

    // Request body
    let requestBody = null;
    if (req.body) {
      const mode = req.body.mode ?? "raw";
      if (mode === "raw") {
        const ct =
          req.body.options?.raw?.language === "json"
            ? "application/json"
            : "text/plain";
        requestBody = {
          required: true,
          description: "",
          content: { [ct]: { schema: {}, example: req.body.raw ?? null } },
        };
      } else if (mode === "formdata" || mode === "urlencoded") {
        const ct =
          mode === "formdata"
            ? "multipart/form-data"
            : "application/x-www-form-urlencoded";
        requestBody = {
          required: true,
          description: "",
          content: {
            [ct]: {
              schema: {
                type: "object",
                properties: Object.fromEntries(
                  (req.body[mode] ?? []).map((f) => [
                    f.key ?? "",
                    { type: "string", example: f.value },
                  ]),
                ),
              },
              example: null,
            },
          },
        };
      }
    }

    // Responses from Postman examples
    const responses = {};
    for (const r of item.response ?? []) {
      const code = String(r.code ?? 200);
      const ct =
        r.header?.find((h) => h.key?.toLowerCase() === "content-type")?.value ??
        "application/json";
      responses[code] = {
        description: r.name ?? r.status ?? "",
        content: { [ct]: { schema: {}, example: r.body ?? null } },
      };
    }
    if (Object.keys(responses).length === 0) {
      responses["200"] = { description: "OK", content: {} };
    }

    return {
      id: `${methodStr} ${path}`,
      method: methodStr,
      path,
      summary: item.name ?? "",
      description: typeof item.description === "string" ? item.description : "",
      tags: item._folderName ? [item._folderName] : [],
      operationId: "",
      parameters,
      requestBody,
      responses,
      security: [],
      deprecated: false,
      customNote: "",
    };
  });

  return {
    specVersion: "postman",
    info,
    servers,
    tags,
    endpoints,
    schemas: {},
    securitySchemes: {},
  };
}

/** Recursively flatten Postman items, tagging each with its folder name. */
function flattenPostmanItems(items, folderName = "") {
  const result = [];
  for (const item of items) {
    if (Array.isArray(item.item)) {
      // folder
      result.push(...flattenPostmanItems(item.item, item.name ?? folderName));
    } else {
      result.push({ ...item, _folderName: folderName });
    }
  }
  return result;
}

// ── Public entry point ────────────────────────────────────────

/**
 * Parse a raw spec string (JSON or YAML) into the normalised shape.
 *
 * @param {string} text — raw spec content
 * @returns {{ specVersion, info, servers, tags, endpoints, schemas, securitySchemes }}
 */
export function parseSpec(text) {
  const doc = parseRaw(text);
  const version = detectVersion(doc);

  switch (version) {
    case "3.0":
    case "3.1":
      return parseOas3(doc, version);
    case "2.0":
      return parseSwagger2(doc);
    case "postman":
      return parsePostman(doc);
    default:
      // Attempt OAS 3.0 as best guess
      try {
        return parseOas3(doc, "unknown");
      } catch {
        throw new Error(
          "Unable to detect spec format. Supported formats: OpenAPI 2.0/3.0/3.1 (JSON or YAML), Postman Collection v2.x.",
        );
      }
  }
}
