// =============================================================
// Diff analysis for incremental documentation sync.
//
// Takes the changed file list (from SHA comparison or webhook payload)
// and maps each file to the agents that need to re-run + the doc
// sections those agents produce.
//
// Agent → File role mapping:
//   repoScanner    — all files (role classification)
//   apiExtractor   — route, controller, entry
//   schemaAnalyser — model, schema, migration
//   componentMapper— service, middleware, utility, config, helper
//   securityAuditor— any code file
//   docWriter      — runs on demand for changed sections only
//
// Manifest files (package.json etc.) trigger a FULL re-run because
// they signal structural changes: new deps, language changes, etc.
// =============================================================

// ── File role → agent mapping ─────────────────────────────────

const ROLE_TO_AGENTS = {
  route: ["apiExtractor", "securityAuditor"],
  controller: ["apiExtractor", "securityAuditor"],
  entry: ["apiExtractor", "securityAuditor"],
  model: ["schemaAnalyser", "securityAuditor"],
  schema: ["schemaAnalyser", "securityAuditor"],
  migration: ["schemaAnalyser"],
  service: ["componentMapper", "securityAuditor"],
  middleware: ["componentMapper", "securityAuditor"],
  utility: ["componentMapper", "securityAuditor"],
  config: ["componentMapper", "securityAuditor"],
  helper: ["componentMapper", "securityAuditor"],
  hook: ["componentMapper", "securityAuditor"],
  frontend: ["componentMapper", "securityAuditor"],
  other: ["securityAuditor"],
};

// Files that signal structural/dependency changes → full re-run
const MANIFEST_FILES =
  /package\.json$|requirements\.txt$|Cargo\.toml$|go\.mod$|pom\.xml$|composer\.json$|Gemfile$|pyproject\.toml$/i;

// Code file extensions (determines if securityAuditor should run)
const CODE_EXT =
  /\.(js|ts|jsx|tsx|py|go|rs|java|rb|php|cs|cpp|c|h|vue|svelte|prisma|graphql|sql)$/i;

// ── Agent → doc sections it affects ──────────────────────────
const AGENT_TO_SECTIONS = {
  repoScanner: [], // doesn't produce doc sections directly
  apiExtractor: ["apiReference"],
  schemaAnalyser: ["schemaDocs"],
  componentMapper: ["internalDocs"],
  securityAuditor: ["securityReport"],
};

// README is regenerated when any LLM-backed section changes
const README_TRIGGERS = new Set([
  "apiExtractor",
  "schemaAnalyser",
  "componentMapper",
]);

// ── Analysis result shape ─────────────────────────────────────
//
// {
//   needsFullRun  : boolean,      — manifest/structural change detected
//   fullRunReason : string|null,
//   agentsNeeded  : Set<string>,  — which agents should re-run
//   sectionsAffected: Set<string>,— which doc sections will be regenerated
//   changedByAgent: {             — which files each agent should process
//     apiExtractor: [{path, status}],
//     ...
//   },
// }

export function analyseChanges(changedFiles, fileManifest) {
  // changedFiles: [{path, status: 'added'|'modified'|'removed'}]
  // fileManifest: [{path, sha, role}]

  const manifestMap = new Map(fileManifest.map((f) => [f.path, f]));
  const result = {
    needsFullRun: false,
    fullRunReason: null,
    agentsNeeded: new Set(),
    sectionsAffected: new Set(),
    changedByAgent: {
      repoScanner: [],
      apiExtractor: [],
      schemaAnalyser: [],
      componentMapper: [],
      securityAuditor: [],
    },
    removedFiles: [],
    addedFiles: [],
  };

  for (const file of changedFiles) {
    const { path, status } = file;

    // Manifest file → full re-run
    if (MANIFEST_FILES.test(path)) {
      result.needsFullRun = true;
      result.fullRunReason = `Structural manifest file changed: ${path}`;
      return result; // early exit — no need to analyse further
    }

    if (status === "removed") {
      result.removedFiles.push(path);
      // Removed files still need agent re-runs to clear their entries
    }

    if (status === "added") {
      result.addedFiles.push(path);
    }

    // Determine role from manifest (for existing files) or from path
    const stored = manifestMap.get(path);
    const role = stored?.role || inferRoleFromPath(path);

    // Map role → agents
    const agents =
      ROLE_TO_AGENTS[role] || (CODE_EXT.test(path) ? ["securityAuditor"] : []);

    // repoScanner handles all non-removed files (role may have changed)
    if (status !== "removed") {
      result.agentsNeeded.add("repoScanner");
      result.changedByAgent.repoScanner.push(file);
    }

    for (const agent of agents) {
      result.agentsNeeded.add(agent);
      result.changedByAgent[agent].push(file);

      // Collect affected doc sections
      const sections = AGENT_TO_SECTIONS[agent] || [];
      for (const section of sections) {
        result.sectionsAffected.add(section);
      }
    }
  }

  // README gets regenerated if any LLM-producing agent runs
  for (const agent of result.agentsNeeded) {
    if (README_TRIGGERS.has(agent)) {
      result.sectionsAffected.add("readme");
      break;
    }
  }

  return result;
}

