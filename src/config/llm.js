// src/config/llm.js
// Central LLM client — Groq via OpenAI-compatible SDK
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

// Core LLM call — all agents funnel through here
export async function llmCall({ systemPrompt, userContent, temperature = 0 }) {
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature,
  });
  return response.choices[0].message.content.trim();
}
