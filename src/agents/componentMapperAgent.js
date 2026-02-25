// src/agents/componentMapperAgent.js
// ─────────────────────────────────────────────────────────────
// AGENT 4 — Component Mapper
// ─────────────────────────────────────────────────────────────
// Skill : Document every non-route, non-model component
// Input : { files, projectMap, structure }
// Output: { components[] }
//   component: { name, file, type, description, exports[], dependencies[] }
// ─────────────────────────────────────────────────────────────

import { llmCall } from "../config/llm.js";
import { chunkText, batchChunks, formatBatch } from "../utils/tokenManager.js";

const SYSTEM_PROMPT = `You are a senior software engineer reviewing a codebase.
Analyse the given source code component and return structured documentation.
Return ONLY valid JSON (no markdown):
{
  "name"        : "AuthMiddleware",
  "file"        : "middleware/auth.js",
  "type"        : "middleware | service | utility | config | helper | hook | component | other",
  "description" : "Verifies JWT tokens on protected routes",
  "exports"     : ["verifyToken", "requireAdmin"],
  "dependencies": ["jsonwebtoken", "./userService"]
}`;

export async function componentMapperAgent({ files, projectMap, structure }) {
  console.log("🔧 [Agent 4] ComponentMapper — documenting components…");

  const TARGET_ROLES = new Set(["service", "middleware", "utility", "config", "helper", "frontend", "hook"]);

  // Also match by path patterns as a fallback when LLM classification was unreliable
  const PATH_ROLE_REGEX = /middleware|service|util|helper|hook|config|context|provider|store|component|\.config\./i;

  const targetFiles = files.filter((f) => {
    const meta = projectMap.find((m) => m.path === f.path);
    const roleMatch = meta && TARGET_ROLES.has(meta.role);
    const pathMatch = PATH_ROLE_REGEX.test(f.path);
    // Exclude routes/models — they're handled by other agents
    const notRoute  = !/route|controller|handler|model|schema|entity|migration/i.test(f.path);
    return (roleMatch || (pathMatch && notRoute));
  }).slice(0, 30); // Hard cap — no need to document every utility file

  console.log(`   ↳ Processing ${targetFiles.length} component files`);

  const components = [];

  for (const file of targetFiles) {
    const chunks  = chunkText(file.content, 400);
    // For components, just use the first chunk — enough for summary
    const userContent = `FILE: ${file.path}\n\n${chunks[0]}`;
    try {
      const raw    = await llmCall({ systemPrompt: SYSTEM_PROMPT, userContent });
      const parsed = JSON.parse(raw);
      components.push(parsed);
    } catch {
      // Fallback: use the projectMap summary
      const meta = projectMap.find((m) => m.path === file.path);
      if (meta) {
        components.push({
          name        : file.path.split("/").pop().replace(/\.[^.]+$/, ""),
          file        : file.path,
          type        : meta.role,
          description : meta.summary || "No description available",
          exports     : [],
          dependencies: [],
        });
      }
    }
  }

  console.log(`   ✅ Mapped ${components.length} components`);
  return { components };
}
