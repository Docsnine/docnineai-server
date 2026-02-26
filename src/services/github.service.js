// =============================================================
// GitHub API client.
//
// v3.1 additions:
//   getCommitSha        — resolve branch name → git SHA
//   getFileTreeWithSha  — full tree with per-file blob SHAs
//   computeFileDiff     — compare stored fileManifest against a
//                         fresh tree to find added/modified/removed
//                         files without using the compare API
// =============================================================

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const GH_API = "https://api.github.com";
const MAX_FILES = parseInt(process.env.MAX_FILES_PER_REPO || "100");
const MAX_KB = parseInt(process.env.MAX_FILE_SIZE_KB || "50");

const SKIP_EXT =
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz|mp4|mp3|bin|exe|dll|so|dylib|lock)$/i;

function ghHeaders() {
  return {
    Accept: "application/vnd.github+json",
    ...(process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}),
  };
}

// ── URL parsing ───────────────────────────────────────────────

export function parseRepoUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/?.]+)/);
  if (!match) throw new Error(`Invalid GitHub URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}

// ── Repo metadata ─────────────────────────────────────────────

export async function getRepoMeta(owner, repo) {
  const { data } = await axios.get(`${GH_API}/repos/${owner}/${repo}`, {
    headers: ghHeaders(),
  });
  return {
    name: data.name,
    description: data.description,
    language: data.language,
    stars: data.stargazers_count,
    defaultBranch: data.default_branch,
    topics: data.topics,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

// ── Commit SHA resolution ─────────────────────────────────────
// Returns the git commit SHA for the HEAD of a branch.
// This is the canonical identifier we store as lastDocumentedCommit.
export async function getCommitSha(owner, repo, branch) {
  const { data } = await axios.get(
    `${GH_API}/repos/${owner}/${repo}/commits/${branch}`,
    { headers: ghHeaders() },
  );
  return data.sha;
}

// ── File tree (original — path + size only) ───────────────────

export async function getFileTree(owner, repo, branch) {
  const { data } = await axios.get(
    `${GH_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: ghHeaders() },
  );
  if (data.truncated) {
    console.warn(
      "⚠️  Tree truncated — repo is very large, some files may be skipped.",
    );
  }
  return data.tree
    .filter((item) => item.type === "blob")
    .map((item) => ({ path: item.path, size: item.size }));
}

// ── File tree with blob SHAs ──────────────────────────────────
// Returns the full tree including per-file git blob SHAs.
// These SHAs are stable — they only change when file content changes.
// This is how we detect what changed between two pipeline runs
// without needing the GitHub compare API.
export async function getFileTreeWithSha(owner, repo, branch) {
  const { data } = await axios.get(
    `${GH_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: ghHeaders() },
  );
  if (data.truncated) {
    console.warn("⚠️  Tree truncated — some files may be missed in diff.");
  }
  return data.tree
    .filter((item) => item.type === "blob")
    .map((item) => ({ path: item.path, sha: item.sha, size: item.size }));
}

// ── Compute file diff from stored manifest ────────────────────
// Compares the current GitHub tree (with SHAs) against the project's
// stored fileManifest to find what changed since last documentation run.
//
// Returns:
//   added    — new files not in manifest
//   modified — files whose blob SHA changed
//   removed  — files in manifest but no longer in tree
//   unchanged — files with matching SHAs (safe to skip)
//
// SKIP_EXT files are filtered out — agents don't process them anyway.
export async function computeFileDiff(owner, repo, branch, storedManifest) {
  const currentTree = await getFileTreeWithSha(owner, repo, branch);
  const eligible = currentTree.filter(
    (f) => !SKIP_EXT.test(f.path) && f.size < MAX_KB * 1024,
  );

  // Build lookup maps
  const manifestMap = new Map(storedManifest.map((f) => [f.path, f]));
  const currentMap = new Map(eligible.map((f) => [f.path, f]));

  const added = [];
  const modified = [];
  const removed = [];
  const unchanged = [];

  // Check current tree against stored manifest
  for (const [path, cur] of currentMap) {
    const stored = manifestMap.get(path);
    if (!stored) {
      added.push({ path, sha: cur.sha, status: "added" });
    } else if (stored.sha !== cur.sha) {
      modified.push({ path, sha: cur.sha, status: "modified" });
    } else {
      unchanged.push({ path });
    }
  }

  // Files in manifest that are no longer in the tree
  for (const [path] of manifestMap) {
    if (!currentMap.has(path)) {
      removed.push({ path, status: "removed" });
    }
  }

  return { added, modified, removed, unchanged, currentTree: eligible };
}

// ── Individual file content ───────────────────────────────────

export async function getFileContent(owner, repo, filePath) {
  try {
    const { data } = await axios.get(
      `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`,
      { headers: ghHeaders() },
    );
    if (data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return data.content || "";
  } catch (err) {
    if (err.response?.status === 403) return ""; // binary / too large
    throw err;
  }
}

// ── Batch-fetch file contents from a list of paths ────────────
// Used by incremental sync to fetch only changed files.
export async function fetchFileContents(owner, repo, filePaths, onProgress) {
  const notify = (msg) => {
    if (onProgress) onProgress(msg);
  };
  const files = [];

  for (const [i, path] of filePaths.entries()) {
    const content = await getFileContent(owner, repo, path);
    if (content.trim()) files.push({ path, content });
    if ((i + 1) % 10 === 0 || i === filePaths.length - 1) {
      notify(`Fetching changed files… ${i + 1}/${filePaths.length}`);
    }
  }
  return files;
}

// ── Full repo fetch (original — used for full pipeline runs) ──

export async function fetchRepoFiles(repoUrl) {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const meta = await getRepoMeta(owner, repo);
  const allFiles = await getFileTree(owner, repo, meta.defaultBranch);

  const eligible = allFiles
    .filter((f) => !SKIP_EXT.test(f.path) && f.size < MAX_KB * 1024)
    .slice(0, MAX_FILES);

  console.log(`📂 Fetching ${eligible.length} files from ${owner}/${repo}…`);

  const files = [];
  for (const file of eligible) {
    const content = await getFileContent(owner, repo, file.path);
    if (content.trim()) files.push({ path: file.path, content });
  }
  return { meta, files, owner, repo };
}

// ── Full repo fetch with progress events ─────────────────────

export async function fetchRepoFilesWithProgress(repoUrl, onProgress) {
  const notify = (msg) => {
    if (onProgress) onProgress(msg);
  };

  const { owner, repo } = parseRepoUrl(repoUrl);
  notify(`Reading repo info for ${owner}/${repo}…`);
  const meta = await getRepoMeta(owner, repo);

  notify(`Reading file tree on branch "${meta.defaultBranch}"…`);
  const allFiles = await getFileTree(owner, repo, meta.defaultBranch);

  const eligible = allFiles
    .filter((f) => !SKIP_EXT.test(f.path) && f.size < MAX_KB * 1024)
    .slice(0, MAX_FILES);

  notify(`Downloading ${eligible.length} source files…`);

  const files = [];
  for (const [i, file] of eligible.entries()) {
    const content = await getFileContent(owner, repo, file.path);
    if (content.trim()) files.push({ path: file.path, content });
    if ((i + 1) % 20 === 0 || i === eligible.length - 1) {
      notify(`Downloaded ${i + 1} / ${eligible.length} files…`);
    }
  }

  return { meta, files, owner, repo };
}
