// ===================================================================
// Agent 5: Doc Writer
// ===================================================================

import { llmCall } from "../config/llm.js";

const README_SYSTEM_PROMPT = `You are a senior technical writer.
Write a complete, professional README.md in Markdown.
Use real badges, code blocks, and tables — no placeholder text.
Sections: overview, tech stack, features, installation, environment variables, API summary, data models overview, contributing.
Keep it under 600 words — dense and useful, not padded.`;

const INTERNAL_SYSTEM_PROMPT = `You are a senior software architect writing internal developer docs.
Write a concise internal documentation guide in Markdown.
Cover: architecture overview, component responsibilities, data flow, key relationships, gotchas for new developers.
Keep it under 500 words — direct, no fluff.`;

function buildReadmeContext({
  meta,
  techStack,
  endpoints,
  models,
  owner,
  repo,
}) {
  const modelSummary = models
    .slice(0, 12)
    .map((m) => `${m.name}: ${m.description || ""}`)
    .join("; ");
  const endpointSummary = endpoints
    .slice(0, 10)
    .map((e) => `${e.method} ${e.path}`)
    .join(", ");
  return JSON.stringify({
    repo: `${owner}/${repo}`,
    name: meta.name,
    description: meta.description,
    language: meta.language,
    stars: meta.stars,
    techStack,
    endpoints: endpointSummary || "none",
    models: modelSummary || "none",
    topics: meta.topics?.join(", ") || "",
  });
}

function buildInternalContext({
  structure,
  components,
  relationships,
  entryPoints,
  techStack,
}) {
  const relSummary = relationships
    .slice(0, 20)
    .map((r) => `${r.from} ${r.type} ${r.to}`)
    .join("; ");
  const compSummary = components
    .slice(0, 10)
    .map((c) => `${c.name}(${c.type}): ${c.description || ""}`)
    .join("; ");
  const structCount = Object.fromEntries(
    Object.entries(structure).map(([r, f]) => [r, f.length]),
  );
  return JSON.stringify({
    techStack,
    entryPoints: entryPoints.slice(0, 5),
    structure: structCount,
    components: compSummary || "none",
    relationships: relSummary || "none",
  });
}

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
  emit,
}) {
  const notify = (msg, detail) => {
    if (emit) emit(msg, detail);
  };

  const readmeCtx = buildReadmeContext({
    meta,
    techStack,
    endpoints,
    models,
    owner,
    repo,
  });
  const internalCtx = buildInternalContext({
    structure,
    components,
    relationships,
    entryPoints,
    techStack,
  });

  const rt = Math.ceil(readmeCtx.length / 4);
  const it = Math.ceil(internalCtx.length / 4);
  notify("Writing README.md…", `~${rt} tokens`);

  const readme = await llmCall({
    systemPrompt: README_SYSTEM_PROMPT,
    userContent: `Write a README.md for this project:\n${readmeCtx}`,
    temperature: 0.2,
  });

  notify("Writing internal developer docs…", `~${it} tokens`);
  const internalDocs = await llmCall({
    systemPrompt: INTERNAL_SYSTEM_PROMPT,
    userContent: `Write internal developer documentation:\n${internalCtx}`,
    temperature: 0.1,
  });

  notify("Building API reference table…", "static — no LLM cost");
  const apiReference = buildApiReference(endpoints);

  notify("Building schema documentation…", "static — no LLM cost");
  const schemaDocs = buildSchemaDocs(models, relationships);

  notify("All documents ready");
  return { readme, internalDocs, apiReference, schemaDocs };
}

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
      md += `### \`${ep.method} ${ep.path}\`\n${ep.description || "No description"}\n\n`;
      md += `**Auth required:** ${ep.auth ? "✅ Yes" : "❌ No"}\n\n`;
      if (ep.params?.length) {
        md += `**Parameters:**\n\n| Name | In | Type | Required |\n|------|-----|------|----------|\n`;
        ep.params.forEach((p) => {
          md += `| \`${p.name}\` | ${p.in} | \`${p.type}\` | ${p.required ? "✅" : "❌"} |\n`;
        });
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
      model.fields.forEach((f) => {
        md += `| \`${f.name}\` | \`${f.type}\` | ${f.required ? "✅" : "❌"} | ${f.unique ? "✅" : "❌"} |\n`;
      });
      md += "\n";
    }
  }
  if (relationships.length) {
    md += `## Relationships\n\n| From | Relationship | To | Via |\n|------|-------------|-----|-----|\n`;
    relationships.forEach((r) => {
      md += `| ${r.from} | ${r.type} | ${r.to} | ${r.through || "—"} |\n`;
    });
  }
  return md;
}
