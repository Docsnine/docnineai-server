// ===================================================================
// Agent 5: Doc Writer (Improved)
// ===================================================================

import { llmCall } from "../config/llm.js";

// ─── System Prompts ───────────────────────────────────────────────

const README_SYSTEM_PROMPT = `You are a senior technical writer who specializes in open-source and professional software documentation.

## YOUR TASK
Write a complete, production-ready README.md in Markdown for the project described in the provided JSON context.

## REQUIRED SECTIONS (in this order)
1. **Header** — Project name as H1, one-line tagline, and a badge row (build status, license, language, version — use shields.io format)
2. **Overview** — 2–3 sentences on what the project is, what problem it solves, and who it's for
3. **Features** — Bulleted list of 5–8 key capabilities, specific and concrete (not "easy to use")
4. **Tech Stack** — Table with columns: Category | Technology | Purpose
5. **Prerequisites** — Runtime versions, required tools (Node >=18, Docker, etc.)
6. **Installation** — Numbered steps with actual shell commands in fenced code blocks
7. **Environment Variables** — Table: Variable | Required | Default | Description
8. **Running the Project** — Dev, test, and production start commands
9. **API Summary** — Table: Method | Endpoint | Auth | Description (top 10 endpoints max)
10. **Data Models** — Brief table per model: Field | Type | Required — keep to 3–4 most important models
11. **Project Structure** — Annotated directory tree using a fenced code block
12. **Contributing** — Fork → branch → PR flow in 4–5 numbered steps
13. **License** — One line

## WRITING RULES
- Use real, specific language based on the provided context — no placeholder text like "your project name" or "add description here"
- Every code block must have a language tag: \`\`\`bash, \`\`\`typescript, \`\`\`env etc.
- Shell commands must be copy-pasteable and realistic for the detected stack
- Badges must use the actual repo owner/name from context
- Do NOT pad with filler sentences — every sentence must add information
- Do NOT add sections not listed above
- Target 700–900 words — dense and complete, not minimal
- Write in present tense, active voice`;

const INTERNAL_SYSTEM_PROMPT = `You are a principal software architect writing internal developer onboarding documentation for a technical audience (senior engineers joining the team).

## YOUR TASK
Write a concise internal developer guide in Markdown based on the provided project context. Assume the reader can read code but needs architectural context and tribal knowledge they can't get from reading files alone.

## REQUIRED SECTIONS (in this order)
1. **Architecture Overview** — 1 diagram in Mermaid (flowchart LR or TD) showing the major layers/services and how they connect, followed by 2–3 sentences of explanation
2. **Technology Decisions** — Table: Decision | Choice | Rationale | Alternatives Considered — explain WHY this stack, not just what it is
3. **Component Responsibilities** — One subsection per major component type (services, middleware, utilities). For each: what it owns, what it must NOT do, and who calls it
4. **Data Flow** — Step-by-step numbered list of the primary request/response lifecycle from entry point to database and back. Be specific about which components handle each step.
5. **Key Relationships & Dependencies** — Table showing the most important inter-component dependencies and why they exist
6. **Entry Points** — List each entry point, what it initializes, and in what order
7. **Environment & Configuration** — How config is loaded, where secrets live, what breaks if a variable is missing
8. **Gotchas & Non-Obvious Behaviour** — Bulleted list of at least 4 things that will surprise a new developer: quirks, implicit conventions, performance traps, things that look wrong but aren't
9. **Development Workflow** — How to run locally, run tests, and simulate production — specific commands
10. **Where to Start** — If a new developer needs to add a feature, trace the exact files they need to touch in order

## WRITING RULES
- Be direct — write for someone who will be reading this at 11pm trying to debug production
- Mermaid diagram must use actual component names from the provided context, not generic placeholders
- "Gotchas" must be specific to this codebase — not generic advice
- Target 600–800 words
- No filler, no preamble, no "this document covers..."`;

