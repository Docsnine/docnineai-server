// =============================================================
// Incremental documentation sync pipeline.
//
// Instead of re-running all 6 agents on the entire repo, this:
//   1. Fetches only the files that changed since lastDocumentedCommit
//   2. Runs only the agents affected by those file types
//   3. Merges fresh agent outputs into the stored agentOutputs
//   4. Regenerates only the documentation sections that changed
//   5. Skips sections that have user edits (marks them stale instead)
//   6. Updates lastDocumentedCommit + fileManifest in MongoDB
//
// This makes re-documentation of active repos nearly instant
// compared to full re-runs — only paying for what changed.
//
// Triggers a full re-run when:
//   • No prior agentOutputs / fileManifest stored
//   • A manifest file changed (package.json, etc.)
//   • Caller passes forceFullRun = true
// =============================================================

import {
  getCommitSha,
  getFileTreeWithSha,
  fetchFileContents,
  computeFileDiff,
  getRepoMeta,
} from "./githubService.js";

import { repoScannerAgent } from "../agents/repoScannerAgent.js";
import { apiExtractorAgent } from "../agents/apiExtractorAgent.js";
import { schemaAnalyserAgent } from "../agents/schemaAnalyserAgent.js";
import { componentMapperAgent } from "../agents/componentMapperAgent.js";
import { securityAuditorAgent } from "../agents/securityAuditorAgent.js";

import {
  analyseChanges,
  mergeAgentOutputs,
  updateFileManifest,
} from "./diffService.js";

import { DocumentVersion } from "../models/DocumentVersion.js";

// Doc-writer functions imported lazily (same resilience pattern as rest of codebase)
let _docWriterAgent = null;
async function getDocWriter() {
  if (_docWriterAgent) return _docWriterAgent;
  const m = await import("../agents/docWriterAgent.js");
  _docWriterAgent = m.docWriterAgent;
  return _docWriterAgent;
}

// ─────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────

/**
 * Run the incremental sync pipeline for a project.
 *
 * @param {Object} project   — Mongoose Project document (with agentOutputs + fileManifest via .select('+agentOutputs +fileManifest'))
 * @param {Function} onProgress — SSE event emitter: (step, status, msg, detail) => void
 * @param {Object}  options
 * @param {Array}   options.webhookChangedFiles — pre-parsed file list from webhook [{path,status}]
 * @param {boolean} options.forceFullRun        — skip diff and do a full re-run
 * @returns {Object} syncResult
 */
