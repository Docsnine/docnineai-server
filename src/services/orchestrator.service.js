// =============================================================
// Full pipeline: all 6 agents, all doc sections.
//
// v3.1 change: also captures and returns raw agent outputs
// (endpoints, models, components, findings, projectMap) and the
// current git commit SHA + file tree with SHAs. This lets
// project.service.js store them for incremental sync later.
//
// Progress event schema:
//   { step, status: "running"|"done"|"error"|"waiting", msg, detail, ts }
// =============================================================

import {
  fetchRepoFilesWithProgress,
  getCommitSha,
  getFileTreeWithSha,
  parseRepoUrl,
} from "./githubService.js";

import { repoScannerAgent } from "../agents/repoScannerAgent.js";
import { apiExtractorAgent } from "../agents/apiExtractorAgent.js";
import { schemaAnalyserAgent } from "../agents/schemaAnalyserAgent.js";
import { componentMapperAgent } from "../agents/componentMapperAgent.js";
import { docWriterAgent } from "../agents/docWriterAgent.js";
import { securityAuditorAgent } from "../agents/securityAuditorAgent.js";
import { createChatSession, getSuggestedQuestions } from "./chatService.js";
import { updateFileManifest } from "./diffService.js";

export async function orchestrate(repoUrl, onProgress) {
  const emit = (step, status, msg, detail = null) => {
    const event = { step, status, msg, detail, ts: Date.now() };
    console.log(`[${step}:${status}] ${msg}${detail ? " — " + detail : ""}`);
    if (onProgress) onProgress(event);
  };

  try {
    // ── STEP 1: Fetch repo ────────────────────────────────────
    emit("fetch", "running", "Connecting to GitHub…");
    const { meta, files, owner, repo } = await fetchRepoFilesWithProgress(
      repoUrl,
      (msg) => emit("fetch", "running", msg),
    );
    emit(
      "fetch",
      "done",
      `${files.length} files downloaded`,
      `${owner}/${repo}`,
    );

    // Capture commit SHA and file tree with SHAs for incremental sync
    // These run in parallel with the repo scan since they're lightweight API calls
    const [currentCommitSha, treeWithSha] = await Promise.all([
      getCommitSha(owner, repo, meta.defaultBranch).catch(() => null),
      getFileTreeWithSha(owner, repo, meta.defaultBranch).catch(() => []),
    ]);

    // ── STEP 2: Repo Scanner ──────────────────────────────────
    emit(
      "scan",
      "running",
      "Classifying files with AI…",
      "Agent 1 — Repo Scanner",
    );
    const { projectMap, techStack, entryPoints, structure } =
      await repoScannerAgent({
        files,
        meta,
        emit: (msg, detail) => emit("scan", "running", msg, detail),
      });
    emit(
      "scan",
      "done",
      `${projectMap.length} files classified`,
      techStack.join(" · ") || "Stack detected",
    );

    // ── STEPS 3–6: Parallel agents ────────────────────────────
    emit("api", "running", "Extracting API endpoints…", "Agent 2");
    emit("schema", "running", "Analysing data models…", "Agent 3");
    emit("components", "running", "Mapping components…", "Agent 4");
    emit("security", "running", "Running security audit…", "Agent 6");

    const [
      { endpoints },
      { models, relationships },
      { components },
      { findings, score, grade, counts, reportMarkdown },
    ] = await Promise.all([
      apiExtractorAgent({
        files,
        projectMap,
        emit: (msg, detail) => emit("api", "running", msg, detail),
      }),
      schemaAnalyserAgent({
        files,
        projectMap,
        emit: (msg, detail) => emit("schema", "running", msg, detail),
      }),
      componentMapperAgent({
        files,
        projectMap,
        structure,
        emit: (msg, detail) => emit("components", "running", msg, detail),
      }),
      securityAuditorAgent({
        files,
        emit: (msg, detail) => emit("security", "running", msg, detail),
      }),
    ]);

    emit("api", "done", `${endpoints.length} endpoints extracted`);
    emit(
      "schema",
      "done",
      `${models.length} models, ${relationships.length} relationships`,
    );
    emit("components", "done", `${components.length} components mapped`);
    emit(
      "security",
      "done",
      `Security score: ${score}/100 (Grade ${grade})`,
      `Critical:${counts.CRITICAL} High:${counts.HIGH} Medium:${counts.MEDIUM} Low:${counts.LOW}`,
    );

    // ── STEP 7: Doc Writer ────────────────────────────────────
    emit("write", "running", "Writing README.md…", "Agent 5 — Doc Writer");
    const { readme, internalDocs, apiReference, schemaDocs } =
      await docWriterAgent({
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
        emit: (msg, detail) => emit("write", "running", msg, detail),
      });
    emit("write", "done", "All documentation generated");

    // ── STEP 8: Chat session ──────────────────────────────────
    emit("chat", "running", "Setting up chat session…");
    const output = {
      readme,
      internalDocs,
      apiReference,
      schemaDocs,
      securityReport: reportMarkdown,
    };
    const sessionId = `${owner}-${repo}-${Date.now()}`;
    createChatSession({ jobId: sessionId, output, meta });
    const suggestedQuestions = getSuggestedQuestions(output);
    emit("chat", "done", "Chat ready — ask anything about this codebase");

    // ── Build fileManifest for incremental sync ───────────────
    const fileManifest = updateFileManifest([], treeWithSha, projectMap);

    // ── Stats ─────────────────────────────────────────────────
    const stats = {
      filesAnalysed: files.length,
      endpoints: endpoints.length,
      models: models.length,
      relationships: relationships.length,
      components: components.length,
    };

    emit(
      "done",
      "done",
      "Documentation complete 🎉",
      `${files.length} files · ${endpoints.length} endpoints · ${models.length} models`,
    );

    return {
      success: true,
      repoUrl,
      owner,
      repo,
      meta,
      techStack,
      stats,
      security: { score, grade, counts, findings: findings.slice(0, 50) },
      output,
      chat: { sessionId, suggestedQuestions },

      // ── v3.1: incremental sync baseline ──────────────────────
      // Stored in Project so future syncs only re-run what changed.
      lastDocumentedCommit: currentCommitSha,
      fileManifest,
      agentOutputs: {
        endpoints,
        models,
        relationships,
        components,
        findings: findings.slice(0, 200), // keep more for merge accuracy
        projectMap,
      },
    };
  } catch (err) {
    console.error("❌ Orchestration failed:", err);
    emit("error", "error", err.message, err.stack?.split("\n")[1]?.trim());
    return { success: false, error: err.message };
  }
}
