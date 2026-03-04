// ===================================================================
// Plan gate middleware — enforces feature access based on subscription.
//
// Usage in routes:
//   router.post('/projects', gate.requirePlan('starter'), ...)
//   router.post('/projects', gate.checkProjectLimit, ...)
//   router.post('/export/pdf', gate.requireFeature('exportFormats', 'pdf'), ...)
//
// Behaviour:
//   • Fetches the user's subscription on each gated request.
//   • Caches subscription in req.subscription to avoid repeated DB calls.
//   • Returns 403 PLAN_GATE with which plan unlocks the feature.
// ===================================================================

import { Subscription } from "../models/Subscription.js";
import { PlanUsage } from "../models/PlanUsage.js";
import { getPlan, PLAN_LEVEL, PLANS } from "../config/plans.js";
import { fail } from "../utils/response.util.js";
import { Project } from "../models/Project.js";
import { Portal } from "../models/Portal.js";

// ── Internal: load subscription (cached per request) ─────────────

async function loadSubscription(req) {
  if (req.subscription) return req.subscription;
  const sub = await Subscription.findOne({ userId: req.user.userId }).lean();
  if (!sub) {
    // Default to free if no record yet
    req.subscription = { plan: "free", status: "free", seats: 1 };
    return req.subscription;
  }
  req.subscription = sub;
  return sub;
}

function effectivePlan(sub) {
  // Paused subscriptions have read-only access (treat as free for creating)
  if (sub.status === "paused") return "free";
  // During active trial, plan is the trialing plan
  if (sub.status === "trialing" || sub.status === "active") return sub.plan;
  // past_due — retain access during grace period
  if (sub.status === "past_due") return sub.plan;
  return "free";
}

// ── Middleware factories ───────────────────────────────────────────

/**
 * Require a minimum plan to access the route.
 * @param {'starter'|'pro'|'team'} minPlan
 */