export async function incrementalSync(project, onProgress, options = {}) {
  const emit = (step, status, msg, detail = null) => {
    const event = { step, status, msg, detail, ts: Date.now() };
    console.log(
      `[sync:${step}:${status}] ${msg}${detail ? " — " + detail : ""}`,
    );
    if (onProgress) onProgress(event);
  };

  const { owner, repoName: repo } = parseOwnerRepo(project);

  try {
    emit("sync", "running", "Starting incremental sync…");

    // ── STEP 1: Resolve current commit SHA ────────────────────
    emit("sync:fetch", "running", "Checking for new commits…");
    const meta = await getRepoMeta(owner, repo);
    const currentSha = await getCommitSha(owner, repo, meta.defaultBranch);
    const lastSha = project.lastDocumentedCommit;

    // Nothing changed since last run — short-circuit
    if (currentSha === lastSha) {
      emit(
        "sync",
        "done",
        "Repository unchanged since last documentation run.",
        `SHA: ${currentSha.slice(0, 8)}`,
      );
      return {
        success: true,
        skipped: true,
        reason: "no_changes",
        currentCommit: currentSha,
      };
    }

    // ── STEP 2: Determine what changed ───────────────────────
    let analysis;
    const hasManifest = project.fileManifest?.length > 0;
    const hasOutputs = project.agentOutputs?.projectMap?.length > 0;

    if (options.forceFullRun || !hasManifest || !hasOutputs) {
      // No stored state to diff against — fall back to full run
      emit(
        "sync:fetch",
        "running",
        "No stored baseline — running full pipeline…",
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

    if (options.webhookChangedFiles?.length) {
      // Webhook provided the file list directly — trust it
      emit(
        "sync:diff",
        "running",
        `Using ${options.webhookChangedFiles.length} files from webhook payload…`,
      );
      const { added, modified, removed } = categoriseWebhookFiles(
        options.webhookChangedFiles,
      );
      const changedFiles = [...added, ...modified, ...removed];
      analysis = analyseChanges(changedFiles, project.fileManifest);
    } else {
      // Compute diff from SHA comparison
      emit("sync:diff", "running", "Comparing repository SHAs…");
      const { added, modified, removed, currentTree } = await computeFileDiff(
        owner,
        repo,
        meta.defaultBranch,
        project.fileManifest,
      );
      const changedFiles = [...added, ...modified, ...removed];
      emit(
        "sync:diff",
        "done",
        `${added.length} added · ${modified.length} modified · ${removed.length} removed`,
        `${changedFiles.length} total changes`,
      );

      if (changedFiles.length === 0) {
        // Tree SHAs all match — nothing to do
        // (This can happen if commit SHA moved but no code files changed)
        await updateCommitSha(project, currentSha);
        emit(
          "sync",
          "done",
          "No eligible files changed.",
          `SHA → ${currentSha.slice(0, 8)}`,
        );
        return {
          success: true,
          skipped: true,
          reason: "no_eligible_changes",
          currentCommit: currentSha,
        };
      }

      analysis = analyseChanges(changedFiles, project.fileManifest);
    }

    // Manifest file changed → must do full run
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

    // ── STEP 3: Fetch only the changed files ──────────────────
    const changedPaths = [
      ...analysis.changedByAgent.repoScanner,
      ...analysis.changedByAgent.apiExtractor,
      ...analysis.changedByAgent.schemaAnalyser,
      ...analysis.changedByAgent.componentMapper,
      ...analysis.changedByAgent.securityAuditor,
    ]
      .filter((f) => f.status !== "removed")
      .map((f) => f.path);

    const uniquePaths = [...new Set(changedPaths)];

    emit(
      "sync:fetch",
      "running",
      `Fetching ${uniquePaths.length} changed files…`,
      `${analysis.agentsNeeded.size} agents to run`,
    );

    const changedFiles = await fetchFileContents(
      owner,
      repo,
      uniquePaths,
      (msg) => emit("sync:fetch", "running", msg),
    );

    emit("sync:fetch", "done", `${changedFiles.length} files downloaded`);

    // ── STEP 4: Run only affected agents ──────────────────────
    const freshOutputs = {
      endpoints: [],
      models: [],
      relationships: undefined, // undefined = schemaAnalyser didn't run → keep stored
      components: [],
      findings: [],
      projectMap: [],
    };

    // We need the full projectMap for agents that need it (apiExtractor etc.)
    // We build a merged projectMap: stored entries for unchanged files + fresh classifications
    const existingProjectMap = project.agentOutputs.projectMap || [];

    if (analysis.agentsNeeded.has("repoScanner") && changedFiles.length > 0) {
      emit("sync:scan", "running", "Re-classifying changed files…", "Agent 1");
      const { projectMap } = await repoScannerAgent({
        files: changedFiles,
        meta,
        emit: (msg, detail) => emit("sync:scan", "running", msg, detail),
      });
      freshOutputs.projectMap = projectMap;
      emit("sync:scan", "done", `${projectMap.length} files re-classified`);
    }

    // Merge project map for use by downstream agents
    const changedPathSet = new Set(uniquePaths);
    const mergedProjectMap = [
      ...existingProjectMap.filter((p) => !changedPathSet.has(p.path)),
      ...freshOutputs.projectMap,
    ];

    // Run apiExtractor only on changed route/controller files
    if (analysis.agentsNeeded.has("apiExtractor")) {
      const routeFiles = filterFilesForAgent(
        changedFiles,
        analysis.changedByAgent.apiExtractor,
      );
      if (routeFiles.length > 0) {
        emit(
          "sync:api",
          "running",
          `Extracting endpoints from ${routeFiles.length} changed route files…`,
          "Agent 2",
        );
        const { endpoints } = await apiExtractorAgent({
          files: routeFiles,
          projectMap: mergedProjectMap,
          emit: (msg, detail) => emit("sync:api", "running", msg, detail),
        });
        freshOutputs.endpoints = endpoints;
        emit("sync:api", "done", `${endpoints.length} endpoints extracted`);
      }
    }

    // Run schemaAnalyser only on changed model/schema files
    if (analysis.agentsNeeded.has("schemaAnalyser")) {
      const schemaFiles = filterFilesForAgent(
        changedFiles,
        analysis.changedByAgent.schemaAnalyser,
      );
      if (schemaFiles.length > 0) {
        emit(
          "sync:schema",
          "running",
          `Analysing ${schemaFiles.length} changed schema files…`,
          "Agent 3",
        );
        const { models, relationships } = await schemaAnalyserAgent({
          files: schemaFiles,
          projectMap: mergedProjectMap,
          emit: (msg, detail) => emit("sync:schema", "running", msg, detail),
        });
        freshOutputs.models = models;
        freshOutputs.relationships = relationships; // defined → replace stored relationships
        emit(
          "sync:schema",
          "done",
          `${models.length} models, ${relationships.length} relationships`,
        );
      }
    }

    // Run componentMapper on changed service/middleware/utility files
    if (analysis.agentsNeeded.has("componentMapper")) {
      const serviceFiles = filterFilesForAgent(
        changedFiles,
        analysis.changedByAgent.componentMapper,
      );
      if (serviceFiles.length > 0) {
        emit(
          "sync:components",
          "running",
          `Mapping ${serviceFiles.length} changed components…`,
          "Agent 4",
        );
        const { components } = await componentMapperAgent({
          files: serviceFiles,
          projectMap: mergedProjectMap,
          structure: buildStructure(mergedProjectMap),
          emit: (msg, detail) =>
            emit("sync:components", "running", msg, detail),
        });
        freshOutputs.components = components;
        emit(
          "sync:components",
          "done",
          `${components.length} components mapped`,
        );
      }
    }

    // Run securityAuditor on all changed code files
    if (
      analysis.agentsNeeded.has("securityAuditor") &&
      changedFiles.length > 0
    ) {
      emit(
        "sync:security",
        "running",
        `Security-scanning ${changedFiles.length} changed files…`,
        "Agent 6",
      );
      const { findings, score, grade, counts, reportMarkdown } =
        await securityAuditorAgent({
          files: changedFiles,
          emit: (msg, detail) => emit("sync:security", "running", msg, detail),
        });
      freshOutputs.findings = findings;
      freshOutputs._secScore = score;
      freshOutputs._secGrade = grade;
      freshOutputs._secCounts = counts;
      freshOutputs._reportMd = reportMarkdown;
      emit("sync:security", "done", `Score: ${score}/100 (Grade ${grade})`);
    }

    // ── STEP 5: Merge outputs ─────────────────────────────────
    const allChangedPaths = uniquePaths;
    const removedPaths = analysis.removedFiles;

    const mergedOutputs = mergeAgentOutputs(
      project.agentOutputs,
      freshOutputs,
      allChangedPaths,
      removedPaths,
    );

    // ── STEP 6: Recompute security score from merged findings ──
    // If security agent ran, recompute from merged findings (not just changed files)
    let securityResult = {
      score: project.security?.score,
      grade: project.security?.grade,
      counts: project.security?.counts,
      findings: mergedOutputs.findings.slice(0, 50),
    };

    if (analysis.agentsNeeded.has("securityAuditor")) {
      securityResult = recomputeSecurity(mergedOutputs.findings);
    }

    // ── STEP 7: Regenerate affected doc sections ───────────────
    emit(
      "sync:docs",
      "running",
      "Regenerating affected documentation sections…",
    );

    const sectionsAffected = [...analysis.sectionsAffected];
    const sectionsRegenerated = [];
    const sectionsSkipped = []; // skipped because user has an edit

    // Build context for doc writer
    const docContext = {
      meta,
      techStack: project.techStack || [],
      structure: buildStructure(mergedProjectMap),
      endpoints: mergedOutputs.endpoints,
      models: mergedOutputs.models,
      relationships:
        mergedOutputs.relationships || project.agentOutputs.relationships || [],
      components: mergedOutputs.components,
      entryPoints: mergedProjectMap
        .filter((f) => f.role === "entry")
        .map((f) => f.path),
      owner,
      repo,
    };

    const newAIOutput = {
      ...(project.output.toObject?.() ?? { ...project.output }),
    };

    // Regenerate each affected section
    for (const section of sectionsAffected) {
      const hasUserEdit = project.editedSections?.some(
        (s) => s.section === section,
      );

      if (section === "apiReference") {
        // Static — no LLM needed
        newAIOutput.apiReference = buildApiReference(mergedOutputs.endpoints);
        sectionsRegenerated.push(section);
      } else if (section === "schemaDocs") {
        // Static — no LLM needed
        newAIOutput.schemaDocs = buildSchemaDocs(
          mergedOutputs.models,
          mergedOutputs.relationships || [],
        );
        sectionsRegenerated.push(section);
      } else if (section === "securityReport") {
        // Rebuilt from merged findings — no LLM needed
        newAIOutput.securityReport =
          securityResult.reportMarkdown ||
          buildSecurityReport(
            mergedOutputs.findings,
            securityResult.score,
            securityResult.grade,
            securityResult.counts,
          );
        sectionsRegenerated.push(section);
      } else if (section === "internalDocs") {
        emit("sync:docs", "running", "Regenerating internal docs…", "LLM call");
        const docWriter = await getDocWriter();
        // Run docWriter for just this section
        const result = await docWriter({
          ...docContext,
          emit: (msg, d) => emit("sync:docs", "running", msg, d),
        });
        newAIOutput.internalDocs = result.internalDocs;
        sectionsRegenerated.push(section);
      } else if (section === "readme") {
        emit("sync:docs", "running", "Regenerating README…", "LLM call");
        const docWriter = await getDocWriter();
        const result = await docWriter({
          ...docContext,
          emit: (msg, d) => emit("sync:docs", "running", msg, d),
        });
        newAIOutput.readme = result.readme;
        sectionsRegenerated.push(section);
      }

      // If user has edited this section, mark it stale but keep their edit
      if (hasUserEdit && sectionsRegenerated.includes(section)) {
        sectionsSkipped.push({ section, reason: "user_edit_preserved" });
      }
    }

    emit(
      "sync:docs",
      "done",
      `${sectionsRegenerated.length} sections updated`,
      sectionsSkipped.length
        ? `${sectionsSkipped.length} skipped (user edits preserved)`
        : null,
    );

    // ── STEP 8: Update fileManifest ───────────────────────────
    // Get the current tree for SHA storage (may already have it from computeFileDiff)
    const currentTree = await getFileTreeWithSha(
      owner,
      repo,
      meta.defaultBranch,
    );
    const newManifest = updateFileManifest(
      project.fileManifest,
      currentTree,
      mergedProjectMap,
    );

    // ── STEP 9: Store version history ─────────────────────────
    // Create a DocumentVersion entry for each regenerated section
    const changedFilePaths = uniquePaths.slice(0, 20); // cap for metadata storage
    for (const section of sectionsRegenerated) {
      await DocumentVersion.createVersion({
        projectId: project._id,
        section,
        content: newAIOutput[section] || "",
        source: "ai_incremental",
        meta: {
          commitSha: currentSha,
          changedFiles: changedFilePaths,
          agentsRun: [...analysis.agentsNeeded],
          changeSummary: `Incremental sync from ${lastSha?.slice(0, 8) || "initial"} → ${currentSha.slice(0, 8)}`,
        },
      });
    }

    // ── STEP 10: Build the MongoDB update ─────────────────────
    const update = {
      // Updated AI output (only sections we regenerated changed)
      "output.readme": newAIOutput.readme,
      "output.internalDocs": newAIOutput.internalDocs,
      "output.apiReference": newAIOutput.apiReference,
      "output.schemaDocs": newAIOutput.schemaDocs,
      "output.securityReport": newAIOutput.securityReport,
      // Updated sync state
      lastDocumentedCommit: currentSha,
      fileManifest: newManifest,
      agentOutputs: mergedOutputs,
      // Updated security aggregate
      security: securityResult,
      // Updated stats
      stats: {
        filesAnalysed: newManifest.length,
        endpoints: mergedOutputs.endpoints.length,
        models: mergedOutputs.models.length,
        relationships: (mergedOutputs.relationships || []).length,
        components: mergedOutputs.components.length,
      },
    };

    // Mark user-edited sections as stale if their content was regenerated
    if (sectionsRegenerated.length > 0) {
      const staleSections =
        project.editedSections?.map((es) =>
          sectionsRegenerated.includes(es.section)
            ? { ...(es.toObject?.() ?? es), stale: true }
            : es,
        ) || [];
      update.editedSections = staleSections;
    }

    emit(
      "sync",
      "done",
      `Sync complete — ${sectionsRegenerated.length} sections updated`,
      `Commit ${lastSha?.slice(0, 8)} → ${currentSha.slice(0, 8)}`,
    );

    return {
      success: true,
      skipped: false,
      currentCommit: currentSha,
      previousCommit: lastSha,
      sectionsRegenerated,
      sectionsSkipped,
      agentsRun: [...analysis.agentsNeeded],
      changedFileCount: uniquePaths.length,
      removedFileCount: removedPaths.length,
      // The caller (project.service.js) is responsible for persisting `update`
      _update: update,
    };
  } catch (err) {
    console.error("❌ Incremental sync failed:", err);
    emit("sync:error", "error", err.message, err.stack?.split("\n")[1]?.trim());
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// FULL SYNC FALLBACK
// Called when no stored state exists or manifest changed.
// Uses the regular orchestrate pipeline but also captures all
// the new fields (agentOutputs, fileManifest, commitSha).
// ─────────────────────────────────────────────────────────────

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

  // Import the regular orchestrator and run the full pipeline
  const { orchestrate } = await import("./orchestrator.js");
  const result = await orchestrate(project.repoUrl, (event) => {
    if (onProgress) onProgress(event);
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // Build fileManifest from fresh tree
  const currentTree = await getFileTreeWithSha(owner, repo, meta.defaultBranch);

  return {
    success: true,
    skipped: false,
    isFullRun: true,
    currentCommit: currentSha,
    sectionsRegenerated: [
      "readme",
      "internalDocs",
      "apiReference",
      "schemaDocs",
      "securityReport",
    ],
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
    // Full orchestrate result — stored by project.service.js
    _fullResult: result,
    _freshTree: currentTree,
  };
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function parseOwnerRepo(project) {
  const match = project.repoUrl?.match(/github\.com\/([^/]+)\/([^/?.]+)/);
  if (!match) throw new Error(`Cannot parse repoUrl: ${project.repoUrl}`);
  return { owner: match[1], repoName: match[2] };
}

function filterFilesForAgent(changedFiles, agentFileList) {
  const pathSet = new Set(agentFileList.map((f) => f.path));
  return changedFiles.filter((f) => pathSet.has(f.path));
}

function categoriseWebhookFiles(webhookFiles) {
  const added = [];
  const modified = [];
  const removed = [];
  for (const f of webhookFiles) {
    const entry = { path: f.path || f, status: f.status || "modified" };
    if (entry.status === "added") added.push(entry);
    else if (entry.status === "removed") removed.push(entry);
    else modified.push(entry);
  }
  return { added, modified, removed };
}

function buildStructure(projectMap) {
  const structure = {};
  for (const f of projectMap) {
    if (!structure[f.role]) structure[f.role] = [];
    structure[f.role].push(f.path);
  }
  return structure;
}

function recomputeSecurity(allFindings) {
  const WEIGHT = { CRITICAL: 25, HIGH: 15, MEDIUM: 7, LOW: 2 };
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let deduction = 0;

  for (const f of allFindings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
    deduction += WEIGHT[f.severity] || 0;
  }

  const score = Math.max(0, 100 - deduction);
  const grade =
    score >= 90
      ? "A"
      : score >= 75
        ? "B"
        : score >= 60
          ? "C"
          : score >= 40
            ? "D"
            : "F";
  const EMOJI = { CRITICAL: "🔴", HIGH: "🟠", MEDIUM: "🟡", LOW: "🔵" };

  let reportMarkdown = `# 🔒 Security Audit Report\n\n## Score: ${score}/100 — Grade: **${grade}**\n\n`;
  reportMarkdown += `| Severity | Count |\n|----------|-------|\n`;
  Object.entries(counts).forEach(([s, c]) => {
    reportMarkdown += `| ${EMOJI[s]} ${s} | ${c} |\n`;
  });
  reportMarkdown += "\n";

  if (!allFindings.length) {
    reportMarkdown += "✅ No issues detected.\n";
  } else {
    for (const sev of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
      const group = allFindings.filter((f) => f.severity === sev);
      if (!group.length) continue;
      reportMarkdown += `## ${EMOJI[sev]} ${sev}\n\n`;
      group.forEach((f) => {
        reportMarkdown += `### [${f.id}] ${f.title}\n**File:** \`${f.file}\`\n\n`;
        if (f.line)
          reportMarkdown += `**Detected:** \`${f.line.replace(/`/g, "'")}\`\n\n`;
        reportMarkdown += `**Fix:** ${f.advice}\n\n---\n\n`;
      });
    }
  }

  return {
    score,
    grade,
    counts,
    findings: allFindings.slice(0, 50),
    reportMarkdown,
  };
}

// Static doc builders (mirrors docWriterAgent — avoids LLM cost for structured data)
function buildApiReference(endpoints) {
  if (!endpoints?.length) return "No API endpoints detected.";
  let md = "# API Reference\n\n";
  const grouped = {};
  for (const ep of endpoints) {
    const prefix = ep.path?.split("/")?.[1] || "root";
    if (!grouped[prefix]) grouped[prefix] = [];
    grouped[prefix].push(ep);
  }
  for (const [group, eps] of Object.entries(grouped)) {
    md += `## /${group}\n\n`;
    for (const ep of eps) {
      md += `### \`${ep.method} ${ep.path}\`\n${ep.description || "No description"}\n\n`;
      md += `**Auth required:** ${ep.auth ? "✅ Yes" : "❌ No"}\n\n`;
      if (ep.params?.length) {
        md += `**Parameters:**\n\n| Name | In | Type | Required |\n|------|-----|------|----------|\n`;
        ep.params.forEach((p) => {
          md += `| \`${p.name}\` | ${p.in} | \`${p.type}\` | ${p.required ? "✅" : "❌"} |\n`;
        });
        md += "\n";
      }
      if (ep.returns) md += `**Returns:** ${ep.returns}\n\n`;
      md += "---\n\n";
    }
  }
  return md;
}

function buildSchemaDocs(models, relationships) {
  if (!models?.length) return "No data models detected.";
  let md = "# Data Models\n\n";
  for (const m of models) {
    md += `## ${m.name}\n\n`;
    if (m.description) md += `${m.description}\n\n`;
    if (m.fields?.length) {
      md += `| Field | Type | Required | Unique |\n|-------|------|----------|--------|\n`;
      m.fields.forEach((f) => {
        md += `| \`${f.name}\` | \`${f.type}\` | ${f.required ? "✅" : "❌"} | ${f.unique ? "✅" : "❌"} |\n`;
      });
      md += "\n";
    }
  }
  if (relationships?.length) {
    md += `## Relationships\n\n| From | Relationship | To | Via |\n|------|-------------|-----|-----|\n`;
    relationships.forEach((r) => {
      md += `| ${r.from} | ${r.type} | ${r.to} | ${r.through || "—"} |\n`;
    });
  }
  return md;
}

function buildSecurityReport(findings, score, grade, counts) {
  return recomputeSecurity(findings || []).reportMarkdown;
}

// ── Update only the commit SHA (when tree unchanged) ──────────
async function updateCommitSha(project, sha) {
  const { Project } = await import("../models/Project.js");
  await Project.findByIdAndUpdate(project._id, { lastDocumentedCommit: sha });
}
