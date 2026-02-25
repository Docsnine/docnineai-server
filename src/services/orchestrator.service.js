// src/services/orchestrator.js — v3 with granular progress events
// ─────────────────────────────────────────────────────────────
// Progress event schema:
//   { step, status: "running"|"done"|"error"|"waiting",
//     msg, detail, ts }
//
// Every agent receives an `emit` callback so it can broadcast
// its own sub-step messages (batch N/M, throttle waits, etc.)
// ─────────────────────────────────────────────────────────────

import { fetchRepoFiles, fetchRepoFilesWithProgress } from "./githubService.js";
import { repoScannerAgent } from "../agents/repo-scanner.agent.js";
import { apiExtractorAgent } from "../agents/api-extractor.agent.js";
import { schemaAnalyserAgent } from "../agents/schema-analyser.agent.js";
import { componentMapperAgent } from "../agents/component-mapper.agent.js";
import { docWriterAgent } from "../agents/doc-writer.agent.js";
import { securityAuditorAgent } from "../agents/security-auditor.agent.js";
import { createChatSession, getSuggestedQuestions } from "./chat.service.js";

export async function orchestrate(repoUrl, onProgress) {
  // all progress flows through here
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
      (msg) => emit("fetch", "running", msg), // pass sub-progress into githubService
    );
    emit(
      "fetch",
      "done",
      `${files.length} files downloaded`,
      `${owner}/${repo}`,
    );

    // ── STEP 2: Repo Scanner (Agent 1) ────────────────────────
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
    emit(
      "api",
      "running",
      "Extracting API endpoints…",
      "Agent 2 — scanning route files",
    );
    emit(
      "schema",
      "running",
      "Analysing data models…",
      "Agent 3 — scanning schema files",
    );
    emit(
      "components",
      "running",
      "Mapping components…",
      "Agent 4 — services, middleware, utilities",
    );
    emit(
      "security",
      "running",
      "Running security audit…",
      "Agent 6 — static scan + AI deep scan",
    );

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

    // ── STEP 7: Doc Writer (Agent 5) ──────────────────────────
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

    // ── Done ──────────────────────────────────────────────────
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
    };
  } catch (err) {
    console.error("❌ Orchestration failed:", err);
    emit("error", "error", err.message, err.stack?.split("\n")[1]?.trim());
    return { success: false, error: err.message };
  }
}
