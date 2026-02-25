// =================================================================== 
// Agent 3: Schema Analyser
// ===================================================================

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
    "through": null
  }]
}
If nothing found, return { "models": [], "relationships": [] }.`;

const SCHEMA_ROLES = new Set(["model", "schema", "migration"]);
const SCHEMA_REGEX =
  /mongoose\.Schema|new Schema\(|sequelize\.define|@Entity|@Table|@Column|prisma\.|TypeORM|class.*extends.*Model|SQLAlchemy|DataTypes\.|belongsTo|hasMany|hasOne|belongsToMany/i;
const PATH_REGEX = /model|schema|entity|migration|database\/|db\//i;
const FILES_PER_BATCH = 3;
const CHARS_PER_FILE = 280;
const MAX_FILES = 20;

export async function schemaAnalyserAgent({ files, projectMap, emit }) {
  const notify = (msg, detail) => {
    if (emit) emit(msg, detail);
  };

  const schemaFiles = files
    .filter((f) => {
      const meta = projectMap.find((m) => m.path === f.path);
      return (
        (meta && SCHEMA_ROLES.has(meta.role)) ||
        SCHEMA_REGEX.test(f.content) ||
        PATH_REGEX.test(f.path)
      );
    })
    .slice(0, MAX_FILES);

  const totalBatches = Math.ceil(schemaFiles.length / FILES_PER_BATCH);
  notify(
    `Found ${schemaFiles.length} schema files`,
    `${totalBatches} batched LLM calls`,
  );

  const allModels = [],
    allRelationships = [];

  for (let i = 0; i < schemaFiles.length; i += FILES_PER_BATCH) {
    const batchNum = Math.floor(i / FILES_PER_BATCH) + 1;
    const batch = schemaFiles.slice(i, i + FILES_PER_BATCH);
    notify(`Extracting models…`, `Batch ${batchNum} of ${totalBatches}`);

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
      /* skip */
    }
  }

  const seen = new Set();
  const models = allModels.filter((m) => {
    if (!m.name || seen.has(m.name)) return false;
    seen.add(m.name);
    return true;
  });

  const relSeen = new Set();
  const relationships = allRelationships.filter((r) => {
    const key = `${r.from}→${r.to}`;
    if (relSeen.has(key)) return false;
    relSeen.add(key);
    return true;
  });

  notify(
    `${models.length} models, ${relationships.length} relationships found`,
  );
  return { models, relationships };
}
