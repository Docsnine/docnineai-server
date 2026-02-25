// src/services/orchestrator.js
// ─────────────────────────────────────────────────────────────
// Orchestrator v2 — 6-agent pipeline
// ─────────────────────────────────────────────────────────────
// Execution order:
//   GitHub fetch
//   → Agent 1 (Scanner)           [sequential — others depend on it]
//   → Agents 2,3,4,6 in parallel  [independent reads]
//   → Agent 5 (DocWriter)         [needs all above]
// ─────────────────────────────────────────────────────────────

import { fetchRepoFiles }         from "./githubService.js";
import { repoScannerAgent }       from "../agents/repoScannerAgent.js";
import { apiExtractorAgent }      from "../agents/apiExtractorAgent.js";
import { schemaAnalyserAgent }    from "../agents/schemaAnalyserAgent.js";
import { componentMapperAgent }   from "../agents/componentMapperAgent.js";
import { docWriterAgent }         from "../agents/docWriterAgent.js";
import { securityAuditorAgent }   from "../agents/securityAuditorAgent.js";
import { createChatSession, getSuggestedQuestions } from "./chatService.js";

export async function orchestrate(repoUrl, onProgress) {
  const log = (step, msg) => {
    console.log(`[${step}] ${msg}`);
    if (onProgress) onProgress({ step, msg, ts: Date.now() });
  };

  try {
    // ── STEP 0: Fetch ───────────────────────────────────────
    log("fetch", `🚀 Fetching repo: ${repoUrl}`);
    const { meta, files, owner, repo } = await fetchRepoFiles(repoUrl);
    log("fetch", `✅ Fetched ${files.length} files from ${owner}/${repo}`);

    // ── STEP 1: Scan & classify ─────────────────────────────
    log("scan", "🔍 Running Agent 1: Repo Scanner");
    const { projectMap, techStack, entryPoints, structure } =
      await repoScannerAgent({ files, meta });
    log("scan", `✅ Tech stack: ${techStack.join(", ") || "detected"}`);

    // ── STEPS 2, 3, 4, 6: Parallel ─────────────────────────
    log("parallel", "⚡ Running Agents 2, 3, 4 & 6 in parallel");
    const [
      { endpoints },
      { models, relationships },
      { components },
      { findings, score, grade, counts, reportMarkdown },
    ] = await Promise.all([
      apiExtractorAgent   ({ files, projectMap }),
      schemaAnalyserAgent ({ files, projectMap }),
      componentMapperAgent({ files, projectMap, structure }),
      securityAuditorAgent({ files }),
    ]);

    log("parallel", `✅ APIs:${endpoints.length} | Models:${models.length} | Components:${components.length} | Security:${score}/100(${grade})`);

    // ── STEP 5: Write docs ──────────────────────────────────
    log("write", "✍️  Running Agent 5: Doc Writer");
    const { readme, internalDocs, apiReference, schemaDocs } =
      await docWriterAgent({
        meta, techStack, structure, endpoints,
        models, relationships, components, entryPoints, owner, repo,
      });

    // ── STEP 6: Create chat session ─────────────────────────
    log("chat", "💬 Initialising chat session");
    const output = { readme, internalDocs, apiReference, schemaDocs, securityReport: reportMarkdown };
    const jobId  = `${owner}-${repo}-${Date.now()}`;
    createChatSession({ jobId, output, meta });
    const suggestedQuestions = getSuggestedQuestions(output);

    log("done", "🎉 Documentation complete!");

    const stats = {
      filesAnalysed: files.length,
      endpoints    : endpoints.length,
      models       : models.length,
      relationships: relationships.length,
      components   : components.length,
    };

    return {
      success : true,
      repoUrl, owner, repo, meta, techStack, stats,
      security: { score, grade, counts, findings: findings.slice(0, 50) },
      output,
      chat    : { sessionId: jobId, suggestedQuestions },
    };
  } catch (err) {
    console.error("❌ Orchestration failed:", err);
    return { success: false, error: err.message, stack: err.stack };
  }
}
