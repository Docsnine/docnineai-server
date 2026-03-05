// ===================================================================
// Agent 2: API Extractor (Improved)
// ===================================================================

import { llmCall } from "../config/llm.js";

// ─── System Prompt ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior API documentation engineer specializing in extracting and documenting HTTP endpoints from source code across all major frameworks (Express, Fastify, NestJS, Django, FastAPI, Laravel, Rails, etc.).

## YOUR TASK
Analyze the provided source files and extract every HTTP endpoint defined, implied, or registered — including nested routers, prefixed route groups, and decorator-based routes.

## OUTPUT FORMAT
Return ONLY a valid JSON array.
No markdown. No code fences. No explanation. No preamble. No trailing text.
Your entire response must start with [ and end with ].
If no endpoints are found, return exactly: []

## SCHEMA (every endpoint object must follow this exactly)
[
  {
    "method": string,               // Uppercase HTTP method: GET | POST | PUT | PATCH | DELETE | HEAD | OPTIONS
    "path": string,                 // Full path including prefix if determinable e.g. "/api/v1/users/:id"
    "file": string,                 // Source file where this endpoint is defined
    "line": number | null,          // Line number of the route definition if determinable, else null
    "handler": string,              // Name of the handler function/method e.g. "UserController.getById"
    "description": string,          // 1–2 sentences: what this endpoint does and when to use it
    "auth": {
      "required": boolean,          // true if any auth guard/middleware is applied
      "type": string,               // "JWT" | "API_KEY" | "SESSION" | "OAUTH" | "BASIC" | "NONE" | "unknown"
      "roles": string[]             // Required roles/permissions if determinable e.g. ["admin", "superuser"] — [] if none
    },
    "request": {
      "headers": [                  // Notable required/optional headers
        {
          "name": string,           // e.g. "Authorization"
          "type": string,           // e.g. "string"
          "required": boolean,
          "description": string     // e.g. "Bearer token"
        }
      ],
      "params": [                   // Path params, query params, and body fields
        {
          "name": string,           // e.g. "userId"
          "in": string,             // "path" | "query" | "body" | "header"
          "type": string,           // e.g. "string" | "number" | "boolean" | "object" | "array"
          "required": boolean,
          "description": string,    // What this param represents
          "validation": string      // Any validation rules observed e.g. "min:1", "email", "uuid" — "" if none
        }
      ],
      "body_schema": string         // Name of the DTO/schema/interface used for body e.g. "CreateUserDto" — "" if none
    },
    "response": {
      "success": {
        "status": number,           // Expected success HTTP status code e.g. 200, 201
        "description": string,      // What the response contains e.g. "Returns the created user object"
        "schema": string            // Response type/interface name if determinable — "" if none
      },
      "errors": [                   // All possible error responses
        {
          "status": number,         // e.g. 404
          "description": string     // e.g. "User not found"
        }
      ]
    },
    "middleware": string[],         // Named middleware applied to this route e.g. ["rateLimiter", "validateBody"]
    "rate_limit": string,           // Rate limit if specified e.g. "100/min" — "" if none
    "deprecated": boolean,          // true if marked as deprecated
    "tags": string[],               // Logical grouping tags inferred from path/controller e.g. ["users", "auth"]
    "notes": string                 // Edge cases, TODOs, security concerns, important caveats — "" if none
  }
]

## EXTRACTION RULES
1. Extract ALL endpoints — do not skip any route, including nested or prefixed ones.
2. Reconstruct FULL paths: if a router is mounted at "/api/v1/users" and defines "/:id", the full path is "/api/v1/users/:id".
3. For decorator-based frameworks (NestJS, FastAPI, Django): read the controller prefix + method decorator to build the full path.
4. Infer auth from: guard decorators (@UseGuards), middleware names (authMiddleware, requireAuth, isAuthenticated), or decorator names (@Roles, @Auth, @Protected).
5. Infer roles from: @Roles(...), @Permissions(...), role checks in the handler body, or middleware name patterns.
6. For "handler", use the format "ClassName.methodName" for class-based controllers, or just "functionName" for function-based handlers.
7. If a route file imports and re-exports routes from another file, note this in "notes" — do not fabricate the re-exported routes.
8. For "tags", infer from the controller class name, router file name, or path prefix (e.g., "/api/users/..." → tag: "users").
9. If a value cannot be determined with confidence, use null for numbers and "unknown" for strings — never fabricate.
10. Do not merge different HTTP methods on the same path — each method is a separate endpoint object.

