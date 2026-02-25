// src/config/llm.js
// Central LLM client — Groq via OpenAI-compatible SDK
// ─────────────────────────────────────────────────────────────
// Rate limit strategy (free tier = 6,000 TPM, 14,400 RPM):
//   • On 429/413: read Retry-After header, wait, then retry
//   • Max 3 retries with exponential backoff fallback
//   • Logs wait time so you know exactly what's happening
// ─────────────────────────────────────────────────────────────

import OpenAI from "openai";
import dotenv  from "dotenv";

dotenv.config();

if (!process.env.GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is required in .env");
}

export const client = new OpenAI({
  apiKey  : process.env.GROQ_API_KEY,
  baseURL : "https://api.groq.com/openai/v1",
});

export const MODEL = "llama-3.1-8b-instant";

const MAX_RETRIES = 3;
const BASE_WAIT_MS = 5000; // fallback if no Retry-After header

// Sleep helper
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Core LLM call — all agents funnel through here
// Auto-retries on 429 (rate limit) and 413 (too large → shouldn't happen after our fix)
export async function llmCall({ systemPrompt, userContent, temperature = 0 }) {
  // Pre-flight token estimate — warn if approaching limit
  const estimatedTokens = Math.ceil((systemPrompt.length + userContent.length) / 4);
  if (estimatedTokens > 4000) {
    console.warn(`   ⚠️  Large request: ~${estimatedTokens} tokens. May hit rate limits.`);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model      : MODEL,
        messages   : [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userContent  },
        ],
        temperature,
        max_tokens: 2048, // cap output tokens — prevents runaway responses
      });
      
      return response.choices[0].message.content.trim();

    } catch (err) {
      const status      = err.status || err.response?.status;
      const isRateLimit = status === 429 || status === 413 ||
                          err.code === "rate_limit_exceeded";

      if (isRateLimit && attempt < MAX_RETRIES) {
        // Read Retry-After from headers (Groq sets this accurately)
        const retryAfter = parseInt(
          err.headers?.["retry-after"] ||
          err.response?.headers?.["retry-after"] || "0"
        , 10);

        const waitMs = retryAfter > 0
          ? (retryAfter * 1000) + 500        // use server hint + 500ms buffer
          : BASE_WAIT_MS * attempt;           // exponential fallback

        console.log(`   ⏳ Rate limited (attempt ${attempt}/${MAX_RETRIES}). Waiting ${(waitMs/1000).toFixed(1)}s…`);
        await sleep(waitMs);
        continue;
      }

      // Not a rate limit error, or out of retries — rethrow
      throw err;
    }
  }
}