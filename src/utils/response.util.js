// ===================================================================
// Single source of truth for every HTTP response in the API.
//
// Success:  { success: true,  data: {...}, message: "..." }
// Error:    { success: false, error: { code, message } }
//
// Usage:
//   ok(res, data, "Created", 201)
//   fail(res, "EMAIL_TAKEN", "Email is already registered", 409)
//   serverError(res, err)          ← catches + logs unexpected throws
// ===================================================================

/**
 * 2xx success
 * @param {import('express').Response} res
 * @param {*}      data     - payload; omit for 204
 * @param {string} message  - human-readable summary
 * @param {number} status   - HTTP status (default 200)
 */
export function ok(res, data = null, message = "OK", status = 200) {
  const body = { success: true };
  if (message) body.message = message;
  if (data !== null) body.data = data;
  return res.status(status).json(body);
}

/**
 * 4xx client error
 * @param {import('express').Response} res
 * @param {string} code     - machine-readable error code (SCREAMING_SNAKE)
 * @param {string} message  - human-readable explanation
 * @param {number} status   - HTTP status (default 400)
 */
export function fail(res, code, message, status = 400) {
  return res.status(status).json({
    success: false,
    error: { code, message },
  });
}

/**
 * 5xx — logs the error, returns a sanitised message (never leaks stack)
 * @param {import('express').Response} res
 * @param {Error}  err
 * @param {string} context  - shown in server log, not in response
 */
export function serverError(res, err, context = "") {
  const label = context ? `[${context}] ` : "";
  console.error(`❌ ${label}${err.stack || err.message}`);
  return res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
  });
}

/**
 * Async route wrapper — eliminates try/catch boilerplate in controllers.
 * Usage:  router.post("/signup", wrap(authController.signup))
 */
export function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
