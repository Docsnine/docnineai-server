# Docnine Documentation

> **AI-powered GitHub documentation generator**

![Node.js](https://img.shields.io/badge/Node.js-20+-green)
![Groq](https://img.shields.io/badge/LLM-Groq%20llama--3.1--8b-orange)
![Agents](https://img.shields.io/badge/Agents-6-blue)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Table of Contents

- [Docnine Documentation](#docnine-documentation)
  - [Table of Contents](#table-of-contents)
  - [Features](#features)
  - [Architecture](#architecture)
  - [Quick Start](#quick-start)
  - [Environment Variables](#environment-variables)
  - [API Reference](#api-reference)
    - [POST /api/document](#post-apidocument)
    - [POST /api/chat](#post-apichat)
  - [GitHub Actions — Auto-Sync Setup](#github-actions--auto-sync-setup)
    - [Option A — Download from the app (easiest)](#option-a--download-from-the-app-easiest)
    - [Option B — Create it manually](#option-b--create-it-manually)
    - [Deploying Project Documentor so GitHub can reach it](#deploying-project-documentor-so-github-can-reach-it)
    - [What triggers re-documentation](#what-triggers-re-documentation)
  - [Webhook Setup](#webhook-setup)
    - [Step 1 — Set your webhook secret](#step-1--set-your-webhook-secret)
    - [Step 2 — Register the webhook in GitHub](#step-2--register-the-webhook-in-github)
    - [Step 3 — Verify it works](#step-3--verify-it-works)
    - [How the webhook validates requests](#how-the-webhook-validates-requests)
  - [Export Options](#export-options)
    - [PDF](#pdf)
    - [Notion](#notion)
  - [Token \& Context Strategy](#token--context-strategy)
  - [Project Structure](#project-structure)

---

## Features

| Feature                  | Description                                                |
| ------------------------ | ---------------------------------------------------------- |
| 🔍 **6-Agent Pipeline**   | Scanner → API → Schema → Components → Security → DocWriter |
| 🔒 **Security Audit**     | 14-rule static scan + LLM deep analysis, scored 0–100      |
| 💬 **Chat With Codebase** | Ask questions about any repo after docs are generated      |
| 📄 **PDF Export**         | Multi-section formatted PDF, streamed directly             |
| 📝 **Notion Export**      | Pushes structured pages to your Notion workspace           |
| ⚙️ **GitHub Actions**     | Auto-regenerate docs on every push to `main`               |
| 🔄 **Webhook Auto-Sync**  | HMAC-validated webhook keeps docs permanently fresh        |

---

## Architecture

```
GitHub URL
    │
    ▼
[GitHub Service] — fetches files, filters binaries, respects rate limits
    │
    ▼
┌───────────────────────────────────────┐
│  Agent 1: Repo Scanner                │
│  • Classifies every file by role      │
│  • Detects tech stack                 │
│  • Builds project map                 │
└──────────────┬────────────────────────┘
               │  fan-out (parallel)
   ┌───────────┼───────────┬────────────┐
   ▼           ▼           ▼            ▼
Agent 2     Agent 3     Agent 4      Agent 6
API         Schema      Component    Security
Extractor   Analyser    Mapper       Auditor
   └───────────┴───────────┴────────────┘
               │  results merged
               ▼
    ┌─────────────────────┐
    │  Agent 5: Doc Writer │
    │  • README.md         │
    │  • Internal Docs     │
    │  • API Reference     │
    │  • Schema Docs       │
    └─────────────────────┘
               │
               ▼
    Chat Session Created
    (docs become context)
```

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/your-username/project-documentor.git
cd project-documentor

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — add GROQ_API_KEY at minimum

# 4. Start
npm start
# → http://localhost:3000
```

Get your free Groq API key at [console.groq.com](https://console.groq.com).

---

## Environment Variables

```bash
# .env
GROQ_API_KEY=your_groq_api_key        # Required — from console.groq.com
GITHUB_TOKEN=your_github_token        # Strongly recommended — raises rate limit 60→5000/hr
PORT=3000                              # Optional — default 3000

# Token management (optional — defaults shown)
CHUNK_SIZE=400                         # Tokens per LLM chunk
BATCH_SIZE=5                           # Chunks per LLM call
MAX_FILES_PER_REPO=100                 # Max files fetched per repo
MAX_FILE_SIZE_KB=50                    # Skip files larger than this

# Notion export (optional)
NOTION_API_KEY=your_notion_token
NOTION_PARENT_PAGE_ID=your_page_id

# Webhook auto-sync (optional)
WEBHOOK_SECRET=any_random_secret_string
```

| Variable                | Required      | Purpose                                        |
| ----------------------- | ------------- | ---------------------------------------------- |
| `GROQ_API_KEY`          | ✅ Yes         | Powers all 6 AI agents                         |
| `GITHUB_TOKEN`          | ⚠️ Recommended | Without it GitHub limits you to 60 requests/hr |
| `NOTION_API_KEY`        | ❌ Optional    | Only needed for Notion export                  |
| `NOTION_PARENT_PAGE_ID` | ❌ Optional    | Notion page to create docs under               |
| `WEBHOOK_SECRET`        | ❌ Optional    | Required for secure webhook validation         |

---

## API Reference

```
POST /api/document              Trigger documentation pipeline
GET  /api/document/:jobId       Poll job status + result
GET  /api/stream/:jobId         SSE live progress stream
POST /api/chat                  Chat with codebase (after docs generated)
GET  /api/export/pdf/:jobId     Download documentation as PDF
POST /api/export/notion/:jobId  Push documentation to Notion
GET  /api/export/workflow/:jobId  Download GitHub Actions workflow file
POST /api/webhook               GitHub push webhook receiver
GET  /health                    Health check
```

### POST /api/document

```bash
curl -X POST http://localhost:3000/api/document \
  -H "Content-Type: application/json" \
  -d '{"repoUrl": "https://github.com/owner/repo"}'

# Response
{ "jobId": "uuid", "status": "running", "streamUrl": "/api/stream/uuid" }
```

### POST /api/chat

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "uuid", "message": "How does authentication work?"}'

# Response
{ "reply": "Authentication uses JWT...", "historyLength": 1 }
```

---

## GitHub Actions — Auto-Sync Setup

This is how you make documentation **never go stale**. Every push to `main` triggers a full re-documentation run automatically.

### Option A — Download from the app (easiest)

After generating docs for a repo, click **"⚙️ GitHub Actions Workflow"** in the sidebar. This downloads a pre-configured `document.yml` file.

Place it in your target repository at:

```
your-repo/
└── .github/
    └── workflows/
        └── document.yml   ← place it here
```

Commit and push. Done.

### Option B — Create it manually

Create `.github/workflows/document.yml` in your repository with the following content:

```yaml
name: Auto-Document

on:
  push:
    branches: [ main, master ]
    paths:
      - '**.js'
      - '**.ts'
      - '**.py'
      - '**.go'
      - '**.rs'
      - '**.java'
      - '**.prisma'
      - '**.graphql'
  workflow_dispatch:

jobs:
  document:
    name: Generate Documentation
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - name: Trigger Documentation Generation
        id: trigger
        env:
          API_BASE_URL: https://your-documentor-instance.com
        run: |
          REPO_URL="${{ github.server_url }}/${{ github.repository }}"
          RESPONSE=$(curl -s -X POST \
            -H "Content-Type: application/json" \
            -d "{\"repoUrl\": \"$REPO_URL\"}" \
            "$API_BASE_URL/api/document")
          JOB_ID=$(echo "$RESPONSE" | jq -r '.jobId')
          echo "job_id=$JOB_ID" >> $GITHUB_OUTPUT
          echo "Triggered job: $JOB_ID"

      - name: Wait for completion
        env:
          API_BASE_URL: https://your-documentor-instance.com
          JOB_ID: ${{ steps.trigger.outputs.job_id }}
        run: |
          MAX_WAIT=600
          ELAPSED=0
          while [ $ELAPSED -lt $MAX_WAIT ]; do
            STATUS=$(curl -s "$API_BASE_URL/api/document/$JOB_ID" | jq -r '.status')
            echo "Status: $STATUS (${ELAPSED}s elapsed)"
            if [ "$STATUS" = "done" ]; then
              echo "Documentation generated successfully"
              exit 0
            elif [ "$STATUS" = "error" ]; then
              echo "Documentation generation failed"
              exit 1
            fi
            sleep 15
            ELAPSED=$((ELAPSED + 15))
          done
          echo "Timeout waiting for documentation"
          exit 1
```

> **Replace** `https://your-documentor-instance.com` with the URL where your Project Documentor instance is running.

### Deploying Project Documentor so GitHub can reach it

GitHub Actions needs a public URL. Options:

**Railway (recommended — free tier available)**

```bash
# Install Railway CLI
npm install -g @railway/cli

railway login
railway init
railway up
# Railway gives you a public URL like https://project-documentor-production.up.railway.app
```

**Render**

```bash
# Push to GitHub, connect repo to render.com
# Set environment variables in Render dashboard
# Deploy — Render provides a public URL automatically
```

**ngrok (local development / testing)**

```bash
# Expose your local server temporarily
ngrok http 3000
# Use the https://xxxx.ngrok.io URL in document.yml
```

### What triggers re-documentation

The workflow only runs when code files change. Pushes that only modify `.md`, `.txt`, images, or other non-code files are **ignored** — no wasted API calls.

Files that trigger a run: `.js` `.ts` `.tsx` `.jsx` `.py` `.go` `.rs` `.java` `.prisma` `.graphql`

You can also trigger it manually from the **Actions** tab in GitHub at any time using `workflow_dispatch`.

---

## Webhook Setup

For real-time sync (docs update within seconds of a push), set up the webhook directly in GitHub.

### Step 1 — Set your webhook secret

In your `.env`:

```bash
WEBHOOK_SECRET=pick_any_long_random_string_here
```

### Step 2 — Register the webhook in GitHub

Go to your repository → **Settings** → **Webhooks** → **Add webhook**

| Field        | Value                                         |
| ------------ | --------------------------------------------- |
| Payload URL  | `https://your-instance.com/api/webhook`       |
| Content type | `application/json`                            |
| Secret       | Same value as `WEBHOOK_SECRET` in your `.env` |
| Events       | Select **"Just the push event"**              |

Click **Add webhook**.

### Step 3 — Verify it works

Push any code change to `main`. You should see a green tick next to the webhook delivery in GitHub, and a new documentation job will start on your server immediately.

### How the webhook validates requests

Every incoming webhook is verified using **HMAC-SHA256** with a timing-safe comparison — preventing both forged requests and timing attacks. If the signature doesn't match, the request is rejected with `401`.

Only pushes to the **default branch** (main/master) trigger re-documentation. The server also checks that at least one code file was changed before starting the pipeline — preventing unnecessary runs from doc-only commits.

---

## Export Options

### PDF

Click **"📄 Download PDF"** in the sidebar after generating docs, or call the API directly:

```bash
curl http://localhost:3000/api/export/pdf/{jobId} --output documentation.pdf
```

### Notion

1. Create a Notion integration at [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Copy the **Internal Integration Token** → set as `NOTION_API_KEY` in `.env`
3. Share a Notion page with your integration → copy the page ID → set as `NOTION_PARENT_PAGE_ID`
4. Click **"📝 Push to Notion"** in the sidebar

The exporter creates one parent page with child pages for README, API Reference, Schema, Security Report, and Architecture docs.

---

## Token & Context Strategy

The entire pipeline is designed to stay within Groq's free tier limits while handling repos of 100+ files.

| Strategy              | Implementation                                                       |
| --------------------- | -------------------------------------------------------------------- |
| Chunk size            | 300–500 tokens per LLM request                                       |
| File classification   | 8 file snippets (300 chars each) per LLM call                        |
| Route/schema analysis | 3 chunks per LLM call                                                |
| Component docs        | First chunk only (enough for signatures)                             |
| Security LLM scan     | Max 8 high-risk files, first chunk only                              |
| File filtering        | Binaries, lock files, node_modules skipped entirely                  |
| Parallel execution    | Agents 2, 3, 4, 6 run simultaneously — 60–70% time saving            |
| Chat context          | Smart section selector — sends only relevant doc section per turn    |
| Chat history          | Ring buffer, max 6 turns — coherent conversation without token bloat |

---

## Project Structure

```
project-documentor/
├── src/
│   ├── agents/
│   │   ├── repoScannerAgent.js       # Agent 1 — file classification + tech stack
│   │   ├── apiExtractorAgent.js      # Agent 2 — route/endpoint extraction
│   │   ├── schemaAnalyserAgent.js    # Agent 3 — models, DB schema, relationships
│   │   ├── componentMapperAgent.js   # Agent 4 — services, middleware, utilities
│   │   ├── docWriterAgent.js         # Agent 5 — README + internal docs generation
│   │   └── securityAuditorAgent.js   # Agent 6 — static + LLM security scan
│   ├── services/
│   │   ├── orchestrator.js           # Pipeline coordinator — wires all agents
│   │   ├── githubService.js          # GitHub API — fetch tree + file contents
│   │   ├── chatService.js            # Chat with codebase — context + history
│   │   ├── exportService.js          # PDF (pdfkit) + Notion export
│   │   └── webhookService.js         # GitHub webhook + Actions workflow generator
│   ├── config/
│   │   └── llm.js                    # Groq client — all agents call through here
│   └── utils/
│       └── tokenManager.js           # Chunking, batching, file relevance scoring
├── public/
│   └── index.html                    # Full SPA — dashboard, chat, security panel
├── .env.example
├── package.json
└── README.md
```