// ── Infer role from file path when not in manifest ────────────
function inferRoleFromPath(path) {
  if (/route|router/i.test(path)) return "route";
  if (/controller|handler/i.test(path)) return "controller";
  if (/model|schema|entity/i.test(path)) return "model";
  if (/migration/i.test(path)) return "migration";
  if (/service/i.test(path)) return "service";
  if (/middleware/i.test(path)) return "middleware";
  if (/util|helper/i.test(path)) return "utility";
  if (/config|\.env/i.test(path)) return "config";
  if (/^src\/index|^src\/server|^src\/app|^index|^server|^main/i.test(path))
    return "entry";
  if (/\.(test|spec)\.(js|ts)$/i.test(path)) return "test";
  return "other";
}

// ── Build merged agent outputs after incremental run ─────────
// Takes the existing stored agentOutputs and merges in new results
// from a partial re-run, handling added, modified, and removed files.
//
// Strategy per output type:
//   1. Remove all entries where entry.file is in changedFilePaths
//   2. Append new entries from the fresh agent run
//   This works because every agent tags its output with file paths.

export function mergeAgentOutputs(
  stored,
  fresh,
  changedFilePaths,
  removedFilePaths,
) {
  const allDirtyPaths = new Set([...changedFilePaths, ...removedFilePaths]);

  return {
    // Endpoints: filter out stale, add fresh
    endpoints: [
      ...stored.endpoints.filter((e) => !allDirtyPaths.has(e.file)),
      ...(fresh.endpoints || []),
    ],
    // Models: filter by file field
    models: [
      ...stored.models.filter((m) => !allDirtyPaths.has(m.file)),
      ...(fresh.models || []),
    ],
    // Relationships: stored by schemaAnalyser, no file field — full replace
    // when schemaAnalyser re-ran (caller passes fresh.relationships or [])
    relationships:
      fresh.relationships !== undefined
        ? [
            ...stored.relationships.filter((r) => {
              // Relationships don't have a file field — they're between models.
              // When schemaAnalyser re-ran, replace the full relationships array
              // since model ownership is ambiguous. If it didn't re-run, keep stored.
              return false;
            }),
            ...(fresh.relationships || []),
          ]
        : stored.relationships,
    // Components: filter by file field
    components: [
      ...stored.components.filter((c) => !allDirtyPaths.has(c.file)),
      ...(fresh.components || []),
    ],
    // Findings: filter by file field
    findings: [
      ...stored.findings.filter((f) => !allDirtyPaths.has(f.file)),
      ...(fresh.findings || []),
    ],
    // ProjectMap: update role classifications for changed files
    projectMap: [
      ...stored.projectMap.filter((p) => !allDirtyPaths.has(p.path)),
      ...(fresh.projectMap || []),
    ],
  };
}

// ── Build updated fileManifest ────────────────────────────────
// Merges stored manifest with the current tree's SHA data.
export function updateFileManifest(storedManifest, currentTree, newProjectMap) {
  const roleMap = new Map(newProjectMap.map((p) => [p.path, p.role]));
  const shaMap = new Map(currentTree.map((f) => [f.path, f.sha]));
  const pathSet = new Set(currentTree.map((f) => f.path));

  // Remove entries for files no longer in tree
  const surviving = storedManifest.filter((f) => pathSet.has(f.path));

  // Update SHAs and roles for surviving entries + add new files
  const updated = new Map(surviving.map((f) => [f.path, f]));

  for (const f of currentTree) {
    const existingRole = updated.get(f.path)?.role;
    updated.set(f.path, {
      path: f.path,
      sha: shaMap.get(f.path) || "",
      role: roleMap.get(f.path) || existingRole || inferRoleFromPath(f.path),
    });
  }

  return [...updated.values()];
}
