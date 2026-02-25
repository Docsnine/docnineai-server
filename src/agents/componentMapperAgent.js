// src/agents/componentMapperAgent.js
// ─────────────────────────────────────────────────────────────
// AGENT 4 — Component Mapper
// ─────────────────────────────────────────────────────────────
// BATCHING STRATEGY:
//   Old: 1 file → 1 LLM call = 30 calls for 30 components
//   New: 4 files → 1 LLM call = ~8 calls for 30 components
//
//   Component purpose is clear from exports + function signatures
//   at the top of each file. 4 files × 200 chars = ~800 chars
//   = ~230 tokens — very efficient per call.
// ─────────────────────────────────────────────────────────────

import { llmCall } from "../config/llm.js";

const SYSTEM_PROMPT = `You are a senior software engineer reviewing a codebase.
Analyse these source files and return documentation for each component.
Return ONLY a valid JSON array (no markdown, no explanation):
[{
  "name": "AuthMiddleware",
  "file": "middleware/auth.ts",
  "type": "middleware | service | utility | config | helper | hook | component | other",
  "description": "One sentence: what this component does",
  "exports": ["verifyToken", "requireAdmin"],
  "dependencies": ["jsonwebtoken", "./userService"]
}]`;

const TARGET_ROLES = new Set([
  "service",
  "middleware",
  "utility",
  "config",
  "helper",
  "frontend",
  "hook",
]);
const PATH_REGEX =
  /middleware|service|util|helper|hook|config|context|provider|store|component|\.config\./i;
const EXCLUDE_REGEX = /route|controller|handler|model|schema|entity|migration/i;

const FILES_PER_BATCH = 4;
const CHARS_PER_FILE = 200; // exports + top-level function names only
const MAX_FILES = 30;

export async function componentMapperAgent({ files, projectMap, structure }) {
  console.log("🔧 [Agent 4] ComponentMapper — documenting components…");

  const targetFiles = files
    .filter((f) => {
      const meta = projectMap.find((m) => m.path === f.path);
      const roleMatch = meta && TARGET_ROLES.has(meta.role);
      const pathMatch = PATH_REGEX.test(f.path) && !EXCLUDE_REGEX.test(f.path);
      return roleMatch || pathMatch;
    })
    .slice(0, MAX_FILES);

  console.log(
    `   ↳ ${targetFiles.length} component files → ${Math.ceil(targetFiles.length / FILES_PER_BATCH)} batched LLM calls`,
  );

  const components = [];

  for (let i = 0; i < targetFiles.length; i += FILES_PER_BATCH) {
    const batch = targetFiles.slice(i, i + FILES_PER_BATCH);

    const userContent = batch
      .map(
        (f) => `=== FILE: ${f.path} ===\n${f.content.slice(0, CHARS_PER_FILE)}`,
      )
      .join("\n\n");

    try {
      const raw = await llmCall({ systemPrompt: SYSTEM_PROMPT, userContent });
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) components.push(...parsed);
    } catch {
      // Fallback: generate entries from projectMap without LLM
      for (const file of batch) {
        const meta = projectMap.find((m) => m.path === file.path);
        components.push({
          name: file.path
            .split("/")
            .pop()
            .replace(/\.[^.]+$/, ""),
          file: file.path,
          type: meta?.role || "utility",
          description: meta?.summary || "No description available",
          exports: [],
          dependencies: [],
        });
      }
    }
  }

  console.log(`   ✅ Mapped ${components.length} components`);
  return { components };
}
