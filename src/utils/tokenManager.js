// src/utils/tokenManager.js
// ─────────────────────────────────────────────────────────────
// Token & Context Management Strategy
//   • Chunk size : 300–500 tokens per LLM request
//   • Batching   : process BATCH_SIZE chunks per request
//   • Files are filtered and sorted by relevance before chunking
// ─────────────────────────────────────────────────────────────

const CHUNK_SIZE  = parseInt(process.env.CHUNK_SIZE  || "400");
const BATCH_SIZE  = parseInt(process.env.BATCH_SIZE  || "5");

// Rough token estimator (1 token ≈ 4 chars for English/code)
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Split text into token-aware chunks
export function chunkText(text, maxTokens = CHUNK_SIZE) {
  const lines   = text.split("\n");
  const chunks  = [];
  let current   = [];
  let tokenCount = 0;

  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (tokenCount + lineTokens > maxTokens && current.length > 0) {
      chunks.push(current.join("\n"));
      current    = [line];
      tokenCount = lineTokens;
    } else {
      current.push(line);
      tokenCount += lineTokens;
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

// Group chunks into batches for LLM calls
export function batchChunks(chunks, batchSize = BATCH_SIZE) {
  const batches = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    batches.push(chunks.slice(i, i + batchSize));
  }
  return batches;
}

// Build numbered batch content string
export function formatBatch(chunks) {
  return chunks
    .map((c, i) => `[CHUNK ${i + 1}]\n${c}`)
    .join("\n\n---\n\n");
}

// File relevance scoring — prioritise important files
const HIGH_PRIORITY = [
  /package\.json$/,    /requirements\.txt$/, /Cargo\.toml$/,
  /go\.mod$/,          /pom\.xml$/,          /README/i,
  /\.env\.example$/,   /docker-compose/i,    /Dockerfile$/i,
];
const LOW_PRIORITY  = [
  /node_modules/, /\.lock$/, /dist\//, /build\//, /coverage\//,
  /\.min\.(js|css)$/, /\.(png|jpg|gif|svg|ico|woff|ttf|eot)$/,
];

export function scoreFile(filePath) {
  if (LOW_PRIORITY.some((r) => r.test(filePath)))  return -1;
  if (HIGH_PRIORITY.some((r) => r.test(filePath))) return 2;
  return 1;
}

export function sortAndFilterFiles(files) {
  return files
    .filter((f) => scoreFile(f.path) >= 0)
    .sort((a, b) => scoreFile(b.path) - scoreFile(a.path));
}
