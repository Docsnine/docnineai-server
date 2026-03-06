// ===================================================================
// Incremental Sync Pipeline (Improved)
// ===================================================================
//
// Coordinates targeted re-documentation when a repo changes.
// Instead of re-running all 6 agents on the entire repo, this:
//
//   1. Fetches only files that changed since lastDocumentedCommit
//   2. Routes changed files to only the agents that care about them
//   3. Runs those agents in parallel where safe
//   4. Merges fresh outputs into stored agentOutputs intelligently
//   5. Regenerates only affected doc sections (static where possible)
//   6. Preserves user-edited sections — marks them stale instead
//   7. Stores version history per regenerated section
//   8. Updates lastDocumentedCommit + fileManifest in MongoDB
//
// Full re-run triggers:
//   • No prior agentOutputs / fileManifest stored
//   • Manifest file changed (package.json, go.mod, requirements.txt, etc.)
//   • Caller passes forceFullRun = true
//   • Changed files exceed FULL_RUN_THRESHOLD
//
// Progress event schema:
//   { step, status: "running"|"done"|"error"|"skipped"|"waiting",
//     msg, detail, ts, duration? }
// ===================================================================

import {
  getCommitSha,
  getFileTreeWithSha,
  fetchFileContents,
  computeFileDiff,
  getRepoMeta,
} from "./github.service.js";

import { repoScannerAgent } from "../agents/repo-scanner.agent.js";
import { apiExtractorAgent } from "../agents/api-extractor.agent.js";
import { schemaAnalyserAgent } from "../agents/schema-analyser.agent.js";
import { componentMapperAgent } from "../agents/component-mapper.agent.js";
import { securityAuditorAgent } from "../agents/security-auditor.agent.js";

import {
  analyseChanges,
  mergeAgentOutputs,
  updateFileManifest,
} from "./diff.service.js";

import { DocumentVersion } from "../models/DocumentVersion.js";

// ─── Configuration ────────────────────────────────────────────────

const TIMEOUTS = {
  fetch: 45_000, // GitHub file content fetch
  scan: 90_000, // Repo Scanner over changed files
  api: 60_000, // API Extractor
  schema: 60_000, // Schema Analyser
  components: 60_000, // Component Mapper
  security: 90_000, // Security Auditor (static + LLM)
  docs: 120_000, // Doc Writer (LLM sections)
};

// If more than this many files changed → skip incremental, do full run
// Large diffs make incremental merging unreliable
const FULL_RUN_THRESHOLD = 80;

// Sections that can be rebuilt statically (no LLM cost)
const STATIC_SECTIONS = new Set([
  "apiReference",
  "schemaDocs",
  "securityReport",
  "componentIndex",
]);

// Sections that require an LLM call to regenerate
const LLM_SECTIONS = new Set(["readme", "internalDocs", "componentRef"]);

// Severity weights — kept in sync with Security Auditor agent
const SEVERITY_WEIGHT = { CRITICAL: 25, HIGH: 15, MEDIUM: 7, LOW: 2 };
const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const SEVERITY_EMOJI = { CRITICAL: "🔴", HIGH: "🟠", MEDIUM: "🟡", LOW: "🔵" };

// ─── Lazy doc writer import ───────────────────────────────────────
// Imported lazily to avoid circular dependency issues and
// to avoid loading the module on every sync that doesn't need it.

