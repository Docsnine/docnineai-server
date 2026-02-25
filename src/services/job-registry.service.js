// src/services/jobRegistry.js
// ─────────────────────────────────────────────────────────────
// Shared in-memory job store — single source of truth for
// pipeline job state and active SSE client connections.
//
// Both the legacy /api/document route (index.js) and the new
// project service import from here. This is the ONLY file that
// needs to change if you later switch to Redis pub/sub.
// ─────────────────────────────────────────────────────────────

/**
 * jobs Map — jobId → { status, events[], result }
 * status: "running" | "done" | "error"
 */
export const jobs = new Map();

/**
 * streams Map — jobId → Set<express.Response>
 * Each value is a Set of active SSE response objects for that job.
 */
export const streams = new Map();

/**
 * Register a new job and initialise its streams slot.
 * @param {string} jobId
 */
export function registerJob(jobId) {
  jobs.set(jobId, { status: "running", events: [], result: null });
  streams.set(jobId, new Set());
}

/**
 * Broadcast a progress event to all SSE clients watching this job
 * AND append it to the event buffer (for late-connecting clients).
 * @param {string} jobId
 * @param {object} event  — { step, status, msg, detail, ts }
 */
export function pushEvent(jobId, event) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.events.push(event);

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of streams.get(jobId) || new Set()) {
    try {
      client.write(payload);
    } catch {
      /* client disconnected */
    }
  }
}

/**
 * Mark a job as complete, broadcast the done event, close all SSE clients.
 * @param {string} jobId
 * @param {object} result — full orchestrate() result
 */
export function finishJob(jobId, result) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = result.success ? "done" : "error";
    job.result = result;
  }

  const payload = `data: ${JSON.stringify({ step: "done", result })}\n\n`;
  for (const client of streams.get(jobId) || new Set()) {
    try {
      client.write(payload);
      client.end();
    } catch {}
  }
  streams.delete(jobId);
}

/**
 * Mark a job as errored from an uncaught exception.
 * @param {string} jobId
 * @param {Error}  err
 */
export function failJob(jobId, err) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = "error";
    job.result = { success: false, error: err.message };
  }

  const payload = `data: ${JSON.stringify({ step: "error", status: "error", msg: err.message })}\n\n`;
  for (const client of streams.get(jobId) || new Set()) {
    try {
      client.write(payload);
      client.end();
    } catch {}
  }
  streams.delete(jobId);
}
