// src/agents/securityAuditorAgent.js — Agent 6: Security Auditor

import { llmCall } from "../config/llm.js";
import { chunkText } from "../utils/tokenManager.js";

const STATIC_RULES = [
  {
    id: "SEC001",
    severity: "CRITICAL",
    title: "Hardcoded secret or API key",
    regex:
      /(?:api_?key|apikey|secret|password|passwd|token|auth_token)\s*[:=]\s*['"`][a-zA-Z0-9_\-\.]{12,}['"`]/gi,
    advice: "Move to environment variables. Never commit credentials.",
  },
  {
    id: "SEC002",
    severity: "CRITICAL",
    title: "AWS credentials in code",
    regex: /AKIA[0-9A-Z]{16}/g,
    advice: "Rotate immediately. Use IAM roles or AWS Secrets Manager.",
  },
  {
    id: "SEC003",
    severity: "CRITICAL",
    title: "Private key embedded",
    regex:
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE KEY-----|-----BEGIN CERTIFICATE-----/g,
    advice: "Never store private keys in source code.",
  },
  {
    id: "SEC004",
    severity: "HIGH",
    title: "SQL injection via string interpolation",
    regex:
      /(?:query|execute|raw)\s*\([`'"]\s*(?:SELECT|INSERT|UPDATE|DELETE)[^)]*\$\{/gi,
    advice: "Use parameterised queries. Never interpolate user input into SQL.",
  },
  {
    id: "SEC005",
    severity: "HIGH",
    title: "eval() usage",
    regex: /\beval\s*\([^)]/g,
    advice: "Replace with JSON.parse() or safe alternatives.",
  },
  {
    id: "SEC006",
    severity: "HIGH",
    title: "Dangerous innerHTML assignment",
    regex: /\.innerHTML\s*=[^=]/g,
    advice: "Use textContent or sanitise with DOMPurify first.",
  },
  {
    id: "SEC007",
    severity: "HIGH",
    title: "CORS wildcard origin",
    regex: /origin\s*:\s*['"`]\*['"`]|cors\(\)/g,
    advice: "Restrict to specific trusted origins in production.",
  },
  {
    id: "SEC008",
    severity: "HIGH",
    title: "JWT secret not validated at startup",
    regex: /process\.env\.JWT_SECRET(?!\s*(?:\|\||or|\?\?))/g,
    advice: "Guard: if (!process.env.JWT_SECRET) throw new Error('required')",
  },
  {
    id: "SEC009",
    severity: "HIGH",
    title: "Command injection via exec",
    regex: /(?:exec|execSync|spawn)\s*\([`][^`]*\$\{/g,
    advice: "Never pass user data to shell. Use execFile with arg arrays.",
  },
  {
    id: "SEC010",
    severity: "MEDIUM",
    title: "No rate limit on auth routes",
    regex:
      /router\.post\s*\(\s*['"`][^'"]*(?:login|register|forgot|reset|auth)/gi,
    advice: "Add express-rate-limit to auth endpoints.",
  },
  {
    id: "SEC011",
    severity: "MEDIUM",
    title: "HTTP instead of HTTPS",
    regex: /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/g,
    advice: "Use HTTPS for all external connections in production.",
  },
  {
    id: "SEC012",
    severity: "MEDIUM",
    title: "Sensitive data in console.log",
    regex: /console\.log\s*\(.*(?:password|token|secret|key|auth)/gi,
    advice: "Remove logs that could expose sensitive data.",
  },
  {
    id: "SEC013",
    severity: "LOW",
    title: "Security-related TODO/FIXME",
    regex:
      /(?:TODO|FIXME|HACK).*(?:auth|security|permission|validate|sanitize)/gi,
    advice: "Address this security debt before production.",
  },
];

const SEVERITY_WEIGHT = { CRITICAL: 25, HIGH: 15, MEDIUM: 7, LOW: 2 };

const LLM_SYSTEM_PROMPT = `You are a senior application security engineer.
Review this code and identify vulnerabilities not caught by static analysis.
Focus on: business logic flaws, missing authorisation, insecure design, error leakage.
Return ONLY valid JSON array (no markdown):
[{ "id":"LLM001","severity":"CRITICAL|HIGH|MEDIUM|LOW","title":"...","file":"...","line":"snippet","advice":"fix" }]
If nothing found, return [].`;

export async function securityAuditorAgent({ files, emit }) {
  const notify = (msg, detail) => {
    if (emit) emit(msg, detail);
  };

  const SKIP =
    /node_modules|\.lock$|\.min\.|dist\/|build\/|\.(md|yaml|yml|txt|svg|png|jpg|gif|ico|woff)$/i;
  const codeFiles = files.filter((f) => !SKIP.test(f.path));

  // Pass 1: static scan (instant, no tokens)
  notify("Running static pattern scan…", `${codeFiles.length} code files`);
  const staticFindings = [];
  for (const file of codeFiles) {
    for (const rule of STATIC_RULES) {
      const re = new RegExp(rule.regex.source, rule.regex.flags);
      const matches = [...file.content.matchAll(re)];
      if (matches.length) {
        staticFindings.push({
          ...rule,
          regex: undefined,
          file: file.path,
          count: matches.length,
          line: matches[0][0].slice(0, 100).trim(),
          source: "static",
        });
      }
    }
  }
  notify(
    `Static scan complete`,
    `${staticFindings.length} potential issues found`,
  );

  // Pass 2: LLM deep scan on high-risk files only
  const HIGH_RISK =
    /auth|jwt|bcrypt|crypto|password|token|permission|role|admin|payment|stripe|session/i;
  const highRiskFiles = codeFiles
    .filter(
      (f) => HIGH_RISK.test(f.path) || HIGH_RISK.test(f.content.slice(0, 400)),
    )
    .slice(0, 8);

  notify(`AI deep scan…`, `${highRiskFiles.length} high-risk files`);
  const llmFindings = [];
  for (const [i, file] of highRiskFiles.entries()) {
    notify(
      `AI scanning sensitive files…`,
      `File ${i + 1} of ${highRiskFiles.length}: ${file.path.split("/").pop()}`,
    );
    const chunks = chunkText(file.content, 400);
    try {
      const raw = await llmCall({
        systemPrompt: LLM_SYSTEM_PROMPT,
        userContent: `FILE: ${file.path}\n\n${chunks[0]}`,
      });
      const parsed = JSON.parse(raw);
      llmFindings.push(
        ...parsed.map((f) => ({ ...f, file: file.path, source: "llm" })),
      );
    } catch {
      /* skip */
    }
  }

  const allFindings = [...staticFindings, ...llmFindings];
  const deduction = allFindings.reduce(
    (s, f) => s + (SEVERITY_WEIGHT[f.severity] || 2),
    0,
  );
  const score = Math.max(0, 100 - deduction);
  const grade =
    score >= 90
      ? "A"
      : score >= 75
        ? "B"
        : score >= 60
          ? "C"
          : score >= 40
            ? "D"
            : "F";
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  allFindings.forEach(
    (f) => (counts[f.severity] = (counts[f.severity] || 0) + 1),
  );

  notify(
    `Audit complete — score ${score}/100 (${grade})`,
    `Critical:${counts.CRITICAL} · High:${counts.HIGH} · Medium:${counts.MEDIUM} · Low:${counts.LOW}`,
  );
  return {
    findings: allFindings,
    score,
    grade,
    counts,
    reportMarkdown: buildReport(allFindings, score, grade, counts),
  };
}

function buildReport(findings, score, grade, counts) {
  const EMOJI = { CRITICAL: "🔴", HIGH: "🟠", MEDIUM: "🟡", LOW: "🔵" };
  let md = `# 🔒 Security Audit Report\n\n## Score: ${score}/100 — Grade: **${grade}**\n\n`;
  md += `| Severity | Count |\n|----------|-------|\n`;
  Object.entries(counts).forEach(([s, c]) => {
    md += `| ${EMOJI[s]} ${s} | ${c} |\n`;
  });
  md += "\n";
  if (!findings.length) {
    md += "✅ No issues detected.\n";
    return md;
  }
  for (const sev of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
    const group = findings.filter((f) => f.severity === sev);
    if (!group.length) continue;
    md += `## ${EMOJI[sev]} ${sev}\n\n`;
    group.forEach((f) => {
      md += `### [${f.id}] ${f.title}\n**File:** \`${f.file}\`\n\n`;
      if (f.line) md += `**Detected:** \`${f.line.replace(/`/g, "'")}\`\n\n`;
      md += `**Fix:** ${f.advice}\n\n---\n\n`;
    });
  }
  return md;
}