let _docWriterAgent = null;
async function getDocWriter() {
  if (_docWriterAgent) return _docWriterAgent;
  const m = await import("../agents/doc-writer.agent.js");
  _docWriterAgent = m.docWriterAgent;
  return _docWriterAgent;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Wrap any async function with a hard timeout.
 */
async function withTimeout(fn, ms, label) {
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  try {
    const result = await Promise.race([fn(), timeout]);
    clearTimeout(handle);
    return { result };
  } catch (err) {
    clearTimeout(handle);
    return { error: err, timedOut: err.message.includes("timed out") };
  }
}

/**
 * Run a single agent with timeout, error isolation, and duration tracking.
 * Never throws — always returns a result or fallback.
 */
async function runAgent({ label, step, fn, timeout, fallback, emit }) {
  const start = Date.now();
  emit(step, "running", `Running ${label}…`);

  const { result, error, timedOut } = await withTimeout(fn, timeout, label);
  const duration = Date.now() - start;

  if (error) {
    const reason = timedOut
      ? `${label} timed out after ${timeout / 1000}s`
      : error.message;
    emit(step, "error", `${label} failed — using fallback`, reason);
    console.error(`[sync:${step}:error] ${label}:`, error);
    return { ...fallback, _failed: true, _error: reason, _duration: duration };
  }

  emit(step, "done", `${label} complete`, `${(duration / 1000).toFixed(1)}s`);
  return { ...result, _duration: duration };
}

/**
 * Parse owner and repo name from a GitHub URL.
 */
function parseOwnerRepo(project) {
  const match = project.repoUrl?.match(/github\.com\/([^/]+)\/([^/?.#]+)/);
  if (!match) throw new Error(`Cannot parse repoUrl: ${project.repoUrl}`);
  return { owner: match[1], repoName: match[2].replace(/\.git$/, "") };
}

/**
 * Categorise webhook file entries into added / modified / removed.
 */
function categoriseWebhookFiles(webhookFiles) {
  const added = [],
    modified = [],
    removed = [];
  for (const f of webhookFiles) {
    const entry = { path: f.path || f, status: f.status || "modified" };
    if (entry.status === "added") added.push(entry);
    else if (entry.status === "removed") removed.push(entry);
    else modified.push(entry);
  }
  return { added, modified, removed };
}

/**
 * Filter the fetched changed files to only those assigned to a specific agent.
 */
function filterFilesForAgent(changedFiles, agentFileList) {
  const pathSet = new Set(agentFileList.map((f) => f.path));
  return changedFiles.filter((f) => pathSet.has(f.path));
}

/**
 * Build a structure map (role → [paths]) from a projectMap array.
 */
function buildStructure(projectMap) {
  const structure = {};
  for (const f of projectMap || []) {
    const role = f.role || "other";
    if (!structure[role]) structure[role] = [];
    structure[role].push(f.path);
  }
  return structure;
}

/**
 * Merge the changed-file projectMap with the stored projectMap.
 * Changed paths replace their stored counterparts; unchanged paths are kept.
 */
function mergeProjectMap(existingProjectMap, freshProjectMap, changedPathSet) {
  return [
    ...(existingProjectMap || []).filter((p) => !changedPathSet.has(p.path)),
    ...(freshProjectMap || []),
  ];
}

/**
 * Recompute the security score and grade from a complete findings array.
 * Uses the same diminishing-deductions formula as the improved Security Auditor.
 */
function recomputeSecurityScore(findings) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings || []) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }

  const criticalDeduct =
    Math.min(counts.CRITICAL, 3) * 25 + Math.max(0, counts.CRITICAL - 3) * 10;
  const highDeduct =
    Math.min(counts.HIGH, 5) * 15 + Math.max(0, counts.HIGH - 5) * 5;
  const mediumDeduct =
    Math.min(counts.MEDIUM, 8) * 7 + Math.max(0, counts.MEDIUM - 8) * 2;
  const lowDeduct = counts.LOW * 2;

  const score = Math.max(
    0,
    Math.min(
      100,
      100 - (criticalDeduct + highDeduct + mediumDeduct + lowDeduct),
    ),
  );
  const grade =
    score >= 90
      ? "A"
      : score >= 80
        ? "B"
        : score >= 65
          ? "C"
          : score >= 45
            ? "D"
            : "F";

  return { score, grade, counts };
}

/**
 * Build a security report Markdown from merged findings.
 * Mirrors the improved Security Auditor's report format
 * without making an LLM call.
 */
function buildSecurityReport(
  findings,
  score,
  grade,
  counts,
  categoryCounts = {},
) {
  let md = `# 🔒 Security Audit Report\n\n`;

  md += `## Summary\n\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| **Score** | ${score}/100 |\n`;
  md += `| **Grade** | **${grade}** |\n`;
  md += `| **Total Findings** | ${findings?.length ?? 0} |\n\n`;

  md += `## Severity Breakdown\n\n`;
  md += `| Severity | Count |\n|----------|-------|\n`;
  for (const sev of SEVERITY_ORDER) {
    md += `| ${SEVERITY_EMOJI[sev]} **${sev}** | ${counts[sev] ?? 0} |\n`;
  }
  md += "\n";

  if (Object.keys(categoryCounts).length > 0) {
    md += `## OWASP Category Breakdown\n\n`;
    md += `| Category | Findings |\n|----------|----------|\n`;
    Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, n]) => (md += `| ${cat} | ${n} |\n`));
    md += "\n";
  }

  if (!findings?.length) {
    md += "✅ No issues detected.\n";
    return md;
  }

  md += `## Findings\n\n`;
  for (const sev of SEVERITY_ORDER) {
    const group = (findings || []).filter((f) => f.severity === sev);
    if (!group.length) continue;
    md += `### ${SEVERITY_EMOJI[sev]} ${sev} (${group.length})\n\n`;
    group.forEach((f) => {
      md += `#### [${f.id}] ${f.title}\n\n`;
      md += `**File:** \`${f.file}\``;
      if (f.cwe) md += ` · **${f.cwe}**`;
      if (f.category) md += ` · ${f.category}`;
      md += "\n\n";
      if (f.line)
        md += `**Detected:**\n\`\`\`\n${f.line.replace(/`/g, "'")}\n\`\`\`\n\n`;
      if (f.description) md += `**Description:** ${f.description}\n\n`;
      if (f.impact) md += `**Impact:** ${f.impact}\n\n`;
      md += `**Fix:** ${f.advice}\n\n---\n\n`;
    });
  }

  return md;
}

/**
 * Build a remediation plan from merged findings.
 */
function buildRemediationPlan(findings) {
  let md = `# 🔧 Remediation Plan\n\n`;
  md += `> Address in order: Critical → High → Medium → Low\n\n`;

  const effort = {
    CRITICAL: "Immediate",
    HIGH: "This sprint",
    MEDIUM: "Next sprint",
    LOW: "Backlog",
  };

  for (const sev of SEVERITY_ORDER) {
    const group = (findings || []).filter((f) => f.severity === sev);
    if (!group.length) continue;
    md += `## ${SEVERITY_EMOJI[sev]} ${sev} — ${effort[sev]}\n\n`;
    group.forEach((f, idx) => {
      md += `${idx + 1}. **[${f.id}] ${f.title}**\n`;
      md += `   - File: \`${f.file}\`\n`;
      md += `   - Fix: ${f.advice}\n`;
      if (f.cwe)
        md += `   - Reference: https://cwe.mitre.org/data/definitions/${f.cwe.replace("CWE-", "")}.html\n`;
      md += "\n";
    });
  }
  return md;
}

/**
 * Build API reference from the improved Agent 2 schema.
 * Mirrors the static builder in the improved Doc Writer.
 */
