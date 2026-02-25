// ===================================================================
// Agent 1: Repo Scanner 
// ===================================================================

import { llmCall } from "../config/llm.js";
import { sortAndFilterFiles } from "../utils/token-manager.util.js";

const SYSTEM_PROMPT = `You are a senior software architect performing a codebase audit.
Given a batch of file paths and snippets, classify each file into one of:
  controller | route | model | service | middleware | utility | config | test | frontend | schema | migration | entry | other

Return ONLY a valid JSON array (no markdown, no explanation):
[{ "path": "...", "role": "...", "summary": "one sentence max" }]`;

export async function repoScannerAgent({ files, meta, emit }) {
  const notify = (msg, detail) => {
    if (emit) emit(msg, detail);
  };
  notify("Classifying files with AI…", "Agent 1 — Repo Scanner");

  const relevant = sortAndFilterFiles(files);
  const BATCH = 8;
  const total = Math.ceil(relevant.length / BATCH);
  const classified = [];

  for (let i = 0; i < relevant.length; i += BATCH) {
    const batchNum = Math.floor(i / BATCH) + 1;
    notify(`Classifying files…`, `Batch ${batchNum} of ${total}`);

    const batch = relevant.slice(i, i + BATCH).map((f) => ({
      path: f.path,
      snippet: f.content.slice(0, 300).replace(/\n/g, " "),
    }));

    const userContent = batch
      .map((f) => `FILE: ${f.path}\nSNIPPET: ${f.snippet}`)
      .join("\n\n---\n\n");

    try {
      const raw = await llmCall({ systemPrompt: SYSTEM_PROMPT, userContent });
      const parsed = JSON.parse(raw);
      classified.push(...parsed);
    } catch {
      // batch failed — skip
    }
  }

  const techStack = detectTechStack(files);
  const entryPoints = classified
    .filter((f) => f.role === "entry")
    .map((f) => f.path);
  const structure = groupByRole(classified);

  // Role distribution summary for progress
  const dist = {};
  classified.forEach((f) => {
    dist[f.role] = (dist[f.role] || 0) + 1;
  });
  const distStr = Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}:${n}`)
    .join(" · ");

  notify(`${classified.length} files classified`, distStr);
  console.log(`   📊 Role distribution: ${JSON.stringify(dist)}`);

  return { projectMap: classified, techStack, entryPoints, structure };
}

function detectTechStack(files) {
  const paths = files.map((f) => f.path).join("\n");
  const manifests = files
    .filter((f) =>
      /package\.json$|requirements\.txt$|Cargo\.toml$|go\.mod$|pom\.xml$/.test(
        f.path,
      ),
    )
    .map((f) => f.content.slice(0, 1000))
    .join("\n");
  const allContent = files
    .slice(0, 30)
    .map((f) => f.content.slice(0, 200))
    .join("\n");
  const combined = manifests + "\n" + allContent;
  const stack = [];

  if (/package\.json/i.test(paths)) {
    stack.push("Node.js");
    if (/\"react\"/i.test(combined)) stack.push("React");
    if (/\"express\"/i.test(combined)) stack.push("Express");
    if (/\"next\"/i.test(combined)) stack.push("Next.js");
    if (/\"vue\"/i.test(combined)) stack.push("Vue");
    if (/\"typescript\"|ts-node/i.test(combined)) stack.push("TypeScript");
    if (/\"prisma\"/i.test(combined)) stack.push("Prisma");
    if (/\"mongoose\"|\"mongodb\"/i.test(combined)) stack.push("MongoDB");
    if (/\"sequelize\"|\"mysql2\"|\"pg\"/i.test(combined)) stack.push("SQL DB");
    if (/\"jsonwebtoken\"/i.test(combined)) stack.push("JWT Auth");
    if (/\"socket\.io\"/i.test(combined)) stack.push("WebSockets");
  }
  if (/requirements\.txt/i.test(paths)) {
    stack.push("Python");
    if (/django/i.test(combined)) stack.push("Django");
    if (/flask/i.test(combined)) stack.push("Flask");
    if (/fastapi/i.test(combined)) stack.push("FastAPI");
  }
  if (/Cargo\.toml/i.test(paths)) stack.push("Rust");
  if (/go\.mod/i.test(paths)) stack.push("Go");
  if (/pom\.xml/i.test(paths)) stack.push("Java/Maven");
  if (/Dockerfile/i.test(paths)) stack.push("Docker");
  if (/docker-compose/i.test(paths)) stack.push("Docker Compose");

  if (!stack.length) {
    if (/\.py$/m.test(paths)) stack.push("Python");
    if (/\.go$/m.test(paths)) stack.push("Go");
    if (/\.rs$/m.test(paths)) stack.push("Rust");
    if (/\.java$/m.test(paths)) stack.push("Java");
    if (/\.ts$/m.test(paths)) stack.push("TypeScript");
    if (/\.js$/m.test(paths)) stack.push("JavaScript");
    if (/\.rb$/m.test(paths)) stack.push("Ruby");
    if (/\.php$/m.test(paths)) stack.push("PHP");
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