const COMPONENT_REF_SYSTEM_PROMPT = `You are a senior technical writer creating a component reference guide.

## YOUR TASK
Write a structured Markdown component reference document based on the provided component data.

## FORMAT PER COMPONENT
### ComponentName
- **Type:** service | middleware | hook | utility etc.
- **File:** relative/path/to/file.ts
- **Layer:** backend | frontend | shared
**Description:** What it does in 1–2 sentences.
**Responsibilities:**
- Active verb bullet points
**Dependencies:** internal and external — comma separated
**Side Effects:** list or "None"
**Notes:** gotchas, TODOs, security concerns or "None"
---

## RULES
- Group components by type (Services first, then Middleware, Hooks, Utilities, Config, Other)
- Within each group, sort alphabetically by name
- Use a H2 heading per group, H3 per component
- Keep each component entry tight — no padding
- If deprecated, add a ⚠️ DEPRECATED badge after the name`;

// ─── Context Builders ─────────────────────────────────────────────

function buildReadmeContext({
  meta,
  techStack,
  endpoints,
  models,
  components,
  structure,
  owner,
  repo,
}) {
  // Build a richer endpoint summary using the new schema from Agent 2
  const endpointSummary = endpoints.slice(0, 15).map((e) => ({
    method: e.method,
    path: e.path,
    auth: e.auth?.required ?? e.auth ?? false,
    description: e.description || "",
    tags: e.tags || [],
  }));

  // Build richer model summary
  const modelSummary = models.slice(0, 15).map((m) => ({
    name: m.name,
    description: m.description || "",
    fields: (m.fields || []).slice(0, 6).map((f) => ({
      name: f.name,
      type: f.type,
      required: f.required,
    })),
  }));

  // Summarise structure as folder → count map
  const structureSummary = Object.fromEntries(
    Object.entries(structure || {}).map(([role, files]) => [
      role,
      files.length,
    ]),
  );

  // Infer key features from components and endpoints
  const inferredFeatures = [
    ...new Set([
      ...(components || [])
        .filter((c) => c.type === "service")
        .map((c) => c.name),
      ...(endpoints || []).flatMap((e) => e.tags || []),
    ]),
  ].slice(0, 10);

  return JSON.stringify(
    {
      repo: `${owner}/${repo}`,
      name: meta?.name || repo,
      description: meta?.description || "",
      language: meta?.language || "unknown",
      stars: meta?.stars || 0,
      license: meta?.license || "MIT",
      topics: meta?.topics || [],
      techStack: techStack || [],
      endpoints: endpointSummary,
      endpointCount: endpoints.length,
      models: modelSummary,
      structure: structureSummary,
      inferredFeatures,
    },
    null,
    2,
  );
}

function buildInternalContext({
  structure,
  components,
  relationships,
  entryPoints,
  techStack,
  endpoints,
}) {
  // Group components by type for richer context
  const componentsByType = {};
  for (const c of components || []) {
    if (!componentsByType[c.type]) componentsByType[c.type] = [];
    componentsByType[c.type].push({
      name: c.name,
      file: c.file,
      description: c.description || "",
      responsibilities: (c.responsibilities || []).slice(0, 3),
      dependencies: {
        internal: (c.dependencies?.internal || []).slice(0, 4),
        external: (c.dependencies?.external || []).slice(0, 4),
      },
      singleton: c.singleton ?? null,
      complexity: c.complexity || "unknown",
      side_effects: (c.side_effects || []).slice(0, 3),
    });
  }

  // Top relationships (highest value — most connected nodes first)
  const relSummary = (relationships || []).slice(0, 30).map((r) => ({
    from: r.from,
    type: r.type,
    to: r.to,
    through: r.through || null,
  }));

  // Structure as folder → file count
  const structureSummary = Object.fromEntries(
    Object.entries(structure || {}).map(([role, files]) => [
      role,
      files.length,
    ]),
  );

  // Auth-required endpoints give architectural hints
  const authEndpoints = (endpoints || [])
    .filter((e) => e.auth?.required || e.auth)
    .slice(0, 5)
    .map((e) => `${e.method} ${e.path}`);

  return JSON.stringify(
    {
      techStack: techStack || [],
      entryPoints: (entryPoints || []).slice(0, 8),
      structure: structureSummary,
      componentsByType,
      relationships: relSummary,
      authEndpoints,
      totalComponents: (components || []).length,
      totalEndpoints: (endpoints || []).length,
    },
    null,
    2,
  );
}

