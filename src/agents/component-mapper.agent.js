// ===================================================================
// Agent 4: Component Mapper (Improved)
// ===================================================================

import { llmCall } from "../config/llm.js";

// ─── System Prompt ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior software engineer and technical documentation specialist with deep expertise in reading and analyzing codebases across multiple languages and frameworks (Node.js, TypeScript, React, Vue, Python, Java, Go, PHP, Ruby, etc.).

## YOUR TASK
Analyze the provided source files and generate precise, structured documentation for every identifiable component, service, utility, hook, middleware, provider, store, config, or helper found. Create one object per export — not one per file.

## OUTPUT FORMAT
Return ONLY a valid JSON array.
No markdown. No code fences. No explanation. No preamble. No trailing text.
Your entire response must start with [ and end with ].
If no components are found, return exactly: []

## SCHEMA (every object must follow this exactly)
[
  {
    "name": string,                   // Exact exported name e.g. "useAuthStore", "EmailService", "formatDate"
    "file": string,                   // Relative file path e.g. "services/email.service.ts"
    "line": number | null,            // Line number where this is defined — null if not determinable
    "type": string,                   // One of: service | middleware | utility | config | helper | hook | component | provider | store | context | guard | interceptor | decorator | constant | type | other
    "layer": string,                  // One of: frontend | backend | shared | infrastructure | database
    "description": string,            // 1–2 sentences: what it does and why it exists — be specific, avoid "handles logic"
    "responsibilities": string[],     // 2–5 bullet points using active verbs: "Validates...", "Transforms...", "Emits..."
    "exports": {
      "default": string | null,       // Default export name — null if none
      "named": string[]               // All named exports from this file
    },
    "parameters": [                   // Top-level function or constructor parameters
      {
        "name": string,
        "type": string,               // TypeScript/inferred type e.g. "string", "UserDto", "Request"
        "required": boolean,
        "default": string,            // Default value if any — "" if none
        "description": string
      }
    ],
    "returns": {
      "type": string,                 // Return type e.g. "Promise<User>", "boolean", "void"
      "description": string           // What the return value represents
    },
    "dependencies": {
      "internal": string[],           // Relative imports exactly as written e.g. ["../models/User", "./config"]
      "external": string[]            // npm/pip/composer packages e.g. ["bcrypt", "axios", "lodash"]
    },
    "state": {
      "manages": boolean,             // true if this component manages any state
      "type": string,                 // "local" | "global" | "server" | "none"
      "description": string           // What state is managed — "" if none
    },
    "side_effects": string[],         // Explicit side effects: "Writes to users table", "Sends email via SMTP", "Publishes Redis event" — [] if none
    "error_handling": string,         // How errors are handled: "Throws HttpException(401)", "Returns null on miss", "Catches and rethrows" — "none" if absent
    "async": boolean,                 // true if this is async/returns a Promise
    "singleton": boolean | null,      // true if instantiated once (e.g. NestJS @Injectable()), null if unknown
    "testable": boolean,              // true if it has no hard dependencies making unit testing difficult
    "deprecated": boolean,            // true if marked @deprecated or has a deprecation comment
    "complexity": string,             // "low" | "medium" | "high" — based on logic branching and dependencies
    "tags": string[],                 // Inferred grouping tags e.g. ["auth", "email", "validation"]
    "notes": string                   // TODOs, security concerns, known issues, important caveats — "" if none
  }
]

## ANALYSIS RULES
1. Create ONE object per export — if a file has 4 named exports, return 4 objects.
2. Be specific in "description" — "Hashes passwords using bcrypt with configurable salt rounds" is good. "Handles password logic" is not acceptable.
3. For "responsibilities", use active verbs exclusively: "Validates...", "Normalizes...", "Caches...", "Emits...", "Queries...".
4. For "dependencies.internal", copy the import path exactly as written in the source file.
5. For "side_effects", be explicit about WHAT is written/read/emitted and WHERE.
6. For "complexity": low = pure function or simple transform; medium = branching logic or 2–4 dependencies; high = orchestrates multiple services or has complex state.
7. For "singleton": set true if @Injectable(), @Service(), exported as instance (export default new Foo()), or uses module-level state.
8. For "testable": set false if the component directly instantiates external dependencies (new Database()), uses global state, or has no dependency injection.
9. If a value cannot be determined with confidence, use null for booleans/numbers and "unknown" for strings — never fabricate.
10. If a file only re-exports from other files (barrel file), create one object with type "other", note it as a barrel export in "notes", and list what it re-exports in "exports.named".

