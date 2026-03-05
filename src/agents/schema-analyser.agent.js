// ===================================================================
// Agent 3: Schema Analyser (Improved)
// ===================================================================

import { llmCall } from "../config/llm.js";

// ─── System Prompt ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a principal database architect and ORM specialist with deep expertise in extracting and documenting data models across all major database frameworks and ORMs (Prisma, TypeORM, Sequelize, Mongoose, SQLAlchemy, Django ORM, ActiveRecord, Eloquent, GORM, Hibernate, and raw SQL schemas).

## YOUR TASK
Analyze the provided source files and extract every data model, schema, entity, and table definition — including all fields, constraints, indexes, relationships, and validation rules.

## OUTPUT FORMAT
Return ONLY a valid JSON object.
No markdown. No code fences. No explanation. No preamble. No trailing text.
Your entire response must start with { and end with }.
If nothing is found, return exactly: { "models": [], "relationships": [] }

## SCHEMA
{
  "models": [
    {
      "name": string,               // Exact model/class/table name e.g. "User", "OrderItem"
      "file": string,               // Source file path where this model is defined
      "line": number | null,        // Line number of the model definition — null if not determinable
      "orm": string,                // ORM/framework: "prisma" | "typeorm" | "sequelize" | "mongoose" | "sqlalchemy" | "django" | "activerecord" | "eloquent" | "gorm" | "hibernate" | "zod" | "joi" | "yup" | "raw_sql" | "other"
      "database": string,           // Target database: "postgresql" | "mysql" | "sqlite" | "mongodb" | "mssql" | "unknown"
      "table": string,              // Actual DB table/collection name if different from model name — "" if same
      "description": string,        // 1–2 sentences: what this model represents and its role in the domain
      "fields": [
        {
          "name": string,           // Field/column name
          "type": string,           // ORM type e.g. "String", "Int", "DateTime", "ObjectId", "jsonb"
          "db_type": string,        // Actual DB column type if specified e.g. "VARCHAR(255)", "BIGINT" — "" if not specified
          "required": boolean,      // true if NOT NULL / required
          "unique": boolean,        // true if unique constraint exists
          "primary": boolean,       // true if this is a primary key field
          "default": string,        // Default value if specified — "" if none
          "auto": boolean,          // true if auto-generated (autoIncrement, @default(uuid()), @updatedAt, etc.)
          "index": boolean,         // true if individually indexed
          "enum_values": string[],  // Possible values if field is an enum — [] if not
          "relation": string,       // Name of related model if this is a FK/relation field — "" if not
          "description": string     // What this field stores — "" if self-evident
        }
      ],
      "indexes": [                  // Composite and named indexes
        {
          "name": string,           // Index name — "" if anonymous
          "fields": string[],       // Field names included in this index
          "unique": boolean,        // true if unique index
          "type": string            // "btree" | "hash" | "gin" | "gist" | "fulltext" | "spatial" | "" if not specified
        }
      ],
      "constraints": [              // Check constraints, composite uniques etc.
        {
          "type": string,           // "unique" | "check" | "foreign_key" | "primary_key"
          "fields": string[],       // Fields involved
          "expression": string      // Constraint expression if applicable — "" if none
        }
      ],
      "hooks": string[],            // Lifecycle hooks: "beforeCreate" | "afterSave" | "beforeDestroy" etc. — [] if none
      "soft_delete": boolean,       // true if model uses soft deletes (deletedAt, paranoid, etc.)
      "timestamps": boolean,        // true if model has createdAt/updatedAt auto fields
      "tags": string[]              // Inferred domain tags e.g. ["auth", "billing", "inventory"]
    }
  ],
  "relationships": [
    {
      "from": string,               // Source model name
      "to": string,                 // Target model name
      "type": string,               // "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many"
      "through": string | null,     // Junction table/model name for many-to-many — null if direct
      "from_field": string,         // FK field on the source model — "" if not determinable
      "to_field": string,           // Referenced field on target model — "" if not determinable
      "cascade": string,            // "CASCADE" | "SET_NULL" | "RESTRICT" | "NO_ACTION" | "" if not specified
      "optional": boolean,          // true if relation is optional (nullable FK)
      "description": string         // One sentence explaining what this relationship means in domain terms
    }
  ]
}