function buildComponentRefContext(components) {
  // Pass full component data — the LLM needs all fields for a proper reference
  const grouped = {};
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

  for (const c of components || []) {
    const type = c.type || "other";
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push({
      name: c.name,
      file: c.file,
      layer: c.layer,
      description: c.description || "",
      responsibilities: c.responsibilities || [],
      exports: c.exports || { default: null, named: [] },
      dependencies: c.dependencies || { internal: [], external: [] },
      side_effects: c.side_effects || [],
      error_handling: c.error_handling || "none",
      async: c.async ?? false,
      singleton: c.singleton ?? null,
      deprecated: c.deprecated ?? false,
      complexity: c.complexity || "unknown",
      notes: c.notes || "",
    });
  }

  // Sort each group alphabetically
  for (const type of Object.keys(grouped)) {
    grouped[type].sort((a, b) => a.name.localeCompare(b.name));
  }

  return JSON.stringify({ grouped, typeOrder }, null, 2);
}

// ─── Static Builders ──────────────────────────────────────────────

/**
 * Build a rich API reference from the improved Agent 2 schema.
 * Fully static — no LLM cost.
 */
function buildApiReference(endpoints) {
  if (!endpoints?.length)
    return "# API Reference\n\nNo API endpoints detected.\n";

  let md = "# API Reference\n\n";

  // Summary stats
  const authCount = endpoints.filter((e) => e.auth?.required || e.auth).length;
  const methodCount = endpoints.reduce((acc, e) => {
    acc[e.method] = (acc[e.method] ?? 0) + 1;
    return acc;
  }, {});
  const deprecatedCount = endpoints.filter((e) => e.deprecated).length;

  md += `> **${endpoints.length} endpoints** · `;
  md += `**${authCount} require auth** · `;
  md += Object.entries(methodCount)
    .map(([m, n]) => `${n} ${m}`)
    .join(" · ");
  if (deprecatedCount) md += ` · ⚠️ ${deprecatedCount} deprecated`;
  md += "\n\n";

  // Group by tag then by path prefix as fallback
  const grouped = {};
  for (const ep of endpoints) {
    const tag =
      ep.tags?.[0] ||
      ep.path?.split("/")?.[2] ||
      ep.path?.split("/")?.[1] ||
      "root";
    if (!grouped[tag]) grouped[tag] = [];
    grouped[tag].push(ep);
  }

  for (const [group, eps] of Object.entries(grouped).sort()) {
    md += `## ${group.charAt(0).toUpperCase() + group.slice(1)}\n\n`;

    for (const ep of eps) {
      const deprecated = ep.deprecated ? " ⚠️ *Deprecated*" : "";
      md += `### \`${ep.method} ${ep.path}\`${deprecated}\n\n`;

      if (ep.description) md += `${ep.description}\n\n`;

      if (ep.handler && ep.handler !== "unknown") {
        md += `**Handler:** \`${ep.handler}\``;
        if (ep.file) md += ` — \`${ep.file}\``;
        if (ep.line) md += ` (line ${ep.line})`;
        md += "\n\n";
      }

      // Auth block
      const authRequired = ep.auth?.required ?? ep.auth ?? false;
      const authType = ep.auth?.type || (authRequired ? "required" : "none");
      const authRoles = ep.auth?.roles || [];
      md += `**Authentication:** ${authRequired ? `✅ Required — \`${authType}\`` : "❌ Public"}`;
      if (authRoles.length)
        md += ` · Roles: ${authRoles.map((r) => `\`${r}\``).join(", ")}`;
      md += "\n\n";

      // Middleware
      if (ep.middleware?.length) {
        md += `**Middleware:** ${ep.middleware.map((m) => `\`${m}\``).join(", ")}\n\n`;
      }

      // Rate limit
      if (ep.rate_limit) {
        md += `**Rate Limit:** \`${ep.rate_limit}\`\n\n`;
      }

      // Request headers
      if (ep.request?.headers?.length) {
        md += `**Headers:**\n\n| Name | Type | Required | Description |\n|------|------|----------|-------------|\n`;
        ep.request.headers.forEach((h) => {
          md += `| \`${h.name}\` | \`${h.type || "string"}\` | ${h.required ? "✅" : "❌"} | ${h.description || "—"} |\n`;
        });
        md += "\n";
      }

      // Request parameters
      if (ep.request?.params?.length) {
        md += `**Parameters:**\n\n| Name | In | Type | Required | Description | Validation |\n|------|-----|------|----------|-------------|------------|\n`;
        ep.request.params.forEach((p) => {
          md += `| \`${p.name}\` | ${p.in} | \`${p.type || "string"}\` | ${p.required ? "✅" : "❌"} | ${p.description || "—"} | ${p.validation || "—"} |\n`;
        });
        md += "\n";
      }

      // Body schema
      if (ep.request?.body_schema) {
        md += `**Request Body:** \`${ep.request.body_schema}\`\n\n`;
      }

      // Responses
      const success = ep.response?.success;
      if (success) {
        md += `**Response \`${success.status}\`:** ${success.description || "Success"}`;
        if (success.schema) md += ` · Schema: \`${success.schema}\``;
        md += "\n\n";
      }

      if (ep.response?.errors?.length) {
        md += `**Error Responses:**\n\n| Status | Description |\n|--------|-------------|\n`;
        ep.response.errors.forEach((e) => {
          md += `| \`${e.status}\` | ${e.description} |\n`;
        });
        md += "\n";
      }

      if (ep.notes) md += `> ⚠️ ${ep.notes}\n\n`;

      md += "---\n\n";
    }
  }

  return md;
}

