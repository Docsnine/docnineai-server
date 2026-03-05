import crypto from "crypto";

// ─── Constants ────────────────────────────────────────────────────

const CODE_FILE =
  /\.(js|ts|jsx|tsx|py|go|rs|java|rb|php|cs|cpp|c|h|vue|svelte|prisma|graphql|sql|kt|swift|dart)$/i;

// Manifest files that trigger a full re-run when changed
const MANIFEST_FILE =
  /^(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|Pipfile|Pipfile\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle|composer\.json|Gemfile|Gemfile\.lock)$/i;

// ─── Signature Validation ─────────────────────────────────────────

/**
 * Validate a GitHub webhook HMAC-SHA256 signature.
 *
 * BUG FIXED: The original used crypto.timingSafeEqual() which THROWS
 * when the two buffers have different lengths (e.g. malformed signature
 * header). The catch block returned false which masked the real error,
 * but also meant any exception — including legitimate errors — silently
 * failed validation. We now explicitly check lengths before comparing.
 *
 * BUG FIXED: The original accepted `payload` as either a string or
 * Buffer without normalising it first. crypto.createHmac().update()
 * handles both, but callers were sometimes passing a parsed JSON object
 * (after express.json() had already consumed the raw body), which
 * caused JSON.stringify(object) !== original_raw_bytes → always invalid.
 * The fix is enforced at the route level (see api-router.js), but we
 * also guard here.
 *
 * @param {Buffer|string} rawPayload   — raw request body bytes (NOT parsed)
 * @param {string}        signature    — value of X-Hub-Signature-256 header
 * @param {string}        secret       — WEBHOOK_SECRET env variable
 */
