// ===================================================================
// Agent 6: Security Auditor (Improved)
// ===================================================================

import { llmCall } from "../config/llm.js";
import { chunkText } from "../utils/token-manager.util.js";

// ─── Static Rules ─────────────────────────────────────────────────
// Organised by OWASP Top 10 category for structured reporting.
// Every rule has: id, category, severity, title, regex, advice, cwe

const STATIC_RULES = [
  // ── A01: Broken Access Control ───────────────────────────────
  {
    id: "SEC001",
    category: "A01:BrokenAccessControl",
    severity: "CRITICAL",
    title: "Route defined with no auth middleware",
    regex:
      /router\.(get|post|put|patch|delete)\s*\(\s*['"`][^'"`,]+['"`]\s*,\s*(?!.*(?:auth|guard|protect|verify|require|middleware|isAuthenticated|jwtGuard))[a-zA-Z]/gi,
    advice:
      "Ensure all non-public routes have authentication middleware applied before the handler.",
    cwe: "CWE-862",
  },
  {
    id: "SEC002",
    category: "A01:BrokenAccessControl",
    severity: "HIGH",
    title: "Role check missing on admin route",
    regex:
      /router\.(get|post|put|patch|delete)\s*\(\s*['"`][^'"`,]*admin[^'"`,]*['"`]/gi,
    advice:
      "Admin routes must verify both authentication AND role/permission level.",
    cwe: "CWE-285",
  },
  {
    id: "SEC003",
    category: "A01:BrokenAccessControl",
    severity: "HIGH",
    title: "Direct object reference without ownership check",
    regex:
      /req\.params\.(?:id|userId|user_id)\b(?!.*(?:userId|owner|createdBy|belongsTo|where.*user))/gi,
    advice:
      "Verify the authenticated user owns the requested resource before returning it.",
    cwe: "CWE-639",
  },

  // ── A02: Cryptographic Failures ───────────────────────────────
  {
    id: "SEC004",
    category: "A02:CryptographicFailures",
    severity: "CRITICAL",
    title: "Hardcoded secret, API key, or password",
    regex:
      /(?:api_?key|apikey|secret|password|passwd|token|auth_?token|private_?key|access_?key)\s*[:=]\s*['"`][a-zA-Z0-9_\-\.\/+]{12,}['"`]/gi,
    advice:
      "Move all credentials to environment variables. Never commit secrets to source control.",
    cwe: "CWE-798",
  },
  {
    id: "SEC005",
    category: "A02:CryptographicFailures",
    severity: "CRITICAL",
    title: "AWS access key ID embedded in code",
    regex: /AKIA[0-9A-Z]{16}/g,
    advice:
      "Rotate this key immediately. Use IAM roles, AWS Secrets Manager, or environment variables.",
    cwe: "CWE-798",
  },
  {
    id: "SEC006",
    category: "A02:CryptographicFailures",
    severity: "CRITICAL",
    title: "Private key or certificate embedded in source",
    regex:
      /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE KEY-----|-----BEGIN CERTIFICATE-----/g,
    advice:
      "Never store private keys in source code. Use a secrets manager or HSM.",
    cwe: "CWE-321",
  },
  {
    id: "SEC007",
    category: "A02:CryptographicFailures",
    severity: "HIGH",
    title: "Weak hashing algorithm used",
    regex:
      /createHash\s*\(\s*['"`](?:md5|sha1|sha-1)['"`]\)|hashlib\.(?:md5|sha1)\s*\(/gi,
    advice: "Replace MD5/SHA1 with SHA-256 or bcrypt/argon2 for passwords.",
    cwe: "CWE-327",
  },
  {
    id: "SEC008",
    category: "A02:CryptographicFailures",
    severity: "HIGH",
    title: "JWT secret sourced from environment without startup validation",
    regex:
      /process\.env\.(?:JWT_SECRET|JWT_KEY|TOKEN_SECRET)(?!\s*(?:\|\||&&|\?\?|if\s*\())/g,
    advice:
      "Add startup guard: if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');",
    cwe: "CWE-320",
  },
  {
    id: "SEC009",
    category: "A02:CryptographicFailures",
    severity: "MEDIUM",
    title: "JWT token signed with algorithm 'none'",
    regex: /(?:sign|verify)\s*\(.*algorithm\s*:\s*['"`]none['"`]/gi,
    advice: "Never use algorithm 'none'. Explicitly specify RS256 or HS256.",
    cwe: "CWE-347",
  },
  {
    id: "SEC010",
    category: "A02:CryptographicFailures",
    severity: "MEDIUM",
    title: "Math.random() used for security-sensitive value",
    regex: /Math\.random\s*\(\s*\)/g,
    advice:
      "Use crypto.randomBytes() or crypto.randomUUID() for tokens, nonces, and IDs.",
    cwe: "CWE-338",
  },
  {
    id: "SEC011",
    category: "A02:CryptographicFailures",
    severity: "MEDIUM",
    title: "Insecure cookie — missing Secure or HttpOnly flag",
    regex:
      /res\.cookie\s*\([^)]+\)(?!.*(?:httpOnly\s*:\s*true|secure\s*:\s*true))/gi,
    advice:
      "Set { httpOnly: true, secure: true, sameSite: 'strict' } on all cookies.",
    cwe: "CWE-614",
  },

  // ── A03: Injection ────────────────────────────────────────────
  {
    id: "SEC012",
    category: "A03:Injection",
    severity: "CRITICAL",
    title: "SQL injection via string interpolation",
    regex:
      /(?:query|execute|raw|db\.run|connection\.query)\s*\([`'"]\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE)[^)]*\$\{/gi,
    advice:
      "Use parameterised queries or a query builder. Never interpolate user input into SQL.",
    cwe: "CWE-89",
  },
  {
    id: "SEC013",
    category: "A03:Injection",
    severity: "CRITICAL",
    title: "Command injection via exec/spawn with template literal",
    regex: /(?:exec|execSync|spawn|spawnSync|system|popen)\s*\([`][^`]*\$\{/gi,
    advice:
      "Never pass user-controlled data to shell commands. Use execFile() with an argument array.",
    cwe: "CWE-78",
  },
  {
    id: "SEC014",
    category: "A03:Injection",
    severity: "CRITICAL",
    title: "eval() called with dynamic input",
    regex: /\beval\s*\(\s*(?!['"`])[^)]/g,
    advice:
      "Replace eval() with JSON.parse(), Function constructors behind validation, or redesign.",
    cwe: "CWE-95",
  },
  {
    id: "SEC015",
    category: "A03:Injection",
    severity: "HIGH",
    title: "Prototype pollution via object spread from request body",
    regex: /Object\.assign\s*\(\s*\{\s*\}\s*,\s*req\.body|\.\.\.req\.body/g,
    advice:
      "Validate and whitelist req.body keys. Use a DTO with class-validator or Zod.",
    cwe: "CWE-1321",
  },
  {
    id: "SEC016",
    category: "A03:Injection",
    severity: "HIGH",
    title: "NoSQL injection — MongoDB query built from user input",
    regex:
      /(?:findOne|find|updateOne|deleteOne)\s*\(\s*req\.(?:body|params|query)/gi,
    advice:
      "Sanitise MongoDB query operators. Use mongoose-sanitize or validate input schema.",
    cwe: "CWE-943",
  },
  {
    id: "SEC017",
    category: "A03:Injection",
    severity: "HIGH",
    title: "Path traversal via user-controlled file path",
    regex:
      /(?:readFile|writeFile|readFileSync|writeFileSync|createReadStream)\s*\([^)]*req\.(?:body|params|query)/gi,
    advice:
      "Sanitise file paths. Use path.basename() and validate against an allowlist of directories.",
    cwe: "CWE-22",
  },
  {
    id: "SEC018",
    category: "A03:Injection",
    severity: "HIGH",
    title: "XSS via dangerous innerHTML or document.write",
    regex: /\.innerHTML\s*=(?!=)|document\.write\s*\(/g,
    advice:
      "Use textContent or sanitise with DOMPurify before setting innerHTML.",
    cwe: "CWE-79",
  },
  {
    id: "SEC019",
    category: "A03:Injection",
    severity: "MEDIUM",
    title: "Server-side template injection risk",
    regex:
      /(?:render|compile|template)\s*\(\s*(?:req\.|res\.|user\.|`[^`]*\${)/gi,
    advice:
      "Never pass user-controlled strings as template source. Pre-compile all templates.",
    cwe: "CWE-94",
  },

  // ── A04: Insecure Design ──────────────────────────────────────
  {
    id: "SEC020",
    category: "A04:InsecureDesign",
    severity: "HIGH",
    title: "CORS wildcard origin — all origins permitted",
    regex: /origin\s*:\s*['"`]\*['"`]|cors\s*\(\s*\)/g,
    advice:
      "Restrict CORS to specific trusted origins. Never use '*' in production.",
    cwe: "CWE-942",
  },
  {
    id: "SEC021",
    category: "A04:InsecureDesign",
    severity: "MEDIUM",
    title: "No rate limiting on authentication routes",
    regex:
      /router\.post\s*\(\s*['"`][^'"`,]*(?:login|signin|register|signup|forgot.?password|reset.?password|verify|auth)/gi,
    advice:
      "Apply express-rate-limit or equivalent to all auth endpoints to prevent brute force.",
    cwe: "CWE-307",
  },
  {
    id: "SEC022",
    category: "A04:InsecureDesign",
    severity: "MEDIUM",
    title: "Unrestricted file upload — no MIME type validation",
    regex:
      /(?:multer|formidable|busboy|upload)\s*\((?!.*(?:mimetype|fileFilter|allowedTypes|accept))/gi,
    advice:
      "Validate file MIME type, extension, and size. Store uploads outside the web root.",
    cwe: "CWE-434",
  },

  // ── A05: Security Misconfiguration ───────────────────────────
  {
    id: "SEC023",
    category: "A05:SecurityMisconfiguration",
    severity: "HIGH",
    title: "Stack trace or error detail returned to client",
    regex:
      /res\.(?:json|send)\s*\(\s*(?:err|error|e)\s*\)|res\.status\(\d+\)\.json\s*\(\s*(?:err|error)\s*\)/gi,
    advice:
      "Never expose raw error objects. Return a sanitised error message and log the full error server-side.",
    cwe: "CWE-209",
  },
  {
    id: "SEC024",
    category: "A05:SecurityMisconfiguration",
    severity: "MEDIUM",
    title: "HTTP used instead of HTTPS for external connection",
    regex:
      /(?:fetch|axios\.get|axios\.post|http\.request|request)\s*\(\s*['"`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/gi,
    advice:
      "Use HTTPS for all external connections. Enforce TLS in production.",
    cwe: "CWE-319",
  },
  {
    id: "SEC025",
    category: "A05:SecurityMisconfiguration",
    severity: "MEDIUM",
    title: "Helmet / security headers not applied",
    regex: /const\s+app\s*=\s*express\s*\(\s*\)(?![\s\S]{0,500}helmet)/g,
    advice:
      "Add helmet() as first middleware: app.use(helmet()). Sets X-Frame-Options, CSP, HSTS, etc.",
    cwe: "CWE-16",
  },
  {
    id: "SEC026",
    category: "A05:SecurityMisconfiguration",
    severity: "LOW",
    title: "Debug mode or verbose logging enabled",
    regex:
      /debug\s*:\s*true|NODE_ENV\s*[!=]=\s*['"`]development['"`]|verbose\s*:\s*true/gi,
    advice: "Ensure debug/verbose mode is disabled in production builds.",
    cwe: "CWE-215",
  },

  // ── A07: Identification & Authentication Failures ─────────────
  {
    id: "SEC027",
    category: "A07:AuthFailures",
    severity: "CRITICAL",
    title: "Password stored without hashing",
    regex:
      /(?:password|passwd)\s*[:=]\s*req\.body\.(?:password|passwd)(?![\s\S]{0,200}(?:bcrypt|argon2|hash|pbkdf2|scrypt))/gi,
    advice:
      "Always hash passwords with bcrypt (cost ≥ 12), argon2, or scrypt before storing.",
    cwe: "CWE-256",
  },
  {
    id: "SEC028",
    category: "A07:AuthFailures",
    severity: "HIGH",
    title: "JWT verification missing — token decoded without verify",
    regex: /jwt\.decode\s*\((?![\s\S]{0,50}jwt\.verify)/gi,
    advice:
      "Use jwt.verify() not jwt.decode(). decode() does NOT validate the signature.",
    cwe: "CWE-347",
  },
  {
    id: "SEC029",
    category: "A07:AuthFailures",
    severity: "HIGH",
    title: "Session secret hardcoded or using default value",
    regex:
      /session\s*\(\s*\{[^}]*secret\s*:\s*['"`](?:secret|keyboard cat|my-secret|changeme|default)[^'"`,]*['"`]/gi,
    advice:
      "Use a cryptographically random secret of at least 32 bytes from environment variables.",
    cwe: "CWE-798",
  },

  // ── A09: Security Logging & Monitoring Failures ───────────────
  {
    id: "SEC030",
    category: "A09:LoggingFailures",
    severity: "MEDIUM",
    title: "Sensitive data exposed in console.log",
    regex:
      /console\.(?:log|info|warn|debug)\s*\(.*(?:password|passwd|token|secret|key|auth|credit_?card|ssn|cvv)/gi,
    advice:
      "Remove logs that may expose PII or credentials. Use a structured logger with redaction.",
    cwe: "CWE-532",
  },
  {
    id: "SEC031",
    category: "A09:LoggingFailures",
    severity: "LOW",
    title: "Security-related TODO or FIXME left in code",
    regex:
      /(?:TODO|FIXME|HACK|XXX)\s*.*(?:auth|security|permission|validate|sanitize|encrypt|token|sql)/gi,
    advice:
      "Address all security-related TODO items before production deployment.",
    cwe: "CWE-1059",
  },

  // ── A10: SSRF ─────────────────────────────────────────────────
  {
    id: "SEC032",
    category: "A10:SSRF",
    severity: "HIGH",
    title: "Server-side request with user-controlled URL",
    regex:
      /(?:fetch|axios\.get|axios\.post|http\.request|got|request)\s*\(\s*(?:req\.body\.|req\.query\.|req\.params\.)/gi,
    advice:
      "Validate and allowlist URLs before making server-side requests. Block internal IP ranges.",
    cwe: "CWE-918",
  },
];

// ─── Severity Configuration ───────────────────────────────────────

const SEVERITY_WEIGHT = { CRITICAL: 25, HIGH: 15, MEDIUM: 7, LOW: 2 };
const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const SEVERITY_EMOJI = { CRITICAL: "🔴", HIGH: "🟠", MEDIUM: "🟡", LOW: "🔵" };

// ─── LLM System Prompt ────────────────────────────────────────────

const LLM_SYSTEM_PROMPT = `You are a principal application security engineer with expertise in OWASP Top 10, secure code review, and penetration testing. You specialise in finding vulnerabilities that static regex analysis cannot catch.

## YOUR TASK
Review the provided source code and identify security vulnerabilities, focusing exclusively on issues that require semantic understanding:
- Business logic flaws (e.g. skippable payment steps, privilege escalation paths)
- Missing or bypassable authorization checks
- Insecure direct object references (IDOR)
- Logic bugs in authentication flows (e.g. timing attacks, token reuse)
- Improper error handling that leaks stack traces or internal state
- Mass assignment vulnerabilities
- Insecure deserialization
- Broken cryptographic implementation (e.g. ECB mode, static IV, reused nonce)
- Race conditions affecting security-sensitive operations
- Second-order injection (stored input later used unsafely)

## OUTPUT FORMAT
Return ONLY a valid JSON array.
No markdown. No code fences. No explanation. No preamble.
Start with [ and end with ].
If no vulnerabilities are found, return: []

## SCHEMA
[
  {
    "id": string,              // e.g. "LLM001", "LLM002" — sequential within this file
    "category": string,        // OWASP category: "A01:BrokenAccessControl" | "A02:CryptographicFailures" | "A03:Injection" | "A04:InsecureDesign" | "A05:SecurityMisconfiguration" | "A06:VulnerableComponents" | "A07:AuthFailures" | "A08:DataIntegrity" | "A09:LoggingFailures" | "A10:SSRF"
    "severity": string,        // "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
    "title": string,           // Short vulnerability name e.g. "Missing ownership check on resource update"
    "file": string,            // File path
    "line": string,            // The specific code snippet (max 120 chars) that demonstrates the issue
    "description": string,     // 2–3 sentences: what the vulnerability is, how it could be exploited
    "impact": string,          // What an attacker could achieve if this is exploited
    "advice": string,          // Specific, actionable fix for this codebase — not generic advice
    "cwe": string,             // CWE identifier e.g. "CWE-639"
    "confidence": string       // "HIGH" | "MEDIUM" | "LOW" — how confident you are this is a real issue
  }
]

## ANALYSIS RULES
1. Only report real, demonstrable vulnerabilities — not theoretical or best-practice suggestions.
2. Set confidence "LOW" if the issue depends on untested assumptions about how the function is called.
3. For "line", quote the most relevant snippet verbatim (truncated to 120 chars).
4. For "advice", refer to actual variable names, function names, or line patterns in the provided code.
5. Do NOT re-report issues that are clearly caught by static analysis (hardcoded secrets, basic eval usage).
6. Do NOT report missing documentation, code style, or non-security concerns.
7. If you are reviewing an auth, payment, or permission-related function — scrutinise it more thoroughly.`;

// ─── Constants ────────────────────────────────────────────────────

const SKIP_REGEX =
  /node_modules|\.lock$|\.min\.|dist\/|build\/|coverage\/|\.nyc_output|__pycache__|\.git\/|\.(md|yaml|yml|txt|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map|d\.ts)$/i;

const HIGH_RISK_PATH_REGEX =
  /auth|jwt|bcrypt|crypto|password|token|permission|role|admin|payment|stripe|billing|session|oauth|saml|login|register|secret|key|certificate|identity|access/i;

const HIGH_RISK_CONTENT_KEYWORDS =
  /jwt\.sign|jwt\.verify|bcrypt\.hash|createHash|Bearer|Authorization|role|permission|admin|stripe\.charges|payment|session\.secret|passport\./i;

const CHUNK_SIZE = 6000; // was 400 — far too small for any real security analysis
const MAX_LLM_FILES = 15; // increased from 8
const MAX_RETRIES = 2;

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Safe JSON parse with fence stripping fallback.
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
 * Validate and normalise a single LLM finding.
 */
function validateLLMFinding(finding, fallbackFile) {
  if (!finding || typeof finding !== "object") return null;

  const severity = String(finding.severity ?? "").toUpperCase();
  if (!SEVERITY_ORDER.includes(severity)) return null;

  const title = String(finding.title ?? "").trim();
  if (!title) return null;

  return {
    id: String(finding.id ?? "LLM???").trim(),
    category: String(finding.category ?? "unknown").trim(),
    severity,
    title,
    file: String(finding.file ?? fallbackFile ?? "unknown").trim(),
    line: String(finding.line ?? "")
      .slice(0, 120)
      .trim(),
    description: String(finding.description ?? "").trim(),
    impact: String(finding.impact ?? "").trim(),
    advice: String(finding.advice ?? "").trim(),
    cwe: String(finding.cwe ?? "").trim(),
    confidence: ["HIGH", "MEDIUM", "LOW"].includes(
      String(finding.confidence ?? "").toUpperCase(),
    )
      ? String(finding.confidence).toUpperCase()
      : "MEDIUM",
    source: "llm",
  };
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
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
}

/**
 * Deduplicate findings — prefer the richer version of any two
 * findings with the same title in the same file.
 */
function deduplicateFindings(findings) {
  const map = new Map();

  for (const f of findings) {
    // Key: file + normalised title (lowercase, stripped punctuation)
    const key = `${f.file}::${f.title.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    const existing = map.get(key);

    if (!existing) {
      map.set(key, f);
    } else {
      // Keep the richer finding (LLM findings over static — more context)
      const scoreF = scoreFinding(f);
      const scoreE = scoreFinding(existing);
      if (scoreF > scoreE) map.set(key, f);
    }
  }

  return Array.from(map.values());
}

/**
 * Score completeness of a finding for deduplication.
 */
function scoreFinding(f) {
  let score = 0;
  if (f.description) score += 3;
  if (f.impact) score += 2;
  if (f.advice) score += 2;
  if (f.cwe) score += 1;
  if (f.line) score += 1;
  if (f.category) score += 1;
  if (f.source === "llm") score += 2;
  if (f.confidence === "HIGH") score += 1;
  return score;
}

/**
 * Calculate security score and grade from findings.
 */
function calculateScore(findings) {
  // Deduct points per finding — CRITICAL findings have diminishing returns
  // to prevent a single file from dominating the score
  const criticalCount = findings.filter(
    (f) => f.severity === "CRITICAL",
  ).length;
  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const mediumCount = findings.filter((f) => f.severity === "MEDIUM").length;
  const lowCount = findings.filter((f) => f.severity === "LOW").length;

  // Diminishing deductions — first occurrence hurts more than the 10th
  const deductCritical =
    Math.min(criticalCount, 3) * 25 + Math.max(0, criticalCount - 3) * 10;
  const deductHigh =
    Math.min(highCount, 5) * 15 + Math.max(0, highCount - 5) * 5;
  const deductMedium =
    Math.min(mediumCount, 8) * 7 + Math.max(0, mediumCount - 8) * 2;
  const deductLow = lowCount * 2;

  const totalDeduction = deductCritical + deductHigh + deductMedium + deductLow;
  const score = Math.max(0, Math.min(100, 100 - totalDeduction));

  const grade =
    score >= 90
      ? "A"
      : score >= 80
        ? "B"
        : score >= 65
          ? "C"
          : score >= 45
            ? "D"
            : "F";

  return { score, grade };
}

/**
 * Count findings per severity.
 */
function countBySeverity(findings) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return counts;
}

/**
 * Count findings per OWASP category.
 */
function countByCategory(findings) {
  const counts = {};
  for (const f of findings) {
    const cat = f.category || "unknown";
    counts[cat] = (counts[cat] ?? 0) + 1;
  }
  return counts;
}

/**
 * Build the list of most affected files sorted by risk score.
 */
function buildAffectedFiles(findings) {
  const fileMap = {};
  for (const f of findings) {
    if (!fileMap[f.file])
      fileMap[f.file] = { file: f.file, score: 0, count: 0 };
    fileMap[f.file].score += SEVERITY_WEIGHT[f.severity] ?? 2;
    fileMap[f.file].count += 1;
  }
  return Object.values(fileMap)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

// ─── Report Builder ───────────────────────────────────────────────

function buildReport(
  findings,
  score,
  grade,
  counts,
  categoryCounts,
  affectedFiles,
  staticCount,
  llmCount,
) {
  let md = `# 🔒 Security Audit Report\n\n`;

  // ── Executive Summary ─────────────────────────────────────────
  md += `## Executive Summary\n\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| **Security Score** | ${score}/100 |\n`;
  md += `| **Grade** | **${grade}** |\n`;
  md += `| **Total Findings** | ${findings.length} |\n`;
  md += `| **Static Analysis** | ${staticCount} findings |\n`;
  md += `| **AI Deep Scan** | ${llmCount} findings |\n\n`;

  // ── Severity Breakdown ────────────────────────────────────────
  md += `## Severity Breakdown\n\n`;
  md += `| Severity | Count | Risk |\n|----------|-------|------|\n`;
  for (const sev of SEVERITY_ORDER) {
    const count = counts[sev] ?? 0;
    const bar =
      "█".repeat(Math.min(count, 10)) + (count > 10 ? `+${count - 10}` : "");
    md += `| ${SEVERITY_EMOJI[sev]} **${sev}** | ${count} | ${bar || "—"} |\n`;
  }
  md += "\n";

  // ── OWASP Category Breakdown ──────────────────────────────────
  if (Object.keys(categoryCounts).length > 0) {
    md += `## OWASP Top 10 Coverage\n\n`;
    md += `| Category | Findings |\n|----------|----------|\n`;
    Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => {
        md += `| ${cat} | ${count} |\n`;
      });
    md += "\n";
  }

  // ── Most Affected Files ───────────────────────────────────────
  if (affectedFiles.length > 0) {
    md += `## Most Affected Files\n\n`;
    md += `| File | Findings | Risk Score |\n|------|----------|------------|\n`;
    affectedFiles.forEach((f) => {
      md += `| \`${f.file}\` | ${f.count} | ${f.score} |\n`;
    });
    md += "\n";
  }

  // ── Score Guide ───────────────────────────────────────────────
  md += `## Score Guide\n\n`;
  md += `| Grade | Score | Meaning |\n|-------|-------|----------|\n`;
  md += `| A | 90–100 | Production ready — address Low findings |\n`;
  md += `| B | 80–89  | Minor issues — fix High findings before release |\n`;
  md += `| C | 65–79  | Significant risk — fix Critical + High before release |\n`;
  md += `| D | 45–64  | High risk — do not deploy to production |\n`;
  md += `| F | 0–44   | Critical risk — security review required |\n\n`;

  // ── Findings Detail ───────────────────────────────────────────
  if (!findings.length) {
    md += `## Findings\n\n✅ No vulnerabilities detected.\n`;
    return md;
  }

  md += `## Findings\n\n`;

  for (const sev of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (!group.length) continue;

    md += `### ${SEVERITY_EMOJI[sev]} ${sev} (${group.length})\n\n`;

    group.forEach((f) => {
      const sourceTag = f.source === "llm" ? " *(AI)*" : " *(static)*";
      const confTag = f.confidence ? ` · Confidence: **${f.confidence}**` : "";
      md += `#### [${f.id}] ${f.title}${sourceTag}\n\n`;
      md += `**File:** \`${f.file}\``;
      if (f.cwe) md += ` · **${f.cwe}**`;
      md += ` · **${f.category || "uncategorised"}**${confTag}\n\n`;

      if (f.line) {
        md += `**Detected:**\n\`\`\`\n${f.line.replace(/`/g, "'")}\n\`\`\`\n\n`;
      }

      if (f.description) md += `**Description:** ${f.description}\n\n`;
      if (f.impact) md += `**Impact:** ${f.impact}\n\n`;
      md += `**Fix:** ${f.advice}\n\n`;
      md += "---\n\n";
    });
  }

  return md;
}

// ─── Remediation Plan Builder ─────────────────────────────────────

/**
 * Build a prioritised remediation checklist from findings.
 * Grouped by severity with effort estimates.
 */
function buildRemediationPlan(findings) {
  let md = `# 🔧 Remediation Plan\n\n`;
  md += `> Address findings in this order: Critical → High → Medium → Low\n\n`;

  for (const sev of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (!group.length) continue;

    const effort = {
      CRITICAL: "Immediate",
      HIGH: "This sprint",
      MEDIUM: "Next sprint",
      LOW: "Backlog",
    };
    md += `## ${SEVERITY_EMOJI[sev]} ${sev} — ${effort[sev]}\n\n`;

    group.forEach((f, idx) => {
      md += `${idx + 1}. **[${f.id}] ${f.title}**\n`;
      md += `   - File: \`${f.file}\`\n`;
      md += `   - Fix: ${f.advice}\n`;
      if (f.cwe)
        md += `   - Reference: https://cwe.mitre.org/data/definitions/${f.cwe.replace("CWE-", "")}.html\n`;
      md += "\n";
    });
  }

  return md;
}

// ─── Agent ────────────────────────────────────────────────────────

export async function securityAuditorAgent({ files, projectMap, emit }) {
  const notify = (msg, detail) => emit?.(msg, detail);

  notify("Starting security audit…", "Agent 6 — Security Auditor");

  // ── 1. Filter scannable code files ────────────────────────────
  const codeFiles = files.filter(
    (f) => f?.path && f?.content && !SKIP_REGEX.test(f.path),
  );

  if (codeFiles.length === 0) {
    notify("No code files to scan", "Security audit skipped");
    return buildEmptyResult();
  }

  notify(
    "Running static pattern scan…",
    `${codeFiles.length} code files · ${STATIC_RULES.length} rules`,
  );

  // ── 2. Static scan — all files, zero LLM cost ─────────────────
  const staticFindings = [];

  for (const file of codeFiles) {
    for (const rule of STATIC_RULES) {
      // Re-create regex each time to reset lastIndex state
      const re = new RegExp(
        rule.regex.source,
        rule.regex.flags.replace("g", "") + "g",
      );
      const matches = [...file.content.matchAll(re)];
      if (!matches.length) continue;

      // Find approximate line number of first match
      const firstMatchIndex = file.content.indexOf(matches[0][0]);
      const lineNumber = file.content
        .slice(0, firstMatchIndex)
        .split("\n").length;

      staticFindings.push({
        id: rule.id,
        category: rule.category,
        severity: rule.severity,
        title: rule.title,
        file: file.path,
        line: matches[0][0].slice(0, 120).trim(),
        line_number: lineNumber,
        description: "",
        impact: "",
        advice: rule.advice,
        cwe: rule.cwe,
        count: matches.length,
        confidence: "HIGH",
        source: "static",
      });
    }
  }

  const staticCountBySev = countBySeverity(staticFindings);
  notify(
    `Static scan complete — ${staticFindings.length} findings`,
    `Critical:${staticCountBySev.CRITICAL} · High:${staticCountBySev.HIGH} · Medium:${staticCountBySev.MEDIUM} · Low:${staticCountBySev.LOW}`,
  );

  // ── 3. Score files for LLM priority ───────────────────────────
  // Files that already have static findings get priority,
  // plus files that contain high-risk keywords
  const fileRiskScore = (file) => {
    const staticHits = staticFindings.filter((f) => f.file === file.path);
    const staticScore = staticHits.reduce(
      (s, f) => s + (SEVERITY_WEIGHT[f.severity] ?? 2),
      0,
    );
    const pathScore = HIGH_RISK_PATH_REGEX.test(file.path) ? 10 : 0;
    const contentScore = HIGH_RISK_CONTENT_KEYWORDS.test(
      file.content.slice(0, 1000),
    )
      ? 8
      : 0;
    const metaScore = (() => {
      const meta = projectMap?.find((m) => m.path === file.path);
      if (!meta) return 0;
      return (
        (meta.flags?.includes("has_auth") ? 5 : 0) +
        (meta.importance === "critical" ? 3 : 0)
      );
    })();
    return staticScore + pathScore + contentScore + metaScore;
  };

  const highRiskFiles = codeFiles
    .filter(
      (f) =>
        fileRiskScore(f) > 0 ||
        HIGH_RISK_PATH_REGEX.test(f.path) ||
        HIGH_RISK_CONTENT_KEYWORDS.test(f.content.slice(0, 600)),
    )
    .sort((a, b) => fileRiskScore(b) - fileRiskScore(a))
    .slice(0, MAX_LLM_FILES);

  notify(`AI deep scan…`, `${highRiskFiles.length} high-risk files selected`);

  // ── 4. LLM deep scan — high-risk files only ───────────────────
  const llmFindings = [];
  const llmErrors = [];

  for (const [i, file] of highRiskFiles.entries()) {
    notify(
      `AI scanning…`,
      `File ${i + 1} of ${highRiskFiles.length}: ${file.path.split("/").pop()}`,
    );

    // Use the first chunk — most files have the critical logic at the top
    // For very large files, also scan the middle chunk (where business logic often lives)
    const allChunks = chunkText(file.content, CHUNK_SIZE);
    const scanChunks =
      allChunks.length > 2
        ? [allChunks[0], allChunks[Math.floor(allChunks.length / 2)]]
        : [allChunks[0]];

    for (const [chunkIdx, chunk] of scanChunks.entries()) {
      try {
        const raw = await llmCallWithRetry({
          systemPrompt: LLM_SYSTEM_PROMPT,
          userContent: `FILE: ${file.path}\nCHUNK: ${chunkIdx + 1} of ${scanChunks.length}\n\n${chunk}`,
        });
        const parsed = safeParseJSON(raw);

        if (!Array.isArray(parsed)) {
          llmErrors.push({
            file: file.path,
            chunk: chunkIdx,
            error: "Response was not a JSON array",
          });
          continue;
        }

        for (const finding of parsed) {
          const validated = validateLLMFinding(finding, file.path);
          if (validated) llmFindings.push(validated);
        }
      } catch (err) {
        llmErrors.push({
          file: file.path,
          chunk: chunkIdx,
          error: err.message,
        });
      }
    }
  }

  const llmCountBySev = countBySeverity(llmFindings);
  notify(
    `AI scan complete — ${llmFindings.length} additional findings`,
    `Critical:${llmCountBySev.CRITICAL} · High:${llmCountBySev.HIGH} · Medium:${llmCountBySev.MEDIUM} · Low:${llmCountBySev.LOW}`,
  );

  // ── 5. Merge, deduplicate, and sort all findings ───────────────
  const rawFindings = [...staticFindings, ...llmFindings];
  const findings = deduplicateFindings(rawFindings).sort((a, b) => {
    const sevOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    return (
      (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3) ||
      a.file.localeCompare(b.file)
    );
  });

  // ── 6. Calculate score and build outputs ──────────────────────
  const { score, grade } = calculateScore(findings);
  const counts = countBySeverity(findings);
  const categoryCounts = countByCategory(findings);
  const affectedFiles = buildAffectedFiles(findings);

  // ── 7. Build summary ──────────────────────────────────────────
  const summary = {
    totalFindings: findings.length,
    staticFindings: staticFindings.length,
    llmFindings: llmFindings.length,
    afterDedup: findings.length,
    score,
    grade,
    counts,
    categoryCounts,
    affectedFiles,
    filesScanned: codeFiles.length,
    filesDeepScanned: highRiskFiles.length,
    llmErrors: llmErrors.length,
  };

  if (llmErrors.length > 0) {
    notify(
      `⚠ ${llmErrors.length} AI scan error(s)`,
      llmErrors.map((e) => `${e.file}: ${e.error}`).join("; "),
    );
  }

  notify(
    `Audit complete — ${score}/100 (${grade})`,
    [
      `${findings.length} total findings`,
      `Critical:${counts.CRITICAL}`,
      `High:${counts.HIGH}`,
      `Medium:${counts.MEDIUM}`,
      `Low:${counts.LOW}`,
    ].join(" · "),
  );

  return {
    findings,
    score,
    grade,
    counts,
    categoryCounts,
    affectedFiles,
    summary,
    reportMarkdown: buildReport(
      findings,
      score,
      grade,
      counts,
      categoryCounts,
      affectedFiles,
      staticFindings.length,
      llmFindings.length,
    ),
    remediationMarkdown: buildRemediationPlan(findings),
    errors: llmErrors.length > 0 ? llmErrors : undefined,
  };
}

// ─── Empty Result Helper ──────────────────────────────────────────

function buildEmptyResult() {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  return {
    findings: [],
    score: 100,
    grade: "A",
    counts,
    categoryCounts: {},
    affectedFiles: [],
    summary: { totalFindings: 0, score: 100, grade: "A", counts },
    reportMarkdown:
      "# 🔒 Security Audit Report\n\n✅ No code files found to scan.\n",
    remediationMarkdown:
      "# 🔧 Remediation Plan\n\n✅ No findings to remediate.\n",
  };
}