/**
 * Build schema documentation from model and relationship data.
 * Fully static — no LLM cost.
 */
function buildSchemaDocs(models, relationships) {
  if (!models?.length) return "# Data Models\n\nNo data models detected.\n";

  let md = "# Data Models\n\n";

  // Summary
  md += `> **${models.length} models detected**`;
  if (relationships?.length)
    md += ` · **${relationships.length} relationships**`;
  md += "\n\n";

  // Table of contents
  md += "## Models\n\n";
  md += models.map((m) => `- [${m.name}](#${m.name.toLowerCase()})`).join("\n");
  md += "\n\n";

  for (const model of models) {
    md += `## ${model.name}\n\n`;
    if (model.description) md += `${model.description}\n\n`;

    // Source file / table name hints
    if (model.file) md += `**File:** \`${model.file}\`\n\n`;
    if (model.table) md += `**Table:** \`${model.table}\`\n\n`;

    // Fields
    if (model.fields?.length) {
      md += `### Fields\n\n| Field | Type | Required | Unique | Default | Description |\n`;
      md += `|-------|------|----------|--------|---------|-------------|\n`;
      model.fields.forEach((f) => {
        md += `| \`${f.name}\` | \`${f.type}\` | ${f.required ? "✅" : "❌"} | ${f.unique ? "✅" : "❌"} | ${f.default ?? "—"} | ${f.description || "—"} |\n`;
      });
      md += "\n";
    }

    // Indexes
    if (model.indexes?.length) {
      md += `### Indexes\n\n| Name | Fields | Unique |\n|------|--------|--------|\n`;
      model.indexes.forEach((idx) => {
        const fields = Array.isArray(idx.fields)
          ? idx.fields.join(", ")
          : idx.fields;
        md += `| \`${idx.name || "—"}\` | \`${fields}\` | ${idx.unique ? "✅" : "❌"} |\n`;
      });
      md += "\n";
    }

    // Inline relationships for this model
    const modelRels = (relationships || []).filter(
      (r) => r.from === model.name || r.to === model.name,
    );
    if (modelRels.length) {
      md += `### Relationships\n\n| Direction | Model | Type | Via |\n|-----------|-------|------|-----|\n`;
      modelRels.forEach((r) => {
        const direction = r.from === model.name ? "→ out" : "← in";
        const other = r.from === model.name ? r.to : r.from;
        md += `| ${direction} | ${other} | \`${r.type}\` | ${r.through || "—"} |\n`;
      });
      md += "\n";
    }

    md += "---\n\n";
  }

  // Global relationship overview
  if (relationships?.length) {
    md += `## Relationship Overview\n\n`;
    md += `| From | Type | To | Via |\n|------|------|----|-----|\n`;
    relationships.forEach((r) => {
      md += `| ${r.from} | \`${r.type}\` | ${r.to} | ${r.through || "—"} |\n`;
    });
    md += "\n";
  }

  return md;
}

/**
 * Build a component reference index statically.
 * Used as a fallback or supplement to the LLM-written version.
 */