function buildApiReference(endpoints) {
  if (!endpoints?.length)
    return "# API Reference\n\nNo API endpoints detected.\n";

  let md = "# API Reference\n\n";
  const authCount = endpoints.filter((e) => e.auth?.required || e.auth).length;
  const methodCount = endpoints.reduce((acc, e) => {
    acc[e.method] = (acc[e.method] ?? 0) + 1;
    return acc;
  }, {});

  md += `> **${endpoints.length} endpoints** · **${authCount} require auth** · `;
  md += Object.entries(methodCount)
    .map(([m, n]) => `${n} ${m}`)
    .join(" · ");
  md += "\n\n";

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

      const authRequired = ep.auth?.required ?? ep.auth ?? false;
      const authType = ep.auth?.type || (authRequired ? "required" : "none");
      const authRoles = ep.auth?.roles || [];
      md += `**Auth:** ${authRequired ? `✅ \`${authType}\`` : "❌ Public"}`;
      if (authRoles.length)
        md += ` · Roles: ${authRoles.map((r) => `\`${r}\``).join(", ")}`;
      md += "\n\n";

      if (ep.request?.params?.length) {
        md += `**Parameters:**\n\n| Name | In | Type | Required | Description |\n|------|-----|------|----------|-------------|\n`;
        ep.request.params.forEach((p) => {
          md += `| \`${p.name}\` | ${p.in} | \`${p.type || "string"}\` | ${p.required ? "✅" : "❌"} | ${p.description || "—"} |\n`;
        });
        md += "\n";
      }

      if (ep.request?.body_schema)
        md += `**Body:** \`${ep.request.body_schema}\`\n\n`;

      if (ep.response?.success) {
        md += `**Response \`${ep.response.success.status}\`:** ${ep.response.success.description || "Success"}`;
        if (ep.response.success.schema)
          md += ` · \`${ep.response.success.schema}\``;
        md += "\n\n";
      }

      if (ep.response?.errors?.length) {
        md += `**Errors:**\n\n| Status | Description |\n|--------|-------------|\n`;
        ep.response.errors.forEach(
          (e) => (md += `| \`${e.status}\` | ${e.description} |\n`),
        );
        md += "\n";
      }

      if (ep.notes) md += `> ⚠️ ${ep.notes}\n\n`;
      md += "---\n\n";
    }
  }
  return md;
}

/**
 * Build schema documentation from the improved Agent 3 schema.
 */
function buildSchemaDocs(models, relationships) {
  if (!models?.length) return "# Data Models\n\nNo data models detected.\n";

  let md = "# Data Models\n\n";
  md += `> **${models.length} models** · **${relationships?.length ?? 0} relationships**\n\n`;
  md +=
    models.map((m) => `- [${m.name}](#${m.name.toLowerCase()})`).join("\n") +
    "\n\n";

  for (const m of models) {
    md += `## ${m.name}\n\n`;
    if (m.description) md += `${m.description}\n\n`;
    if (m.file) md += `**File:** \`${m.file}\`\n\n`;
    if (m.orm) md += `**ORM:** \`${m.orm}\``;
    if (m.table) md += ` · **Table:** \`${m.table}\``;
    if (m.orm || m.table) md += "\n\n";

    if (m.fields?.length) {
      md += `### Fields\n\n| Field | Type | Required | Unique | Default |\n`;
      md += `|-------|------|----------|--------|----------|\n`;
      m.fields.forEach((f) => {
        md += `| \`${f.name}\` | \`${f.type}\` | ${f.required ? "✅" : "❌"} | ${f.unique ? "✅" : "❌"} | ${f.default || "—"} |\n`;
      });
      md += "\n";
    }

    if (m.indexes?.length) {
      md += `### Indexes\n\n| Name | Fields | Unique |\n|------|--------|--------|\n`;
      m.indexes.forEach((idx) => {
        md += `| \`${idx.name || "—"}\` | \`${(idx.fields || []).join(", ")}\` | ${idx.unique ? "✅" : "❌"} |\n`;
      });
      md += "\n";
    }

    const modelRels = (relationships || []).filter(
      (r) => r.from === m.name || r.to === m.name,
    );
    if (modelRels.length) {
      md += `### Relationships\n\n| Direction | Model | Type | Via |\n|-----------|-------|------|-----|\n`;
      modelRels.forEach((r) => {
        const dir = r.from === m.name ? "→ out" : "← in";
        const other = r.from === m.name ? r.to : r.from;
        md += `| ${dir} | ${other} | \`${r.type}\` | ${r.through || "—"} |\n`;
      });
      md += "\n";
    }

    md += "---\n\n";
  }

  if (relationships?.length) {
    md += `## Relationship Overview\n\n| From | Type | To | Via |\n|------|------|----|-----|\n`;
    relationships.forEach((r) => {
      md += `| ${r.from} | \`${r.type}\` | ${r.to} | ${r.through || "—"} |\n`;
    });
  }

  return md;
}

/**
 * Build a component index statically from merged components.
 */
function buildComponentIndex(components) {
  if (!components?.length)
    return "# Component Index\n\nNo components documented.\n";

  let md = `# Component Index\n\n`;
  md += `> **${components.length} components**\n\n`;

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
    const t = c.type || "other";
    if (!grouped[t]) grouped[t] = [];
    grouped[t].push(c);
  }

  for (const type of typeOrder) {
    const group = grouped[type];
    if (!group?.length) continue;

    const label = type.charAt(0).toUpperCase() + type.slice(1) + "s";
    md += `## ${label}\n\n`;
    md += `| Name | File | Async | Complexity | Description |\n`;
    md += `|------|------|-------|------------|-------------|\n`;

    group
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((c) => {
        const dep = c.deprecated ? " ⚠️" : "";
        const cplx =
          { low: "🟢", medium: "🟡", high: "🔴" }[c.complexity] || "—";
        const desc = c.description
          ? c.description.slice(0, 70) + (c.description.length > 70 ? "…" : "")
          : "—";
        md += `| \`${c.name}\`${dep} | \`${c.file}\` | ${c.async ? "✅" : "❌"} | ${cplx} | ${desc} |\n`;
      });
    md += "\n";
  }

  return md;
}

