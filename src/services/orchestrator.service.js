// ===================================================================
// Orchestrator — Full Pipeline (Improved)
// ===================================================================
//
// Coordinates all 6 agents with:
//   - Intelligent routing based on Agent 1 outputs
//   - Parallel execution where safe, sequential where dependent
//   - Per-agent timeout and graceful degradation
//   - Rich progress events with timing
//   - Partial success — one agent failure never kills the pipeline
//   - Full incremental sync baseline in return payload
//
// Progress event schema:
//   { step, status: "running"|"done"|"error"|"skipped"|"waiting",
//     msg, detail, ts, duration? }
// ===================================================================

import {
  fetchRepoFilesWithProgress,
  getCommitSha,
  getFileTreeWithSha,
  parseRepoUrl,
} from "./github.service.js";

import { repoScannerAgent } from "../agents/repo-scanner.agent.js";
import { apiExtractorAgent } from "../agents/api-extractor.agent.js";
import { schemaAnalyserAgent } from "../agents/schema-analyser.agent.js";
import { componentMapperAgent } from "../agents/component-mapper.agent.js";
import { docWriterAgent } from "../agents/doc-writer.agent.js";
import { securityAuditorAgent } from "../agents/security-auditor.agent.js";
import { createChatSession, getSuggestedQuestions } from "./chat.service.js";
import { updateFileManifest } from "./diff.service.js";

// ─── Timeouts (ms) ────────────────────────────────────────────────
// Each agent has an independent timeout so one slow agent can't
// stall the entire pipeline indefinitely.

const TIMEOUTS = {
  fetch: 60_000, // GitHub API fetch
  scan: 120_000, // Repo Scanner — LLM batches over all files
  api: 90_000, // API Extractor
  schema: 90_000, // Schema Analyser
  components: 90_000, // Component Mapper
  security: 120_000, // Security Auditor — static + LLM
  write: 180_000, // Doc Writer — multiple LLM calls
  chat: 15_000, // Chat session setup
};

// ─── Routing Thresholds ───────────────────────────────────────────
// Agent 1 outputs drive intelligent routing decisions.
// Agents are skipped when there's nothing for them to do.

const ROUTING = {
  // Skip API extractor if fewer than this many route/controller files
  minRouteFiles: 1,
  // Skip schema analyser if fewer than this many model/schema/migration files
  minSchemaFiles: 1,
  // Skip component mapper if fewer than this many service/middleware/hook/component files
  minComponentFiles: 1,
  // Skip security auditor if total code files below this (tiny repos)
  minCodeFiles: 3,
  // Skip LLM doc sections if we have essentially nothing to document
  minDocumentableItems: 1,
};

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Wrap any async function with a hard timeout.
 * Returns { result } on success, { error, timedOut: true } on timeout.
 */
async function withTimeout(fn, ms, label) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    clearTimeout(timeoutHandle);
    return { result };
  } catch (err) {
    clearTimeout(timeoutHandle);
    return { error: err, timedOut: err.message.includes("timed out") };
  }
}

/**
 * Run an agent with timeout, error isolation, and duration tracking.
 * Never throws — always returns a result object so the pipeline continues.
 */
async function runAgent({ label, step, fn, timeout, emit, fallback }) {
  const start = Date.now();
  emit(step, "running", `Starting ${label}…`);

  const { result, error, timedOut } = await withTimeout(fn, timeout, label);

  const duration = Date.now() - start;

  if (error) {
    const reason = timedOut
      ? `${label} timed out after ${timeout / 1000}s`
      : error.message;

    emit(step, "error", `${label} failed — using fallback`, reason);
    console.error(`[${step}:error] ${label}:`, error);

    return { ...fallback, _failed: true, _error: reason, _duration: duration };
  }

  emit(step, "done", `${label} complete`, `${(duration / 1000).toFixed(1)}s`);
  return { ...result, _duration: duration };
}

/**
 * Determine which agents to run based on Agent 1 outputs.
 * Returns a routing decision object with reasons for each skip.
 */
