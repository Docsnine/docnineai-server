import crypto from "crypto";

const CODE_FILE =
  /\.(js|ts|jsx|tsx|py|go|rs|java|rb|php|cs|cpp|c|h|vue|svelte|prisma|graphql|sql|kt|swift|dart)$/i;

const MANIFEST_FILE =
  /^(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|Pipfile|Pipfile\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle|composer\.json|Gemfile|Gemfile\.lock)$/i;

export function validateWebhookSignature(rawPayload, signature, secret) {
  if (!secret) return true;
  if (!signature || typeof signature !== "string") return false;

  const computed = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawPayload)
    .digest("hex")}`;

  const a = Buffer.from(signature);
  const b = Buffer.from(computed);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

export function shouldReDocument(pushPayload) {
  const { ref, repository, commits = [], after } = pushPayload;
  const defaultBranch = repository?.default_branch || "main";

  if (!ref || !ref.endsWith(`/${defaultBranch}`)) {
    return { should: false, reason: "not_default_branch", ref, defaultBranch };
  }

  if (after === "0000000000000000000000000000000000000000") {
    return { should: false, reason: "branch_deleted" };
  }

  if (!commits.length) {
    return { should: false, reason: "no_commits" };
  }

  const pathMap = new Map();

  for (const commit of commits) {
    for (const p of commit.added || [])
      pathMap.set(p, { path: p, status: "added" });
    for (const p of commit.modified || [])
      pathMap.set(p, { path: p, status: "modified" });
    for (const p of commit.removed || [])
      pathMap.set(p, { path: p, status: "removed" });
  }

  const changedFiles = [...pathMap.values()];
  const codeFiles = changedFiles.filter((f) => CODE_FILE.test(f.path));

  if (codeFiles.length === 0) {
    return {
      should: false,
      reason: "no_code_changes",
      totalChanged: changedFiles.length,
    };
  }

  const needsFullRun = changedFiles.some((f) =>
    MANIFEST_FILE.test(f.path.split("/").pop()),
  );

  return {
    should: true,
    reason: "code_changed",
    changedFiles,
    codeFiles,
    needsFullRun,
    repoUrl: repository?.html_url,
    repoFullName: repository?.full_name,
    pusher: pushPayload.pusher?.name || pushPayload.sender?.login,
    branch: defaultBranch,
    headCommit: after,
    commitCount: commits.length,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRepoIdentity(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  const fullName = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (fullName) {
    const owner = fullName[1];
    const repo = fullName[2].replace(/\.git$/i, "");
    return {
      owner,
      repo,
      fullName: `${owner}/${repo}`,
      repoUrl: `https://github.com/${owner}/${repo}`,
    };
  }

  try {
    let normalized = raw;
    if (/^git@github\.com:/i.test(normalized)) {
      normalized = `https://github.com/${normalized.replace(/^git@github\.com:/i, "")}`;
    }

    const u = new URL(normalized);
    if (!/github\.com$/i.test(u.hostname)) return null;

    const parts = u.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .split("/");

    if (parts.length < 2 || !parts[0] || !parts[1]) return null;

    const owner = parts[0];
    const repo = parts[1];
    return {
      owner,
      repo,
      fullName: `${owner}/${repo}`,
      repoUrl: `https://github.com/${owner}/${repo}`,
    };
  } catch {
    return null;
  }
}

function getRepoIdentityFromPayload(payload) {
  const repository = payload?.repository || {};
  const candidates = [
    repository.full_name,
    repository.html_url,
    repository.clone_url,
    repository.ssh_url,
    repository.git_url,
  ];

  for (const c of candidates) {
    const parsed = parseRepoIdentity(c);
    if (parsed) return parsed;
  }

  if (repository.owner?.login && repository.name) {
    const owner = String(repository.owner.login);
    const repo = String(repository.name).replace(/\.git$/i, "");
    return {
      owner,
      repo,
      fullName: `${owner}/${repo}`,
      repoUrl: `https://github.com/${owner}/${repo}`,
    };
  }

  return null;
}

async function findProjectAndUserForWebhook({
  rawPayload,
  signature,
  repoIdentity,
}) {
  const { Project } = await import("../models/Project.js");
  const { User } = await import("../models/User.js");

  const ownerRx = new RegExp(`^${escapeRegExp(repoIdentity.owner)}$`, "i");
  const repoRx = new RegExp(`^${escapeRegExp(repoIdentity.repo)}$`, "i");

  const candidates = await Project.find({
    repoOwner: ownerRx,
    repoName: repoRx,
    status: { $ne: "archived" },
  })
    .select("_id userId repoUrl repoOwner repoName status updatedAt")
    .sort({ updatedAt: -1 })
    .lean(false);

  if (!candidates.length) {
    return { kind: "no_project" };
  }

  const userCache = new Map();
  const userOrder = [];
  const seen = new Set();

  for (const project of candidates) {
    const userId = project.userId.toString();
    if (seen.has(userId)) continue;
    seen.add(userId);
    userOrder.push(userId);
  }

  for (const userId of userOrder) {
    if (!userCache.has(userId)) {
      const user = await User.findById(userId).select(
        "+webhookSecret webhookEnabled",
      );
      userCache.set(userId, user || null);
    }

    const user = userCache.get(userId);
    if (!user?.webhookSecret) continue;

    const valid = validateWebhookSignature(
      rawPayload,
      signature || "",
      user.webhookSecret,
    );

    if (!valid) continue;

    const userProjects = candidates.filter(
      (p) => p.userId.toString() === userId,
    );
    const project =
      userProjects.find((p) => p.status === "done" || p.status === "error") ||
      userProjects[0];

    return { kind: "match", project, user };
  }

  return { kind: "invalid_signature" };
}