/**
 * Determine which documentation sections need regeneration
 * based on which agents ran.
 * Returns both the full set needed and split by static vs LLM.
 */
function determineSectionsToRegenerate(agentsRun, analysis) {
  const sections = new Set(analysis.sectionsAffected || []);

  // Ensure agent→section mappings are always applied even if analysis missed some
  if (agentsRun.has("apiExtractor")) sections.add("apiReference");
  if (agentsRun.has("schemaAnalyser")) {
    sections.add("schemaDocs");
    sections.add("internalDocs");
  }
  if (agentsRun.has("componentMapper")) {
    sections.add("componentRef");
    sections.add("componentIndex");
  }
  if (agentsRun.has("securityAuditor")) {
    sections.add("securityReport");
    sections.add("remediationReport");
  }
  if (agentsRun.has("repoScanner")) sections.add("internalDocs");

  // Any agent running could affect the readme
  if (agentsRun.size > 0) sections.add("readme");

  return {
    all: [...sections],
    static: [...sections].filter((s) => STATIC_SECTIONS.has(s)),
    llm: [...sections].filter((s) => LLM_SECTIONS.has(s)),
  };
}

/**
 * Check if a project has valid stored state for incremental sync.
 */
function hasValidStoredState(project) {
  return (
    project.agentOutputs?.projectMap?.length > 0 &&
    project.fileManifest?.length > 0
  );
}

/**
 * Update only the commit SHA in the database when nothing changed.
 */
async function updateCommitSha(project, sha) {
  const { Project } = await import("../models/Project.js");
  await Project.findByIdAndUpdate(project._id, {
    lastDocumentedCommit: sha,
    "stats.lastChecked": new Date(),
  });
}

// ─── Main Entry Point ─────────────────────────────────────────────

/**
 * Run the incremental sync pipeline for a project.
 *
 * @param {Object}   project               — Mongoose Project document
 * @param {Function} onProgress            — SSE progress emitter
 * @param {Object}   options
 * @param {Array}    options.webhookChangedFiles — pre-parsed files from webhook
 * @param {boolean}  options.forceFullRun        — skip diff, do full re-run
 * @returns {Object} syncResult
 */
