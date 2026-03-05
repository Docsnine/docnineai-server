// ===================================================================
// Agent 1: Repo Scanner (Improved)
// ===================================================================

import { llmCall } from "../config/llm.js";
import { sortAndFilterFiles } from "../utils/token-manager.util.js";

// ─── System Prompt ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior software architect performing a deep codebase audit across any language or framework.

## YOUR TASK
Classify each provided file into a role, assess its importance, and write a concise & detailed summary. You are given the file path and a content snippet for each file.

## OUTPUT FORMAT
Return ONLY a valid JSON array.
No markdown. No code fences. No explanation. No preamble. No trailing text.
Your entire response must start with [ and end with ].

## SCHEMA (every object must follow this exactly)
[
  {
    "path": string,               // Exact file path as provided — do not modify
    "role": string,               // One role from the allowed list below
    "layer": string,              // One of: frontend | backend | shared | infrastructure | database | test | other
    "language": string,           // Detected language: typescript | javascript | python | go | rust | java | ruby | php | css | html | json | yaml | other
    "importance": string,         // "critical" | "high" | "medium" | "low"
    "summary": string,            // One sentence: what this file does — be specific, no generic phrases
    "exports": string[],          // Top-level exports detected from snippet — [] if none visible
    "flags": string[]             // Notable flags from: "has_auth" | "has_db" | "has_side_effects" | "has_env_usage" | "has_error_handling" | "is_entry_point" | "is_barrel" | "is_deprecated" | "has_todos" | "has_hardcoded_values"
  }
]

## ALLOWED ROLES
| Role         | When to use |
|--------------|-------------|
| entry        | Application entry point — main.ts, index.js, app.py, server.go, wsgi.py |
| controller   | Handles HTTP request/response cycle, delegates to services |
| route        | Defines URL routing — may overlap with controller in some frameworks |
| service      | Contains business logic, called by controllers or other services |
| model        | Data model class or interface definition |
| schema       | Validation schema or serializer (Zod, Joi, Yup, Pydantic, Marshmallow) |
| middleware   | Request/response pipeline function (auth, logging, rate limiting) |
| utility      | Pure helper functions with no side effects or framework coupling |
| helper       | Impure helpers — may have dependencies but not a full service |
| config       | App configuration, environment loading, constants |
| migration    | Database migration file |
| seed         | Database seed or fixture file |
| test         | Unit, integration, or e2e test file |
| hook         | React/Vue/Svelte hook or composable |
| component    | UI component |
| store        | State management (Redux, Zustand, Pinia, MobX, Vuex) |
| context      | React context, Vue provide/inject, DI container |
| guard        | Auth/permission guard (NestJS guard, middleware wrapper, decorator) |
| interceptor  | Request/response interceptor or transformer |
| decorator    | Class or method decorator / annotation |
| job          | Background job, queue worker, cron task |
| event        | Event emitter, listener, pub-sub handler |
| frontend     | General frontend file not matching a more specific role |
| other        | Doesn't fit any role above |

## CLASSIFICATION RULES
1. Assign the MOST SPECIFIC role available — never use "other" if a more specific role fits.
2. For "importance":
   - critical = entry points, auth middleware, core services called by many others
   - high = controllers, models, primary services
   - medium = utilities, configs, helpers, hooks
   - low = tests, migrations, seeds, barrel files, generated files
3. For "summary", be specific: "Defines the User Prisma model with fields for auth and profile data" is correct. "User model file" is not acceptable.
4. For "exports", extract named or default export identifiers visible in the snippet — do not fabricate.
5. For "flags", only set flags you can actually observe in the snippet — do not guess.
6. If you cannot determine a value confidently, use "unknown" for strings and [] for arrays — never fabricate.
7. Always return one object per file — even if the snippet is minimal.

