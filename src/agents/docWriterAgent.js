// src/agents/docWriterAgent.js
// ─────────────────────────────────────────────────────────────
// AGENT 5 — Doc Writer
// ─────────────────────────────────────────────────────────────
// TOKEN BUDGET STRATEGY (Groq free tier = 6,000 TPM)
//
//  Problem: 73 models + 79 relationships + 30 components as
//           pretty-printed JSON = 20,000+ tokens. Instant 413.
//
//  Solution — three rules:
//    1. Build COMPRESSED context (no JSON.stringify indentation)
//    2. README and Internal Docs get DIFFERENT lean payloads
//       — README gets: meta, tech, endpoints, model NAMES only
//       — Internal gets: structure, components, relationships summary
//    3. API Reference + Schema Docs are built STATICALLY
//       (no LLM call needed — pure string builders)
//
//  Result: each LLM call stays under ~2,500 tokens
// ─────────────────────────────────────────────────────────────

import { llmCall } from "../config/llm.js";

// ── System prompts ────────────────────────────────────────────
const README_SYSTEM_PROMPT = `You are a senior technical writer.
Write a complete, professional README.md in Markdown.
Use real badges, code blocks, and tables — no placeholder text.
Sections to include: overview, tech stack, features, installation,
environment variables, API summary, data models overview, contributing.
Keep it under 600 words — be dense and useful, not padded.`;

const INTERNAL_SYSTEM_PROMPT = `You are a senior software architect writing internal developer docs.
Write a concise internal documentation guide in Markdown.
Cover: architecture overview, component responsibilities, data flow,
key relationships, gotchas for new developers.
Keep it under 500 words — be direct, no fluff.`;

// ── Context builders — each stays well under 2,000 tokens ─────

function buildReadmeContext({ meta, techStack, endpoints, models, owner, repo }) {
  // Model names + descriptions only — no fields (those are in schemaDocs)
  const modelSummary = models
    .slice(0, 12)
    .map((m) => `${m.name}: ${m.description || "no description"}`)
    .join("; ");

  const endpointSummary = endpoints
    .slice(0, 10)
    .map((e) => `${e.method} ${e.path}`)
    .join(", ");

  // Compact object — no JSON indentation
  return JSON.stringify({
    repo        : `${owner}/${repo}`,
    name        : meta.name,
    description : meta.description,
    language    : meta.language,
    stars       : meta.stars,
    techStack,
    endpoints   : endpointSummary || "none detected",
    models      : modelSummary    || "none detected",
    topics      : meta.topics?.join(", ") || "",
  });
}

function buildInternalContext({ structure, components, relationships, entryPoints, techStack }) {
  // Relationship summary: "User one-to-many Post, Post many-to-many Tag"
  const relSummary = relationships
    .slice(0, 20)
    .map((r) => `${r.from} ${r.type} ${r.to}`)
    .join("; ");

  // Component list: name + type + description (no exports/deps)
  const compSummary = components
    .slice(0, 10)
    .map((c) => `${c.name} (${c.type}): ${c.description || ""}`)
    .join("; ");

  // Structure: role → count (not the full file list)
  const structureSummary = Object.fromEntries(
    Object.entries(structure).map(([role, files]) => [role, files.length])
  );

  return JSON.stringify({
    techStack,
    entryPoints : entryPoints.slice(0, 5),
    structure   : structureSummary,
    components  : compSummary  || "none",
    relationships: relSummary  || "none",
  });
}

// ── Main agent ────────────────────────────────────────────────
export async function docWriterAgent({
  meta, techStack, structure, endpoints,
  models, relationships, components, entryPoints, owner, repo,
}) {
  console.log("✍️  [Agent 5] DocWriter — generating documentation…");

  const readmeCtx   = buildReadmeContext({ meta, techStack, endpoints, models, owner, repo });
  const internalCtx = buildInternalContext({ structure, components, relationships, entryPoints, techStack });

  // Estimate and log token usage before sending
  const readmeTokens   = Math.ceil(readmeCtx.length   / 4);
  const internalTokens = Math.ceil(internalCtx.length / 4);
  console.log(`   ↳ README context: ~${readmeTokens} tokens | Internal context: ~${internalTokens} tokens`);

  // ── README ─────────────────────────────────────────────────
  console.log("   ↳ Writing README.md…");
  const readme = await llmCall({
    systemPrompt: README_SYSTEM_PROMPT,
    userContent : `Write a README.md for this project:\n${readmeCtx}`,
    temperature : 0.2,
  });

  // ── Internal Docs ──────────────────────────────────────────
  console.log("   ↳ Writing internal docs…");
  const internalDocs = await llmCall({
    systemPrompt: INTERNAL_SYSTEM_PROMPT,
    userContent : `Write internal developer documentation:\n${internalCtx}`,
    temperature : 0.1,
  });

  // ── API Reference — built statically, zero LLM cost ───────
  const apiReference = buildApiReference(endpoints);

  // ── Schema Docs — built statically, zero LLM cost ─────────
  const schemaDocs = buildSchemaDocs(models, relationships);

  console.log("   ✅ Documentation generated");
  return { readme, internalDocs, apiReference, schemaDocs };
}

// ── Static builders ───────────────────────────────────────────
function buildApiReference(endpoints) {
  if (!endpoints.length) return "No API endpoints detected.";
  let md = "# API Reference\n\n";
  const grouped = {};
  for (const ep of endpoints) {
    const prefix = ep.path?.split("/")?.[1] || "root";
    if (!grouped[prefix]) grouped[prefix] = [];
    grouped[prefix].push(ep);
  }
  for (const [group, eps] of Object.entries(grouped)) {
    md += `## /${group}\n\n`;
    for (const ep of eps) {
      md += `### \`${ep.method} ${ep.path}\`\n`;
      md += `${ep.description || "No description"}\n\n`;
      md += `**Auth required:** ${ep.auth ? "✅ Yes" : "❌ No"}\n\n`;
      if (ep.params?.length) {
        md += `**Parameters:**\n\n| Name | In | Type | Required |\n|------|-----|------|----------|\n`;
        for (const p of ep.params) {
          md += `| \`${p.name}\` | ${p.in} | \`${p.type}\` | ${p.required ? "✅" : "❌"} |\n`;
        }
        md += "\n";
      }
      if (ep.returns) md += `**Returns:** ${ep.returns}\n\n`;
      md += "---\n\n";
    }
  }
  return md;
}

function buildSchemaDocs(models, relationships) {
  if (!models.length) return "No data models detected.";
  let md = "# Data Models\n\n";
  for (const model of models) {
    md += `## ${model.name}\n\n`;
    if (model.description) md += `${model.description}\n\n`;
    if (model.fields?.length) {
      md += `| Field | Type | Required | Unique |\n|-------|------|----------|--------|\n`;
      for (const f of model.fields) {
        md += `| \`${f.name}\` | \`${f.type}\` | ${f.required ? "✅" : "❌"} | ${f.unique ? "✅" : "❌"} |\n`;
      }
      md += "\n";
    }
  }
  if (relationships.length) {
    md += "## Relationships\n\n";
    md += "| From | Relationship | To | Via |\n|------|-------------|-----|-----|\n";
    for (const r of relationships) {
      md += `| ${r.from} | ${r.type} | ${r.to} | ${r.through || "—"} |\n`;
    }
  }
  return md;
}