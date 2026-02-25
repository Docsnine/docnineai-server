// src/services/githubService.js
// ─────────────────────────────────────────────────────────────
// Responsible for all GitHub API interactions:
//   • Parse repo URL → owner/repo
//   • Fetch complete file tree (recursive)
//   • Fetch individual file content
//   • Respect rate limits & max file sizes
// ─────────────────────────────────────────────────────────────

import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const GH_API      = "https://api.github.com";
const MAX_FILES   = parseInt(process.env.MAX_FILES_PER_REPO || "100");
const MAX_KB      = parseInt(process.env.MAX_FILE_SIZE_KB   || "50");

const headers = {
  Accept: "application/vnd.github+json",
  ...(process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
};

// ── helpers ──────────────────────────────────────────────────
export function parseRepoUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/?.]+)/);
  if (!match) throw new Error(`Invalid GitHub URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}

// ── API calls ─────────────────────────────────────────────────
export async function getRepoMeta(owner, repo) {
  const { data } = await axios.get(`${GH_API}/repos/${owner}/${repo}`, { headers });
  return {
    name        : data.name,
    description : data.description,
    language    : data.language,
    stars       : data.stargazers_count,
    defaultBranch: data.default_branch,
    topics      : data.topics,
    createdAt   : data.created_at,
    updatedAt   : data.updated_at,
  };
}

export async function getFileTree(owner, repo, branch) {
  const { data } = await axios.get(
    `${GH_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers }
  );
  if (data.truncated) {
    console.warn("⚠️  Tree truncated — repo is very large, some files may be skipped.");
  }
  return data.tree
    .filter((item) => item.type === "blob")
    .map((item) => ({ path: item.path, size: item.size }));
}

export async function getFileContent(owner, repo, filePath) {
  try {
    const { data } = await axios.get(
      `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`,
      { headers }
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

// ── Main export: fetch & filter repo files ────────────────────
export async function fetchRepoFiles(repoUrl) {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const meta             = await getRepoMeta(owner, repo);
  const allFiles         = await getFileTree(owner, repo, meta.defaultBranch);

  // Filter out binaries and oversized files
  const SKIP_EXT = /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz|mp4|mp3|bin|exe|dll|so|dylib|lock)$/i;
  const eligible = allFiles
    .filter((f) => !SKIP_EXT.test(f.path) && f.size < MAX_KB * 1024)
    .slice(0, MAX_FILES);

  console.log(`📂 Fetching ${eligible.length} files from ${owner}/${repo}…`);

  const files = [];
  for (const file of eligible) {
    const content = await getFileContent(owner, repo, file.path);
    if (content.trim()) {
      files.push({ path: file.path, content });
    }
  }

  return { meta, files, owner, repo };
}