## FRAMEWORK-SPECIFIC HINTS
- NestJS: @Injectable() = singleton service; @Middleware() = middleware class; @Guard() = guard
- React/Vue hooks: functions starting with "use" = hook type
- Zustand/Pinia/Redux: store files = store type with state.manages = true
- React Context: createContext/Provider pattern = context type
- Express: function(req, res, next) signature = middleware type
- Config files: exports of plain objects or dotenv wrappers = config type

## STRICT OUTPUT RULES
- No markdown of any kind
- No \`\`\`json fences
- No introductory or closing sentences
- No comments inside JSON
- Must be parseable by JSON.parse() with zero preprocessing
- Start with [ end with ]

## EXAMPLE OUTPUT (single component, abbreviated)
[
  {
    "name": "hashPassword",
    "file": "utils/crypto.util.ts",
    "line": 12,
    "type": "utility",
    "layer": "backend",
    "description": "Hashes a plain-text password using bcrypt with a configurable number of salt rounds. Returns the hashed string for secure storage.",
    "responsibilities": [
      "Accepts plain-text password and optional salt rounds",
      "Generates bcrypt salt using provided rounds (default: 12)",
      "Returns bcrypt hash of the input password",
      "Throws TypeError if input is not a non-empty string"
    ],
    "exports": {
      "default": null,
      "named": ["hashPassword", "comparePassword"]
    },
    "parameters": [
      { "name": "password", "type": "string", "required": true, "default": "", "description": "Plain-text password to hash" },
      { "name": "rounds", "type": "number", "required": false, "default": "12", "description": "bcrypt salt rounds — higher is slower but more secure" }
    ],
    "returns": {
      "type": "Promise<string>",
      "description": "The bcrypt-hashed password string"
    },
    "dependencies": {
      "internal": ["../config/app.config"],
      "external": ["bcrypt"]
    },
    "state": { "manages": false, "type": "none", "description": "" },
    "side_effects": [],
    "error_handling": "Throws TypeError if password is empty or not a string",
    "async": true,
    "singleton": false,
    "testable": true,
    "deprecated": false,
    "complexity": "low",
    "tags": ["auth", "security", "crypto"],
    "notes": "TODO: Add pepper support for additional security layer."
  }
]`;

// ─── Constants ────────────────────────────────────────────────────

const TARGET_ROLES = new Set([
  "service",
  "middleware",
  "utility",
  "config",
  "helper",
  "frontend",
  "hook",
  "provider",
  "store",
  "context",
  "guard",
  "interceptor",
  "decorator",
]);

const PATH_REGEX =
  /middleware|service|util|helper|hook|config|context|provider|store|component|\.config\.|guard|interceptor|decorator/i;

const EXCLUDE_REGEX =
  /route|controller|handler|model|schema|entity|migration|spec|test|\.d\.ts$|__mocks__|fixture/i;

const FILES_PER_BATCH = 3;
const CHARS_PER_FILE = 6000; // was 200 — completely insufficient for real files
const MAX_FILES = 40;
const MAX_RETRIES = 2;

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
 * Validate and normalise a single component object.
 * Returns null if too malformed to be useful.
 */
function validateComponent(comp, fallbackFile) {
  if (!comp || typeof comp !== "object") return null;

  const name = String(comp.name ?? "").trim();
  const file = String(comp.file ?? fallbackFile ?? "").trim();
  if (!name || !file) return null;

  const VALID_TYPES = [
    "service",
    "middleware",
    "utility",
    "config",
    "helper",
    "hook",
    "component",
    "provider",
    "store",
    "context",
    "guard",
    "interceptor",
    "decorator",
    "constant",
    "type",
    "other",
  ];
  const VALID_LAYERS = [
    "frontend",
    "backend",
    "shared",
    "infrastructure",
    "database",
  ];
  const VALID_COMPLEXITY = ["low", "medium", "high"];

  return {
    name,
    file,
    line: comp.line ?? null,
    type: VALID_TYPES.includes(comp.type) ? comp.type : "other",
    layer: VALID_LAYERS.includes(comp.layer) ? comp.layer : "unknown",
    description: comp.description || "",
    responsibilities: Array.isArray(comp.responsibilities)
      ? comp.responsibilities
      : [],
    exports: {
      default: comp.exports?.default ?? null,
      named: Array.isArray(comp.exports?.named) ? comp.exports.named : [],
    },
    parameters: Array.isArray(comp.parameters)
      ? comp.parameters.map(normalizeParam)
      : [],
    returns: {
      type: comp.returns?.type || "void",
      description: comp.returns?.description || "",
    },
    dependencies: {
      internal: Array.isArray(comp.dependencies?.internal)
        ? comp.dependencies.internal
        : [],
      external: Array.isArray(comp.dependencies?.external)
        ? comp.dependencies.external
        : [],
    },
    state: {
      manages: comp.state?.manages ?? false,
      type: comp.state?.type || "none",
      description: comp.state?.description || "",
    },
    side_effects: Array.isArray(comp.side_effects) ? comp.side_effects : [],
    error_handling: comp.error_handling || "none",
    async: comp.async ?? false,
    singleton: comp.singleton ?? null,
    testable: comp.testable ?? true,
    deprecated: comp.deprecated ?? false,
    complexity: VALID_COMPLEXITY.includes(comp.complexity)
      ? comp.complexity
      : "unknown",
    tags: Array.isArray(comp.tags) ? comp.tags : inferTags(name, file),
    notes: comp.notes || "",
  };
}

