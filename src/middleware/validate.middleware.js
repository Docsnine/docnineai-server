// ===================================================================
// Thin validation layer using express-validator.
// Returns a consistent 422 response with field-level error detail.
//
// Usage:
//   import { validate, rules } from "../middleware/validate.middleware.js";
//   router.post("/signup", rules.signup, validate, controller.signup);
//
// IMPORTANT — PATCH route composition rule:
//   rules.updateProject validates the REQUEST BODY only.
//   The :id param is validated separately by the validateMongoId array
//   defined in project.routes.js.
//   Never include a param("id") rule inside a rules.* body rule set —
//   it will conflict with the id validation done at the router level.
// ===================================================================

import { body, query, param, validationResult } from "express-validator";

/**
 * Run after rule chains — short-circuits with 422 if any rule failed.
 * Place this as the last item before the controller in a middleware array.
 */
export function validate(req, res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();

  const fields = errors.array().map((e) => ({
    field: e.path,
    message: e.msg,
  }));

  return res.status(422).json({
    success: false,
    error: {
      code: "VALIDATION_ERROR",
      message: "Request validation failed.",
      fields,
    },
  });
}

// ── Reusable field builders ───────────────────────────────────

const nameField = () =>
  body("name")
    .trim()
    .notEmpty()
    .withMessage("Name is required")
    .isLength({ max: 80 })
    .withMessage("Name must be 80 characters or fewer");

const emailField = () =>
  body("email")
    .trim()
    .notEmpty()
    .withMessage("Email is required")
    .isEmail()
    .withMessage("Email is not valid")
    .normalizeEmail();

const passwordField = (field = "password") =>
  body(field)
    .notEmpty()
    .withMessage("Password is required")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters");

const repoUrlField = () =>
  body("repoUrl")
    .trim()
    .notEmpty()
    .withMessage("repoUrl is required")
    .contains("github.com")
    .withMessage("repoUrl must be a GitHub repository URL");

// ── Rule sets — one per endpoint ──────────────────────────────
export const rules = {
  /** POST /auth/signup */
  signup: [nameField(), emailField(), passwordField()],

  /** POST /auth/login */
  login: [
    emailField(),
    body("password").notEmpty().withMessage("Password is required"),
  ],

  /** POST /auth/forgot-password */
  forgotPassword: [emailField()],

  /** POST /auth/reset-password */
  resetPassword: [
    body("token").notEmpty().withMessage("Reset token is required"),
    passwordField("password"),
    body("confirmPassword")
      .notEmpty()
      .withMessage("Confirm password is required")
      .custom((val, { req }) => val === req.body.password)
      .withMessage("Passwords do not match"),
  ],

  /** POST /auth/verify-email */
  verifyEmail: [
    body("token").notEmpty().withMessage("Verification token is required"),
  ],

  /** POST /projects */
  createProject: [repoUrlField()],

  /** GET /projects — query params */
  listProjects: [
    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("page must be a positive integer"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("limit must be between 1 and 100"),
    query("status")
      .optional()
      .isIn(["queued", "running", "done", "error", "archived"])
      .withMessage("Invalid status filter"),
    query("sort")
      .optional()
      .isIn([
        "createdAt",
        "-createdAt",
        "updatedAt",
        "-updatedAt",
        "repoName",
        "-repoName",
      ])
      .withMessage(
        "Invalid sort field — valid values: createdAt, -createdAt, updatedAt, -updatedAt, repoName, -repoName",
      ),
    query("search").optional().isString().trim(),
  ],

  /**
   * PATCH /projects/:id — REQUEST BODY ONLY.
   * The :id param is validated at the router level by validateMongoId.
   * Do NOT add a param("id") rule here.
   */
  updateProject: [
    body("status")
      .optional()
      .isIn(["archived"])
      .withMessage("Only 'archived' status can be set via PATCH"),
  ],
};
