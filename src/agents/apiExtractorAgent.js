// src/agents/apiExtractorAgent.js
// ─────────────────────────────────────────────────────────────
// AGENT 2 — API Extractor
// ─────────────────────────────────────────────────────────────
// BATCHING STRATEGY:
//   Old: 1 file → multiple chunk calls = many calls for 25 files
//   New: 2 route files → 1 LLM call = ~13 calls for 25 files
//
//   Route files are small (mostly decorator/app.get declarations)
//   so 2 files × 350 chars fits comfortably in one call.
//   We only need the route declarations, not the handler bodies.
// ─────────────────────────────────────────────────────────────

import { llmCall } from "../config/llm.js";

const SYSTEM_PROMPT = `You are an API documentation specialist.
Analyse these source files and extract all HTTP endpoints.
Return ONLY a valid JSON array (no markdown, no explanation):
[{
  "method": "GET|POST|PUT|DELETE|PATCH",
  "path": "/api/example",
  "description": "What this endpoint does in one sentence",
  "params": [{ "name": "id", "in": "path|query|body", "type": "string", "required": true }],
  "returns": "Brief response description",
  "auth": true
}]
If no endpoints found, return [].`;

const ROUTE_ROLES = new Set(["route", "controller", "entry"]);
const ROUTE_REGEX =
  /router\.(get|post|put|delete|patch)\s*\(|app\.(get|post|put|delete|patch)\s*\(|@(Get|Post|Put|Delete|Patch|Request)\s*\(|path\s*=\s*['"]\/|urlpatterns\s*=|fastify\.(get|post)|createRouter/i;
const PATH_REGEX = /route|controller|handler|endpoint/i;

// Files packed per LLM call
const FILES_PER_BATCH = 2;
// Chars per file — route declarations are near top of file
const CHARS_PER_FILE = 400;
// Hard cap
const MAX_ROUTE_FILES = 25;

export async function apiExtractorAgent({ files, projectMap }) {
  console.log("🌐 [Agent 2] ApiExtractor — extracting endpoints…");

  const routeFiles = files
    .filter((f) => {
      const meta = projectMap.find((m) => m.path === f.path);
      return (
        (meta && ROUTE_ROLES.has(meta.role)) ||
        ROUTE_REGEX.test(f.content) ||
        PATH_REGEX.test(f.path)
      );
    })
    .slice(0, MAX_ROUTE_FILES);

  console.log(
    `   ↳ ${routeFiles.length} route files → ${Math.ceil(routeFiles.length / FILES_PER_BATCH)} batched LLM calls`,
  );

  const allEndpoints = [];

  for (let i = 0; i < routeFiles.length; i += FILES_PER_BATCH) {
    const batch = routeFiles.slice(i, i + FILES_PER_BATCH);

    const userContent = batch
      .map(
        (f) => `=== FILE: ${f.path} ===\n${f.content.slice(0, CHARS_PER_FILE)}`,
      )
      .join("\n\n");

    try {
      const raw = await llmCall({ systemPrompt: SYSTEM_PROMPT, userContent });
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        allEndpoints.push(
          ...parsed.map((ep) => ({ ...ep, file: batch[0].path })),
        );
      }
    } catch {
      // No endpoints in this batch
    }
  }

  // Deduplicate by method + path
  const seen = new Set();
  const endpoints = allEndpoints.filter((ep) => {
    if (!ep.method || !ep.path) return false;
    const key = `${ep.method}:${ep.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`   ✅ Extracted ${endpoints.length} unique endpoints`);
  return { endpoints };
}