## EXTRACTION RULES
1. Extract EVERY model — do not skip any, including junction/pivot tables and embedded sub-schemas.
2. For "table", only populate if the model uses @Table(), tableName, or collection() to override the default name.
3. For "orm", detect from decorators, imports, or syntax patterns — see framework hints below.
4. For "fields", include ALL fields including auto-generated ones (id, createdAt, updatedAt, deletedAt).
5. For "relationships", create one entry per directional relationship. A User hasMany Posts → one entry from User to Post (one-to-many).
6. For many-to-many via junction table, set "through" to the junction table/model name.
7. For "description", be domain-specific: "Represents a customer's subscription to a plan, tracking billing cycle and status" not "User model".
8. For "hooks", list any @BeforeInsert, @AfterUpdate, beforeCreate, signal handlers visible in the snippet.
9. For "soft_delete", detect: deletedAt field, paranoid: true, SoftDelete decorator, @DeleteDateColumn.
10. If a value cannot be determined confidently, use null for numbers, "" for strings, [] for arrays — never fabricate.

## FRAMEWORK DETECTION HINTS

**Prisma** — model User { }, @default(), @relation(), @@index(), @@unique()
**TypeORM** — @Entity(), @Column(), @PrimaryGeneratedColumn(), @OneToMany(), @ManyToOne(), @JoinTable()
**Sequelize** — sequelize.define(), DataTypes.STRING, belongsTo(), hasMany(), hasOne(), belongsToMany()
**Mongoose** — new Schema({ }), mongoose.model(), SchemaTypes, ref: 'ModelName'
**SQLAlchemy** — class Model(Base), Column(), relationship(), ForeignKey(), declarative_base()
**Django ORM** — class Model(models.Model), models.CharField(), ForeignKey(), ManyToManyField()
**ActiveRecord (Rails)** — class Model < ApplicationRecord, belongs_to, has_many, has_one, has_and_belongs_to_many
**Eloquent (Laravel)** — class Model extends Model, $fillable, $casts, belongsTo(), hasMany()
**GORM** — type Struct struct { gorm:"..." }, gorm.Model embedding, has_many, belongs_to
**Hibernate** — @Entity, @Table, @Column, @OneToMany, @ManyToOne, @JoinColumn
**Zod/Joi/Yup** — validation schemas — treat as "schema" orm type, extract field shapes

## STRICT OUTPUT RULES
- No markdown of any kind
- No \`\`\`json fences
- No introductory or closing sentences
- No comments inside the JSON
- Must be parseable by JSON.parse() with zero preprocessing
- Start with { and end with }`;

// ─── Constants ────────────────────────────────────────────────────

const SCHEMA_ROLES = new Set([
  "model",
  "schema",
  "migration",
  "entity",
  "seed",
]);

