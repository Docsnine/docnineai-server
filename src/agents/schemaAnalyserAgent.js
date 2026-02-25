// src/agents/schemaAnalyserAgent.js
// ─────────────────────────────────────────────────────────────
// AGENT 3 — Schema Analyser
// ─────────────────────────────────────────────────────────────
// BATCHING STRATEGY:
//   Old: 1 file → 1 LLM call = 63 calls for 63 schema files
//   New: 3 files → 1 LLM call = ~7 calls for 20 schema files
//
//   Each file contributes its first 250 chars (field definitions
//   are at the top of model files — we don't need the whole file)
//   3 files × 250 chars = ~750 chars = ~215 tokens per batch
//   Well within budget, and captures all field definitions.
// ─────────────────────────────────────────────────────────────

import { llmCall } from "../config/llm.js";

const SYSTEM_PROMPT = `You are a database architect.
Analyse the given source files and extract all data models/schemas.
Return ONLY valid JSON (no markdown, no explanation):
{
  "models": [{
    "name": "User",
    "file": "models/user.ts",
    "fields": [{ "name": "email", "type": "String", "required": true, "unique": true }],
    "description": "One sentence about this model"
  }],
  "relationships": [{
    "from": "User", "to": "Post",
    "type": "one-to-many | many-to-many | one-to-one",
    "through": "optional join table/model name or null"
  }]
}
If nothing found, return { "models": [], "relationships": [] }.`;

// Schema file detector patterns
const SCHEMA_ROLES = new Set(["model", "schema", "migration"]);
const SCHEMA_REGEX =
  /mongoose\.Schema|new Schema\(|sequelize\.define|@Entity|@Table|@Column|prisma\.|TypeORM|class.*extends.*Model|SQLAlchemy|Base\.metadata|models\.Model|createTable|db\.Model|DataTypes\.|belongsTo|hasMany|hasOne|belongsToMany/i;
const PATH_REGEX = /model|schema|entity|migration|database\/|db\//i;

// How many files to pack into one LLM call
const FILES_PER_BATCH = 3;
// How many chars to take from each file (field defs are at the top)
const CHARS_PER_FILE = 280;
// Hard cap on total schema files to process
const MAX_SCHEMA_FILES = 20;

export async function schemaAnalyserAgent({ files, projectMap }) {
  console.log("🗄️  [Agent 3] SchemaAnalyser — mapping models & relationships…");

  const schemaFiles = files
    .filter((f) => {
      const meta = projectMap.find((m) => m.path === f.path);
      return (
        (meta && SCHEMA_ROLES.has(meta.role)) ||
        SCHEMA_REGEX.test(f.content) ||
        PATH_REGEX.test(f.path)
      );
    })
    .slice(0, MAX_SCHEMA_FILES);

  console.log(
    `   ↳ ${schemaFiles.length} schema files → ${Math.ceil(schemaFiles.length / FILES_PER_BATCH)} batched LLM calls`,
  );

  const allModels = [];
  const allRelationships = [];

  // Group files into batches of FILES_PER_BATCH
  for (let i = 0; i < schemaFiles.length; i += FILES_PER_BATCH) {
    const batch = schemaFiles.slice(i, i + FILES_PER_BATCH);

    // Pack multiple files into one prompt — separated clearly
    const userContent = batch
      .map(
        (f) => `=== FILE: ${f.path} ===\n${f.content.slice(0, CHARS_PER_FILE)}`,
      )
      .join("\n\n");

    try {
      const raw = await llmCall({ systemPrompt: SYSTEM_PROMPT, userContent });
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.models)) allModels.push(...parsed.models);
      if (Array.isArray(parsed.relationships))
        allRelationships.push(...parsed.relationships);
    } catch {
      // Batch had no schema content — skip
    }
  }

  // Deduplicate models by name (multiple files can define the same model)
  const seen = new Set();
  const models = allModels.filter((m) => {
    if (!m.name || seen.has(m.name)) return false;
    seen.add(m.name);
    return true;
  });

  // Deduplicate relationships
  const relSeen = new Set();
  const relationships = allRelationships.filter((r) => {
    const key = `${r.from}→${r.to}`;
    if (relSeen.has(key)) return false;
    relSeen.add(key);
    return true;
  });

  console.log(
    `   ✅ Found ${models.length} models, ${relationships.length} relationships`,
  );
  return { models, relationships };
}
