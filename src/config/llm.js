// ─────────────────────────────────────────────────────────────
// Global LLM Rate-Limited Queue
// ─────────────────────────────────────────────────────────────
// Problem: 4 agents running in parallel all share one 6,000 TPM
// bucket. They fire independently → instant rate limit storm.
//
// Solution: ALL agents submit to a single global queue.
//   • Queue drains one call at a time
//   • Tracks tokens used in the last 60s (sliding window)
//   • If next call would exceed TPM_LIMIT → wait until window clears
//   • Each call estimates its own token cost upfront
//   • Result: smooth, predictable throughput, zero retry storms
// ─────────────────────────────────────────────────────────────

import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is required in .env");
}

export const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

export const MODEL = "llama-3.1-8b-instant";

// ── Rate limit config ─────────────────────────────────────────
const TPM_LIMIT = 5000; // stay under 6000 — leave 1000 buffer
const TPM_WINDOW_MS = 62000; // 62s window (slightly over 60s for safety)
const MAX_TOKENS_PER_CALL = 1800; // input + output budget per call

// ── Sliding window token tracker ─────────────────────────────
// Each entry: { tokens, ts }
const tokenLog = [];

function tokensUsedInWindow() {
  const now = Date.now();
  const cutoff = now - TPM_WINDOW_MS;
  // Evict old entries
  while (tokenLog.length && tokenLog[0].ts < cutoff) tokenLog.shift();
  return tokenLog.reduce((sum, e) => sum + e.tokens, 0);
}

function recordTokens(tokens) {
  tokenLog.push({ tokens, ts: Date.now() });
}

function msUntilCapacity(needed) {
  // How long until oldest entries roll out of window to free up space?
  let freed = 0;
  const now = Date.now();
  const cutoff = now - TPM_WINDOW_MS;

  for (const entry of tokenLog) {
    if (entry.ts < cutoff) continue; // already expired
    freed += entry.tokens;
    const expiresAt = entry.ts + TPM_WINDOW_MS;
    if (tokensUsedInWindow() - freed + needed <= TPM_LIMIT) {
      return Math.max(0, expiresAt - now + 200); // +200ms buffer
    }
  }
  return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Estimate tokens for a call ────────────────────────────────
function estimateTokens(systemPrompt, userContent) {
  return Math.ceil((systemPrompt.length + userContent.length) / 3.5);
}

// ── Global sequential queue ───────────────────────────────────
// Prevents concurrent calls from racing to the same token bucket
let queuePromise = Promise.resolve();

export async function llmCall({ systemPrompt, userContent, temperature = 0 }) {
  // Chain onto the global queue — each call waits for the previous to finish
  const result = new Promise((resolve, reject) => {
    queuePromise = queuePromise.then(() =>
      executeCall({ systemPrompt, userContent, temperature })
        .then(resolve)
        .catch(reject),
    );
  });
  return result;
}

async function executeCall({ systemPrompt, userContent, temperature }) {
  const estimatedInput = estimateTokens(systemPrompt, userContent);
  const estimatedTotal = estimatedInput + 512; // assume ~512 output tokens

  if (estimatedInput > 4000) {
    console.warn(
      `   ⚠️  Request ~${estimatedInput} tokens — trimming recommended`,
    );
  }

  // Wait if adding this call would exceed TPM window
  let waited = false;
  while (tokensUsedInWindow() + estimatedTotal > TPM_LIMIT) {
    const waitMs = msUntilCapacity(estimatedTotal) || 5000;
    if (!waited) {
      console.log(
        `   🪣 Token bucket full (~${tokensUsedInWindow()}/${TPM_LIMIT} TPM used). Waiting ${(waitMs / 1000).toFixed(1)}s…`,
      );
      waited = true;
    }
    await sleep(waitMs);
  }

  // Make the call
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature,
    max_tokens: 1536, // hard cap on output tokens
  });

  // Record actual tokens used (from response header if available)
  const actualTokens = response.usage?.total_tokens || estimatedTotal;
  recordTokens(actualTokens);

  const remaining = TPM_LIMIT - tokensUsedInWindow();
  console.log(
    `   ✓ LLM call done (${actualTokens} tokens | ${remaining} remaining in window)`,
  );

  return response.choices[0].message.content.trim();
}