// Comprehensive ORM/schema detection regex
const SCHEMA_REGEX = new RegExp(
  [
    // Prisma
    /model\s+\w+\s*\{/,
    /@@relation|@relation|@default|@@index|@@unique/,
    // TypeORM
    /@Entity\s*\(|@Table\s*\(|@Column\s*\(|@PrimaryGeneratedColumn/,
    /@OneToMany|@ManyToOne|@OneToOne|@ManyToMany|@JoinTable|@JoinColumn/,
    // Sequelize
    /sequelize\.define\s*\(|DataTypes\.|belongsTo\s*\(|hasMany\s*\(|hasOne\s*\(|belongsToMany\s*\(/,
    // Mongoose
    /new\s+Schema\s*\(|mongoose\.Schema|mongoose\.model\s*\(/,
    /SchemaTypes\.|ref\s*:\s*['"]\w+['"]/,
    // SQLAlchemy
    /class\s+\w+\s*\(\s*Base\s*\)|Column\s*\(|relationship\s*\(|ForeignKey\s*\(/,
    /declarative_base\s*\(\)|db\.Model/,
    // Django
    /models\.Model\s*\)|models\.CharField|models\.ForeignKey|models\.ManyToManyField/,
    // ActiveRecord
    /belongs_to\s+:|has_many\s+:|has_one\s+:|has_and_belongs_to_many/,
    // Eloquent
    /extends\s+Model|protected\s+\$fillable|protected\s+\$casts/,
    // GORM
    /gorm:"[^"]*"|gorm\.Model/,
    // Hibernate
    /@Entity|@Table|@ManyToOne|@OneToMany|@JoinColumn/,
    // Zod / Joi / Yup
    /z\.object\s*\(|Joi\.object\s*\(|yup\.object\s*\(|object\s*\(\s*\{/,
    // Generic SQL
    /CREATE\s+TABLE|ALTER\s+TABLE|PRIMARY\s+KEY|FOREIGN\s+KEY|REFERENCES\s+\w+/i,
  ]
    .map((r) => r.source)
    .join("|"),
  "i",
);

const PATH_REGEX =
  /model[s]?\/|schema[s]?\/|entity|entities\/|migration[s]?\/|database\/|db\/|orm\/|\.model\.|\.schema\.|\.entity\./i;

const EXCLUDE_REGEX = /\.test\.|\.spec\.|__mock|fixture|\.d\.ts$/i;

const FILES_PER_BATCH = 3;
const CHARS_PER_FILE = 8000; // was 280 — completely inadequate for real schema files
const MAX_FILES = 50;
const MAX_RETRIES = 2;

const VALID_ORMS = new Set([
  "prisma",
  "typeorm",
  "sequelize",
  "mongoose",
  "sqlalchemy",
  "django",
  "activerecord",
  "eloquent",
  "gorm",
  "hibernate",
  "zod",
  "joi",
  "yup",
  "raw_sql",
  "other",
]);

const VALID_DATABASES = new Set([
  "postgresql",
  "mysql",
  "sqlite",
  "mongodb",
  "mssql",
  "redis",
  "unknown",
]);

const VALID_REL_TYPES = new Set([
  "one-to-one",
  "one-to-many",
  "many-to-one",
  "many-to-many",
]);

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Safe JSON parser with markdown fence stripping fallback.
 */
function safeParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    try {
      return JSON.parse(stripped);
    } catch {
      return null;
    }
  }
}

/**
 * Validate and normalise a single model object.
 */
function validateModel(model, fallbackFile) {
  if (!model || typeof model !== "object") return null;

  const name = String(model.name ?? "").trim();
  const file = String(model.file ?? fallbackFile ?? "").trim();
  if (!name || !file) return null;

  return {
    name,
    file,
    line: model.line ?? null,
    orm: VALID_ORMS.has(model.orm) ? model.orm : "other",
    database: VALID_DATABASES.has(model.database) ? model.database : "unknown",
    table: model.table || "",
    description: model.description || "",
    fields: Array.isArray(model.fields)
      ? model.fields.map(normalizeField).filter(Boolean)
      : [],
    indexes: Array.isArray(model.indexes)
      ? model.indexes.map(normalizeIndex).filter(Boolean)
      : [],
    constraints: Array.isArray(model.constraints)
      ? model.constraints.map(normalizeConstraint).filter(Boolean)
      : [],
    hooks: Array.isArray(model.hooks)
      ? model.hooks.filter((h) => typeof h === "string")
      : [],
    soft_delete: model.soft_delete ?? false,
    timestamps: model.timestamps ?? detectTimestamps(model.fields),
    tags: Array.isArray(model.tags) ? model.tags : inferModelTags(name, file),
  };
}

function normalizeField(f) {
  if (!f || typeof f !== "object") return null;
  const name = String(f.name ?? "").trim();
  if (!name) return null;

  return {
    name,
    type: String(f.type ?? "unknown").trim(),
    db_type: String(f.db_type ?? "").trim(),
    required: f.required ?? false,
    unique: f.unique ?? false,
    primary: f.primary ?? false,
    default: String(f.default ?? "").trim(),
    auto: f.auto ?? false,
    index: f.index ?? false,
    enum_values: Array.isArray(f.enum_values) ? f.enum_values : [],
    relation: String(f.relation ?? "").trim(),
    description: String(f.description ?? "").trim(),
  };
}

function normalizeIndex(idx) {
  if (!idx || typeof idx !== "object") return null;
  if (!Array.isArray(idx.fields) || idx.fields.length === 0) return null;

  return {
    name: String(idx.name ?? "").trim(),
    fields: idx.fields.filter((f) => typeof f === "string"),
    unique: idx.unique ?? false,
    type: String(idx.type ?? "").trim(),
  };
}

function normalizeConstraint(c) {
  if (!c || typeof c !== "object") return null;

  return {
    type: String(c.type ?? "").trim(),
    fields: Array.isArray(c.fields) ? c.fields : [],
    expression: String(c.expression ?? "").trim(),
  };
}

/**
 * Validate and normalise a single relationship object.
 */
function validateRelationship(rel) {
  if (!rel || typeof rel !== "object") return null;

  const from = String(rel.from ?? "").trim();
  const to = String(rel.to ?? "").trim();
  if (!from || !to) return null;

  return {
    from,
    to,
    type: VALID_REL_TYPES.has(rel.type) ? rel.type : "one-to-many",
    through: rel.through || null,
    from_field: rel.from_field || "",
    to_field: rel.to_field || "",
    cascade: rel.cascade || "",
    optional: rel.optional ?? false,
    description: rel.description || "",
  };
}

/**
 * Detect if a model has timestamps by checking its fields array.
 */
function detectTimestamps(fields) {
  if (!Array.isArray(fields)) return false;
  const names = fields.map((f) => String(f.name ?? "").toLowerCase());
  return names.some((n) =>
    ["createdat", "updatedat", "created_at", "updated_at"].includes(n),
  );
}

/**
 * Infer domain tags from model name and file path.
 */
function inferModelTags(name, file) {
  const tags = new Set();

  // From camelCase/PascalCase name breakdown
  const words = name
    .replace(/([A-Z])/g, " $1")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  words.forEach((w) => tags.add(w));

  // From file path
  const segments = file.split("/").filter(Boolean).slice(0, -1); // exclude filename
  segments.forEach((s) => {
    const clean = s.replace(/[-_]/g, " ").toLowerCase();
    if (!["src", "app", "models", "schemas", "entities"].includes(clean)) {
      tags.add(clean);
    }
  });

  return Array.from(tags).slice(0, 4);
}

/**
 * Infer ORM from file content heuristics.
 * Used as fallback when LLM doesn't return the orm field.
 */
function inferOrm(content) {
  if (!content) return "other";
  if (/model\s+\w+\s*\{|@default\(|@@index/i.test(content)) return "prisma";
  if (/@Entity\s*\(|@Column\s*\(|@PrimaryGeneratedColumn/i.test(content))
    return "typeorm";
  if (/sequelize\.define|DataTypes\./i.test(content)) return "sequelize";
  if (/new\s+Schema\s*\(|mongoose\.Schema/i.test(content)) return "mongoose";
  if (/class\s+\w+\s*\(\s*Base\s*\)|Column\s*\(/i.test(content))
    return "sqlalchemy";
  if (/models\.Model\)|models\.CharField/i.test(content)) return "django";
  if (/belongs_to\s+:|has_many\s+:/i.test(content)) return "activerecord";
  if (/extends\s+Model.*\$fillable/is.test(content)) return "eloquent";
  if (/gorm:"|gorm\.Model/i.test(content)) return "gorm";
  if (/@Entity|@OneToMany|@ManyToOne/i.test(content)) return "hibernate";
  if (/z\.object\s*\(/i.test(content)) return "zod";
  if (/Joi\.object\s*\(/i.test(content)) return "joi";
  if (/yup\.object\s*\(/i.test(content)) return "yup";
  if (/CREATE\s+TABLE/i.test(content)) return "raw_sql";
  return "other";
}

/**
 * Infer target database from ORM and content.
 */
function inferDatabase(orm, content) {
  if (!content) return "unknown";
  if (/mongodb|mongoose/i.test(content)) return "mongodb";
  if (/postgresql|postgres|pg\b/i.test(content)) return "postgresql";
  if (/mysql|mysql2/i.test(content)) return "mysql";
  if (/sqlite/i.test(content)) return "sqlite";
  if (/mssql|sqlserver/i.test(content)) return "mssql";
  if (orm === "mongoose") return "mongodb";
  if (orm === "activerecord") return "unknown"; // depends on config
  return "unknown";
}

/**
 * Score completeness of a model for deduplication merge.
 */
function scoreModel(model) {
  let score = 0;
  if (model.description) score += 2;
  if (model.fields.length > 0) score += 3;
  if (model.orm !== "other") score += 2;
  if (model.database !== "unknown") score += 1;
  if (model.indexes.length > 0) score += 2;
  if (model.constraints.length > 0) score += 1;
  if (model.hooks.length > 0) score += 1;
  if (model.table) score += 1;
  if (model.line !== null) score += 1;
  if (model.fields.some((f) => f.description)) score += 1;
  return score;
}

/**
 * Score completeness of a relationship for dedup merge.
 */
function scoreRelationship(rel) {
  let score = 0;
  if (rel.through) score += 2;
  if (rel.from_field) score += 1;
  if (rel.to_field) score += 1;
  if (rel.cascade) score += 1;
  if (rel.description) score += 2;
  return score;
}

/**
 * LLM call with exponential back-off retry.
 */
async function llmCallWithRetry({
  systemPrompt,
  userContent,
  retries = MAX_RETRIES,
}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await llmCall({ systemPrompt, userContent });
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

/**
 * Attempt to extract relationships from model fields statically.
 * Catches relationships the LLM may miss when snippets are truncated.
 */
function extractStaticRelationships(models) {
  const rels = [];
  const modelNames = new Set(models.map((m) => m.name));

  for (const model of models) {
    for (const field of model.fields) {
      if (!field.relation) continue;
      const target = field.relation;
      if (!modelNames.has(target)) continue;

      // Determine type from field name conventions
      const isMany =
        field.name.endsWith("s") ||
        field.name.includes("List") ||
        field.name.includes("Items") ||
        /\[\]/.test(field.type);

      rels.push({
        from: model.name,
        to: target,
        type: isMany ? "one-to-many" : "many-to-one",
        through: null,
        from_field: field.name,
        to_field: "id",
        cascade: "",
        optional: !field.required,
        description: `${model.name} ${isMany ? "has many" : "belongs to"} ${target}`,
        _static: true, // internal marker
      });
    }
  }

  return rels;
}

/**
 * Build a summary report from extracted models and relationships.
 */
function buildSummary(models, relationships) {
  const ormDist = {};
  const dbDist = {};
  const tagSet = new Set();
  let totalFields = 0;
  let withTimestamps = 0;
  let withSoftDelete = 0;
  let withIndexes = 0;

  for (const m of models) {
    ormDist[m.orm] = (ormDist[m.orm] ?? 0) + 1;
    dbDist[m.database] = (dbDist[m.database] ?? 0) + 1;
    totalFields += m.fields.length;
    if (m.timestamps) withTimestamps++;
    if (m.soft_delete) withSoftDelete++;
    if (m.indexes.length > 0) withIndexes++;
    m.tags.forEach((t) => tagSet.add(t));
  }

  const relTypeDist = {};
  for (const r of relationships) {
    relTypeDist[r.type] = (relTypeDist[r.type] ?? 0) + 1;
  }

  return {
    totalModels: models.length,
    totalFields,
    totalRelationships: relationships.length,
    withTimestamps,
    withSoftDelete,
    withIndexes,
    avgFieldsPerModel: models.length
      ? Math.round(totalFields / models.length)
      : 0,
    ormDist,
    dbDist,
    relTypeDist,
    tags: Array.from(tagSet).sort(),
  };
}

// ─── Agent ────────────────────────────────────────────────────────

export async function schemaAnalyserAgent({ files, projectMap, emit }) {
  const notify = (msg, detail) => emit?.(msg, detail);

  // ── 1. Filter to schema-relevant files ────────────────────────
  const schemaFiles = files
    .filter((f) => {
      if (!f?.path || !f?.content) return false;
      if (EXCLUDE_REGEX.test(f.path)) return false;

      const meta = projectMap?.find((m) => m.path === f.path);
      return (
        (meta && SCHEMA_ROLES.has(meta.role)) ||
        SCHEMA_REGEX.test(f.content) ||
        PATH_REGEX.test(f.path)
      );
    })
    // Prioritise files flagged as has_db or critical by Agent 1
    .sort((a, b) => {
      const metaA = projectMap?.find((m) => m.path === a.path);
      const metaB = projectMap?.find((m) => m.path === b.path);
      const scoreA =
        (metaA?.flags?.includes("has_db") ? 2 : 0) +
        (metaA?.importance === "critical" ? 1 : 0);
      const scoreB =
        (metaB?.flags?.includes("has_db") ? 2 : 0) +
        (metaB?.importance === "critical" ? 1 : 0);
      return scoreB - scoreA;
    })
    .slice(0, MAX_FILES);

  if (schemaFiles.length === 0) {
    notify("No schema files found", "Skipping schema analysis");
    return {
      models: [],
      relationships: [],
      summary: buildSummary([], []),
    };
  }

  const totalBatches = Math.ceil(schemaFiles.length / FILES_PER_BATCH);
  notify(
    `Found ${schemaFiles.length} schema files`,
    `Processing in ${totalBatches} batch${totalBatches > 1 ? "es" : ""}`,
  );

  // ── 2. Extract models and relationships batch by batch ─────────
  const rawModels = [];
  const rawRelationships = [];
  const batchErrors = [];

  for (let i = 0; i < schemaFiles.length; i += FILES_PER_BATCH) {
    const batchNum = Math.floor(i / FILES_PER_BATCH) + 1;
    const batch = schemaFiles.slice(i, i + FILES_PER_BATCH);

    notify(`Extracting models…`, `Batch ${batchNum} of ${totalBatches}`);

    const userContent = batch
      .map((f) => {
        const truncated = f.content.length > CHARS_PER_FILE;
        return [
          `=== FILE: ${f.path} ===`,
          truncated
            ? `[Truncated at ${CHARS_PER_FILE} chars — ${f.content.length} total]`
            : "",
          f.content.slice(0, CHARS_PER_FILE),
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");

    try {
      const raw = await llmCallWithRetry({
        systemPrompt: SYSTEM_PROMPT,
        userContent,
      });
      const parsed = safeParseJSON(raw);

      if (!parsed || typeof parsed !== "object") {
        batchErrors.push({
          batch: batchNum,
          error: "Response was not a JSON object",
        });
        continue;
      }

      // Process models
      if (Array.isArray(parsed.models)) {
        for (const model of parsed.models) {
          // Match file back to correct batch file
          const matchedFile = batch.find((f) =>
            model.file
              ? f.path.endsWith(model.file) || model.file.endsWith(f.path)
              : false,
          );
          const fallbackFile =
            batch.length === 1
              ? batch[0].path
              : matchedFile?.path || model.file || batch[0].path;

          // Enrich with static inference if LLM missed orm/database
          const enriched = {
            ...model,
            orm:
              model.orm ||
              inferOrm(
                batch.find((f) => f.path === fallbackFile)?.content || "",
              ),
            database:
              model.database ||
              inferDatabase(
                model.orm,
                batch.find((f) => f.path === fallbackFile)?.content || "",
              ),
          };

          const validated = validateModel(enriched, fallbackFile);
          if (validated) rawModels.push(validated);
        }
      }

      // Process relationships
      if (Array.isArray(parsed.relationships)) {
        for (const rel of parsed.relationships) {
          const validated = validateRelationship(rel);
          if (validated) rawRelationships.push(validated);
        }
      }
    } catch (err) {
      batchErrors.push({ batch: batchNum, error: err.message });
    }
  }

  // ── 3. Deduplicate models — keep the most complete version ────
  const modelMap = new Map();

  for (const model of rawModels) {
    const existing = modelMap.get(model.name);
    if (!existing) {
      modelMap.set(model.name, model);
    } else {
      // Merge fields from both versions
      const mergedFields = mergeFields(existing.fields, model.fields);
      const winner =
        scoreModel(model) >= scoreModel(existing) ? model : existing;
      modelMap.set(model.name, { ...winner, fields: mergedFields });
    }
  }

  const models = Array.from(modelMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // ── 4. Extract static relationships from model fields ─────────
  const staticRels = extractStaticRelationships(models);

  // ── 5. Deduplicate relationships — keep the richer version ────
  const relMap = new Map();

  const allRels = [...rawRelationships, ...staticRels];
  for (const rel of allRels) {
    // Key includes direction — User→Post (one-to-many) and Post→User (many-to-one) are different
    const key = `${rel.from}→${rel.to}:${rel.type}`;
    const existing = relMap.get(key);

    if (!existing) {
      relMap.set(key, rel);
    } else {
      if (scoreRelationship(rel) > scoreRelationship(existing)) {
        relMap.set(key, rel);
      }
    }
  }

  // Strip internal _static marker before returning
  const relationships = Array.from(relMap.values())
    .map(({ _static, ...rel }) => rel)
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // ── 6. Post-process: infer missing timestamps on all models ───
  for (const model of models) {
    if (!model.timestamps) {
      model.timestamps = detectTimestamps(model.fields);
    }
  }

  // ── 7. Build summary ──────────────────────────────────────────
  const summary = buildSummary(models, relationships);

  if (batchErrors.length > 0) {
    notify(
      `⚠ ${batchErrors.length} batch(es) had errors`,
      batchErrors.map((e) => e.error).join("; "),
    );
  }

  notify(
    `${models.length} models · ${relationships.length} relationships extracted`,
    [
      `${summary.withTimestamps} with timestamps`,
      `${summary.withSoftDelete} with soft delete`,
      `${summary.withIndexes} with indexes`,
      `avg ${summary.avgFieldsPerModel} fields/model`,
      Object.entries(summary.ormDist)
        .map(([orm, n]) => `${n} ${orm}`)
        .join(", "),
    ].join(" · "),
  );

  return {
    models,
    relationships,
    summary,
    errors: batchErrors.length > 0 ? batchErrors : undefined,
  };
}

// ─── Field Merge Helper ───────────────────────────────────────────

/**
 * Merge two field arrays from duplicate model extractions.
 * Union by field name — keeps the more complete version of each field.
 */
function mergeFields(fieldsA, fieldsB) {
  const fieldMap = new Map();

  for (const f of [...fieldsA, ...fieldsB]) {
    const existing = fieldMap.get(f.name);
    if (!existing) {
      fieldMap.set(f.name, f);
    } else {
      // Keep the version with more data
      const scoreF =
        (f.description ? 2 : 0) +
        (f.db_type ? 1 : 0) +
        (f.enum_values.length > 0 ? 1 : 0) +
        (f.relation ? 1 : 0);
      const scoreE =
        (existing.description ? 2 : 0) +
        (existing.db_type ? 1 : 0) +
        (existing.enum_values.length > 0 ? 1 : 0) +
        (existing.relation ? 1 : 0);
      if (scoreF > scoreE) fieldMap.set(f.name, f);
    }
  }

  return Array.from(fieldMap.values());
}