function buildComponentIndex(components) {
  if (!components?.length)
    return "# Component Index\n\nNo components documented.\n";

  let md = "# Component Index\n\n";
  md += `> **${components.length} components** across ${[...new Set(components.map((c) => c.layer))].join(", ")} layers\n\n`;

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

  const grouped = {};
  for (const c of components) {
    const type = c.type || "other";
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(c);
  }

  for (const type of typeOrder) {
    const group = grouped[type];
    if (!group?.length) continue;

    const label = type.charAt(0).toUpperCase() + type.slice(1) + "s";
    md += `## ${label}\n\n`;
    md += `| Name | File | Layer | Async | Complexity | Description |\n`;
    md += `|------|------|-------|-------|------------|-------------|\n`;

    group
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((c) => {
        const deprecated = c.deprecated ? " ⚠️" : "";
        const async_ = c.async ? "✅" : "❌";
        const complexity =
          { low: "🟢 Low", medium: "🟡 Medium", high: "🔴 High" }[
            c.complexity
          ] || "—";
        md += `| \`${c.name}\`${deprecated} | \`${c.file}\` | ${c.layer || "—"} | ${async_} | ${complexity} | ${c.description ? c.description.slice(0, 80) + (c.description.length > 80 ? "…" : "") : "—"} |\n`;
      });
    md += "\n";
  }

  return md;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Validate that LLM output looks like Markdown and not JSON or an error.
 */
function validateMarkdown(raw, docName) {
  if (!raw || typeof raw !== "string") {
    throw new Error(`${docName}: LLM returned empty or non-string output`);
  }
  if (raw.trim().startsWith("{") || raw.trim().startsWith("[")) {
    throw new Error(`${docName}: LLM returned JSON instead of Markdown`);
  }
  if (raw.trim().length < 100) {
    throw new Error(
      `${docName}: Output suspiciously short (${raw.trim().length} chars)`,
    );
  }
  return raw.trim();
}

/**
 * LLM call with retry and back-off.
 */
async function llmCallWithRetry({
  systemPrompt,
  userContent,
  temperature = 0.15,
  retries = 2,
}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await llmCall({ systemPrompt, userContent, temperature });
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
}

// ─── Agent ────────────────────────────────────────────────────────

export async function docWriterAgent({
  meta,
  techStack,
  structure,
  endpoints,
  models,
  relationships,
  components,
  entryPoints,
  owner,
  repo,
  emit,
}) {
  const notify = (msg, detail) => emit?.(msg, detail);
  const errors = [];
  const docs = {};

  // ── 1. README.md ──────────────────────────────────────────────
  const readmeCtx = buildReadmeContext({
    meta,
    techStack,
    endpoints,
    models,
    components,
    structure,
    owner,
    repo,
  });

  notify(
    "Writing README.md…",
    `~${Math.ceil(readmeCtx.length / 4)} input tokens`,
  );

  try {
    const raw = await llmCallWithRetry({
      systemPrompt: README_SYSTEM_PROMPT,
      userContent: `Generate a complete README.md for this project:\n\n${readmeCtx}`,
      temperature: 0.2,
    });
    docs.readme = validateMarkdown(raw, "README.md");
  } catch (err) {
    errors.push({ doc: "readme", error: err.message });
    // Minimal fallback README
    docs.readme = buildFallbackReadme({
      meta,
      owner,
      repo,
      techStack,
      endpoints,
    });
    notify("⚠ README.md generation failed — using fallback", err.message);
  }

  // ── 2. Internal Developer Docs ────────────────────────────────
  const internalCtx = buildInternalContext({
    structure,
    components,
    relationships,
    entryPoints,
    techStack,
    endpoints,
  });

  notify(
    "Writing internal developer docs…",
    `~${Math.ceil(internalCtx.length / 4)} input tokens`,
  );

  try {
    const raw = await llmCallWithRetry({
      systemPrompt: INTERNAL_SYSTEM_PROMPT,
      userContent: `Generate internal developer documentation:\n\n${internalCtx}`,
      temperature: 0.1,
    });
    docs.internalDocs = validateMarkdown(raw, "Internal Docs");
  } catch (err) {
    errors.push({ doc: "internalDocs", error: err.message });
    docs.internalDocs =
      "# Internal Developer Docs\n\n> ⚠️ Generation failed — please write this manually.\n";
    notify("⚠ Internal docs generation failed", err.message);
  }

  // ── 3. Component Reference (LLM-written, rich) ────────────────
  if (components?.length > 0) {
    const chunkSize = 30; // components per LLM call to avoid context overflow
    const chunks = [];
    for (let i = 0; i < components.length; i += chunkSize) {
      chunks.push(components.slice(i, i + chunkSize));
    }

    notify(
      "Writing component reference…",
      `${components.length} components · ${chunks.length} chunk${chunks.length > 1 ? "s" : ""}`,
    );

    const compChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      try {
        const ctx = buildComponentRefContext(chunks[i]);
        const raw = await llmCallWithRetry({
          systemPrompt: COMPONENT_REF_SYSTEM_PROMPT,
          userContent: `Document these components:\n\n${ctx}`,
          temperature: 0.1,
        });
        compChunks.push(validateMarkdown(raw, `Component Ref chunk ${i + 1}`));
      } catch (err) {
        errors.push({ doc: `componentRef_chunk_${i}`, error: err.message });
        // Fall back to static index for this chunk
        compChunks.push(buildComponentIndex(chunks[i]));
        notify(
          `⚠ Component ref chunk ${i + 1} failed — using static fallback`,
          err.message,
        );
      }
    }

    docs.componentRef =
      chunks.length > 1
        ? `# Component Reference\n\n${compChunks.join("\n\n")}`
        : compChunks[0];
  } else {
    docs.componentRef = "# Component Reference\n\nNo components documented.\n";
  }

  // ── 4. API Reference (static — no LLM cost) ───────────────────
  notify(
    "Building API reference…",
    `${endpoints?.length || 0} endpoints · static build`,
  );
  docs.apiReference = buildApiReference(endpoints || []);

  // ── 5. Schema Docs (static — no LLM cost) ─────────────────────
  notify(
    "Building schema documentation…",
    `${models?.length || 0} models · static build`,
  );
  docs.schemaDocs = buildSchemaDocs(models || [], relationships || []);

  // ── 6. Component Index (static — supplements LLM ref) ─────────
  notify("Building component index…", "static build");
  docs.componentIndex = buildComponentIndex(components || []);

  // ── 7. Summary ────────────────────────────────────────────────
  const summary = {
    readme: docs.readme.split("\n").length,
    internalDocs: docs.internalDocs.split("\n").length,
    componentRef: docs.componentRef.split("\n").length,
    apiReference: docs.apiReference.split("\n").length,
    schemaDocs: docs.schemaDocs.split("\n").length,
    componentIndex: docs.componentIndex.split("\n").length,
    totalLines: Object.values(docs).reduce(
      (acc, d) => acc + d.split("\n").length,
      0,
    ),
    errors: errors.length,
  };

  notify(
    "All documents ready",
    [
      `${summary.totalLines} total lines`,
      `${endpoints?.length || 0} endpoints documented`,
      `${models?.length || 0} models documented`,
      `${components?.length || 0} components documented`,
      errors.length ? `⚠ ${errors.length} error(s)` : "✅ no errors",
    ].join(" · "),
  );

  return {
    ...docs,
    summary,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// ─── Fallback README Builder ──────────────────────────────────────

/**
 * Minimal static README used when LLM generation fails entirely.
 * Better than returning nothing.
 */
function buildFallbackReadme({ meta, owner, repo, techStack, endpoints }) {
  const name = meta?.name || repo || "Project";
  const desc = meta?.description || "No description available.";
  const lang = meta?.language || "unknown";
  const stack = (techStack || []).slice(0, 5).join(", ") || "unknown";
  const epList = (endpoints || [])
    .slice(0, 5)
    .map((e) => `- \`${e.method} ${e.path}\``)
    .join("\n");

  return `# ${name}

${desc}

![Language](https://img.shields.io/badge/language-${encodeURIComponent(lang)}-blue)

## Tech Stack
${stack}

## Quick Start
\`\`\`bash
# Install dependencies
npm install

# Start development server
npm run dev
\`\`\`

## API Endpoints (partial)
${epList || "No endpoints detected."}

> ⚠️ This README was auto-generated as a fallback. Please expand it with real content.
`;
}