function normalizeParam(p) {
  if (!p || typeof p !== "object") return null;
  return {
    name: String(p.name ?? "unknown"),
    type: String(p.type ?? "unknown"),
    required: p.required ?? true,
    default: String(p.default ?? ""),
    description: String(p.description ?? ""),
  };
}

/**
 * Infer tags from component name and file path.
 */
function inferTags(name, file) {
  const tags = new Set();

  // From file path segments
  const segments = file.split("/").filter(Boolean);
  segments.forEach((seg) => {
    const clean = seg
      .replace(/\.[^.]+$/, "")
      .replace(/[-_.]/g, " ")
      .toLowerCase();
    if (clean && clean !== "src" && clean !== "index") tags.add(clean);
  });

  // From camelCase/PascalCase name breakdown
  const words = name
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  words.forEach((w) => tags.add(w));

  return Array.from(tags).slice(0, 4);
}

/**
 * Score completeness of a component for deduplication merge.
 */
function scoreCompleteness(comp) {
  let score = 0;
  if (comp.description) score += 2;
  if (comp.responsibilities.length > 0) score += 2;
  if (comp.parameters.length > 0) score += 2;
  if (comp.returns.type !== "void") score += 1;
  if (comp.dependencies.internal.length > 0) score += 1;
  if (comp.dependencies.external.length > 0) score += 1;
  if (comp.side_effects.length > 0) score += 1;
  if (comp.error_handling !== "none") score += 1;
  if (comp.complexity !== "unknown") score += 1;
  if (comp.line !== null) score += 1;
  if (comp.notes) score += 1;
  if (comp.state.manages) score += 1;
  if (comp.singleton !== null) score += 1;
  return score;
}

/**
 * Create a minimal stub component when LLM fails for a file.
 * Better than losing the file entirely from the output.
 */
