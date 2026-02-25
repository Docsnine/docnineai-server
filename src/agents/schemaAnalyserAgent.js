// src/agents/schemaAnalyserAgent.js
// ─────────────────────────────────────────────────────────────
// AGENT 3 — Schema Analyser
// ─────────────────────────────────────────────────────────────
// Skill : Identify models, schemas, DB tables, and relationships
// Input : { files, projectMap }
// Output: { models[], relationships[] }
// ─────────────────────────────────────────────────────────────

import { llmCall } from "../config/llm.js";
import { chunkText, batchChunks, formatBatch } from "../utils/tokenManager.js";

const MODEL_SYSTEM_PROMPT = `You are a database architect.
Analyse the given source code and extract data models/schemas.
Return ONLY valid JSON (no markdown):
{
  "models": [{
    "name"       : "User",
    "file"       : "models/user.js",
    "fields"     : [{ "name": "email", "type": "String", "required": true, "unique": true }],
    "description": "Represents an authenticated user"
  }],
  "relationships": [{
    "from"   : "User",
    "to"     : "Post",
    "type"   : "one-to-many | many-to-many | one-to-one",
    "through": "optional join table/model"
  }]
}
If nothing found, return { "models": [], "relationships": [] }.`;

export async function schemaAnalyserAgent({ files, projectMap }) {
  console.log("🗄️  [Agent 3] SchemaAnalyser — mapping models & relationships…");

  const SCHEMA_ROLES  = new Set(["model", "schema", "migration"]);
  // Broad pattern to catch any ORM/ODM definition style
  const SCHEMA_REGEX = /mongoose\.Schema|new Schema\(|sequelize\.define|@Entity|@Table|@Column|prisma\.|TypeORM|class.*extends.*Model|SQLAlchemy|Base\.metadata|models\.Model|createTable|db\.Model|DataTypes\.|belongsTo|hasMany|hasOne|belongsToMany/i;

  const schemaFiles = files.filter((f) => {
    const meta = projectMap.find((m) => m.path === f.path);
    const roleMatch = meta && SCHEMA_ROLES.has(meta.role);
    const contentMatch = SCHEMA_REGEX.test(f.content);
    // Also catch files with "model" or "schema" or "entity" in their path
    const pathMatch = /model|schema|entity|migration|database\/|db\//i.test(f.path);
    return roleMatch || contentMatch || pathMatch;
  });

  console.log(`   ↳ Found ${schemaFiles.length} schema/model files`);

  const allModels        = [];
  const allRelationships = [];

  for (const file of schemaFiles) {
    const chunks  = chunkText(file.content, 450);
    const batches = batchChunks(chunks, 3);

    for (const batch of batches) {
      const userContent = `FILE: ${file.path}\n\n${formatBatch(batch)}`;
      try {
        const raw    = await llmCall({ systemPrompt: MODEL_SYSTEM_PROMPT, userContent });
        const parsed = JSON.parse(raw);
        if (parsed.models)        allModels.push(...parsed.models);
        if (parsed.relationships) allRelationships.push(...parsed.relationships);
      } catch {
        // skip
      }
    }
  }

  // Deduplicate models by name
  const seen   = new Set();
  const models = allModels.filter((m) => {
    if (seen.has(m.name)) return false;
    seen.add(m.name);
    return true;
  });

  console.log(`   ✅ Found ${models.length} models, ${allRelationships.length} relationships`);
  return { models, relationships: allRelationships };
}