// webhook.service.js - in validateWebhookSignature
export function validateWebhookSignature(rawPayload, signature, secret) {
  if (!secret) return true;

  const computed = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawPayload)
    .digest("hex")}`;

  const a = Buffer.from(signature);
  const b = Buffer.from(computed);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Should Re-Document? ──────────────────────────────────────────

/**
 * Analyse a push payload and decide whether to trigger a sync.
 *
 * Returns:
 *   { should: false, reason }
 *   { should: true, changedFiles, codeFiles, needsFullRun, ... }
 */
export function shouldReDocument(pushPayload) {
  const { ref, repository, commits = [], after } = pushPayload;
  const defaultBranch = repository?.default_branch || "main";

  // Only respond to pushes on the default branch
  if (!ref || !ref.endsWith(`/${defaultBranch}`)) {
    return { should: false, reason: "not_default_branch", ref, defaultBranch };
  }

  // after = "0000000000000000000000000000000000000000" means branch deleted
  if (after === "0000000000000000000000000000000000000000") {
    return { should: false, reason: "branch_deleted" };
  }

  if (!commits.length) {
    return { should: false, reason: "no_commits" };
  }

  // Build a deduplicated changed-file list from all commits in the push.
  // Priority: removed > modified > added (last write wins per path)
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

  // Check if a manifest file changed — signals a full re-run is needed
  const needsFullRun = changedFiles.some((f) =>
    MANIFEST_FILE.test(f.path.split("/").pop()),
  );

  return {
    should: true,
    reason: "code_changed",
    changedFiles, // all changed files (all statuses)
    codeFiles, // code-only subset
    needsFullRun, // true → force full pipeline
    repoUrl: repository?.html_url,
    repoFullName: repository?.full_name,
    pusher: pushPayload.pusher?.name || pushPayload.sender?.login,
    branch: defaultBranch,
    headCommit: after, // new HEAD SHA from push event
    commitCount: commits.length,
  };
}

// ─── Handle Incoming Push Webhook ─────────────────────────────────

/**
 * Process a GitHub push webhook.
 *
 * Expects:
 *   payload   — raw Buffer or string (NOT parsed object — see note above)
 *   signature — X-Hub-Signature-256 header value
 *   secret    — WEBHOOK_SECRET
 */
export async function handleWebhook({ payload, signature, secret }) {
  // ── 1. Validate signature ──────────────────────────────────
  const rawPayload = Buffer.isBuffer(payload)
    ? payload
    : typeof payload === "string"
      ? payload
      : null;

  if (!rawPayload) {
    console.error(
      "[webhook] ✗ Payload is neither Buffer nor string — raw body middleware missing",
    );
    return {
      status: 400,
      body: {
        error:
          "Invalid payload format. Ensure raw body middleware is applied to this route.",
      },
    };
  }

  const isValid = validateWebhookSignature(rawPayload, signature, secret);
  if (!isValid) {
    console.warn("[webhook] ✗ Signature validation failed");
    console.warn(`[webhook]   Received:  ${signature?.slice(0, 45)}...`);
    console.warn(`[webhook]   Secret set: ${!!secret}`);
    console.warn(`[webhook]   Payload length: ${rawPayload.length} bytes`);
    return { status: 401, body: { error: "Invalid webhook signature" } };
  }

  console.log("[webhook] ✓ Signature valid");

  // ── 2. Parse payload ──────────────────────────────────────
  let parsed;
  try {
    parsed = JSON.parse(rawPayload.toString("utf8"));
  } catch (err) {
    return {
      status: 400,
      body: { error: `Invalid JSON payload: ${err.message}` },
    };
  }

  // ── 3. Check GitHub event type ────────────────────────────
  // We only handle push events — ping and others are acknowledged but skipped
  // The event type comes from X-GitHub-Event header (passed in options)
  // If not passed, we infer from payload shape
  const isPushEvent = parsed.ref && parsed.commits !== undefined;
  const isPingEvent = parsed.zen !== undefined;

  if (isPingEvent) {
    console.log(
      "[webhook] ✓ Ping event received — webhook configured correctly",
    );
    return {
      status: 200,
      body: { message: "Pong! Webhook configured correctly." },
    };
  }

  if (!isPushEvent) {
    return {
      status: 200,
      body: {
        message: "Event type not handled — only push events trigger sync.",
      },
    };
  }

  // ── 4. Decide whether to re-document ─────────────────────
  const check = shouldReDocument(parsed);

  if (!check.should) {
    console.log(`[webhook] Skipped: ${check.reason}`);
    return {
      status: 200,
      body: { message: `Skipped: ${check.reason}`, detail: check },
    };
  }

  console.log(
    `[webhook] Push on ${check.repoFullName} by ${check.pusher} — ` +
      `${check.codeFiles.length} code files · ${check.commitCount} commit(s)` +
      (check.needsFullRun
        ? " · FULL RUN (manifest changed)"
        : " · incremental"),
  );

  // ── 5. Find registered projects for this repo ────────────
  const { Project } = await import("../models/Project.js");
  const { syncProject } = await import("../api/projects/project.service.js");

  // Normalise URL for matching — strip trailing slash, .git, case-insensitive
  const normUrl = (check.repoUrl || "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (!normUrl) {
    return {
      status: 400,
      body: { error: "Could not determine repository URL from payload" },
    };
  }

  // Escape special regex chars before using in $regex query
  const escapedUrl = normUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const projects = await Project.find({
    repoUrl: { $regex: escapedUrl, $options: "i" },
    status: { $in: ["done", "error"] },
  })
    .select("+agentOutputs +fileManifest +events")
    // lean(false) — we need Mongoose documents for syncProject
    .lean(false);

  if (projects.length === 0) {
    console.log(`[webhook] No projects found for ${normUrl}`);
    return {
      status: 200,
      body: {
        message:
          "No projects registered for this repository. Create one via the dashboard first.",
        repoUrl: check.repoUrl,
      },
    };
  }

  // ── 6. Trigger incremental sync for each project ─────────
  const triggered = [];
  const errors = [];

  // Run syncs in parallel — each project is independent
  await Promise.all(
    projects.map(async (project) => {
      try {
        const result = await syncProject({
          projectId: project._id.toString(),
          userId: project.userId.toString(),
          forceFullRun: check.needsFullRun,
          webhookChangedFiles: check.changedFiles,
        });

        triggered.push({
          projectId: project._id,
          streamUrl: result.streamUrl,
          jobId: result.project?.jobId,
        });

        console.log(
          `[webhook] ✓ Sync triggered — project ${project._id} ` +
            `(user ${project.userId}) · job ${result.project?.jobId}`,
        );
      } catch (err) {
        errors.push({
          projectId: project._id,
          error: err.message,
          code: err.code,
        });
        console.error(
          `[webhook] ✗ Failed to trigger sync for project ${project._id}:`,
          err.message,
        );
      }
    }),
  );

  return {
    status: 202,
    body: {
      message: `Sync triggered for ${triggered.length} project(s)`,
      triggered,
      errors: errors.length ? errors : undefined,
      repoUrl: check.repoUrl,
      branch: check.branch,
      headCommit: check.headCommit?.slice(0, 8),
      codeFiles: check.codeFiles.length,
      needsFullRun: check.needsFullRun,
    },
  };
}

// ─── GitHub Actions Workflow Generator ───────────────────────────

/**
 * Generate a .github/workflows/document.yml that:
 *   1. Runs on every push to main/master
 *   2. Computes an HMAC-SHA256 signature over the payload it sends
 *   3. POSTs to your webhook endpoint with the correct signature
 *
 * BUG FIXED: The original generated workflow sent the payload without
 * computing a signature — it just forwarded whatever was in the header
 * from the GitHub event context. The signature in ${{ github.event }}
 * was computed by GitHub over the ORIGINAL webhook bytes, which differ
 * from the reconstructed curl payload, causing permanent signature
 * mismatch (exactly the error in the CI logs).
 *
 * The fix: compute a fresh HMAC over the exact payload bytes being sent.
 */
export function generateGitHubActionsWorkflow(apiBaseUrl) {
  const base = (apiBaseUrl || "https://your-docnine-instance.com").replace(
    /\/$/,
    "",
  );

  return `# .github/workflows/document.yml
