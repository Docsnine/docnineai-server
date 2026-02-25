// ===================================================================
// GitHub OAuth flow and repository access.
//
// WHY no module-level env var constants:
//   ESM module evaluation happens before dotenv.config() in server.js.
//   Reading process.env at module load time gives undefined for .env values.
//   All env reads are inside functions so they run after dotenv has loaded.
//
// Required env:
//   GITHUB_CLIENT_ID      — from your GitHub OAuth App
//   GITHUB_CLIENT_SECRET  — from your GitHub OAuth App
//   GITHUB_REDIRECT_URI   — must match what's registered on GitHub
//                           e.g. http://localhost:3000/github/oauth/callback
//   JWT_ACCESS_SECRET     — reused as OAuth state JWT secret (10-min expiry)
// ===================================================================

import jwt from "jsonwebtoken";
import axios from "axios";

import { User } from "../../models/User.js";
import { GitHubToken } from "../../models/GitHubToken.js";
import { encrypt, decrypt } from "../../utils/crypto.util.js";

const GH_API = "https://api.github.com";
const GH_AUTH = "https://github.com/login/oauth";

// ── Internal helpers ──────────────────────────────────────────

/** Read and validate GitHub OAuth credentials at call-time. */
function getOAuthConfig() {
  const CLIENT_ID = process.env.GITHUB_CLIENT_ID;
  const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
  const REDIRECT_URI = process.env.GITHUB_REDIRECT_URI;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set in .env\n" +
        "Create an OAuth App at: https://github.com/settings/developers",
    );
  }

  return { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI };
}

/** JWT secret for signing the OAuth state parameter. */
function getStateSecret() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("JWT_ACCESS_SECRET must be set in .env");
  return secret;
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchGitHubUser(accessToken) {
  const res = await axios.get(`${GH_API}/user`, {
    headers: ghHeaders(accessToken),
  });
  return res.data;
}

async function getDecryptedToken(userId) {
  const record = await GitHubToken.findOne({ userId }).select(
    "+accessTokenEncrypted",
  );
  if (!record) {
    const err = new Error(
      "No GitHub account connected. Please connect via GET /github/oauth/start.",
    );
    err.code = "GITHUB_NOT_CONNECTED";
    err.status = 403;
    throw err;
  }
  return decrypt(record.accessTokenEncrypted);
}

// ── OAuth Step 1: Build authorisation URL ─────────────────────

/**
 * Generate the GitHub OAuth authorisation URL.
 * The `state` parameter is a short-lived signed JWT containing the userId —
 * this serves as CSRF protection with no server-side state required.
 *
 * @param {string} userId
 * @returns {string} redirect URL
 */
export function buildOAuthUrl(userId) {
  const { CLIENT_ID, REDIRECT_URI } = getOAuthConfig();
  const stateSecret = getStateSecret();

  const state = jwt.sign({ userId }, stateSecret, { expiresIn: "10m" });

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "repo read:user user:email",
    state,
  });

  return `${GH_AUTH}/authorize?${params.toString()}`;
}

// ── OAuth Step 2: Exchange code → token ───────────────────────

/**
 * Complete the OAuth flow: exchange code, fetch GitHub profile,
 * encrypt and persist the token.
 *
 * @param {{ code: string, state: string }}
 * @returns {{ githubUsername: string }}
 */
export async function handleOAuthCallback({ code, state }) {
  const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = getOAuthConfig();
  const stateSecret = getStateSecret();

  // 1. Verify state JWT (CSRF check)
  let statePayload;
  try {
    statePayload = jwt.verify(state, stateSecret);
  } catch {
    const err = new Error(
      "Invalid or expired OAuth state. Please start the OAuth flow again.",
    );
    err.code = "INVALID_OAUTH_STATE";
    err.status = 400;
    throw err;
  }

  const userId = statePayload.userId;

  // 2. Exchange code for access token
  const tokenRes = await axios.post(
    `${GH_AUTH}/access_token`,
    {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    },
    { headers: { Accept: "application/json" } },
  );

  const { access_token, scope, error } = tokenRes.data;
  if (error || !access_token) {
    const err = new Error(
      `GitHub OAuth error: ${error || "no access token returned"}`,
    );
    err.code = "OAUTH_EXCHANGE_FAILED";
    err.status = 400;
    throw err;
  }

  // 3. Fetch GitHub user profile
  const ghUser = await fetchGitHubUser(access_token);

  // 4. Update User record with GitHub identity
  await User.findByIdAndUpdate(userId, {
    githubId: String(ghUser.id),
    githubUsername: ghUser.login,
  });

  // 5. Upsert encrypted token — one document per user
  await GitHubToken.findOneAndUpdate(
    { userId },
    {
      userId,
      accessTokenEncrypted: encrypt(access_token),
      scopes: (scope || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      githubUserId: String(ghUser.id),
      githubUsername: ghUser.login,
      githubEmail: ghUser.email || null,
      connectedAt: new Date(),
    },
    { upsert: true, new: true },
  );

  return { githubUsername: ghUser.login };
}

// ── Get user repositories ─────────────────────────────────────

/**
 * Fetch repositories the user has access to (public + private).
 * @param {string} userId
 * @param {{ page, perPage, type, sort }}
 * @returns {{ repos, page, perPage, hasNextPage }}
 */
export async function getUserRepos(
  userId,
  {
    page = 1,
    perPage = 30,
    type = "all", // all | owner | member | public | private
    sort = "updated", // created | updated | pushed | full_name
  } = {},
) {
  const token = await getDecryptedToken(userId);

  const res = await axios.get(`${GH_API}/user/repos`, {
    headers: ghHeaders(token),
    params: { type, sort, per_page: perPage, page },
  });

  const repos = res.data.map((r) => ({
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    description: r.description,
    url: r.html_url,
    cloneUrl: r.clone_url,
    language: r.language,
    stars: r.stargazers_count,
    forks: r.forks_count,
    isPrivate: r.private,
    isArchived: r.archived,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
  }));

  // GitHub paginates via Link header
  const linkHeader = res.headers.link || "";
  const hasNextPage = linkHeader.includes('rel="next"');

  return { repos, page, perPage, hasNextPage };
}

// ── Connection status ─────────────────────────────────────────

/**
 * Return public GitHub connection metadata for a user, or null if not connected.
 * @param {string} userId
 */
export async function getConnectionStatus(userId) {
  const record = await GitHubToken.findOne({ userId });
  if (!record) return null;
  return {
    connected: true,
    githubUsername: record.githubUsername,
    scopes: record.scopes,
    connectedAt: record.connectedAt,
  };
}

// ── Disconnect ────────────────────────────────────────────────

/**
 * Remove the stored GitHub token and unlink the GitHub identity from the user.
 * @param {string} userId
 */
export async function disconnectGitHub(userId) {
  await GitHubToken.findOneAndDelete({ userId });
  await User.findByIdAndUpdate(userId, {
    $unset: { githubId: 1, githubUsername: 1 },
  });
}