export function requirePlan(minPlan) {
  return async (req, res, next) => {
    try {
      const sub = await loadSubscription(req);
      const plan = effectivePlan(sub);
      if (PLAN_LEVEL[plan] >= PLAN_LEVEL[minPlan]) return next();
      return fail(
        res,
        "PLAN_GATE",
        `This feature requires the ${getPlan(minPlan).name} plan or higher.`,
        403,
        { requiredPlan: minPlan },
      );
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Gate based on a boolean feature flag in plan.features.
 * @param {string} featureKey  - key in plan.features
 */
export function requireFeature(featureKey) {
  return async (req, res, next) => {
    try {
      const sub = await loadSubscription(req);
      const plan = effectivePlan(sub);
      const planConfig = getPlan(plan);
      if (planConfig.features[featureKey]) return next();

      // Find the lowest plan that has this feature
      const requiredPlan = findMinPlanForFeature(featureKey);
      return fail(
        res,
        "PLAN_GATE",
        `This feature is not available on your current plan.`,
        403,
        { requiredPlan, featureKey },
      );
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Check project creation limit.
 * Attaches req.planAllowed = true if under limit.
 */
export async function checkProjectLimit(req, res, next) {
  try {
    const sub = await loadSubscription(req);
    const plan = effectivePlan(sub);
    const planConfig = getPlan(plan);
    const maxProjects = planConfig.limits.projects;

    if (maxProjects === null) return next(); // unlimited

    // Count real (non-archived) projects owned by this user — avoids stale cache issues
    const projectCount = await Project.countDocuments({
      userId: req.user.userId,
      status: { $ne: "archived" },
    });

    if (projectCount < maxProjects) return next();

    return fail(
      res,
      "PROJECT_LIMIT_REACHED",
      `You've reached the ${maxProjects}-project limit on the ${planConfig.name} plan.`,
      403,
      { requiredPlan: "starter", limit: maxProjects },
    );
  } catch (err) {
    next(err);
  }
}

/**
 * Check portal publish limit.
 * Free plan = 0 portals (cannot publish).
 * Starter = 1 published portal at a time.
 * Pro/Team = unlimited.
 *
 * Unpublishing is always allowed regardless of plan.
 */
export async function checkPortalPublishLimit(req, res, next) {
  try {
    const sub = await loadSubscription(req);
    const plan = effectivePlan(sub);
    const planConfig = getPlan(plan);
    const maxPortals = planConfig.limits.portals;

    if (maxPortals === null) return next(); // unlimited

    // If the portal is already published the user wants to unpublish → always allow
    const currentPortal = await Portal.findOne({ projectId: req.params.id })
      .select("isPublished")
      .lean();
    if (currentPortal?.isPublished) return next();

    // User wants to publish — enforce limit
    if (maxPortals === 0) {
      return fail(
        res,
        "PLAN_GATE",
        `Publishing portals requires the Starter plan or higher.`,
        403,
        { requiredPlan: "starter" },
      );
    }

    // Count published portals across all projects owned by this user
    const userProjectIds = await Project.find({ userId: req.user.userId })
      .select("_id")
      .lean();
    const projectIds = userProjectIds.map((p) => p._id);
    const publishedCount = await Portal.countDocuments({
      projectId: { $in: projectIds },
      isPublished: true,
    });

    if (publishedCount < maxPortals) return next();

    return fail(
      res,
      "PLAN_GATE",
      `You've reached the ${maxPortals}-portal limit on the ${planConfig.name} plan.`,
      403,
      { requiredPlan: "pro", limit: maxPortals },
    );
  } catch (err) {
    next(err);
  }
}

/**
 * Check file upload size limit.
 * @param {number} fileSizeBytes
 */
export function checkFileSizeLimit(fileSizeBytes) {
  return async (req, res, next) => {
    try {
      const sub = await loadSubscription(req);
      const plan = effectivePlan(sub);
      const maxMb = getPlan(plan).limits.maxFileSizeMb;
      const maxBytes = maxMb * 1024 * 1024;

      const size =
        fileSizeBytes || req.headers["content-length"] || req.file?.size || 0;

      if (size <= maxBytes) return next();

      return fail(
        res,
        "FILE_TOO_LARGE",
        `Files are limited to ${maxMb}MB on your current plan.`,
        413,
        { maxMb },
      );
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Gate the OpenAPI / Swagger importer to Pro+.
 */
export const requireApiImporter = requireFeature("openApiImporter");

/**
 * Gate GitHub sync to Pro+.
 */
export const requireGithubSync = requireFeature("githubSync");

/**
 * Gate custom domain to Pro+.
 */
export const requireCustomDomain = requireFeature("customDomain");

/**
 * Gate export format.
 * @param {'pdf'|'google_docs'|'notion'} format
 */
export function requireExportFormat(format) {
  return async (req, res, next) => {
    try {
      const sub = await loadSubscription(req);
      const plan = effectivePlan(sub);
      const formats = getPlan(plan).limits.exportFormats;
      if (formats.includes(format)) return next();

      const requiredPlan = findMinPlanForExport(format);
      return fail(
        res,
        "PLAN_GATE",
        `${format.toUpperCase()} export requires ${getPlan(requiredPlan).name} plan or higher.`,
        403,
        { requiredPlan, format },
      );
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Gate AI chat — check per-month quota.
 */
export async function checkAiChatLimit(req, res, next) {
  try {
    const sub = await loadSubscription(req);
    const plan = effectivePlan(sub);
    const planConfig = getPlan(plan);
    const limit = planConfig.limits.aiChatsPerMonth;

    if (limit === null) return next(); // unlimited
    if (limit === 0) {
      return fail(
        res,
        "PLAN_GATE",
        "Chat with codebase is not available on your current plan.",
        403,
        { requiredPlan: "pro" },
      );
    }

    const usage = await PlanUsage.findOne({ userId: req.user.userId });
    const used = usage?.aiChatsUsed ?? 0;

    if (used < limit) {
      // Increment will happen in the chat handler after successful response
      req.aiChatAllowed = true;
      return next();
    }

    return fail(
      res,
      "AI_CHAT_LIMIT_REACHED",
      `You've used all ${limit} AI chats for this month.`,
      403,
      { used, limit, resetAt: usage?.aiChatsResetAt },
    );
  } catch (err) {
    next(err);
  }
}

/**
 * Gate portal creation — check portal limit.
 */
export async function checkPortalLimit(req, res, next) {
  try {
    const sub = await loadSubscription(req);
    const plan = effectivePlan(sub);
    const planConfig = getPlan(plan);
    const limit = planConfig.limits.portals;

    if (limit === null) return next(); // unlimited
    if (limit === 0) {
      return fail(
        res,
        "PLAN_GATE",
        "Public documentation portals are not available on your current plan.",
        403,
        { requiredPlan: "starter" },
      );
    }

    const usage = await PlanUsage.findOne({ userId: req.user.userId });
    const count = usage?.portalCount ?? 0;

    if (count < limit) return next();

    return fail(
      res,
      "PORTAL_LIMIT_REACHED",
      `You've reached the ${limit} portal limit on your current plan.`,
      403,
      { requiredPlan: "pro", limit },
    );
  } catch (err) {
    next(err);
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function findMinPlanForFeature(featureKey) {
  for (const planId of ["free", "starter", "pro", "team"]) {
    if (PLANS[planId].features[featureKey]) return planId;
  }
  return "team";
}

function findMinPlanForExport(format) {
  for (const planId of ["free", "starter", "pro", "team"]) {
    if (PLANS[planId].limits.exportFormats.includes(format)) return planId;
  }
  return "team";
}
