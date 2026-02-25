// src/agents/apiExtractorAgent.js
// ─────────────────────────────────────────────────────────────
// AGENT 2 — API Extractor
// ─────────────────────────────────────────────────────────────
// Skill : Parse route/controller files → structured API docs
// Input : { files, projectMap }
// Output: { endpoints[] }
//   endpoint: { method, path, description, params, returns, auth }
// ─────────────────────────────────────────────────────────────

import { llmCall } from "../config/llm.js";
import { chunkText, formatBatch, batchChunks } from "../utils/tokenManager.js";

const SYSTEM_PROMPT = `You are an API documentation specialist.
Analyse the given source code and extract all HTTP endpoints.
Return ONLY a valid JSON array (no markdown):
[{
  "method"     : "GET|POST|PUT|DELETE|PATCH",
  "path"       : "/api/example",
  "description": "What this endpoint does",
  "params"     : [{ "name": "id", "in": "path|query|body", "type": "string", "required": true }],
  "returns"    : "Description of response",
  "auth"       : true | false
}]
If no endpoints found, return [].`;

export async function apiExtractorAgent({ files, projectMap }) {
  console.log("🌐 [Agent 2] ApiExtractor — extracting endpoints…");

  // Only look at route/controller files
  const ROUTE_ROLES = new Set(["route", "controller", "entry"]);
  // Cast wider net — detect routes by content patterns, not just classified role
  const ROUTE_REGEX =
    /router\.(get|post|put|delete|patch)\s*\(|app\.(get|post|put|delete|patch)\s*\(|@(Get|Post|Put|Delete|Patch|Request)\s*\(|path\s*=\s*['"]\/|urlpatterns\s*=|Route\(|\.route\(['"]|fastify\.(get|post|put|delete)|hono\.(get|post)|createRouter/i;

  const routeFiles = files.filter((f) => {
    const meta = projectMap.find((m) => m.path === f.path);
    const roleMatch = meta && ROUTE_ROLES.has(meta.role);
    const contentMatch = ROUTE_REGEX.test(f.content);
    // Also catch files with "route" or "controller" in their path
    const pathMatch = /route|controller|handler|endpoint/i.test(f.path);
    return roleMatch || contentMatch || pathMatch;
  });

  console.log(`   ↳ Found ${routeFiles.length} route/controller files`);

  const allEndpoints = [];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const [fileIdx, file] of routeFiles.entries()) {
    const chunks = chunkText(file.content, 450);
    const batches = batchChunks(chunks, 3);

    for (const [idx, batch] of batches.entries()) {
      const userContent = `FILE: ${file.path}\n\n${formatBatch(batch)}`;
      try {
        const raw = await llmCall({ systemPrompt: SYSTEM_PROMPT, userContent });
        const parsed = JSON.parse(raw);
        allEndpoints.push(...parsed.map((ep) => ({ ...ep, file: file.path })));
      } catch {
        // non-route chunk — skip silently
      }
      if (fileIdx < routeFiles.length - 1 || idx < batches.length - 1)
        await sleep(250);
    }
  }

  // Deduplicate by method+path
  const seen = new Set();
  const endpoints = allEndpoints.filter((ep) => {
    const key = `${ep.method}:${ep.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`   ✅ Extracted ${endpoints.length} unique endpoints`);
  return { endpoints };
}