## FRAMEWORK DETECTION HINTS
- Express/Fastify: router.get(), app.post(), fastify.put()
- NestJS: @Get(), @Post(), @Controller() prefix + @UseGuards()
- FastAPI: @app.get(), @router.post(), Depends() for auth
- Django: path(), re_path(), urlpatterns, @login_required
- Laravel: Route::get(), Route::apiResource(), middleware()
- Rails: resources :name, get '/path', to: 'controller#action'`;

// ─── Constants ────────────────────────────────────────────────────

const ROUTE_ROLES = new Set(["route", "controller", "entry", "handler", "api"]);

const ROUTE_REGEX = new RegExp(
  [
    // Express / Fastify
    /router\.(get|post|put|delete|patch|head|options)\s*\(/,
    /app\.(get|post|put|delete|patch|head|options)\s*\(/,
    /fastify\.(get|post|put|delete|patch)\s*\(/,
    // NestJS decorators
    /@(Get|Post|Put|Delete|Patch|Head|Options|All|Request|Controller)\s*\(/,
    // FastAPI / Python
    /@(app|router)\.(get|post|put|delete|patch)\s*\(/,
    // Django
    /urlpatterns\s*=/,
    /path\s*\(\s*['"][^'"]+['"]/,
    // Laravel
    /Route::(get|post|put|delete|patch|resource|apiResource)\s*\(/,
    // Rails
    /resources?\s+:/,
    /(get|post|put|delete|patch)\s+['"]\/[^'"]*['"]\s*,\s*to:/,
    // Generic
    /createRouter|useRouter|mountRouter/,
  ]
    .map((r) => r.source)
    .join("|"),
  "i",
);

const PATH_REGEX = /route|controller|handler|endpoint|api/i;

const FILES_PER_BATCH = 3;
const CHARS_PER_FILE = 6000; // was 400 — far too small for real route files
const MAX_ROUTE_FILES = 40;
const MAX_RETRIES = 2;

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Attempt JSON.parse with one retry after stripping
 * accidental markdown fences the model may emit.
 */
function safeParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // Strip ```json ... ``` wrapper if the model added it despite instructions
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    try {
      return JSON.parse(stripped);
    } catch {
      return null;
    }
  }
}

/**
 * Validate and normalise a single extracted endpoint object.
 * Returns null if the object is too malformed to be useful.
 */
function validateEndpoint(ep, fallbackFile) {
  if (!ep || typeof ep !== "object") return null;

  const method = String(ep.method ?? "").toUpperCase();
  const validMethods = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ];
  if (!validMethods.includes(method)) return null;

  const path = String(ep.path ?? "").trim();
  if (!path || !path.startsWith("/")) return null;

  // Normalise nested/missing fields with safe defaults
  return {
    method,
    path,
    file: ep.file || fallbackFile,
    line: ep.line ?? null,
    handler: ep.handler || "unknown",
    description: ep.description || "",
    auth: {
      required: ep.auth?.required ?? false,
      type: ep.auth?.type || "unknown",
      roles: Array.isArray(ep.auth?.roles) ? ep.auth.roles : [],
    },
    request: {
      headers: Array.isArray(ep.request?.headers) ? ep.request.headers : [],
      params: Array.isArray(ep.request?.params) ? ep.request.params : [],
      body_schema: ep.request?.body_schema || "",
    },
    response: {
      success: {
        status: ep.response?.success?.status ?? 200,
        description: ep.response?.success?.description || "",
        schema: ep.response?.success?.schema || "",
      },
      errors: Array.isArray(ep.response?.errors) ? ep.response.errors : [],
    },
    middleware: Array.isArray(ep.middleware) ? ep.middleware : [],
    rate_limit: ep.rate_limit || "",
    deprecated: ep.deprecated ?? false,
    tags: Array.isArray(ep.tags) ? ep.tags : inferTags(path, fallbackFile),
    notes: ep.notes || "",
  };
}

/**
 * Infer tags from path segments or file name when
 * the model didn't provide them.
 */
function inferTags(path, file) {
  const fromPath = path
    .split("/")
    .filter((s) => s && !s.startsWith(":") && s !== "api");
  if (fromPath.length > 0) return [fromPath[0]];
  const fromFile = file
    .split("/")
    .pop()
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]/g, " ");
  return fromFile ? [fromFile] : [];
}

/**
 * LLM call with retry on failure.
 */
async function llmCallWithRetry({
  systemPrompt,
  userContent,
  retries = MAX_RETRIES,
}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await llmCall({ systemPrompt, userContent });
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt)); // back-off
    }
  }
}

// ─── Agent ────────────────────────────────────────────────────────

export async function apiExtractorAgent({ files, projectMap, emit }) {
  const notify = (msg, detail) => emit?.(msg, detail);

  // ── 1. Filter to route-related files ──────────────────────────
  const routeFiles = files
    .filter((f) => {
      if (!f?.path || !f?.content) return false;
      const meta = projectMap?.find((m) => m.path === f.path);
      return (
        (meta && ROUTE_ROLES.has(meta.role)) ||
        ROUTE_REGEX.test(f.content) ||
        PATH_REGEX.test(f.path)
      );
    })
    .slice(0, MAX_ROUTE_FILES);

  if (routeFiles.length === 0) {
    notify("No route files found", "Skipping API extraction");
    return { endpoints: [] };
  }

  const totalBatches = Math.ceil(routeFiles.length / FILES_PER_BATCH);
  notify(
    `Found ${routeFiles.length} route files`,
    `Processing in ${totalBatches} batch${totalBatches > 1 ? "es" : ""}`,
  );

  // ── 2. Extract endpoints batch by batch ───────────────────────
  const rawEndpoints = [];
  const batchErrors = [];

  for (let i = 0; i < routeFiles.length; i += FILES_PER_BATCH) {
    const batchNum = Math.floor(i / FILES_PER_BATCH) + 1;
    const batch = routeFiles.slice(i, i + FILES_PER_BATCH);

    notify(`Extracting endpoints…`, `Batch ${batchNum} of ${totalBatches}`);

    // Build user content with full file context
    const userContent = batch
      .map((f) => {
        const truncated = f.content.length > CHARS_PER_FILE;
        const content = f.content.slice(0, CHARS_PER_FILE);
        return [
          `=== FILE: ${f.path} ===`,
          truncated ? `[Note: file truncated at ${CHARS_PER_FILE} chars]` : "",
          content,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");

    try {
      const raw = await llmCallWithRetry({
        systemPrompt: SYSTEM_PROMPT,
        userContent,
      });
      const parsed = safeParseJSON(raw);

      if (!Array.isArray(parsed)) {
        batchErrors.push({
          batch: batchNum,
          error: "Response was not a JSON array",
        });
        continue;
      }

      // ── BUG FIX: was always assigning batch[0].path to ALL endpoints.
      // Now each endpoint keeps its own file field from the LLM response,
      // falling back to the correct file based on path matching.
      for (const ep of parsed) {
        // Try to match the endpoint's file to one of the batch files
        const matchedFile = batch.find((f) =>
          ep.file
            ? f.path.endsWith(ep.file) || ep.file.endsWith(f.path)
            : false,
        );
        const fallbackFile =
          batch.length === 1
            ? batch[0].path
            : matchedFile?.path || ep.file || batch[0].path;

        const validated = validateEndpoint(ep, fallbackFile);
        if (validated) rawEndpoints.push(validated);
      }
    } catch (err) {
      batchErrors.push({ batch: batchNum, error: err.message });
    }
  }

  // ── 3. Deduplicate ────────────────────────────────────────────
  // Prefer the richer object when duplicates exist (more fields filled)
  const endpointMap = new Map();

  for (const ep of rawEndpoints) {
    const key = `${ep.method}:${ep.path}`;
    const existing = endpointMap.get(key);

    if (!existing) {
      endpointMap.set(key, ep);
    } else {
      // Merge: keep the version with more complete data
      const existingScore = scoreCompleteness(existing);
      const newScore = scoreCompleteness(ep);
      if (newScore > existingScore) endpointMap.set(key, ep);
    }
  }

  const endpoints = Array.from(endpointMap.values())
    // Sort by tag then path for readable output
    .sort((a, b) => {
      const tagA = a.tags[0] ?? "";
      const tagB = b.tags[0] ?? "";
      return tagA.localeCompare(tagB) || a.path.localeCompare(b.path);
    });

  // ── 4. Build summary ──────────────────────────────────────────
  const summary = buildSummary(endpoints);

  if (batchErrors.length > 0) {
    notify(
      `⚠ ${batchErrors.length} batch(es) had errors`,
      batchErrors.map((e) => e.error).join("; "),
    );
  }

  notify(
    `${endpoints.length} unique endpoints extracted`,
    `${summary.authRequired} require auth · ${summary.deprecated} deprecated · ${summary.tags.length} tags`,
  );

  return {
    endpoints,
    summary,
    errors: batchErrors.length > 0 ? batchErrors : undefined,
  };
}

// ─── Utilities ────────────────────────────────────────────────────

/**
 * Score how complete an endpoint object is.
 * Used to pick the richer duplicate when merging.
 */
function scoreCompleteness(ep) {
  let score = 0;
  if (ep.description) score += 2;
  if (ep.handler !== "unknown") score += 1;
  if (ep.request.params.length > 0) score += 2;
  if (ep.request.body_schema) score += 1;
  if (ep.response.errors.length > 0) score += 2;
  if (ep.response.success.schema) score += 1;
  if (ep.middleware.length > 0) score += 1;
  if (ep.auth.type !== "unknown") score += 2;
  if (ep.auth.roles.length > 0) score += 1;
  if (ep.line !== null) score += 1;
  if (ep.notes) score += 1;
  return score;
}

/**
 * Build a high-level summary of all extracted endpoints.
 * Useful for the top-level report and UI dashboard.
 */
function buildSummary(endpoints) {
  const byMethod = {};
  const tagSet = new Set();

  for (const ep of endpoints) {
    byMethod[ep.method] = (byMethod[ep.method] ?? 0) + 1;
    ep.tags.forEach((t) => tagSet.add(t));
  }

  return {
    total: endpoints.length,
    authRequired: endpoints.filter((e) => e.auth.required).length,
    deprecated: endpoints.filter((e) => e.deprecated).length,
    byMethod,
    tags: Array.from(tagSet).sort(),
  };
}