export async function incrementalSync(project, onProgress, options = {}) {
  const syncStart = Date.now();
  const syncErrors = [];

  const emit = (step, status, msg, detail = null, duration = null) => {
    const event = { step, status, msg, detail, ts: Date.now(), duration };
    console.log(
      `[sync:${step}:${status}] ${msg}${detail ? " — " + detail : ""}${duration ? ` (${(duration / 1000).toFixed(1)}s)` : ""}`,
    );
    if (onProgress) onProgress(event);
  };

  const { owner, repoName: repo } = parseOwnerRepo(project);

  try {
    emit("sync", "running", "Starting incremental sync…", `${owner}/${repo}`);

    // ── PHASE 1: Resolve current state ────────────────────────

    emit("sync:fetch", "running", "Checking for new commits…");
    const fetchStart = Date.now();

    let meta, currentSha;
    try {
      [meta, currentSha] = await Promise.all([
        getRepoMeta(owner, repo),
        getCommitSha(owner, repo, project.meta?.defaultBranch || "main"),
      ]);
    } catch (err) {
      emit("sync:fetch", "error", "Failed to fetch repo metadata", err.message);
      return { success: false, error: err.message, phase: "fetch" };
    }

    const lastSha = project.lastDocumentedCommit;

    // Short-circuit: nothing changed
    if (currentSha && currentSha === lastSha && !options.forceFullRun) {
      emit(
        "sync",
        "done",
        "Repository unchanged — no sync needed",
        `SHA: ${currentSha.slice(0, 8)}`,
      );
      return {
        success: true,
        skipped: true,
        reason: "no_changes",
        currentCommit: currentSha,
      };
    }

    // Short-circuit: no stored state → full run
    if (options.forceFullRun || !hasValidStoredState(project)) {
      const reason = options.forceFullRun
        ? "forceFullRun requested"
        : "No stored baseline found";
      emit("sync:fetch", "running", `Full re-run: ${reason}`);
      return await fullSyncFallback(
        project,
        owner,
        repo,
        meta,
        currentSha,
        onProgress,
      );
    }

    // ── PHASE 2: Compute what changed ─────────────────────────

    emit("sync:diff", "running", "Computing file diff…");
    const diffStart = Date.now();

    let added = [],
      modified = [],
      removed = [],
      currentTree = [];
    let changedFileEntries = [];

    if (options.webhookChangedFiles?.length) {
      // Webhook provided the diff directly — trust it, skip SHA comparison
      emit(
        "sync:diff",
        "running",
        `Using ${options.webhookChangedFiles.length} files from webhook`,
      );
      ({ added, modified, removed } = categoriseWebhookFiles(
        options.webhookChangedFiles,
      ));
      changedFileEntries = [...added, ...modified, ...removed];

      // Fetch current tree for manifest update (needed in Phase 7)
      currentTree = await getFileTreeWithSha(
        owner,
        repo,
        meta.defaultBranch,
      ).catch(() => []);
    } else {
      // Compute diff from GitHub tree SHA comparison
      try {
        const diffResult = await computeFileDiff(
          owner,
          repo,
          meta.defaultBranch,
          project.fileManifest,
        );
        added = diffResult.added || [];
        modified = diffResult.modified || [];
        removed = diffResult.removed || [];
        currentTree = diffResult.currentTree || [];
        changedFileEntries = [...added, ...modified, ...removed];
      } catch (err) {
        syncErrors.push({ phase: "diff", error: err.message });
        emit(
          "sync:diff",
          "error",
          "Diff computation failed — falling back to full run",
          err.message,
        );
        return await fullSyncFallback(
          project,
          owner,
          repo,
          meta,
          currentSha,
          onProgress,
        );
      }
    }

    const diffDuration = Date.now() - diffStart;
    emit(
      "sync:diff",
      "done",
      `${added.length} added · ${modified.length} modified · ${removed.length} removed`,
      `${changedFileEntries.length} total · ${(diffDuration / 1000).toFixed(1)}s`,
    );

    // Nothing changed (SHA moved but no code files affected)
    if (changedFileEntries.length === 0) {
      await updateCommitSha(project, currentSha);
      emit(
        "sync",
        "done",
        "No eligible files changed — commit SHA updated",
        `→ ${currentSha.slice(0, 8)}`,
      );
      return {
        success: true,
        skipped: true,
        reason: "no_eligible_changes",
        currentCommit: currentSha,
      };
    }

    // Analyse changes and determine which agents need to run
    const analysis = analyseChanges(changedFileEntries, project.fileManifest);

    // Full run if manifest changed (package.json, go.mod, etc.)
    if (analysis.needsFullRun) {
      emit(
        "sync:diff",
        "running",
        `Full re-run required: ${analysis.fullRunReason}`,
      );
      return await fullSyncFallback(
        project,
        owner,
        repo,
        meta,
        currentSha,
        onProgress,
      );
    }

    // Full run if too many files changed to merge reliably
    if (changedFileEntries.length > FULL_RUN_THRESHOLD) {
      emit(
        "sync:diff",
        "running",
        `${changedFileEntries.length} files changed — exceeds threshold (${FULL_RUN_THRESHOLD}), doing full run`,
      );
      return await fullSyncFallback(
        project,
        owner,
        repo,
        meta,
        currentSha,
        onProgress,
      );
    }

    const agentsNeeded = analysis.agentsNeeded;
    emit(
      "sync:routing",
      "done",
      `Agents needed: ${[...agentsNeeded].join(", ") || "none"}`,
      `${changedFileEntries.filter((f) => f.status !== "removed").length} files to re-analyse`,
    );

    // ── PHASE 3: Fetch changed file contents ──────────────────

    // Collect all paths assigned to any agent (deduplicated)
    const changedPathsToFetch = [
      ...new Set([
        ...analysis.changedByAgent.repoScanner.map((f) => f.path),
        ...analysis.changedByAgent.apiExtractor.map((f) => f.path),
        ...analysis.changedByAgent.schemaAnalyser.map((f) => f.path),
        ...analysis.changedByAgent.componentMapper.map((f) => f.path),
        ...analysis.changedByAgent.securityAuditor.map((f) => f.path),
      ]),
    ].filter((p) => !removed.map((r) => r.path).includes(p)); // don't fetch deleted files

    emit(
      "sync:fetch",
      "running",
      `Fetching ${changedPathsToFetch.length} changed files…`,
    );

    let changedFiles = [];
    const { result: fetchResult, error: fetchErr } = await withTimeout(
      () =>
        fetchFileContents(owner, repo, changedPathsToFetch, (msg) =>
          emit("sync:fetch", "running", msg),
        ),
      TIMEOUTS.fetch,
      "File fetch",
    );

    if (fetchErr) {
      syncErrors.push({ phase: "fetch_files", error: fetchErr.message });
      emit(
        "sync:fetch",
        "error",
        "File fetch failed — falling back to full run",
        fetchErr.message,
      );
      return await fullSyncFallback(
        project,
        owner,
        repo,
        meta,
        currentSha,
        onProgress,
      );
    }

    changedFiles = fetchResult || [];
    emit("sync:fetch", "done", `${changedFiles.length} files downloaded`);

    // ── PHASE 4: Parallel Agent Execution ─────────────────────
    // All needed agents run in parallel — same as the main orchestrator.
    // Each receives only the files relevant to it.

    const existingProjectMap = project.agentOutputs?.projectMap || [];
    const changedPathSet = new Set(changedPathsToFetch);

    emit(
      "sync:agents",
      "running",
      `Running ${agentsNeeded.size} agent(s) in parallel…`,
    );
    const agentsStart = Date.now();

    const [
      scanResult,
      apiResult,
      schemaResult,
      componentResult,
      securityResult,
    ] = await Promise.all([
      // Agent 1: Re-classify changed files
      agentsNeeded.has("repoScanner") && changedFiles.length > 0
        ? runAgent({
            label: "Repo Scanner",
            step: "sync:scan",
            timeout: TIMEOUTS.scan,
            fallback: { projectMap: [] },
            emit,
            fn: () =>
              repoScannerAgent({
                files: changedFiles,
                meta,
                emit: (msg, d) => emit("sync:scan", "running", msg, d),
              }),
          })
        : Promise.resolve({ projectMap: [], _skipped: true }),

      // Agent 2: Re-extract endpoints from changed route files
      agentsNeeded.has("apiExtractor")
        ? runAgent({
            label: "API Extractor",
            step: "sync:api",
            timeout: TIMEOUTS.api,
            fallback: { endpoints: [], summary: {} },
            emit,
            fn: () => {
              const routeFiles = filterFilesForAgent(
                changedFiles,
                analysis.changedByAgent.apiExtractor,
              );
              if (!routeFiles.length) return Promise.resolve({ endpoints: [] });

              // Merge projectMap: fresh classifications for changed + stored for unchanged
              const mergedMap = mergeProjectMap(
                existingProjectMap,
                [],
                changedPathSet,
              );
              return apiExtractorAgent({
                files: routeFiles,
                projectMap: mergedMap,
                emit: (msg, d) => emit("sync:api", "running", msg, d),
              });
            },
          })
        : Promise.resolve({ endpoints: [], _skipped: true }),

      // Agent 3: Re-analyse changed schema files
      agentsNeeded.has("schemaAnalyser")
        ? runAgent({
            label: "Schema Analyser",
            step: "sync:schema",
            timeout: TIMEOUTS.schema,
            fallback: { models: [], relationships: undefined },
            emit,
            fn: () => {
              const schemaFiles = filterFilesForAgent(
                changedFiles,
                analysis.changedByAgent.schemaAnalyser,
              );
              if (!schemaFiles.length)
                return Promise.resolve({
                  models: [],
                  relationships: undefined,
                });

              const mergedMap = mergeProjectMap(
                existingProjectMap,
                [],
                changedPathSet,
              );
              return schemaAnalyserAgent({
                files: schemaFiles,
                projectMap: mergedMap,
                emit: (msg, d) => emit("sync:schema", "running", msg, d),
              });
            },
          })
        : Promise.resolve({
            models: [],
            relationships: undefined,
            _skipped: true,
          }),

      // Agent 4: Re-map changed components
      agentsNeeded.has("componentMapper")
        ? runAgent({
            label: "Component Mapper",
            step: "sync:components",
            timeout: TIMEOUTS.components,
            fallback: { components: [], summary: {} },
            emit,
            fn: () => {
              const serviceFiles = filterFilesForAgent(
                changedFiles,
                analysis.changedByAgent.componentMapper,
              );
              if (!serviceFiles.length)
                return Promise.resolve({ components: [] });

              const mergedMap = mergeProjectMap(
                existingProjectMap,
                [],
                changedPathSet,
              );
              return componentMapperAgent({
                files: serviceFiles,
                projectMap: mergedMap,
                structure: buildStructure(mergedMap),
                emit: (msg, d) => emit("sync:components", "running", msg, d),
              });
            },
          })
        : Promise.resolve({ components: [], _skipped: true }),

      // Agent 6: Security-scan all changed code files
      // Passes merged projectMap so it can use has_auth flags for prioritisation
      agentsNeeded.has("securityAuditor") && changedFiles.length > 0
        ? runAgent({
            label: "Security Auditor",
            step: "sync:security",
            timeout: TIMEOUTS.security,
            fallback: {
              findings: [],
              score: null,
              grade: null,
              counts: null,
              categoryCounts: {},
              remediationMarkdown: "",
            },
            emit,
            fn: () => {
              const mergedMap = mergeProjectMap(
                existingProjectMap,
                [],
                changedPathSet,
              );
              return securityAuditorAgent({
                files: changedFiles,
                projectMap: mergedMap, // passes Agent 1 metadata for LLM prioritisation
                emit: (msg, d) => emit("sync:security", "running", msg, d),
              });
            },
          })
        : Promise.resolve({ findings: [], _skipped: true }),
    ]);

    const agentsDuration = Date.now() - agentsStart;

    // ── Unpack results ────────────────────────────────────────
    const freshProjectMap = scanResult.projectMap || [];
    const freshEndpoints = apiResult.endpoints || [];
    const freshModels = schemaResult.models || [];
    const freshRelationships = schemaResult.relationships; // undefined if agent didn't run → keep stored
    const freshComponents = componentResult.components || [];
    const freshFindings = securityResult.findings || [];

    // Collect agent errors
    if (scanResult._failed)
      syncErrors.push({ agent: "scan", error: scanResult._error });
    if (apiResult._failed)
      syncErrors.push({ agent: "api", error: apiResult._error });
    if (schemaResult._failed)
      syncErrors.push({ agent: "schema", error: schemaResult._error });
    if (componentResult._failed)
      syncErrors.push({ agent: "components", error: componentResult._error });
    if (securityResult._failed)
      syncErrors.push({ agent: "security", error: securityResult._error });

    emit(
      "sync:agents",
      "done",
      `${agentsNeeded.size} agent(s) complete`,
      `${(agentsDuration / 1000).toFixed(1)}s · ${syncErrors.length > 0 ? `⚠ ${syncErrors.length} error(s)` : "✅ no errors"}`,
    );

    // ── PHASE 5: Merge outputs ────────────────────────────────
    // Build merged projectMap first (used by merge and doc context)
    const mergedProjectMap = mergeProjectMap(
      existingProjectMap,
      freshProjectMap,
      changedPathSet,
    );

    // Merge each agent's outputs into the stored baseline
    // mergeAgentOutputs handles: replacing changed items, removing deleted items,
    // keeping unchanged stored items
    const removedPaths = removed.map((r) => r.path);
    const mergedOutputs = mergeAgentOutputs(
      project.agentOutputs,
      {
        endpoints: freshEndpoints,
        models: freshModels,
        relationships: freshRelationships, // undefined = not re-run → keep stored value
        components: freshComponents,
        findings: freshFindings,
        projectMap: freshProjectMap,
      },
      changedPathsToFetch,
      removedPaths,
    );

    // ── PHASE 6: Recompute security from full merged findings ──
    // Security score must be recomputed from ALL merged findings
    // (not just the fresh ones) for accuracy.
    let securitySummary;

    if (agentsNeeded.has("securityAuditor")) {
      const { score, grade, counts } = recomputeSecurityScore(
        mergedOutputs.findings,
      );
      const categoryCounts = securityResult.categoryCounts || {};
      securitySummary = {
        score,
        grade,
        counts,
        categoryCounts,
        affectedFiles: securityResult.affectedFiles || [],
        findings: mergedOutputs.findings.slice(0, 50),
        reportMarkdown: buildSecurityReport(
          mergedOutputs.findings,
          score,
          grade,
          counts,
          categoryCounts,
        ),
        remediationMarkdown: buildRemediationPlan(mergedOutputs.findings),
      };
    } else {
      // Security didn't run — carry forward stored values
      securitySummary = project.security || {
        score: 100,
        grade: "A",
        counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        findings: [],
      };
    }

    // ── PHASE 7: Regenerate doc sections ─────────────────────

    emit(
      "sync:docs",
      "running",
      "Regenerating affected documentation sections…",
    );
    const docsStart = Date.now();

    const sectionsInfo = determineSectionsToRegenerate(agentsNeeded, analysis);
    const sectionsAll = sectionsInfo.all;
    const regenerated = []; // sections successfully updated
    const skipped = []; // sections skipped due to user edits
    const docErrors = []; // sections that failed to regenerate

    // Build current output object (deep clone to avoid mutating the DB document)
    const newOutput = {
      ...(project.output?.toObject?.() ?? { ...project.output }),
    };

    // Build shared context for doc writer calls
    const docContext = {
      meta,
      techStack: project.techStack || [],
      structure: buildStructure(mergedProjectMap),
      endpoints: mergedOutputs.endpoints,
      models: mergedOutputs.models,
      relationships:
        mergedOutputs.relationships ||
        project.agentOutputs?.relationships ||
        [],
      components: mergedOutputs.components,
      entryPoints: mergedProjectMap
        .filter((f) => f.role === "entry")
        .map((f) => f.path),
      owner,
      repo,
      // Pass enriched context from improved agents
      layerMap: buildLayerMap(mergedProjectMap),
      architectureHint: project.architectureHint || "",
      securitySummary: {
        score: securitySummary.score,
        grade: securitySummary.grade,
        counts: securitySummary.counts,
        topFindings: mergedOutputs.findings
          .filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH")
          .slice(0, 10),
      },
    };

    // ── Static sections (no LLM cost) ─────────────────────────
    for (const section of sectionsInfo.static) {
      const hasUserEdit = project.editedSections?.some(
        (s) => s.section === section,
      );

      try {
        switch (section) {
          case "apiReference":
            newOutput.apiReference = buildApiReference(mergedOutputs.endpoints);
            break;
          case "schemaDocs":
            newOutput.schemaDocs = buildSchemaDocs(
              mergedOutputs.models,
              mergedOutputs.relationships ||
                project.agentOutputs?.relationships ||
                [],
            );
            break;
          case "securityReport":
            newOutput.securityReport = securitySummary.reportMarkdown;
            break;
          case "remediationReport":
            newOutput.remediationReport = securitySummary.remediationMarkdown;
            break;
          case "componentIndex":
            newOutput.componentIndex = buildComponentIndex(
              mergedOutputs.components,
            );
            break;
        }
        regenerated.push(section);

        // If user had edited this section, mark their edit as stale
        if (hasUserEdit) {
          skipped.push({ section, reason: "user_edit_preserved_as_stale" });
        }
      } catch (err) {
        docErrors.push({ section, error: err.message });
        syncErrors.push({ agent: "docs_static", section, error: err.message });
      }
    }

    // ── LLM sections (one doc writer call for all LLM sections) ──
    // Batch all LLM sections into a single doc writer call to avoid
    // multiple separate LLM invocations for the same context.
    const llmSectionsNeeded = sectionsInfo.llm;

    if (llmSectionsNeeded.length > 0) {
      emit(
        "sync:docs",
        "running",
        `Regenerating ${llmSectionsNeeded.length} LLM section(s)…`,
        llmSectionsNeeded.join(", "),
      );

      const { result: docResult, error: docErr } = await withTimeout(
        async () => {
          const docWriter = await getDocWriter();
          return docWriter({
            ...docContext,
            emit: (msg, d) => emit("sync:docs", "running", msg, d),
          });
        },
        TIMEOUTS.docs,
        "Doc Writer",
      );

      if (docErr) {
        docErrors.push(
          ...llmSectionsNeeded.map((s) => ({
            section: s,
            error: docErr.message,
          })),
        );
        syncErrors.push({ agent: "docs_llm", error: docErr.message });
        emit(
          "sync:docs",
          "error",
          "LLM doc generation failed — existing content preserved",
          docErr.message,
        );
      } else {
        for (const section of llmSectionsNeeded) {
          const hasUserEdit = project.editedSections?.some(
            (s) => s.section === section,
          );

          if (docResult?.[section]) {
            newOutput[section] = docResult[section];
            regenerated.push(section);
            if (hasUserEdit)
              skipped.push({ section, reason: "user_edit_preserved_as_stale" });
          }
        }
      }
    }

    const docsDuration = Date.now() - docsStart;
    emit(
      "sync:docs",
      "done",
      `${regenerated.length} sections updated · ${skipped.length} user-edits marked stale`,
      `${(docsDuration / 1000).toFixed(1)}s`,
    );

    // ── PHASE 8: Update file manifest ─────────────────────────

    if (!currentTree.length) {
      // Fetch tree if we didn't get it from computeFileDiff (webhook path)
      currentTree = await getFileTreeWithSha(
        owner,
        repo,
        meta.defaultBranch,
      ).catch(() => []);
    }

    const newManifest = updateFileManifest(
      project.fileManifest,
      currentTree,
      mergedProjectMap,
    );

    // ── PHASE 9: Store version history ────────────────────────
    // One DocumentVersion entry per regenerated section.
    const versionPromises = regenerated.map((section) =>
      DocumentVersion.createVersion({
        projectId: project._id,
        section,
        content: newOutput[section] || "",
        source: "ai_incremental",
        meta: {
          commitSha: currentSha,
          previousSha: lastSha,
          changedFiles: changedPathsToFetch.slice(0, 20),
          agentsRun: [...agentsNeeded],
          changeSummary: `Incremental sync ${lastSha?.slice(0, 8) ?? "initial"} → ${currentSha.slice(0, 8)}`,
        },
      }).catch((err) => {
        // Version history failure is non-fatal
        syncErrors.push({
          agent: "version_history",
          section,
          error: err.message,
        });
      }),
    );
    await Promise.all(versionPromises);

    // ── PHASE 10: Build MongoDB update payload ─────────────────

    // Mark user-edited sections as stale if their content was regenerated
    const updatedEditedSections = (project.editedSections || []).map((es) => ({
      ...(es.toObject?.() ?? es),
      stale: regenerated.includes(es.section) ? true : es.stale,
    }));

    const totalDuration = Date.now() - syncStart;

    const mongoUpdate = {
      // Documentation output
      "output.readme": newOutput.readme,
      "output.internalDocs": newOutput.internalDocs,
      "output.apiReference": newOutput.apiReference,
      "output.schemaDocs": newOutput.schemaDocs,
      "output.securityReport": newOutput.securityReport,
      "output.remediationReport": newOutput.remediationReport,
      "output.componentRef": newOutput.componentRef,
      "output.componentIndex": newOutput.componentIndex,
      // Sync state
      lastDocumentedCommit: currentSha,
      fileManifest: newManifest,
      agentOutputs: mergedOutputs,
      // Security aggregate
      security: securitySummary,
      // Edited sections with stale flags
      editedSections: updatedEditedSections,
      // Updated stats
      stats: {
        filesAnalysed: newManifest.length,
        endpoints: mergedOutputs.endpoints.length,
        models: mergedOutputs.models.length,
        relationships: (mergedOutputs.relationships || []).length,
        components: mergedOutputs.components.length,
        securityScore: securitySummary.score,
        lastSyncedAt: new Date(),
        lastSyncDuration: totalDuration,
      },
    };

    emit(
      "sync",
      "done",
      `Sync complete — ${regenerated.length} sections updated`,
      [
        `${lastSha?.slice(0, 8) ?? "initial"} → ${currentSha.slice(0, 8)}`,
        `${changedPathsToFetch.length} files · ${(totalDuration / 1000).toFixed(1)}s`,
        syncErrors.length
          ? `⚠ ${syncErrors.length} non-fatal error(s)`
          : "✅ clean",
      ].join(" · "),
      totalDuration,
    );

    return {
      success: true,
      skipped: false,
      isFullRun: false,
      currentCommit: currentSha,
      previousCommit: lastSha,
      sectionsRegenerated: regenerated,
      sectionsSkipped: skipped,
      agentsRun: [...agentsNeeded],
      changedFileCount: changedPathsToFetch.length,
      removedFileCount: removedPaths.length,
      totalDuration,
      errors: syncErrors.length > 0 ? syncErrors : undefined,
      // The caller (project.service.js) is responsible for persisting this
      _update: mongoUpdate,
    };
  } catch (err) {
    console.error("❌ Incremental sync failed:", err);
    emit("sync:error", "error", err.message, err.stack?.split("\n")[1]?.trim());
    return { success: false, error: err.message, errors: syncErrors };
  }
}

