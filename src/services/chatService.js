// src/services/chatService.js
// ─────────────────────────────────────────────────────────────
// Chat With Your Codebase Service
// ─────────────────────────────────────────────────────────────
// Strategy:
//   • Docs (README + API + Schema + Internal) = permanent context
//   • Conversation history kept per session (in-memory, ring buffer)
//   • Smart context injection: only include relevant doc sections
//     based on question keywords (saves tokens on each turn)
//   • Max history: 6 turns (3 user + 3 assistant) to stay in budget
// ─────────────────────────────────────────────────────────────

import { llmCall } from "../config/llm.js";

const MAX_HISTORY_TURNS = 6;
const MAX_CONTEXT_CHARS = 3000; // ~750 tokens of doc context per message

// In-memory sessions: sessionId → { docsContext, history[], repoMeta }
const sessions = new Map();

// ── Build compressed docs context ────────────────────────────
function buildDocsContext(output, meta) {
  const sections = [
    `# Project: ${meta?.name || "Unknown"}\n${meta?.description || ""}`,
    output.readme       ? `## README SUMMARY\n${output.readme.slice(0, 800)}` : "",
    output.apiReference ? `## API REFERENCE\n${output.apiReference.slice(0, 800)}` : "",
    output.schemaDocs   ? `## DATA MODELS\n${output.schemaDocs.slice(0, 600)}` : "",
    output.internalDocs ? `## ARCHITECTURE\n${output.internalDocs.slice(0, 600)}` : "",
    output.securityReport ? `## SECURITY REPORT\n${output.securityReport.slice(0, 400)}` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

// ── Smart section selector based on question keywords ─────────
function selectRelevantContext(question, fullContext) {
  const q = question.toLowerCase();

  // Map keywords → which context sections to prioritise
  const SECTION_KEYWORDS = {
    api      : ["endpoint", "route", "api", "request", "post", "get", "http", "url", "param"],
    schema   : ["model", "schema", "database", "db", "table", "field", "relation", "mongo", "sql"],
    security : ["security", "auth", "jwt", "token", "password", "vulnerability", "hack", "safe"],
    arch     : ["architecture", "how does", "flow", "component", "service", "middleware", "structure"],
  };

  // Find which section the question is most about
  let bestSection = null;
  let bestScore   = 0;
  for (const [section, keywords] of Object.entries(SECTION_KEYWORDS)) {
    const score = keywords.filter((k) => q.includes(k)).length;
    if (score > bestScore) { bestScore = score; bestSection = section; }
  }

  // If strongly matched, extract just that section from context
  if (bestScore >= 2 && bestSection) {
    const sectionMap = {
      api     : "API REFERENCE",
      schema  : "DATA MODELS",
      security: "SECURITY REPORT",
      arch    : "ARCHITECTURE",
    };
    const heading = sectionMap[bestSection];
    const start   = fullContext.indexOf(`## ${heading}`);
    if (start !== -1) {
      const end = fullContext.indexOf("\n## ", start + 1);
      const section = fullContext.slice(start, end === -1 ? undefined : end);
      // Return the specific section + project overview
      const overview = fullContext.slice(0, 200);
      return `${overview}\n\n${section}`.slice(0, MAX_CONTEXT_CHARS);
    }
  }

  // Default: trim full context to budget
  return fullContext.slice(0, MAX_CONTEXT_CHARS);
}

// ── Create session ────────────────────────────────────────────
export function createChatSession({ jobId, output, meta }) {
  const docsContext = buildDocsContext(output, meta);
  sessions.set(jobId, { docsContext, history: [], meta });
  return jobId;
}

// ── Send message ──────────────────────────────────────────────
export async function chat({ jobId, message }) {
  const session = sessions.get(jobId);
  if (!session) throw new Error("Chat session not found. Generate docs first.");

  const { docsContext, history, meta } = session;
  const relevantContext = selectRelevantContext(message, docsContext);

  const SYSTEM_PROMPT = `You are an expert developer assistant with deep knowledge of this specific codebase.
You have been given the project documentation below as your knowledge base.
Answer questions accurately based on the documentation. If something is not covered in the docs, say so clearly.
Be concise but complete. Format code examples with backticks.

=== CODEBASE DOCUMENTATION ===
${relevantContext}
=== END DOCUMENTATION ===`;

  // Build messages array: system + trimmed history + new message
  const trimmedHistory = history.slice(-MAX_HISTORY_TURNS);
  const messages = [
    { role: "system",  content: SYSTEM_PROMPT },
    ...trimmedHistory,
    { role: "user",    content: message },
  ];

  // Direct API call to preserve conversation format
  const { client, MODEL } = await import("../config/llm.js");
  const response = await client.chat.completions.create({
    model      : MODEL,
    messages,
    temperature: 0.1,
  });
  const reply = response.choices[0].message.content.trim();

  // Update history (ring buffer)
  history.push({ role: "user",      content: message });
  history.push({ role: "assistant", content: reply   });
  if (history.length > MAX_HISTORY_TURNS * 2) {
    history.splice(0, 2); // drop oldest turn
  }

  return {
    reply,
    sessionId    : jobId,
    contextUsed  : relevantContext.slice(0, 100) + "…",
    historyLength: history.length / 2,
  };
}

// ── Suggested starter questions ───────────────────────────────
export function getSuggestedQuestions(output) {
  const questions = [
    "How does authentication work in this project?",
    "What is the overall architecture of this application?",
    "Which endpoints require authentication?",
    "What are the main data models and how are they related?",
    "How do I set up and run this project locally?",
    "What are the most critical security issues found?",
    "What tech stack does this project use?",
    "How is error handling implemented?",
  ];
  // Filter based on what was actually found
  return questions.filter((q) => {
    if (q.includes("security") && !output.securityReport) return false;
    if (q.includes("endpoint") && !output.apiReference?.includes("GET")) return false;
    return true;
  }).slice(0, 5);
}
