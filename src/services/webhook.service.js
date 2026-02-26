// =============================================================
// GitHub push webhook handler.
//
// v3.1 changes:
//   When a push arrives for a repo that has existing Project
//   documents, the webhook now triggers INCREMENTAL SYNC instead
//   of a full re-run — passing the push payload's changed file
//   list directly to incrementalOrchestrator so it doesn't even
//   need to call the GitHub compare/tree APIs.
//
//   If no project exists for the repo, the webhook still responds
//   with 200 (no-op) because we can't associate it with a user.
//   The user must create a project via the dashboard first.
// =============================================================

import crypto from "crypto";

// ── Signature validation ──────────────────────────────────────
export function validateWebhookSignature(payload, signature, secret) {
  if (!secret) {
    console.warn("⚠️  WEBHOOK_SECRET not set — signature validation skipped");
    return true;
  }
  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")}`;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

// ── Should re-document? ───────────────────────────────────────
const CODE_FILE =
  /\.(js|ts|jsx|tsx|py|go|rs|java|rb|php|cs|cpp|c|h|vue|svelte|prisma|graphql|sql)$/i;

export function shouldReDocument(pushPayload) {
  const { ref, repository, commits = [] } = pushPayload;
  const defaultBranch = repository?.default_branch || "main";

  if (!ref?.endsWith(defaultBranch)) {
    return { should: false, reason: "not_default_branch" };
  }

  // Build changed-file list from all commits in the push
  const allChanged = commits.flatMap((c) => [
    ...(c.added || []).map((p) => ({ path: p, status: "added" })),
    ...(c.modified || []).map((p) => ({ path: p, status: "modified" })),
    ...(c.removed || []).map((p) => ({ path: p, status: "removed" })),
  ]);

  // Deduplicate — if a file appears in multiple commits keep "modified"
  const pathMap = new Map();
  for (const f of allChanged) {
    if (!pathMap.has(f.path) || f.status === "modified") {
      pathMap.set(f.path, f);
    }
  }
  const changedFiles = [...pathMap.values()];
  const codeChanges = changedFiles.filter((f) => CODE_FILE.test(f.path));

  if (codeChanges.length === 0) {
    return { should: false, reason: "no_code_changes" };
  }

  return {
    should: true,
    reason: "code_changed",
    changedFiles, // full list (all statuses)
    codeFiles: codeChanges, // code-only subset
    repoUrl: repository?.html_url,
    pusher: pushPayload.pusher?.name,
    branch: defaultBranch,
    headCommit: pushPayload.after, // new HEAD sha from push event
  };
}

// ── Handle incoming push webhook ─────────────────────────────
export async function handleWebhook({ payload, signature, secret }) {
  const rawPayload =
    typeof payload === "string" ? payload : JSON.stringify(payload);

  if (!validateWebhookSignature(rawPayload, signature, secret)) {
    return { status: 401, body: { error: "Invalid webhook signature" } };
  }

  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  const check = shouldReDocument(parsed);

  if (!check.should) {
    return { status: 200, body: { message: `Skipped: ${check.reason}` } };
  }

  console.log(
    `🔔 Webhook push: ${check.repoUrl} by ${check.pusher} (${check.codeFiles.length} code files changed)`,
  );

  // Look up existing done/error projects for this repo across all users
  const { Project } = await import("../models/Project.js");
  const { syncProject } = await import("../api/projects/project.service.js");

  // Normalise the repo URL to match the stored format
  const normUrl = check.repoUrl?.replace(/\.git$/, "");

  const projects = await Project.find({
    repoUrl: {
      $regex: normUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      $options: "i",
    },
    status: { $in: ["done", "error"] },
  })
    .select("+agentOutputs +fileManifest")
    .lean(false); // we need Mongoose docs for syncProject

  if (projects.length === 0) {
    console.log(`   ↳ No projects found for ${normUrl} — skipping`);
    return {
      status: 200,
      body: {
        message:
          "No projects registered for this repository. Create one via the dashboard.",
      },
    };
  }

  const triggered = [];
  const errors = [];

  for (const project of projects) {
    try {
      const result = await syncProject({
        projectId: project._id.toString(),
        userId: project.userId.toString(),
        webhookChangedFiles: check.changedFiles,
      });
      triggered.push({ projectId: project._id, streamUrl: result.streamUrl });
      console.log(
        `   ↳ Incremental sync triggered for project ${project._id} (user ${project.userId})`,
      );
    } catch (err) {
      errors.push({ projectId: project._id, error: err.message });
      console.error(
        `   ↳ Failed to trigger sync for project ${project._id}:`,
        err.message,
      );
    }
  }

  return {
    status: 202,
    body: {
      message: `Incremental sync triggered for ${triggered.length} project(s)`,
      triggered,
      errors: errors.length ? errors : undefined,
      repoUrl: check.repoUrl,
      changedFiles: check.codeFiles.length,
    },
  };
}

// ── Generate GitHub Actions workflow file ─────────────────────
export function generateGitHubActionsWorkflow(apiBaseUrl) {
  const base = apiBaseUrl || "https://your-documentor-instance.com";
  const e = (expr) => "${{ " + expr + " }}";

  return [
    "# .github/workflows/document.yml",
    "# Auto-generated by Docnine v3.1",
    "# Triggers an incremental sync on every push to main.",
    "# Only changed files are re-documented — fast and token-efficient.",
    "",
    "name: Auto-Document",
    "",
    "on:",
    "  push:",
    "    branches: [ main, master ]",
    "    paths:",
    "      - '**.js'",
    "      - '**.ts'",
    "      - '**.tsx'",
    "      - '**.jsx'",
    "      - '**.py'",
    "      - '**.go'",
    "      - '**.rs'",
    "      - '**.java'",
    "      - '**.prisma'",
    "      - '**.graphql'",
    "  workflow_dispatch:",
    "",
    "jobs:",
    "  document:",
    "    name: Incremental Documentation Sync",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 15",
    "",
    "    steps:",
    "      - name: Trigger Documentation Sync",
    "        id: trigger",
    "        env:",
    `          API_BASE_URL: ${base}`,
    `          WEBHOOK_SECRET: ${e("secrets.DOCUMENTOR_WEBHOOK_SECRET")}`,
    "        run: |",
    `          REPO_URL="${e("github.server_url")}/${e("github.repository")}"`,
    `          RESPONSE=$(curl -s -X POST \\`,
    `            -H "Content-Type: application/json" \\`,
    `            -d "{\\"repoUrl\\": \\"$REPO_URL\\"}" \\`,
    `            "$API_BASE_URL/api/document")`,
    `          JOB_ID=$(echo "$RESPONSE" | jq -r '.jobId')`,
    `          echo "job_id=$JOB_ID" >> $GITHUB_OUTPUT`,
    `          echo "Triggered job: $JOB_ID"`,
    "",
    "      - name: Wait for completion",
    "        env:",
    `          API_BASE_URL: ${base}`,
    `          JOB_ID: ${e("steps.trigger.outputs.job_id")}`,
    "        run: |",
    "          MAX_WAIT=600",
    "          ELAPSED=0",
    "          while [ $ELAPSED -lt $MAX_WAIT ]; do",
    `            STATUS=$(curl -s "$API_BASE_URL/api/document/$JOB_ID" | jq -r '.status')`,
    `            echo "Status: $STATUS (${"{ELAPSED}"}s elapsed)"`,
    `            if [ "$STATUS" = "done" ]; then`,
    `              echo "Documentation synced successfully"`,
    "              exit 0",
    `            elif [ "$STATUS" = "error" ]; then`,
    `              echo "Sync failed"`,
    "              exit 1",
    "            fi",
    "            sleep 15",
    "            ELAPSED=$((ELAPSED + 15))",
    "          done",
    `          echo "Timeout"`,
    "          exit 1",
  ].join("\n");
}