## FRAMEWORK HINTS
- NestJS: @Controller(), @Injectable(), @Module(), @Guard() → use controller/service/guard/interceptor
- Express/Fastify: router.get(), app.use(), fastify.register() → route/middleware
- React: function Component() + JSX, useXxx() → component/hook
- Prisma/TypeORM/Sequelize: model definitions, @Entity() → model
- Zod/Joi/Yup: .object(), .string(), schema exports → schema
- Django: views.py, urls.py, models.py, serializers.py → controller/route/model/schema
- Bull/BullMQ, Celery: @Processor(), @Job(), task definitions → job`;

// ─── Constants ────────────────────────────────────────────────────

const BATCH_SIZE = 10; // files per LLM call — larger than original for efficiency
const SNIPPET_SIZE = 600; // chars per file — was 300, too small for export detection
const MAX_FILES = 200; // hard cap before filtering
const MAX_RETRIES = 2;

const VALID_ROLES = new Set([
  "entry",
  "controller",
  "route",
  "service",
  "model",
  "schema",
  "middleware",
  "utility",
  "helper",
  "config",
  "migration",
  "seed",
  "test",
  "hook",
  "component",
  "store",
  "context",
  "guard",
  "interceptor",
  "decorator",
  "job",
  "event",
  "frontend",
  "other",
]);

const VALID_LAYERS = new Set([
  "frontend",
  "backend",
  "shared",
  "infrastructure",
  "database",
  "test",
  "other",
]);

const VALID_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "ruby",
  "php",
  "css",
  "html",
  "json",
  "yaml",
  "other",
]);

const VALID_IMPORTANCE = new Set(["critical", "high", "medium", "low"]);

const VALID_FLAGS = new Set([
  "has_auth",
  "has_db",
  "has_side_effects",
  "has_env_usage",
  "has_error_handling",
  "is_entry_point",
  "is_barrel",
  "is_deprecated",
  "has_todos",
  "has_hardcoded_values",
]);

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Safe JSON parser with markdown fence stripping fallback.
 */
function safeParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {
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
 * Validate and normalise a single classified file object.
 * Returns null if too malformed to use.
 */
function validateClassification(item, originalPath) {
  if (!item || typeof item !== "object") return null;

  const path = String(item.path ?? originalPath ?? "").trim();
  if (!path) return null;

  return {
    path,
    role: VALID_ROLES.has(item.role) ? item.role : "other",
    layer: VALID_LAYERS.has(item.layer) ? item.layer : "other",
    language: VALID_LANGUAGES.has(item.language)
      ? item.language
      : inferLanguage(path),
    importance: VALID_IMPORTANCE.has(item.importance)
      ? item.importance
      : "medium",
    summary: String(item.summary ?? "").trim() || "",
    exports: Array.isArray(item.exports)
      ? item.exports.filter((e) => typeof e === "string")
      : [],
    flags: Array.isArray(item.flags)
      ? item.flags.filter((f) => VALID_FLAGS.has(f))
      : [],
  };
}

/**
 * Fallback classification when LLM fails for a file.
 * Uses heuristics so no file is silently lost.
 */
function heuristicClassify(file) {
  const p = file.path.toLowerCase();
  const ext = p.split(".").pop();
  const name = p.split("/").pop();

  let role = "other";
  let layer = "other";
  let importance = "medium";

  // Role heuristics
  if (/\.(test|spec)\.[jt]sx?$/.test(p) || /__(tests?|specs?)__/.test(p)) {
    role = "test";
    importance = "low";
  } else if (/migration[s]?\//.test(p) || /\d{8,}_/.test(name)) {
    role = "migration";
    importance = "low";
  } else if (/seed[s]?\/|fixture[s]?\//i.test(p)) {
    role = "seed";
    importance = "low";
  } else if (/index\.[jt]sx?$/.test(p) && !/src\//.test(p)) {
    role = "entry";
    importance = "critical";
  } else if (/main\.[jt]s$|server\.[jt]s$|app\.[jt]s$/.test(p)) {
    role = "entry";
    importance = "critical";
  } else if (/controller[s]?\/|\.controller\.[jt]sx?$/.test(p)) {
    role = "controller";
    importance = "high";
  } else if (/route[s]?\/|\.route[s]?\.[jt]sx?$/.test(p)) {
    role = "route";
    importance = "high";
  } else if (/service[s]?\/|\.service\.[jt]sx?$/.test(p)) {
    role = "service";
    importance = "high";
  } else if (/model[s]?\/|\.model\.[jt]sx?$/.test(p)) {
    role = "model";
    importance = "high";
  } else if (/middleware[s]?\/|\.middleware\.[jt]sx?$/.test(p)) {
    role = "middleware";
    importance = "high";
  } else if (/schema[s]?\/|\.schema\.[jt]sx?$/.test(p)) {
    role = "schema";
    importance = "medium";
  } else if (/util[s]?\/|\.util\.[jt]sx?$|helper[s]?\//.test(p)) {
    role = "utility";
    importance = "medium";
  } else if (/config[s]?\/|\.config\.[jt]sx?$|constants\./i.test(p)) {
    role = "config";
    importance = "medium";
  } else if (/hook[s]?\/|use[A-Z]/.test(name)) {
    role = "hook";
    importance = "medium";
  } else if (/store[s]?\/|slice[s]?\//i.test(p)) {
    role = "store";
    importance = "medium";
  } else if (/guard[s]?\/|\.guard\.[jt]sx?$/.test(p)) {
    role = "guard";
    importance = "high";
  } else if (/job[s]?\/|queue[s]?\/|worker[s]?\//i.test(p)) {
    role = "job";
    importance = "medium";
  } else if (/component[s]?\/|pages\/|views\//i.test(p)) {
    role = "component";
    importance = "medium";
  }

  // Layer heuristics
  if (/src\/client|src\/frontend|src\/ui|pages\/|components\/|hooks\//i.test(p))
    layer = "frontend";
  else if (/src\/server|src\/api|src\/backend/i.test(p)) layer = "backend";
  else if (/shared\/|common\/|lib\//i.test(p)) layer = "shared";
  else if (/docker|k8s|terraform|\.yml$|\.yaml$|nginx/i.test(p))
    layer = "infrastructure";
  else if (/migration|seed|schema|prisma|entity/i.test(p)) layer = "database";
  else if (/test|spec|__mock/i.test(p)) layer = "test";

  // Static flags from content
  const content = file.content || "";
  const flags = [];
  if (/process\.env\.|dotenv|os\.environ/i.test(content))
    flags.push("has_env_usage");
  if (/jwt|bearer|auth|passport|session|cookie/i.test(content))
    flags.push("has_auth");
  if (/db\.|pool\.|prisma\.|mongoose\.|sequelize\.|query\(/i.test(content))
    flags.push("has_db");
  if (/try\s*{|catch\s*\(|\.catch\(|throw new/i.test(content))
    flags.push("has_error_handling");
  if (/TODO|FIXME|HACK|XXX/i.test(content)) flags.push("has_todos");
  if (role === "entry") flags.push("is_entry_point");
  if (/^export\s*\{|export \* from/m.test(content)) flags.push("is_barrel");

  return {
    path: file.path,
    role,
    layer,
    language: inferLanguage(file.path),
    importance,
    summary: "", // heuristic can't write a meaningful summary
    exports: [],
    flags,
    _heuristic: true, // internal marker — stripped before returning
  };
}

/**
 * Infer language from file extension.
 */
function inferLanguage(filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "java",
    rb: "ruby",
    php: "php",
    css: "css",
    scss: "css",
    sass: "css",
    html: "html",
    htm: "html",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
  };
  return map[ext] || "other";
}

/**
 * LLM call with exponential back-off retry.
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
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

/**
 * Build role distribution string for logging.
 */
function buildDistributionString(classified) {
  const dist = {};
  for (const f of classified) {
    dist[f.role] = (dist[f.role] ?? 0) + 1;
  }
  return Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .map(([role, count]) => `${role}:${count}`)
    .join(" · ");
}

/**
 * Build a detailed tech stack with version hints from manifest files.
 */
function detectTechStack(files) {
  const paths = files.map((f) => f.path).join("\n");
  const manifests = files
    .filter((f) =>
      /package\.json$|requirements\.txt$|Cargo\.toml$|go\.mod$|pom\.xml$|composer\.json$|Gemfile$/.test(
        f.path,
      ),
    )
    .map((f) => f.content.slice(0, 2000))
    .join("\n");
  const allContent = files
    .slice(0, 50)
    .map((f) => f.content.slice(0, 300))
    .join("\n");
  const combined = manifests + "\n" + allContent;
  const stack = [];

  // ── JavaScript / Node.js ──────────────────────────────────────
  if (/package\.json/i.test(paths)) {
    stack.push("Node.js");

    // Frameworks
    if (/"next"/i.test(combined)) stack.push("Next.js");
    else if (/"react"/i.test(combined)) stack.push("React");
    if (/"vue"/i.test(combined)) stack.push("Vue");
    if (/"svelte"/i.test(combined)) stack.push("Svelte");
    if (/"nuxt"/i.test(combined)) stack.push("Nuxt.js");
    if (/"express"/i.test(combined)) stack.push("Express");
    if (/"fastify"/i.test(combined)) stack.push("Fastify");
    if (/"koa"/i.test(combined)) stack.push("Koa");
    if (/"hono"/i.test(combined)) stack.push("Hono");
    if (/"@nestjs\/core"/i.test(combined)) stack.push("NestJS");

    // Language
    if (/"typescript"|"ts-node"|tsconfig/i.test(combined))
      stack.push("TypeScript");

    // ORMs & Databases
    if (/"prisma"/i.test(combined)) stack.push("Prisma");
    if (/"typeorm"/i.test(combined)) stack.push("TypeORM");
    if (/"sequelize"/i.test(combined)) stack.push("Sequelize");
    if (/"mongoose"|"mongodb"/i.test(combined)) stack.push("MongoDB");
    if (/"pg"|"postgres"/i.test(combined)) stack.push("PostgreSQL");
    if (/"mysql2"/i.test(combined)) stack.push("MySQL");
    if (/"redis"|"ioredis"/i.test(combined)) stack.push("Redis");
    if (/"sqlite"|"better-sqlite"/i.test(combined)) stack.push("SQLite");

    // Auth & Security
    if (/"jsonwebtoken"/i.test(combined)) stack.push("JWT");
    if (/"passport"/i.test(combined)) stack.push("Passport.js");
    if (/"bcrypt"/i.test(combined)) stack.push("bcrypt");

    // Communication
    if (/"socket\.io"/i.test(combined)) stack.push("Socket.io");
    if (/"graphql"|"@apollo"/i.test(combined)) stack.push("GraphQL");
    if (/"grpc"/i.test(combined)) stack.push("gRPC");

    // Queues
    if (/"bull"|"bullmq"/i.test(combined)) stack.push("BullMQ");
    if (/"kafka"/i.test(combined)) stack.push("Kafka");
    if (/"amqplib"|"rabbitmq"/i.test(combined)) stack.push("RabbitMQ");

    // Testing
    if (/"jest"/i.test(combined)) stack.push("Jest");
    if (/"vitest"/i.test(combined)) stack.push("Vitest");
    if (/"cypress"/i.test(combined)) stack.push("Cypress");
  }

  // ── Python ────────────────────────────────────────────────────
  if (/requirements\.txt|setup\.py|pyproject\.toml/i.test(paths)) {
    stack.push("Python");
    if (/django/i.test(combined)) stack.push("Django");
    if (/djangorestframework|rest_framework/i.test(combined)) stack.push("DRF");
    if (/flask/i.test(combined)) stack.push("Flask");
    if (/fastapi/i.test(combined)) stack.push("FastAPI");
    if (/sqlalchemy/i.test(combined)) stack.push("SQLAlchemy");
    if (/alembic/i.test(combined)) stack.push("Alembic");
    if (/pydantic/i.test(combined)) stack.push("Pydantic");
    if (/celery/i.test(combined)) stack.push("Celery");
    if (/pytest/i.test(combined)) stack.push("pytest");
  }

  // ── Go ────────────────────────────────────────────────────────
  if (/go\.mod/i.test(paths)) {
    stack.push("Go");
    if (/gin-gonic\/gin/i.test(combined)) stack.push("Gin");
    if (/go-chi\/chi/i.test(combined)) stack.push("Chi");
    if (/labstack\/echo/i.test(combined)) stack.push("Echo");
    if (/gorm\.io/i.test(combined)) stack.push("GORM");
    if (/grpc/i.test(combined)) stack.push("gRPC");
  }

  // ── Rust ──────────────────────────────────────────────────────
  if (/Cargo\.toml/i.test(paths)) {
    stack.push("Rust");
    if (/actix-web/i.test(combined)) stack.push("Actix Web");
    if (/axum/i.test(combined)) stack.push("Axum");
    if (/tokio/i.test(combined)) stack.push("Tokio");
    if (/diesel/i.test(combined)) stack.push("Diesel");
    if (/sqlx/i.test(combined)) stack.push("SQLx");
  }

  // ── Java / Kotlin ─────────────────────────────────────────────
  if (/pom\.xml|build\.gradle/i.test(paths)) {
    stack.push(/\.kt$/m.test(paths) ? "Kotlin" : "Java");
    if (/spring-boot/i.test(combined)) stack.push("Spring Boot");
    if (/hibernate/i.test(combined)) stack.push("Hibernate");
    if (/maven/i.test(combined)) stack.push("Maven");
    if (/gradle/i.test(combined)) stack.push("Gradle");
  }

  // ── PHP ───────────────────────────────────────────────────────
  if (/composer\.json/i.test(paths)) {
    stack.push("PHP");
    if (/laravel/i.test(combined)) stack.push("Laravel");
    if (/symfony/i.test(combined)) stack.push("Symfony");
    if (/eloquent/i.test(combined)) stack.push("Eloquent");
  }

  // ── Ruby ──────────────────────────────────────────────────────
  if (/Gemfile/i.test(paths)) {
    stack.push("Ruby");
    if (/rails/i.test(combined)) stack.push("Rails");
    if (/sinatra/i.test(combined)) stack.push("Sinatra");
    if (/activerecord/i.test(combined)) stack.push("ActiveRecord");
  }

  // ── Infrastructure ────────────────────────────────────────────
  if (/Dockerfile/i.test(paths)) stack.push("Docker");
  if (/docker-compose/i.test(paths)) stack.push("Docker Compose");
  if (/kubernetes|k8s|\.yaml$/m.test(paths) && /apiVersion/i.test(combined))
    stack.push("Kubernetes");
  if (/terraform/i.test(paths)) stack.push("Terraform");
  if (/nginx/i.test(paths)) stack.push("Nginx");
  if (/\.github\/workflows/i.test(paths)) stack.push("GitHub Actions");

  // ── Extension fallback (no manifest found) ────────────────────
  if (!stack.length) {
    if (/\.py$/m.test(paths)) stack.push("Python");
    if (/\.go$/m.test(paths)) stack.push("Go");
    if (/\.rs$/m.test(paths)) stack.push("Rust");
    if (/\.java$/m.test(paths)) stack.push("Java");
    if (/\.kt$/m.test(paths)) stack.push("Kotlin");
    if (/\.ts$/m.test(paths)) stack.push("TypeScript");
    if (/\.js$/m.test(paths)) stack.push("JavaScript");
    if (/\.rb$/m.test(paths)) stack.push("Ruby");
    if (/\.php$/m.test(paths)) stack.push("PHP");
    if (/\.cs$/m.test(paths)) stack.push("C#");
    if (/\.swift$/m.test(paths)) stack.push("Swift");
  }

  return [...new Set(stack)];
}

/**
 * Detect testing frameworks separately — useful for the report.
 */
function detectTestFrameworks(files) {
  const combined = files
    .filter((f) =>
      /package\.json$|requirements\.txt$|Gemfile$|pom\.xml$/.test(f.path),
    )
    .map((f) => f.content.slice(0, 2000))
    .join("\n");

  const frameworks = [];
  if (/jest/i.test(combined)) frameworks.push("Jest");
  if (/vitest/i.test(combined)) frameworks.push("Vitest");
  if (/mocha/i.test(combined)) frameworks.push("Mocha");
  if (/jasmine/i.test(combined)) frameworks.push("Jasmine");
  if (/cypress/i.test(combined)) frameworks.push("Cypress");
  if (/playwright/i.test(combined)) frameworks.push("Playwright");
  if (/pytest/i.test(combined)) frameworks.push("pytest");
  if (/rspec/i.test(combined)) frameworks.push("RSpec");
  if (/junit/i.test(combined)) frameworks.push("JUnit");
  return frameworks;
}

/**
 * Group classified files by role → array of paths.
 */
function groupByRole(classified) {
  const map = {};
  for (const f of classified) {
    if (!map[f.role]) map[f.role] = [];
    map[f.role].push(f.path);
  }
  return map;
}

/**
 * Group classified files by layer.
 */
function groupByLayer(classified) {
  const map = {};
  for (const f of classified) {
    const layer = f.layer || "other";
    if (!map[layer]) map[layer] = [];
    map[layer].push(f.path);
  }
  return map;
}

/**
 * Build a cross-file flags summary (e.g. how many files have auth, db usage etc.)
 */
function buildFlagsSummary(classified) {
  const summary = {};
  for (const f of classified) {
    for (const flag of f.flags || []) {
      summary[flag] = (summary[flag] ?? 0) + 1;
    }
  }
  return summary;
}

/**
 * Identify the most critical files for downstream agents.
 * Entry points + critical/high importance non-test files.
 */
function identifyKeyFiles(classified) {
  return classified
    .filter(
      (f) =>
        f.role === "entry" ||
        f.importance === "critical" ||
        (f.importance === "high" && f.role !== "test"),
    )
    .sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return (order[a.importance] ?? 3) - (order[b.importance] ?? 3);
    })
    .map((f) => f.path)
    .slice(0, 20);
}

/**
 * Produce a brief architecture hint string from the classified files.
 * Passed to downstream agents for context.
 */
function inferArchitecturePattern(classified, techStack) {
  const roles = new Set(classified.map((f) => f.role));
  const stack = techStack.join(" ").toLowerCase();

  if (roles.has("controller") && roles.has("service") && roles.has("model")) {
    if (/nestjs/i.test(stack))
      return "NestJS layered architecture (Controllers → Services → Repositories)";
    return "MVC / layered architecture (Controllers → Services → Models)";
  }
  if (roles.has("route") && roles.has("service") && !roles.has("controller")) {
    return "Service-based routing (Routes → Services → Models)";
  }
  if (roles.has("component") && roles.has("hook") && roles.has("store")) {
    return "Frontend SPA with component-hook-store pattern";
  }
  if (
    roles.has("component") &&
    !roles.has("service") &&
    !roles.has("controller")
  ) {
    return "Frontend-only application";
  }
  if (roles.has("job") || roles.has("event")) {
    return "Event-driven or queue-based architecture";
  }
  return "Mixed / undetermined architecture pattern";
}

// ─── Agent ────────────────────────────────────────────────────────

export async function repoScannerAgent({ files, meta, emit }) {
  const notify = (msg, detail) => emit?.(msg, detail);

  notify("Starting codebase scan…", "Repository Scanning");

  // ── 1. Pre-filter and prioritise files ────────────────────────
  const relevant = sortAndFilterFiles(files).slice(0, MAX_FILES);

  if (relevant.length === 0) {
    notify("No files to classify", "Repo scanner found zero relevant files");
    return {
      projectMap: [],
      techStack: [],
      testFrameworks: [],
      entryPoints: [],
      keyFiles: [],
      structure: {},
      layerMap: {},
      flagsSummary: {},
      architectureHint: "No files found",
      summary: { total: 0, classified: 0, heuristic: 0, failed: 0 },
    };
  }

  const totalBatches = Math.ceil(relevant.length / BATCH_SIZE);
  notify(
    `Classifying ${relevant.length} files…`,
    `${totalBatches} batch${totalBatches > 1 ? "es" : ""} · ${BATCH_SIZE} files each`,
  );

  // ── 2. LLM classification in batches ──────────────────────────
  const classifiedMap = new Map(); // path → classified object
  const batchErrors = [];

  for (let i = 0; i < relevant.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = relevant.slice(i, i + BATCH_SIZE);

    notify(`Classifying files…`, `Batch ${batchNum} of ${totalBatches}`);

    const userContent = batch
      .map((f) => {
        const snippet = f.content
          .slice(0, SNIPPET_SIZE)
          .replace(/\n/g, " ")
          .trim();
        const truncated = f.content.length > SNIPPET_SIZE ? " [truncated]" : "";
        return `FILE: ${f.path}\nSNIPPET: ${snippet}${truncated}`;
      })
      .join("\n\n---\n\n");

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
        // Fall back to heuristics for this batch
        batch.forEach((f) => {
          const h = heuristicClassify(f);
          classifiedMap.set(f.path, h);
        });
        continue;
      }

      for (const item of parsed) {
        // Match returned path to the original batch file
        const matchedFile = batch.find(
          (f) =>
            item.path === f.path ||
            f.path.endsWith(item.path) ||
            item.path.endsWith(f.path),
        );
        const fallbackPath = matchedFile?.path || item.path;
        const validated = validateClassification(item, fallbackPath);
        if (validated) classifiedMap.set(validated.path, validated);
      }

      // Any batch file not returned by LLM → heuristic fallback
      for (const f of batch) {
        if (!classifiedMap.has(f.path)) {
          classifiedMap.set(f.path, heuristicClassify(f));
        }
      }
    } catch (err) {
      batchErrors.push({ batch: batchNum, error: err.message });
      // Heuristic fallback for entire batch
      batch.forEach((f) => {
        classifiedMap.set(f.path, heuristicClassify(f));
      });
    }
  }

  // ── 3. Strip internal markers and finalise ────────────────────
  const classified = Array.from(classifiedMap.values()).map((c) => {
    const { _heuristic, ...clean } = c;
    return clean;
  });

  const heuristicCount = Array.from(classifiedMap.values()).filter(
    (c) => c._heuristic,
  ).length;

  // ── 4. Derive outputs ─────────────────────────────────────────
  const techStack = detectTechStack(files);
  const testFrameworks = detectTestFrameworks(files);
  const structure = groupByRole(classified);
  const layerMap = groupByLayer(classified);
  const flagsSummary = buildFlagsSummary(classified);
  const entryPoints = classified
    .filter((f) => f.role === "entry")
    .map((f) => f.path);
  const keyFiles = identifyKeyFiles(classified);
  const architectureHint = inferArchitecturePattern(classified, techStack);

  // ── 5. Importance-sorted projectMap for downstream agents ─────
  const importanceOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  classified.sort(
    (a, b) =>
      (importanceOrder[a.importance] ?? 3) -
      (importanceOrder[b.importance] ?? 3),
  );

  // ── 6. Summary ────────────────────────────────────────────────
  const dist = {};
  const layerDist = {};
  for (const f of classified) {
    dist[f.role] = (dist[f.role] ?? 0) + 1;
    layerDist[f.layer] = (layerDist[f.layer] ?? 0) + 1;
  }

  const summary = {
    total: relevant.length,
    classified: classified.length - heuristicCount,
    heuristic: heuristicCount,
    failed: batchErrors.length,
    byRole: dist,
    byLayer: layerDist,
    flagsSummary,
    techStack,
    testFrameworks,
    entryPoints,
    keyFiles,
    architectureHint,
  };

  if (batchErrors.length > 0) {
    notify(
      `⚠ ${batchErrors.length} batch(es) used heuristic fallback`,
      batchErrors.map((e) => e.error).join("; "),
    );
  }

  const distStr = buildDistributionString(classified);
  notify(`${classified.length} files classified`, distStr);
  notify(`Stack: ${techStack.join(", ") || "unknown"}`, architectureHint);

  if (entryPoints.length) {
    notify(`Entry points: ${entryPoints.length}`, entryPoints.join(", "));
  }
  if (flagsSummary.has_auth) {
    notify(`Auth detected in ${flagsSummary.has_auth} file(s)`, "");
  }

  return {
    projectMap: classified,
    techStack,
    testFrameworks,
    entryPoints,
    keyFiles,
    structure,
    layerMap,
    flagsSummary,
    architectureHint,
    summary,
    errors: batchErrors.length > 0 ? batchErrors : undefined,
  };
}
