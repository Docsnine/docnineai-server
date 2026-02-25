// src/agents/componentMapperAgent.js — Agent 4: Component Mapper

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
const CHARS_PER_FILE = 200;
const MAX_FILES = 30;

export async function componentMapperAgent({
  files,
  projectMap,
  structure,
  emit,
}) {
  const notify = (msg, detail) => {
    if (emit) emit(msg, detail);
  };

  const targetFiles = files
    .filter((f) => {
      const meta = projectMap.find((m) => m.path === f.path);
      return (
        (meta && TARGET_ROLES.has(meta.role)) ||
        (PATH_REGEX.test(f.path) && !EXCLUDE_REGEX.test(f.path))
      );
    })
    .slice(0, MAX_FILES);

  const totalBatches = Math.ceil(targetFiles.length / FILES_PER_BATCH);
  notify(
    `Found ${targetFiles.length} component files`,
    `${totalBatches} batched LLM calls`,
  );

  const components = [];

  for (let i = 0; i < targetFiles.length; i += FILES_PER_BATCH) {
    const batchNum = Math.floor(i / FILES_PER_BATCH) + 1;
    const batch = targetFiles.slice(i, i + FILES_PER_BATCH);
    notify(`Documenting components…`, `Batch ${batchNum} of ${totalBatches}`);

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
      for (const file of batch) {
        const meta = projectMap.find((m) => m.path === file.path);
        components.push({
          name: file.path
            .split("/")
            .pop()
            .replace(/\.[^.]+$/, ""),
          file: file.path,
          type: meta?.role || "utility",
          description: meta?.summary || "No description",
          exports: [],
          dependencies: [],
        });
      }
    }
  }

  notify(`${components.length} components documented`);
  return { components };
}
