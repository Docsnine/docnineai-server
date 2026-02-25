# ⚡ Project Documentor v3

> **AI-powered GitHub documentation generator** — SaaS platform with authentication, persistent projects, and live pipeline streaming.

![Node.js](https://img.shields.io/badge/Node.js-20+-green)
![MongoDB](https://img.shields.io/badge/MongoDB-8+-green)
![Groq](https://img.shields.io/badge/LLM-Groq%20llama--3.1--8b-orange)
![Agents](https://img.shields.io/badge/Agents-6-blue)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Table of Contents

1. [What's New in v3](#whats-new-in-v3)
2. [Architecture](#architecture)
3. [Quick Start](#quick-start)
4. [Environment Variables](#environment-variables)
5. [API Reference](#api-reference)
   - [Auth](#auth-routes)
   - [GitHub](#github-routes)
   - [Projects](#project-routes)
   - [Exports](#export-routes)
   - [Legacy Pipeline](#legacy-api-v2-compatible)
6. [GitHub OAuth Setup](#github-oauth-setup)
7. [Webhook & Auto-Sync](#webhook--auto-sync)
8. [Deployment](#deployment)
9. [Project Structure](#project-structure)

---

## What's New in v3

| Feature                       | Description                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| 🔐 **Auth**                    | JWT access tokens (15 min) + rotating refresh tokens (7 days, httpOnly cookie)       |
| 🗄 **MongoDB persistence**     | Projects, users, and GitHub tokens stored in MongoDB                                 |
| 🔄 **Refresh token rotation**  | Each refresh invalidates the previous token — replay attacks are detected            |
| 🔒 **Encrypted GitHub tokens** | OAuth access tokens stored AES-256-GCM encrypted at rest                             |
| 📁 **Project dashboard**       | Full CRUD — create, list, archive, delete, retry failed pipelines                    |
| 📡 **Per-project SSE**         | `/projects/:id/stream` replays persisted events after page refresh or server restart |
| ♻️  **Pipeline retry**         | `POST /projects/:id/retry` re-runs the pipeline on any error or completed project    |
| 📦 **MongoDB-backed exports**  | PDF, YAML, and Notion exports work after server restarts (read from DB, not memory)  |
| 🔗 **GitHub repo picker**      | OAuth-connected users can pick repos from a paginated list                           |
| ✅ **v2 backward-compatible**  | All `/api/*` legacy routes still work with no changes required                       |

---

## Architecture

```
HTTP Request
    │
    ▼
server.js  ──  import "dotenv/config"  (first import, ESM race-free)
    │
    ├── CORS + body parsing + morgan
    │
    ├── GET /health
    │
    └── api/router.js
          ├── /auth     → auth.routes.js   → auth.controller.js   → auth.service.js
          ├── /github   → github.routes.js → github.controller.js → github.service.js
          ├── /projects → project.routes.js → project.controller.js → project.service.js
          │                                        │
          │                                        ├── project.service.js → orchestrator.js
          │                                        │         └── 6 AI agents (parallel)
          │                                        │
          │                                        └── jobRegistry.js  (shared SSE state)
          │
          └── /api  → legacy.router.js  (v2 compatible, no auth)
                           └── same orchestrator + jobRegistry
```

**Shared SSE infrastructure** — `jobRegistry.js` is the single in-memory store for running jobs and SSE clients. Both `/projects/:id/stream` and `/api/stream/:jobId` use it.  
**Event persistence** — every pipeline event is also written to `Project.events` in MongoDB (last 200 kept), so the stream can be replayed after a page refresh or server restart.

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
# Open .env and set:
#   MONGODB_URI, GROQ_API_KEY,
#   JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY

# 4. Start
npm run dev          # development (nodemon)
npm start            # production
```

**Minimum required variables:** `MONGODB_URI`, `GROQ_API_KEY`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`.

Get a free Groq key at [console.groq.com](https://console.groq.com).

---

## Environment Variables

See `.env.example` for the full annotated list. Key variables:

| Variable                                   | Required      | Purpose                                                   |
| ------------------------------------------ | ------------- | --------------------------------------------------------- |
| `MONGODB_URI`                              | ✅             | MongoDB connection string                                 |
| `GROQ_API_KEY`                             | ✅             | Powers all 6 AI agents                                    |
| `JWT_ACCESS_SECRET`                        | ✅             | Signs 15-min access tokens                                |
| `JWT_REFRESH_SECRET`                       | ✅             | Signs 7-day refresh tokens                                |
| `ENCRYPTION_KEY`                           | ✅             | AES-256-GCM key for GitHub token storage (64 hex chars)   |
| `GITHUB_TOKEN`                             | ⚠️ Recommended | Server-level PAT — raises GitHub API limit 60→5000 req/hr |
| `GITHUB_CLIENT_ID`                         | OAuth only    | Required for GitHub repo picker                           |
| `GITHUB_CLIENT_SECRET`                     | OAuth only    | Required for GitHub repo picker                           |
| `GITHUB_REDIRECT_URI`                      | OAuth only    | Must match GitHub OAuth App settings                      |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS`    | Email only    | Without these, emails are logged to console               |
| `NOTION_API_KEY` / `NOTION_PARENT_PAGE_ID` | Notion only   | Required for Notion export                                |
| `WEBHOOK_SECRET`                           | Webhook only  | HMAC secret for GitHub push webhook                       |
| `FRONTEND_URL`                             | Prod          | Locked CORS origin + OAuth redirect target                |

**Generating secrets:**
```bash
# JWT secrets and webhook secret
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# Encryption key (must be exactly 64 hex chars = 32 bytes)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## API Reference

All responses follow a consistent envelope:

```jsonc
// Success
{ "success": true, "data": { ... }, "message": "..." }

// Error
{ "success": false, "error": { "code": "SCREAMING_SNAKE", "message": "..." } }

// Validation error (422)
{ "success": false, "error": { "code": "VALIDATION_ERROR", "fields": [...] } }
```

**Authentication:** Send the access token as `Authorization: Bearer <token>` on all protected routes.

---

### Auth Routes

#### `POST /auth/signup`
Create a new account. Sends a verification email.

```bash
curl -X POST /auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@example.com","password":"secret123"}'
```

**Request body:** `name` (string, max 80), `email`, `password` (min 8 chars)  
**Response 201:** `{ user, accessToken }` + sets `refreshToken` httpOnly cookie

---

#### `POST /auth/login`
```bash
curl -X POST /auth/login \
  -d '{"email":"alice@example.com","password":"secret123"}'
```
**Response 200:** `{ user, accessToken }` + sets `refreshToken` httpOnly cookie

---

#### `POST /auth/refresh`
Exchange the refresh-token cookie for a new access token. Rotates the refresh token — each use invalidates the previous one.

```bash
curl -X POST /auth/refresh --cookie "refreshToken=<token>"
```
**No Authorization header needed.** Reads `refreshToken` cookie.  
**Response 200:** `{ user, accessToken }` + new `refreshToken` cookie

---

#### `POST /auth/logout`
Invalidates the refresh token server-side and clears the cookie.

```bash
curl -X POST /auth/logout -H "Authorization: Bearer <token>"
```

---

#### `POST /auth/verify-email`
**Body:** `{ token }` — the raw token from the email link  

#### `POST /auth/forgot-password`
**Body:** `{ email }` — always returns 200 (no email enumeration)  

#### `POST /auth/reset-password`
**Body:** `{ token, password, confirmPassword }`  

#### `GET /auth/me`
Returns the current authenticated user's profile.

---

### GitHub Routes

#### `GET /github/oauth/start` 🔒
Returns the GitHub authorization URL. The client must navigate to it (`window.location.href = data.url`).

```bash
curl /github/oauth/start -H "Authorization: Bearer <token>"
# Response: { "data": { "url": "https://github.com/login/oauth/authorize?..." } }
```

---

#### `GET /github/oauth/callback`
**Public — no Authorization header.** GitHub redirects the browser here after the user grants access. Redirects to `FRONTEND_URL/?github=connected&user=<username>` on success, or `?github=error&msg=<message>` on failure.

---

#### `GET /github/repos` 🔒
List the authenticated user's GitHub repositories.

```bash
curl "/github/repos?page=1&perPage=30&type=all&sort=updated" \
  -H "Authorization: Bearer <token>"
```

**Query params:** `page` (default 1), `perPage` (default 30, max 100), `type` (`all`|`owner`|`member`|`public`|`private`), `sort` (`updated`|`created`|`pushed`|`full_name`)  
**Response:** `{ repos[], page, perPage, hasNextPage }`

---

#### `GET /github/status` 🔒
Returns GitHub connection status for the current user.

**Response:** `{ connected: false }` or `{ connected: true, githubUsername, scopes[], connectedAt }`

#### `DELETE /github/disconnect` 🔒
Removes the stored GitHub token and unlinks the GitHub account.

---

### Project Routes

All project routes require authentication (`🔒`).

#### `POST /projects` 🔒
Create a project and immediately start the AI documentation pipeline.

```bash
curl -X POST /projects \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"repoUrl":"https://github.com/owner/repo"}'
```

**Request body:** `{ repoUrl }` — full GitHub URL, SSH URL, or `owner/repo` shorthand  
**Response 201:** `{ project, streamUrl: "/projects/:id/stream" }`  
**Error 409:** `DUPLICATE_PROJECT` if a pipeline is already running for this repo

---

#### `GET /projects` 🔒
List your projects with pagination, filtering, and full-text search.

```bash
curl "/projects?page=1&limit=20&status=done&sort=-createdAt&search=express" \
  -H "Authorization: Bearer <token>"
```

**Query params:**

| Param    | Default      | Description                                                                          |
| -------- | ------------ | ------------------------------------------------------------------------------------ |
| `page`   | 1            | Page number                                                                          |
| `limit`  | 20 (max 100) | Results per page                                                                     |
| `status` | —            | Filter: `queued` `running` `done` `error` `archived`                                 |
| `sort`   | `-createdAt` | Sort field: `createdAt` `-createdAt` `updatedAt` `-updatedAt` `repoName` `-repoName` |
| `search` | —            | Full-text search across repo name, owner, and description                            |

**Response:** `{ projects[], total, page, limit, totalPages }`

---

#### `GET /projects/:id` 🔒
Full project detail including all generated output (readme, apiReference, schemaDocs, internalDocs, securityReport).

**Response:** `{ project }` with all fields populated after a successful pipeline run.

---

#### `PATCH /projects/:id` 🔒
Archive a project (the only currently supported mutation).

```bash
curl -X PATCH /projects/:id \
  -H "Authorization: Bearer <token>" \
  -d '{"status":"archived"}'
```

**Error 409:** `PROJECT_RUNNING` if the pipeline is still running.

---

#### `DELETE /projects/:id` 🔒
Hard-delete a project and all its data. Blocked while the pipeline is running.

**Error 409:** `PROJECT_RUNNING`

---

#### `POST /projects/:id/retry` 🔒
Re-run the documentation pipeline. Allowed for `done` and `error` projects only. Resets all output fields and starts a fresh run.

```bash
curl -X POST /projects/:id/retry -H "Authorization: Bearer <token>"
```

**Response 202:** `{ project, streamUrl: "/projects/:id/stream" }`  
**Error 409:** `PROJECT_RUNNING` or `PROJECT_ARCHIVED`

---

#### `GET /projects/:id/stream` 🔒
SSE stream of live pipeline events. Replays all buffered events for late-connecting clients. Works after server restarts — reconstructs a synthetic done event from MongoDB if the in-memory job is gone.

```javascript
const es = new EventSource(`/projects/${id}/stream`, {
  headers: { Authorization: `Bearer ${token}` }
});
es.onmessage = (e) => {
  const event = JSON.parse(e.data);
  if (event.step === "done") { /* pipeline complete */ }
  if (event.step === "error") { /* pipeline failed */ }
};
```

**Event shape:** `{ step, status, msg, detail, ts }` during pipeline; `{ step: "done", result: {...} }` on completion.

---

### Export Routes

All export routes read from MongoDB — they work even after a server restart, unlike the legacy `/api/export/*` routes which require the in-memory job to still exist.

#### `GET /projects/:id/export/pdf` 🔒
Stream a multi-section PDF of the documentation.

```bash
curl /projects/:id/export/pdf \
  -H "Authorization: Bearer <token>" \
  --output documentation.pdf
```

**Error 409:** `PROJECT_NOT_READY` if the pipeline hasn't completed successfully.  
**Error 503:** `SERVICE_UNAVAILABLE` if `pdfkit` isn't installed.

---

#### `GET /projects/:id/export/yaml` 🔒
Download a ready-to-use GitHub Actions workflow file that auto-regenerates documentation on every push to `main`.

```bash
curl /projects/:id/export/yaml \
  -H "Authorization: Bearer <token>" \
  --output .github/workflows/document.yml
```

---

#### `POST /projects/:id/export/notion` 🔒
Push the documentation to a Notion workspace. Requires `NOTION_API_KEY` and `NOTION_PARENT_PAGE_ID` in `.env`.

```bash
curl -X POST /projects/:id/export/notion \
  -H "Authorization: Bearer <token>"
```

**Response:** `{ mainPageUrl, mainPageId, childPages[] }`

---

### Legacy API (v2 compatible)

These routes are **unauthenticated** and work exactly as they did in v2. They use the same SSE infrastructure as `/projects/:id/stream`.

| Method | Route                         | Description                                                           |
| ------ | ----------------------------- | --------------------------------------------------------------------- |
| `POST` | `/api/document`               | Start pipeline. Body: `{ repoUrl }`. Response: `{ jobId, streamUrl }` |
| `GET`  | `/api/stream/:jobId`          | SSE live events for a job                                             |
| `POST` | `/api/chat`                   | Chat with docs. Body: `{ sessionId, message }`                        |
| `GET`  | `/api/export/pdf/:jobId`      | Download PDF (job must be in memory)                                  |
| `POST` | `/api/export/notion/:jobId`   | Push to Notion (job must be in memory)                                |
| `GET`  | `/api/export/workflow/:jobId` | Download GitHub Actions YAML                                          |
| `POST` | `/api/webhook`                | GitHub push webhook receiver                                          |

> **Note:** Legacy export routes require the job to still be in memory. Use the authenticated `/projects/:id/export/*` routes for persistent exports.

---

#### `GET /health`
```jsonc
{
  "status": "ok",
  "version": "3.0.0",
  "env": "development",
  "uptime": 42,
  "services": {
    "orchestrator": true,
    "chat": true,
    "pdf": true,
    "notion": false,
    "webhook": true
  }
}
```

---

## GitHub OAuth Setup

1. Go to [github.com/settings/developers](https://github.com/settings/developers) → **OAuth Apps** → **New OAuth App**
2. Set **Authorization callback URL** to `http://localhost:3000/github/oauth/callback` (or your deployed URL)
3. Copy the **Client ID** and generate a **Client Secret**
4. Add to `.env`:
   ```bash
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   GITHUB_REDIRECT_URI=http://localhost:3000/github/oauth/callback
   ```

**Flow:**
1. Client calls `GET /github/oauth/start` → receives `{ url }` → navigates to `url`
2. User approves on GitHub → GitHub redirects browser to `GITHUB_REDIRECT_URI`
3. Server exchanges code, fetches profile, stores AES-256-GCM encrypted token
4. Server redirects browser to `FRONTEND_URL/?github=connected&user=<username>`

---

## Webhook & Auto-Sync

Automatically regenerate documentation whenever code is pushed to the default branch.

### Setup

1. Set `WEBHOOK_SECRET` in `.env` to any random string
2. Go to your repo → **Settings** → **Webhooks** → **Add webhook**
   - Payload URL: `https://your-instance.com/api/webhook`
   - Content type: `application/json`
   - Secret: same value as `WEBHOOK_SECRET`
   - Events: **Just the push event**

The webhook receiver validates every request using HMAC-SHA256 with a timing-safe comparison. Pushes to non-default branches and commits with no code file changes are silently ignored.

### GitHub Actions Alternative

Download a pre-configured workflow from `GET /projects/:id/export/yaml` and place it at `.github/workflows/document.yml` in your target repository. Adjust `API_BASE_URL` to point to your deployed instance.

---

## Deployment

The server has no filesystem state — all data lives in MongoDB. It can be deployed to any platform that supports Node.js and environment variables.

### Railway
```bash
npm install -g @railway/cli
railway login && railway init && railway up
# Set environment variables in the Railway dashboard
```

### Render
Connect your GitHub repository to [render.com](https://render.com), set environment variables in the dashboard, and deploy.

### Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 3000
CMD ["node", "src/server.js"]
```

```bash
docker build -t project-documentor .
docker run -p 3000:3000 --env-file .env project-documentor
```

---

## Project Structure

```
project-documentor/
├── src/
│   ├── server.js                    # Entry point — Express app + startup
│   │
│   ├── api/
│   │   ├── router.js                # Mounts all 4 feature routers
│   │   ├── legacy.router.js         # /api/* backward-compatible routes
│   │   ├── auth/
│   │   │   ├── auth.routes.js
│   │   │   ├── auth.controller.js
│   │   │   └── auth.service.js
│   │   ├── github/
│   │   │   ├── github.routes.js
│   │   │   ├── github.controller.js
│   │   │   └── github.service.js
│   │   └── projects/
│   │       ├── project.routes.js
│   │       ├── project.controller.js
│   │       └── project.service.js
│   │
│   ├── middleware/
│   │   ├── auth.middleware.js        # protect + optionalAuth
│   │   ├── validate.middleware.js    # express-validator rules + validate()
│   │   └── rateLimiter.middleware.js # authLimiter, signupLimiter, apiLimiter
│   │
│   ├── models/
│   │   ├── User.js                  # Auth state, bcrypt password, refresh token hash
│   │   ├── GitHubToken.js           # Encrypted OAuth token per user
│   │   └── Project.js               # Pipeline state, output, events, security findings
│   │
│   ├── config/
│   │   ├── db.js                    # Mongoose connection (lazy env read)
│   │   └── email.js                 # Nodemailer transporter (dev console fallback)
│   │
│   ├── utils/
│   │   ├── jwt.util.js              # signAccessToken, signRefreshToken, verify*
│   │   ├── crypto.util.js           # AES-256-GCM encrypt/decrypt, hashToken
│   │   ├── response.util.js         # ok(), fail(), serverError(), wrap()
│   │   └── tokenManager.js          # Chunking, batching, file relevance scoring
│   │
│   ├── services/
│   │   ├── jobRegistry.js           # Shared in-memory SSE job state
│   │   ├── orchestrator.js          # Pipeline coordinator — wires 6 agents
│   │   ├── githubService.js         # GitHub API — fetch repo files
│   │   ├── chatService.js           # Chat with codebase — context + history
│   │   ├── exportService.js         # PDF (pdfkit) + Notion export
│   │   └── webhookService.js        # Webhook handler + Actions YAML generator
│   │
│   ├── agents/
│   │   ├── repoScannerAgent.js      # Agent 1 — file classification + tech stack
│   │   ├── apiExtractorAgent.js     # Agent 2 — route/endpoint extraction
│   │   ├── schemaAnalyserAgent.js   # Agent 3 — models, DB schema, relationships
│   │   ├── componentMapperAgent.js  # Agent 4 — services, middleware, utilities
│   │   ├── docWriterAgent.js        # Agent 5 — README + internal docs
│   │   └── securityAuditorAgent.js  # Agent 6 — static + LLM security scan
│   │
│   └── index.js                     # Standalone v2 server (untouched, fully operational)
│
├── public/
│   └── index.html                   # SPA frontend
│
├── .env.example                     # All variables documented with examples
├── .gitignore
├── package.json
└── README.md
```

---

## Security Design

| Concern                   | Implementation                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| Password storage          | bcrypt, cost factor 12                                                                     |
| Access tokens             | JWT, 15-min TTL, `JWT_ACCESS_SECRET`                                                       |
| Refresh tokens            | JWT, 7-day TTL, `JWT_REFRESH_SECRET`, stored as SHA-256 hash in DB, httpOnly Secure cookie |
| Refresh token rotation    | Every use invalidates the previous token; replay attempts force full re-login              |
| Email verification tokens | Raw token in email, SHA-256 hash in DB, 24-hour expiry                                     |
| Password reset tokens     | Raw token in email, SHA-256 hash in DB, 1-hour expiry                                      |
| GitHub OAuth tokens       | AES-256-GCM encrypted at rest with `ENCRYPTION_KEY`                                        |
| Email enumeration         | `forgot-password` always returns 200 regardless of whether the email exists                |
| Webhook validation        | HMAC-SHA256 with `timingSafeEqual` — prevents both forged requests and timing attacks      |
| Rate limiting             | Auth: 10 req/15 min; Signup: 20 req/hr; API: 300 req/5 min                                 |