function computeRouting(projectMap, structure, files) {
  const roles = Object.fromEntries(
    Object.entries(structure).map(([role, paths]) => [role, paths.length]),
  );

  const routeFileCount =
    (roles.route ?? 0) + (roles.controller ?? 0) + (roles.entry ?? 0);
  const schemaFileCount =
    (roles.model ?? 0) +
    (roles.schema ?? 0) +
    (roles.migration ?? 0) +
    (roles.entity ?? 0);
  const componentFileCount =
    (roles.service ?? 0) +
    (roles.middleware ?? 0) +
    (roles.hook ?? 0) +
    (roles.component ?? 0) +
    (roles.utility ?? 0) +
    (roles.helper ?? 0) +
    (roles.store ?? 0) +
    (roles.guard ?? 0) +
    (roles.provider ?? 0);

  const codeFileCount = files.filter(
    (f) => !/\.(md|yaml|yml|txt|svg|png|jpg|json|lock)$/i.test(f.path),
  ).length;

  const runApi = routeFileCount >= ROUTING.minRouteFiles;
  const runSchema = schemaFileCount >= ROUTING.minSchemaFiles;
  const runComponents = componentFileCount >= ROUTING.minComponentFiles;
  const runSecurity = codeFileCount >= ROUTING.minCodeFiles;

  return {
    runApi,
    runSchema,
    runComponents,
    runSecurity,
    reasons: {
      api: runApi
        ? null
        : `Only ${routeFileCount} route/controller files found`,
      schema: runSchema
        ? null
        : `Only ${schemaFileCount} model/schema files found`,
      components: runComponents
        ? null
        : `Only ${componentFileCount} component/service files found`,
      security: runSecurity
        ? null
        : `Only ${codeFileCount} code files — below threshold`,
    },
    counts: {
      routeFiles: routeFileCount,
      schemaFiles: schemaFileCount,
      componentFiles: componentFileCount,
      codeFiles: codeFileCount,
    },
  };
}

/**
 * Build empty fallback outputs for each agent.
 * Used when an agent is skipped or fails.
 */
const FALLBACKS = {
  scan: {
    projectMap: [],
    techStack: [],
    testFrameworks: [],
    entryPoints: [],
    keyFiles: [],
    structure: {},
    layerMap: {},
    flagsSummary: {},
    architectureHint: "unknown",
    summary: {},
  },
  api: {
    endpoints: [],
    summary: {
      total: 0,
      authRequired: 0,
      deprecated: 0,
      byMethod: {},
      tags: [],
    },
  },
  schema: {
    models: [],
    relationships: [],
    summary: {},
  },
  components: {
    components: [],
    summary: {},
  },
  security: {
    findings: [],
    score: 100,
    grade: "A",
    counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    categoryCounts: {},
    affectedFiles: [],
    summary: {},
    reportMarkdown: "# Security Audit\n\nAgent did not run.\n",
    remediationMarkdown: "# Remediation Plan\n\nNo findings.\n",
  },
  write: {
    readme: "# README\n\nDocumentation could not be generated.\n",
    internalDocs: "# Internal Docs\n\nDocumentation could not be generated.\n",
    apiReference: "# API Reference\n\nNo data available.\n",
    schemaDocs: "# Schema Docs\n\nNo data available.\n",
    componentRef: "# Component Reference\n\nNo data available.\n",
    componentIndex: "# Component Index\n\nNo data available.\n",
    summary: {},
  },
};

/**
 * Build a structured pipeline report summarising what ran,
 * what was skipped, timings, and any errors.
 */
function buildPipelineReport(steps) {
  const totalDuration = steps.reduce((s, step) => s + (step.duration ?? 0), 0);
  const failed = steps.filter((s) => s.status === "error");
  const skipped = steps.filter((s) => s.status === "skipped");
  const succeeded = steps.filter((s) => s.status === "done");

  let md = `# Pipeline Execution Report\n\n`;
  md += `| Step | Status | Duration | Detail |\n`;
  md += `|------|--------|----------|--------|\n`;

  for (const step of steps) {
    const statusEmoji =
      {
        done: "✅",
        error: "❌",
        skipped: "⏭️",
        running: "⏳",
      }[step.status] || "—";

    const dur =
      step.duration != null ? `${(step.duration / 1000).toFixed(1)}s` : "—";
    md += `| **${step.label}** | ${statusEmoji} ${step.status} | ${dur} | ${step.detail || "—"} |\n`;
  }

  md += `\n**Total duration:** ${(totalDuration / 1000).toFixed(1)}s`;
  md += ` · **${succeeded.length} succeeded**`;
  if (skipped.length) md += ` · **${skipped.length} skipped**`;
  if (failed.length) md += ` · **${failed.length} failed**`;
  md += "\n";

  return { md, failed, skipped, succeeded, totalDuration };
}