// ─── Full Sync Fallback ───────────────────────────────────────────

/**
 * Called when no stored state exists, manifest changed, or file
 * count exceeds FULL_RUN_THRESHOLD.
 * Runs the full orchestrator pipeline and maps the result to the
 * incremental sync return format.
 */
async function fullSyncFallback(
  project,
  owner,
  repo,
  meta,
  currentSha,
  onProgress,
) {
  const emit = (step, status, msg, detail = null) => {
    const event = { step, status, msg, detail, ts: Date.now() };
    if (onProgress) onProgress(event);
  };

  emit("sync:full", "running", "Running full pipeline…", `${owner}/${repo}`);

  const { orchestrate } = await import("./orchestrator.service.js");
  const result = await orchestrate(project.repoUrl, onProgress);

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // Fetch fresh tree for manifest storage
  const currentTree = await getFileTreeWithSha(
    owner,
    repo,
    meta?.defaultBranch || "main",
  ).catch(() => []);

  const allSections = [
    "readme",
    "internalDocs",
    "apiReference",
    "schemaDocs",
    "securityReport",
    "remediationReport",
    "componentRef",
    "componentIndex",
  ];

  return {
    success: true,
    skipped: false,
    isFullRun: true,
    currentCommit: currentSha || result.lastDocumentedCommit,
    previousCommit: project.lastDocumentedCommit,
    sectionsRegenerated: allSections,
    sectionsSkipped: [],
    agentsRun: [
      "repoScanner",
      "apiExtractor",
      "schemaAnalyser",
      "componentMapper",
      "securityAuditor",
      "docWriter",
    ],
    changedFileCount: currentTree.length,
    removedFileCount: 0,
    totalDuration: null,
    errors: result.agentErrors,
    // Caller persists these
    _fullResult: result,
    _freshTree: currentTree,
  };
}

// ─── Layer Map Helper ─────────────────────────────────────────────

function buildLayerMap(projectMap) {
  const map = {};
  for (const f of projectMap || []) {
    const layer = f.layer || "other";
    if (!map[layer]) map[layer] = [];
    map[layer].push(f.path);
  }
  return map;
}
