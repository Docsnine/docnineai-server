// src/agents/docWriterAgent.js
// ─────────────────────────────────────────────────────────────
// AGENT 5 — Doc Writer
// ─────────────────────────────────────────────────────────────
// Skill : Synthesise all agent outputs into polished documentation
// Input : { meta, techStack, structure, endpoints, models,
//           relationships, components, entryPoints }
// Output: { readme, internalDocs }
// ─────────────────────────────────────────────────────────────

import { llmCall } from "../config/llm.js";

const README_SYSTEM_PROMPT = `You are a senior technical writer creating world-class open-source documentation.
Write a comprehensive, beautifully formatted README.md.
Use real Markdown: headers, code blocks, tables, badges.
Do NOT use placeholder text — generate real, useful content based on the data provided.
Cover: project overview, tech stack, installation, environment variables, API reference, data models, architecture, contributing.`;

const INTERNAL_SYSTEM_PROMPT = `You are a senior software architect writing internal developer documentation.
Create clear, detailed internal documentation covering:
- Project architecture decisions
- Component responsibilities
- Data flow between components  
- Database relationships explained in plain English
- Key utilities and how to use them
- Gotchas and important notes for new developers
Format as structured Markdown with clear sections.`;

export async function docWriterAgent({
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
}) {
  console.log("✍️  [Agent 5] DocWriter — generating documentation…");

  // ── Build rich context payload ──────────────────────────────
  const context = JSON.stringify(
    {
      repoMeta      : meta,
      techStack,
      projectStructure: structure,
      entryPoints,
      apiEndpoints  : endpoints.slice(0, 30), // keep within token budget
      dataModels    : models,
      relationships,
      components    : components.slice(0, 20),
    },
    null,
    2
  );

  // ── README ─────────────────────────────────────────────────
  console.log("   ↳ Writing README.md…");
  const readme = await llmCall({
    systemPrompt: README_SYSTEM_PROMPT,
    userContent : `Generate a complete README.md for this project:\n\n${context}`,
    temperature : 0.2,
  });

  // ── Internal Docs ──────────────────────────────────────────
  console.log("   ↳ Writing internal developer docs…");
  const internalDocs = await llmCall({
    systemPrompt: INTERNAL_SYSTEM_PROMPT,
    userContent : `Generate internal developer documentation for this project:\n\n${context}`,
    temperature : 0.1,
  });

  // ── API Reference ──────────────────────────────────────────
  const apiReference = buildApiReference(endpoints);

  // ── Schema Docs ────────────────────────────────────────────
  const schemaDocs = buildSchemaDocs(models, relationships);

  console.log("   ✅ Documentation generated");
  return { readme, internalDocs, apiReference, schemaDocs };
}

// ── Static builders (no LLM needed) ──────────────────────────
function buildApiReference(endpoints) {
  if (!endpoints.length) return "No API endpoints detected.";
  let md = "# API Reference\n\n";
  const grouped = {};
  for (const ep of endpoints) {
    const prefix = ep.path.split("/")[1] || "root";
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