# Auto-generated by Docnine
# Triggers an incremental documentation sync on every push to main.
# Only changed files are re-documented — fast and token-efficient.
#
# SETUP:
#   1. Go to your repo Settings → Secrets and variables → Actions
#   2. Add a secret named DOCNINE_WEBHOOK_SECRET
#      (must match the WEBHOOK_SECRET set on your Docnine server)
#   3. Add a secret named DOCNINE_PROJECT_ID
#      (the project ID from your Docnine dashboard)

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
          API_BASE_URL:   ${base}
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

          # Compute HMAC-SHA256 signature over the exact payload bytes being sent.
          # This MUST use the same secret configured on your Docnine server.
          SIGNATURE="sha256=\$(echo -n "\${PAYLOAD}" | openssl dgst -sha256 -hmac "\${WEBHOOK_SECRET}" | awk '{print \$2}')"

          echo "Sending sync request to \${API_BASE_URL}/api/webhook"
          echo "Repository: \${REPO_URL}"
          echo "Commit: \${HEAD_COMMIT}"

          HTTP_STATUS=\$(curl -s -o /tmp/webhook_response.json -w "%{http_code}" \\
            -X POST \\
            -H "Content-Type: application/json" \\
            -H "X-Hub-Signature-256: \${SIGNATURE}" \\
            -H "X-GitHub-Event: push" \\
            -d "\${PAYLOAD}" \\
            "\${API_BASE_URL}/api/webhook")

          RESPONSE=\$(cat /tmp/webhook_response.json)
          echo "HTTP Status: \${HTTP_STATUS}"
          echo "Response: \${RESPONSE}"

          # Fail the step if the server returned an error
          if [ "\${HTTP_STATUS}" -ge 400 ]; then
            echo "❌ Webhook returned HTTP \${HTTP_STATUS}"
            echo "Error: \$(echo "\${RESPONSE}" | jq -r '.error // .message // "Unknown error"')"
            exit 1
          fi

          TRIGGERED=\$(echo "\${RESPONSE}" | jq -r '.triggered | length // 0')
          echo "✓ Sync triggered for \${TRIGGERED} project(s)"
`;
}