// ─── Orchestrator ─────────────────────────────────────────────────

export async function orchestrate(repoUrl, onProgress) {
  const pipelineStart = Date.now();
  const pipelineSteps = []; // tracks each step for the pipeline report
  const agentErrors = []; // collects non-fatal errors across all agents

  // ── Emit helper ───────────────────────────────────────────────
  // Wraps onProgress with console logging and step tracking.
  const emit = (step, status, msg, detail = null, duration = null) => {
    const event = { step, status, msg, detail, ts: Date.now(), duration };
    console.log(
      `[${step}:${status}] ${msg}${detail ? " — " + detail : ""}${duration ? ` (${(duration / 1000).toFixed(1)}s)` : ""}`,
    );
    if (onProgress) onProgress(event);
  };

  const trackStep = (label, status, detail = null, duration = null) => {
    pipelineSteps.push({ label, status, detail, duration });
  };

  // ── PHASE 1: Fetch Repository ─────────────────────────────────
  emit("fetch", "running", "Connecting to GitHub…");
  const fetchStart = Date.now();

  let meta, files, owner, repo;
  try {
    const fetched = await Promise.race([
      fetchRepoFilesWithProgress(repoUrl, (msg) =>
        emit("fetch", "running", msg),
      ),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("GitHub fetch timed out")),
          TIMEOUTS.fetch,
        ),
      ),
    ]);
    ({ meta, files, owner, repo } = fetched);
  } catch (err) {
    // Fetch failure is fatal — nothing else can run without files
    emit("fetch", "error", "Failed to fetch repository", err.message);
    return { success: false, error: err.message, phase: "fetch" };
  }

  const fetchDuration = Date.now() - fetchStart;
  emit(
    "fetch",
    "done",
    `${files.length} files downloaded`,
    `${owner}/${repo}`,
    fetchDuration,
  );
  trackStep("Fetch Repo", "done", `${files.length} files`, fetchDuration);

  // Fetch commit SHA and file tree in parallel — lightweight, non-blocking
  const [currentCommitSha, treeWithSha] = await Promise.all([
    getCommitSha(owner, repo, meta.defaultBranch).catch(() => null),
    getFileTreeWithSha(owner, repo, meta.defaultBranch).catch(() => []),
  ]);

  // ── PHASE 2: Agent 1 — Repo Scanner (Sequential, blocks all others) ──
  // Must run first — its projectMap, structure, and techStack drive
  // intelligent routing decisions for all downstream agents.

  emit(
    "scan",
    "running",
    "Classifying and analysing repository…",
    "Agent — Repo Scanner",
  );
  const scanStart = Date.now();

  let scanResult;
  const { result: scanRes, error: scanErr } = await withTimeout(
    () =>
      repoScannerAgent({
        files,
        meta,
        emit: (msg, detail) => emit("scan", "running", msg, detail),
      }),
    TIMEOUTS.scan,
    "Repo Scanner",
  );

  if (scanErr) {
    // Agent 1 failure is semi-fatal — we can continue with empty projectMap
    // but results will be lower quality
    emit(
      "scan",
      "error",
      "Repo Scanner failed — continuing with heuristics",
      scanErr.message,
    );
    agentErrors.push({ agent: "scan", error: scanErr.message });
    scanResult = FALLBACKS.scan;
  } else {
    scanResult = scanRes;
  }

  const scanDuration = Date.now() - scanStart;
  const {
    projectMap,
    techStack,
    testFrameworks,
    entryPoints,
    keyFiles,
    structure,
    layerMap,
    flagsSummary,
    architectureHint,
    summary: scanSummary,
  } = scanResult;

  emit(
    "scan",
    scanErr ? "error" : "done",
    `${projectMap.length} files classified`,
    [techStack.join(" · ") || "Stack unknown", architectureHint || ""]
      .filter(Boolean)
      .join(" · "),
    scanDuration,
  );
  trackStep(
    "Repo Scanner",
    scanErr ? "error" : "done",
    architectureHint,
    scanDuration,
  );

  // ── PHASE 3: Intelligent Routing ─────────────────────────────
  // Decide which agents to run based on what Agent 1 found.

  const routing = computeRouting(projectMap, structure, files);

  emit(
    "routing",
    "done",
    "Pipeline routing determined",
    [
      routing.runApi
        ? "✅ API Extractor"
        : `⏭️  API Extractor (${routing.reasons.api})`,
      routing.runSchema
        ? "✅ Schema Analyser"
        : `⏭️  Schema Analyser (${routing.reasons.schema})`,
      routing.runComponents
        ? "✅ Component Mapper"
        : `⏭️  Component Mapper (${routing.reasons.components})`,
      routing.runSecurity
        ? "✅ Security Auditor"
        : `⏭️  Security Auditor (${routing.reasons.security})`,
    ].join(" | "),
  );

  // Announce skipped agents
  for (const [key, reason] of Object.entries(routing.reasons)) {
    if (reason) {
      emit(key, "skipped", `Skipped — ${reason}`);
      trackStep(
        {
          api: "API Extractor",
          schema: "Schema Analyser",
          components: "Component Mapper",
          security: "Security Auditor",
        }[key],
        "skipped",
        reason,
      );
    }
  }

  // ── PHASE 4: Parallel Agents 2–4 + 6 ─────────────────────────
  // All four run in parallel since they share only read-only inputs
  // (files, projectMap, structure) — none depends on the others' output.
  //
  // Security auditor also benefits from projectMap flags (has_auth etc.)
  // to prioritise which files to deep-scan with the LLM.

  emit(
    "parallel",
    "running",
    "Running analysis agents in parallel…",
    "Agents 2, 3, 4, 6",
  );

  const parallelStart = Date.now();

  const [apiResult, schemaResult, componentResult, securityResult] =
    await Promise.all([
      // Agent 2: API Extractor
      routing.runApi
        ? runAgent({
            label: "API Extractor",
            step: "api",
            timeout: TIMEOUTS.api,
            fallback: FALLBACKS.api,
            emit,
            fn: () =>
              apiExtractorAgent({
                files,
                projectMap,
                emit: (msg, detail) => emit("api", "running", msg, detail),
              }),
          })
        : Promise.resolve({ ...FALLBACKS.api, _skipped: true }),

      // Agent 3: Schema Analyser
      routing.runSchema
        ? runAgent({
            label: "Schema Analyser",
            step: "schema",
            timeout: TIMEOUTS.schema,
            fallback: FALLBACKS.schema,
            emit,
            fn: () =>
              schemaAnalyserAgent({
                files,
                projectMap,
                emit: (msg, detail) => emit("schema", "running", msg, detail),
              }),
          })
        : Promise.resolve({ ...FALLBACKS.schema, _skipped: true }),

      // Agent 4: Component Mapper
      routing.runComponents
        ? runAgent({
            label: "Component Mapper",
            step: "components",
            timeout: TIMEOUTS.components,
            fallback: FALLBACKS.components,
            emit,
            fn: () =>
              componentMapperAgent({
                files,
                projectMap,
                structure,
                emit: (msg, detail) =>
                  emit("components", "running", msg, detail),
              }),
          })
        : Promise.resolve({ ...FALLBACKS.components, _skipped: true }),

      // Agent 6: Security Auditor
      // Receives projectMap so it can use has_auth flags and importance scores
      // from Agent 1 to prioritise LLM deep-scan files.
      routing.runSecurity
        ? runAgent({
            label: "Security Auditor",
            step: "security",
            timeout: TIMEOUTS.security,
            fallback: FALLBACKS.security,
            emit,
            fn: () =>
              securityAuditorAgent({
                files,
                projectMap, // NEW: passes Agent 1 metadata to improve file prioritisation
                emit: (msg, detail) => emit("security", "running", msg, detail),
              }),
          })
        : Promise.resolve({ ...FALLBACKS.security, _skipped: true }),
    ]);

  const parallelDuration = Date.now() - parallelStart;

  // ── Unpack and track parallel results ─────────────────────────
  const {
    endpoints,
    summary: apiSummary,
    _failed: apiFailed,
    _skipped: apiSkipped,
    _duration: apiDuration,
  } = apiResult;

  const {
    models,
    relationships,
    summary: schemaSummary,
    _failed: schemaFailed,
    _skipped: schemaSkipped,
    _duration: schemaDuration,
  } = schemaResult;

  const {
    components,
    summary: componentSummary,
    _failed: componentFailed,
    _skipped: componentSkipped,
    _duration: componentDuration,
  } = componentResult;

  const {
    findings,
    score: securityScore,
    grade: securityGrade,
    counts: securityCounts,
    categoryCounts,
    affectedFiles,
    summary: securitySummary,
    reportMarkdown: securityReport,
    remediationMarkdown: remediationReport,
    _failed: securityFailed,
    _skipped: securitySkipped,
    _duration: securityDuration,
  } = securityResult;

  // Collect agent errors
  if (apiFailed) agentErrors.push({ agent: "api", error: apiResult._error });
  if (schemaFailed)
    agentErrors.push({ agent: "schema", error: schemaResult._error });
  if (componentFailed)
    agentErrors.push({ agent: "components", error: componentResult._error });
  if (securityFailed)
    agentErrors.push({ agent: "security", error: securityResult._error });

  // Track steps
  if (!apiSkipped)
    trackStep(
      "API Extractor",
      apiFailed ? "error" : "done",
      `${endpoints?.length ?? 0} endpoints`,
      apiDuration,
    );
  if (!schemaSkipped)
    trackStep(
      "Schema Analyser",
      schemaFailed ? "error" : "done",
      `${models?.length ?? 0} models`,
      schemaDuration,
    );
  if (!componentSkipped)
    trackStep(
      "Component Mapper",
      componentFailed ? "error" : "done",
      `${components?.length ?? 0} components`,
      componentDuration,
    );
  if (!securitySkipped)
    trackStep(
      "Security Auditor",
      securityFailed ? "error" : "done",
      `${securityScore}/100 (${securityGrade})`,
      securityDuration,
    );

  // Emit parallel summary
  emit(
    "parallel",
    "done",
    "All parallel agents complete",
    [
      `${endpoints?.length ?? 0} endpoints`,
      `${models?.length ?? 0} models`,
      `${relationships?.length ?? 0} relationships`,
      `${components?.length ?? 0} components`,
      `Security: ${securityScore}/100 (${securityGrade})`,
      `${(parallelDuration / 1000).toFixed(1)}s total`,
    ].join(" · "),
  );

  // ── PHASE 5: Agent 5 — Doc Writer (Sequential, needs all outputs) ──
  // Runs after all parallel agents because it consumes all their outputs.
  // Passes the richer data from improved agents: components (with responsibilities,
  // complexity, state), endpoints (with auth.roles, request/response schema),
  // models (with indexes, hooks, soft_delete), security findings.

  emit("write", "running", "Generating documentation…", "Agent 5 — Doc Writer");
  const writeStart = Date.now();

  const writeResult = await runAgent({
    label: "Doc Writer",
    step: "write",
    timeout: TIMEOUTS.write,
    fallback: FALLBACKS.write,
    emit,
    fn: () =>
      docWriterAgent({
        meta,
        techStack,
        structure,
        endpoints: endpoints ?? [],
        models: models ?? [],
        relationships: relationships ?? [],
        components: components ?? [],
        entryPoints: entryPoints ?? [],
        owner,
        repo,
        // Pass extra context from improved agents
        layerMap,
        flagsSummary,
        architectureHint,
        keyFiles,
        testFrameworks,
        securitySummary: {
          score: securityScore,
          grade: securityGrade,
          counts: securityCounts,
          topFindings: (findings ?? [])
            .filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH")
            .slice(0, 10),
        },
        emit: (msg, detail) => emit("write", "running", msg, detail),
      }),
  });

  const writeDuration = Date.now() - writeStart;

  const {
    readme,
    internalDocs,
    apiReference,
    schemaDocs,
    componentRef,
    componentIndex,
    summary: writeSummary,
    _failed: writeFailed,
  } = writeResult;

  if (writeFailed)
    agentErrors.push({ agent: "write", error: writeResult._error });
  trackStep(
    "Doc Writer",
    writeFailed ? "error" : "done",
    `${writeSummary?.totalLines ?? 0} lines generated`,
    writeDuration,
  );

  // ── PHASE 6: Chat Session ─────────────────────────────────────

  emit("chat", "running", "Setting up chat session…");
  const chatStart = Date.now();

  const docOutput = {
    readme,
    internalDocs,
    apiReference,
    schemaDocs,
    componentRef,
    componentIndex,
    securityReport,
    remediationReport,
  };

  let sessionId, suggestedQuestions;
  try {
    const chatResult = await Promise.race([
      (async () => {
        const sid = `${owner}-${repo}-${Date.now()}`;
        createChatSession({ jobId: sid, output: docOutput, meta });
        return {
          sessionId: sid,
          suggestedQuestions: getSuggestedQuestions(docOutput),
        };
      })(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Chat setup timed out")),
          TIMEOUTS.chat,
        ),
      ),
    ]);
    sessionId = chatResult.sessionId;
    suggestedQuestions = chatResult.suggestedQuestions;
  } catch (err) {
    emit(
      "chat",
      "error",
      "Chat setup failed — docs still available",
      err.message,
    );
    agentErrors.push({ agent: "chat", error: err.message });
    sessionId = `${owner}-${repo}-${Date.now()}`;
    suggestedQuestions = [];
  }

  const chatDuration = Date.now() - chatStart;
  emit(
    "chat",
    "done",
    "Chat ready — ask anything about this codebase",
    null,
    chatDuration,
  );
  trackStep(
    "Chat Session",
    "done",
    `${suggestedQuestions?.length ?? 0} suggested questions`,
    chatDuration,
  );

  // ── PHASE 7: File Manifest for Incremental Sync ───────────────

  let fileManifest = [];
  try {
    fileManifest = updateFileManifest([], treeWithSha, projectMap);
  } catch (err) {
    agentErrors.push({ agent: "manifest", error: err.message });
  }

  // ── PHASE 8: Build Final Stats and Pipeline Report ────────────

  const totalDuration = Date.now() - pipelineStart;

  const stats = {
    filesAnalysed: files.length,
    filesClassified: projectMap.length,
    endpoints: endpoints?.length ?? 0,
    models: models?.length ?? 0,
    relationships: relationships?.length ?? 0,
    components: components?.length ?? 0,
    securityFindings: findings?.length ?? 0,
    docsGenerated: Object.keys(docOutput).length,
    agentErrors: agentErrors.length,
    totalDuration,
  };

  const { md: pipelineReportMd, ...pipelineReportStats } =
    buildPipelineReport(pipelineSteps);

  emit(
    "done",
    "done",
    "Documentation pipeline complete 🎉",
    [
      `${files.length} files`,
      `${endpoints?.length ?? 0} endpoints`,
      `${models?.length ?? 0} models`,
      `${components?.length ?? 0} components`,
      `Security: ${securityScore}/100`,
      `${(totalDuration / 1000).toFixed(1)}s`,
      agentErrors.length
        ? `⚠ ${agentErrors.length} agent error(s)`
        : "✅ no errors",
    ].join(" · "),
    null,
    totalDuration,
  );

  // ── Return Payload ────────────────────────────────────────────
  return {
    success: true,
    repoUrl,
    owner,
    repo,
    meta,

    // ── Core analysis outputs ─────────────────────────────────
    techStack,
    testFrameworks,
    architectureHint,
    entryPoints,
    keyFiles,
    layerMap,
    flagsSummary,

    // ── Structured doc output ─────────────────────────────────
    output: docOutput,

    // ── Security summary ──────────────────────────────────────
    security: {
      score: securityScore,
      grade: securityGrade,
      counts: securityCounts,
      categoryCounts,
      affectedFiles,
      findings: (findings ?? []).slice(0, 50), // top 50 for display
    },

    // ── Chat ──────────────────────────────────────────────────
    chat: { sessionId, suggestedQuestions },

    // ── Stats ─────────────────────────────────────────────────
    stats,

    // ── Pipeline execution report ─────────────────────────────
    pipelineReport: {
      markdown: pipelineReportMd,
      steps: pipelineSteps,
      ...pipelineReportStats,
    },

    // ── Agent errors (non-fatal) ──────────────────────────────
    agentErrors: agentErrors.length > 0 ? agentErrors : undefined,

    // ── Routing decisions (for debugging and UI display) ──────
    routing,

    // ── v3.2: Incremental sync baseline ──────────────────────
    // Stored in Project so future syncs only re-run changed files.
    lastDocumentedCommit: currentCommitSha,
    fileManifest,
    agentOutputs: {
      projectMap,
      endpoints: endpoints ?? [],
      models: models ?? [],
      relationships: relationships ?? [],
      components: components ?? [],
      findings: (findings ?? []).slice(0, 200), // keep more for merge accuracy
      // Per-agent summaries for the UI dashboard
      summaries: {
        scan: scanSummary,
        api: apiSummary,
        schema: schemaSummary,
        components: componentSummary,
        security: securitySummary,
        write: writeSummary,
      },
    },
  };
}