async function updateUserWebhookStatus({ userId, status }) {
  try {
    const { User } = await import("../models/User.js");
    await User.findByIdAndUpdate(userId, {
      $set: {
        lastWebhookAt: new Date(),
        lastWebhookStatus: status,
      },
    });
  } catch (err) {
    console.error(
      `[webhook] Failed to update user webhook status (${userId}): ${err.message}`,
    );
  }
}

export async function handleWebhook({ payload, signature }) {
  const rawPayload = Buffer.isBuffer(payload)
    ? payload
    : typeof payload === "string"
      ? Buffer.from(payload, "utf8")
      : null;

  if (!rawPayload) {
    console.error("[webhook] Invalid payload type (expected Buffer/string)");
    return {
      status: 400,
      body: {
        error:
          "Invalid payload format. Ensure raw body middleware is applied to this route.",
      },
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawPayload.toString("utf8"));
  } catch (err) {
    return {
      status: 400,
      body: { error: `Invalid JSON payload: ${err.message}` },
    };
  }

  const repoIdentity = getRepoIdentityFromPayload(parsed);
  if (!repoIdentity) {
    return {
      status: 400,
      body: {
        error:
          "Could not determine repository identity from payload. Ensure repository.full_name or repository.html_url is present.",
      },
    };
  }

  const match = await findProjectAndUserForWebhook({
    rawPayload,
    signature,
    repoIdentity,
  });

  if (match.kind === "no_project") {
    console.log(`[webhook] No project registered for ${repoIdentity.fullName}`);
    return {
      status: 200,
      body: {
        message:
          "No project registered for this repository. Create one via the dashboard first.",
        repoUrl: repoIdentity.repoUrl,
      },
    };
  }

  if (match.kind === "invalid_signature") {
    console.warn(
      `[webhook] Signature validation failed for ${repoIdentity.fullName}`,
    );
    return { status: 401, body: { error: "Invalid webhook signature" } };
  }

  const project = match.project;
  const user = match.user;

  if (!user.webhookEnabled) {
    console.log(
      `[webhook] Skipped for user ${user._id}: account webhooks are disabled`,
    );
    await updateUserWebhookStatus({ userId: user._id, status: "skipped" });
    return {
      status: 200,
      body: { message: "Webhooks are disabled for this account." },
    };
  }

  const isPushEvent = parsed.ref && parsed.commits !== undefined;
  const isPingEvent = parsed.zen !== undefined;

  if (isPingEvent) {
    console.log(`[webhook] Ping event verified for user ${user._id}`);
    await updateUserWebhookStatus({ userId: user._id, status: "success" });
    return {
      status: 200,
      body: { message: "Pong! Webhook configured correctly." },
    };
  }

  if (!isPushEvent) {
    await updateUserWebhookStatus({ userId: user._id, status: "skipped" });
    return {
      status: 200,
      body: {
        message: "Event type not handled - only push events trigger sync.",
      },
    };
  }

  const check = shouldReDocument(parsed);
  if (!check.should) {
    console.log(`[webhook] Skipped for ${project._id}: ${check.reason}`);
    await updateUserWebhookStatus({ userId: user._id, status: "skipped" });
    return {
      status: 200,
      body: { message: `Skipped: ${check.reason}`, detail: check },
    };
  }

  if (project.status === "running" || project.status === "queued") {
    await updateUserWebhookStatus({ userId: user._id, status: "skipped" });
    return {
      status: 202,
      body: { message: "Pipeline already running", projectId: project._id },
    };
  }

  if (project.status === "archived") {
    await updateUserWebhookStatus({ userId: user._id, status: "skipped" });
    return {
      status: 202,
      body: { message: "Project is archived", projectId: project._id },
    };
  }

  if (project.status !== "done" && project.status !== "error") {
    await updateUserWebhookStatus({ userId: user._id, status: "skipped" });
    return {
      status: 202,
      body: {
        message: "Project must be in done or error state to sync",
        status: project.status,
        projectId: project._id,
      },
    };
  }

  const { syncProject } = await import("../api/projects/project.service.js");

  try {
    const result = await syncProject({
      projectId: project._id.toString(),
      userId: project.userId.toString(),
      forceFullRun: check.needsFullRun,
      webhookChangedFiles: check.changedFiles,
    });

    await updateUserWebhookStatus({ userId: user._id, status: "success" });

    return {
      status: 202,
      body: {
        message: "Sync triggered",
        projectId: project._id,
        jobId: result.project?.jobId,
        streamUrl: result.streamUrl,
        repoUrl: project.repoUrl || repoIdentity.repoUrl,
        branch: check.branch,
        headCommit: check.headCommit?.slice(0, 8),
        codeFiles: check.codeFiles.length,
        needsFullRun: check.needsFullRun,
      },
    };
  } catch (err) {
    console.error(
      `[webhook] Failed to trigger sync for project ${project._id}: ${err.message}`,
    );
    await updateUserWebhookStatus({ userId: user._id, status: "failed" });
    return {
      status: 500,
      body: {
        error: `Failed to trigger sync: ${err.message}`,
        code: err.code,
      },
    };
  }
}

