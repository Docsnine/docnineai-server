// src/agents/repoScannerAgent.js
// ─────────────────────────────────────────────────────────────
// AGENT 1 — Repo Scanner
// ─────────────────────────────────────────────────────────────
// Skill : Classify every file in the repo by type/role
// Input : { files: [{path, content}], meta }
// Output: { projectMap, techStack, entryPoints, structure }
// ─────────────────────────────────────────────────────────────

import { llmCall } from "../config/llm.js";
import { sortAndFilterFiles, chunkText, batchChunks, formatBatch } from "../utils/tokenManager.js";

const SYSTEM_PROMPT = `You are a senior software architect performing a codebase audit.
Given a batch of file paths and snippets, classify each file into one of:
  controller | route | model | service | middleware | utility | config | test | frontend | schema | migration | entry | other

Return ONLY a valid JSON array (no markdown, no explanation):
[{ "path": "...", "role": "...", "summary": "one sentence max" }]`;

export async function repoScannerAgent({ files, meta }) {
  console.log("🔍 [Agent 1] RepoScanner — classifying files…");

  const relevant = sortAndFilterFiles(files);

  // Build compact file summaries (first 300 chars per file)
  const fileSummaries = relevant.map((f) => ({
    path   : f.path,
    snippet: f.content.slice(0, 300).replace(/\n/g, " "),
  }));

  // Chunk into batches of 8 files per LLM call
  const BATCH = 8;
  const batches = [];
  for (let i = 0; i < fileSummaries.length; i += BATCH) {
    batches.push(fileSummaries.slice(i, i + BATCH));
  }

  const classified = [];
  for (const [idx, batch] of batches.entries()) {
    console.log(`   ↳ batch ${idx + 1}/${batches.length}`);
    const userContent = batch
      .map((f) => `FILE: ${f.path}\nSNIPPET: ${f.snippet}`)
      .join("\n\n---\n\n");

    try {
      const raw    = await llmCall({ systemPrompt: SYSTEM_PROMPT, userContent });
      const parsed = JSON.parse(raw);
      classified.push(...parsed);
    } catch (err) {
      console.warn(`   ⚠️  Parse error on batch ${idx + 1}:`, err.message);
    }
  }

  // Build project map
  const techStack    = detectTechStack(files);
  const entryPoints  = classified.filter((f) => f.role === "entry").map((f) => f.path);
  const structure    = groupByRole(classified);

  console.log(`   ✅ Classified ${classified.length} files. Tech: ${techStack.join(", ") || "unknown (check manifests)"}`);
  // Debug: show role distribution
  const dist = {};
  classified.forEach((f) => { dist[f.role] = (dist[f.role] || 0) + 1; });
  console.log("   📊 Role distribution:", JSON.stringify(dist));
  return { projectMap: classified, techStack, entryPoints, structure };
}

// ── helpers ──────────────────────────────────────────────────
function detectTechStack(files) {
  const paths = files.map((f) => f.path).join("\n");

  // Find manifest files and read their content
  const manifests = files
    .filter((f) => /package\.json$|requirements\.txt$|Cargo\.toml$|go\.mod$|pom\.xml$/.test(f.path))
    .map((f) => f.content.slice(0, 1000))
    .join("\n");

  // Also scan all file content for framework signatures
  const allContent = files
    .slice(0, 30) // scan first 30 files for speed
    .map((f) => f.content.slice(0, 200))
    .join("\n");

  const combined = manifests + "\n" + allContent;
  const stack = [];

  if (/package\.json/i.test(paths)) {
    stack.push("Node.js");
    if (/\"react\"/i.test(combined))      stack.push("React");
    if (/\"express\"/i.test(combined))    stack.push("Express");
    if (/\"next\"/i.test(combined))       stack.push("Next.js");
    if (/\"vue\"/i.test(combined))        stack.push("Vue");
    if (/\"typescript\"|ts-node/i.test(combined)) stack.push("TypeScript");
    if (/\"prisma\"/i.test(combined))     stack.push("Prisma");
    if (/\"mongoose\"|\"mongodb\"/i.test(combined)) stack.push("MongoDB");
    if (/\"sequelize\"|\"mysql2\"|\"pg\"/i.test(combined)) stack.push("SQL DB");
    if (/\"jsonwebtoken\"/i.test(combined)) stack.push("JWT Auth");
    if (/\"socket\.io\"/i.test(combined)) stack.push("WebSockets");
  }
  if (/requirements\.txt/i.test(paths)) {
    stack.push("Python");
    if (/django/i.test(combined))   stack.push("Django");
    if (/flask/i.test(combined))    stack.push("Flask");
    if (/fastapi/i.test(combined))  stack.push("FastAPI");
  }
  if (/Cargo\.toml/i.test(paths))     stack.push("Rust");
  if (/go\.mod/i.test(paths))         stack.push("Go");
  if (/pom\.xml/i.test(paths))        stack.push("Java/Maven");
  if (/Dockerfile/i.test(paths))      stack.push("Docker");
  if (/docker-compose/i.test(paths))  stack.push("Docker Compose");

  // Detect by file extensions as fallback
  if (!stack.length) {
    if (/\.py$/m.test(paths))   stack.push("Python");
    if (/\.go$/m.test(paths))   stack.push("Go");
    if (/\.rs$/m.test(paths))   stack.push("Rust");
    if (/\.java$/m.test(paths)) stack.push("Java");
    if (/\.ts$/m.test(paths))   stack.push("TypeScript");
    if (/\.js$/m.test(paths))   stack.push("JavaScript");
    if (/\.rb$/m.test(paths))   stack.push("Ruby");
    if (/\.php$/m.test(paths))  stack.push("PHP");
  }

  return [...new Set(stack)];
}

function groupByRole(classified) {
  const map = {};
  for (const f of classified) {
    if (!map[f.role]) map[f.role] = [];
    map[f.role].push(f.path);
  }
  return map;
}