function createFallbackComponent(file, projectMap) {
  const meta = projectMap?.find((m) => m.path === file.path);
  const name = file.path
    .split("/")
    .pop()
    .replace(/\.[^.]+$/, "")
    .replace(/[-_.](.)/g, (_, c) => c.toUpperCase()); // basic camelCase

  return {
    name,
    file: file.path,
    line: null,
    type: meta?.role || "utility",
    layer: "unknown",
    description: meta?.summary || "",
    responsibilities: [],
    exports: { default: null, named: [] },
    parameters: [],
    returns: { type: "unknown", description: "" },
    dependencies: { internal: [], external: [] },
    state: { manages: false, type: "none", description: "" },
    side_effects: [],
    error_handling: "none",
    async: false,
    singleton: null,
    testable: true,
    deprecated: false,
    complexity: "unknown",
    tags: inferTags(name, file.path),
    notes: "⚠ Auto-generated stub — LLM extraction failed for this file.",
  };
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
 * Build a summary report from all extracted components.
 */
function buildSummary(components) {
  const byType = {};
  const byLayer = {};
  const tagSet = new Set();

  for (const c of components) {
    byType[c.type] = (byType[c.type] ?? 0) + 1;
    byLayer[c.layer] = (byLayer[c.layer] ?? 0) + 1;
    c.tags.forEach((t) => tagSet.add(t));
  }

  return {
    total: components.length,
    deprecated: components.filter((c) => c.deprecated).length,
    async: components.filter((c) => c.async).length,
    withState: components.filter((c) => c.state.manages).length,
    untestable: components.filter((c) => !c.testable).length,
    highComplexity: components.filter((c) => c.complexity === "high").length,
    byType,
    byLayer,
    tags: Array.from(tagSet).sort(),
  };
}

// ─── Agent ────────────────────────────────────────────────────────

export async function componentMapperAgent({
  files,
  projectMap,
  structure,
  emit,
}) {
  const notify = (msg, detail) => emit?.(msg, detail);

  // ── 1. Filter to component-relevant files ─────────────────────
  const targetFiles = files
    .filter((f) => {
      if (!f?.path || !f?.content) return false;
      const meta = projectMap?.find((m) => m.path === f.path);
      return (
        (meta && TARGET_ROLES.has(meta.role)) ||
        (PATH_REGEX.test(f.path) && !EXCLUDE_REGEX.test(f.path))
      );
    })
    .slice(0, MAX_FILES);

  if (targetFiles.length === 0) {
    notify("No component files found", "Skipping component mapping");
    return { components: [], summary: buildSummary([]) };
  }

  const totalBatches = Math.ceil(targetFiles.length / FILES_PER_BATCH);
  notify(
    `Found ${targetFiles.length} component files`,
    `Processing in ${totalBatches} batch${totalBatches > 1 ? "es" : ""}`,
  );

  // ── 2. Process batches ────────────────────────────────────────
  const rawComponents = [];
  const batchErrors = [];

  for (let i = 0; i < targetFiles.length; i += FILES_PER_BATCH) {
    const batchNum = Math.floor(i / FILES_PER_BATCH) + 1;
    const batch = targetFiles.slice(i, i + FILES_PER_BATCH);

    notify(`Documenting components…`, `Batch ${batchNum} of ${totalBatches}`);

    const userContent = batch
      .map((f) => {
        const truncated = f.content.length > CHARS_PER_FILE;
        return [
          `=== FILE: ${f.path} ===`,
          truncated
            ? `[Truncated at ${CHARS_PER_FILE} chars — ${f.content.length} total]`
            : "",
          f.content.slice(0, CHARS_PER_FILE),
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
        // Fall back to stubs for this batch
        batch.forEach((f) =>
          rawComponents.push(createFallbackComponent(f, projectMap)),
        );
        continue;
      }

      for (const comp of parsed) {
        // Match reported file back to the correct batch file
        const matchedFile = batch.find((f) =>
          comp.file
            ? f.path.endsWith(comp.file) || comp.file.endsWith(f.path)
            : false,
        );
        const fallbackFile =
          batch.length === 1
            ? batch[0].path
            : matchedFile?.path || comp.file || batch[0].path;

        const validated = validateComponent(comp, fallbackFile);
        if (validated) rawComponents.push(validated);
      }
    } catch (err) {
      batchErrors.push({ batch: batchNum, error: err.message });
      // Produce stubs so no file is silently lost
      batch.forEach((f) =>
        rawComponents.push(createFallbackComponent(f, projectMap)),
      );
    }
  }

  // ── 3. Deduplicate — keep the richer of any two duplicates ────
  const componentMap = new Map();

  for (const comp of rawComponents) {
    const key = `${comp.file}::${comp.name}`;
    const existing = componentMap.get(key);

    if (!existing) {
      componentMap.set(key, comp);
    } else {
      const existingScore = scoreCompleteness(existing);
      const newScore = scoreCompleteness(comp);
      if (newScore > existingScore) componentMap.set(key, comp);
    }
  }

  // ── 4. Sort by layer, then type, then name ────────────────────
  const components = Array.from(componentMap.values()).sort((a, b) => {
    const layerOrder = [
      "backend",
      "frontend",
      "shared",
      "infrastructure",
      "database",
      "unknown",
    ];
    const typeOrder = [
      "service",
      "middleware",
      "guard",
      "hook",
      "store",
      "context",
      "provider",
      "component",
      "utility",
      "config",
      "helper",
      "decorator",
      "interceptor",
      "constant",
      "type",
      "other",
    ];
    const layerDiff = layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer);
    if (layerDiff !== 0) return layerDiff;
    const typeDiff = typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type);
    if (typeDiff !== 0) return typeDiff;
    return a.name.localeCompare(b.name);
  });

  // ── 5. Build summary ──────────────────────────────────────────
  const summary = buildSummary(components);

  if (batchErrors.length > 0) {
    notify(
      `⚠ ${batchErrors.length} batch(es) had errors`,
      batchErrors.map((e) => e.error).join("; "),
    );
  }

  notify(
    `${components.length} components documented`,
    [
      `${summary.highComplexity} high complexity`,
      `${summary.withState} stateful`,
      `${summary.deprecated} deprecated`,
      `${summary.untestable} hard to test`,
    ].join(" · "),
  );

  return {
    components,
    summary,
    errors: batchErrors.length > 0 ? batchErrors : undefined,
  };
}