export function generateGitHubActionsWorkflow(apiBaseUrl) {
  const base = (apiBaseUrl || "https://your-docnine-instance.com").replace(
    /\/$/,
    "",
  );

  return `# .github/workflows/document.yml
# Auto-generated by Docnine
# Triggers an incremental documentation sync on every push to main.
# Only changed files are re-documented - fast and token-efficient.
#
# SETUP:
#   1. Go to your repo Settings -> Secrets and variables -> Actions
#   2. Add a secret named DOCNINE_WEBHOOK_SECRET
#      (copy once from Docnine Settings -> Webhook Integration)
#   3. Commit this workflow file
#
# Reuse the same DOCNINE_WEBHOOK_SECRET across all repos in your account.

name: Auto-Document

on:
  push:
    branches: [ main, master ]
    paths:
      - '**.js'
      - '**.ts'
      - '**.tsx'
      - '**.jsx'
      - '**.py'
      - '**.go'
      - '**.rs'
      - '**.java'
      - '**.kt'
      - '**.prisma'
      - '**.graphql'
      - '**.sql'
      - 'package.json'
      - 'requirements.txt'
      - 'go.mod'
      - 'Cargo.toml'
  workflow_dispatch:

jobs:
  document:
    name: Incremental Documentation Sync
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - name: Trigger Docnine Documentation Sync
        env:
          WEBHOOK_SECRET: \${{ secrets.DOCNINE_WEBHOOK_SECRET }}
          APP_URL:   ${base}
        run: |
          # Build the payload from the GitHub push context
          REPO_URL="\${{ github.server_url }}/\${{ github.repository }}"
          HEAD_COMMIT="\${{ github.sha }}"
          PUSHER="\${{ github.actor }}"
          REF="\${{ github.ref }}"

          PAYLOAD=$(cat <<EOF
          {
            "ref": "\${REF}",
            "after": "\${HEAD_COMMIT}",
            "pusher": { "name": "\${PUSHER}" },
            "repository": {
              "html_url": "\${REPO_URL}",
              "full_name": "\${{ github.repository }}",
              "default_branch": "\${{ github.event.repository.default_branch || 'main' }}"
            },
            "commits": \${{ toJson(github.event.commits) }}
          }
          EOF
          )

          SIGNATURE="sha256=\$(echo -n "\${PAYLOAD}" | openssl dgst -sha256 -hmac "\${WEBHOOK_SECRET}" | awk '{print \$2}')"

          echo "Sending sync request to \${APP_URL}/webhook/github"
          echo "Repository: \${REPO_URL}"
          echo "Commit: \${HEAD_COMMIT}"

          HTTP_STATUS=\$(curl -s -o /tmp/webhook_response.json -w "%{http_code}" \\
            -X POST \\
            -H "Content-Type: application/json" \\
            -H "X-Hub-Signature-256: \${SIGNATURE}" \\
            -H "X-GitHub-Event: push" \\
            --data-binary "\${PAYLOAD}" \\
            "\${APP_URL}/webhook/github")

          RESPONSE=\$(cat /tmp/webhook_response.json)
          echo "HTTP Status: \${HTTP_STATUS}"
          echo "Response: \${RESPONSE}"

          if [ "\${HTTP_STATUS}" -ge 400 ]; then
            echo "Webhook returned HTTP \${HTTP_STATUS}"
            echo "Error: \$(echo "\${RESPONSE}" | jq -r '.error // .message // "Unknown error"')"
            exit 1
          fi

          MESSAGE=\$(echo "\${RESPONSE}" | jq -r '.message // "Webhook delivered"')
          PROJECT_ID=\$(echo "\${RESPONSE}" | jq -r '.projectId // ""')

          if [ -n "\${PROJECT_ID}" ]; then
            echo "Sync triggered for project \${PROJECT_ID}"
          else
            echo "\${MESSAGE}"
          fi
`;
}

// handleProjectWebhook has been removed (v4.1+)
// Webhook architecture now uses user-level webhook secret with server-side repo matching.
// See handleWebhook() for the current implementation.
