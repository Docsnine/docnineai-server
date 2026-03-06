// ===================================================================
// Plans — single source of truth for every pricing tier.
//
// NEVER store pricing logic in the database. The DB stores which plan
// a subscription is on (id string). This file owns all rules.
//
// Prices are in USD cents (amounts) so proration math stays integer-safe.
// For display, divide by 100.
//
// Tier hierarchy (for gate comparisons):
//   free < starter < pro < team
// ===================================================================

/**
 * @typedef {Object} PlanLimits
 * @property {number|null} projects         - max projects (null = unlimited)
 * @property {number|null} seats            - max seats (null = unlimited)
 * @property {number|null} extraSeatPriceMonthly - cents per extra seat/mo (null = N/A)
 * @property {number|null} attachmentsPerProject - null = unlimited
 * @property {number}      maxFileSizeMb    - max upload per file
 * @property {number|null} aiChatsPerMonth  - null = unlimited, 0 = none
 * @property {number|null} portals          - public doc portals (null = unlimited)
 * @property {number|null} versionHistoryDays - null = full history, 0 = none
 * @property {string[]}    exportFormats    - e.g. ['pdf', 'google_docs', 'notion']
 */

/**
 * @typedef {Object} PlanFeatures
 * @property {boolean} shareViewOnly  - project sharing (view-only)
 * @property {boolean} shareEdit      - project sharing with edit role
 * @property {number}  maxShares      - max active share links (0 = none)
 * @property {boolean} archiveRestore
 * @property {boolean} customDomain
 * @property {boolean} docApproval
 * @property {boolean} progressTracker
 * @property {boolean} openApiImporter
 * @property {boolean} apiWebhookAccess
 * @property {boolean} githubSync
 */

export const PLAN_IDS = ["free", "starter", "pro", "team"];

// Hierarchy level — higher = more powerful
export const PLAN_LEVEL = { free: 0, starter: 1, pro: 2, team: 3 };

export const PLANS = {
  // ── Free ──────────────────────────────────────────────────────
  free: {
    id: "free",
    name: "Free",
    tagline: "Solo devs exploring the platform",
    prices: {
      monthly: 0, // cents
      annual: 0, // cents (per month, billed annually)
      annualTotal: 0,
    },
    limits: {
      projects: 2,
      seats: 1,
      extraSeatPriceMonthly: null,
      attachmentsPerProject: 3,
      maxFileSizeMb: 5,
      aiChatsPerMonth: 0,
      portals: 0,
      versionHistoryDays: 0,
      exportFormats: [],
    },
    features: {
      shareViewOnly: false,
      shareEdit: false,
      maxShares: 0,
      archiveRestore: false,
      customDomain: false,
      docApproval: false,
      progressTracker: false,
      openApiImporter: false,
      apiWebhookAccess: false,
      githubSync: false,
    },
  },

  // ── Starter ───────────────────────────────────────────────────
  starter: {
    id: "starter",
    name: "Starter",
    tagline: "Freelancers & solo developers",
    prices: {
      monthly: 1500, // $15.00
      annual: 1200, // $12.00/mo (billed $144/yr)
      annualTotal: 14400,
    },
    limits: {
      projects: null, // unlimited
      seats: 1,
      extraSeatPriceMonthly: null,
      attachmentsPerProject: null, // unlimited
      maxFileSizeMb: 20,
      aiChatsPerMonth: 0,
      portals: 1,
      versionHistoryDays: 30,
      exportFormats: ["pdf"],
    },
    features: {
      shareViewOnly: true,
      shareEdit: false,
      maxShares: 5,
      archiveRestore: true,
      customDomain: false,
      docApproval: false,
      progressTracker: true,
      openApiImporter: false,
      apiWebhookAccess: false,
      githubSync: false,
    },
  },

  // ── Pro ───────────────────────────────────────────────────────
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "Small teams up to 5 seats",
    prices: {
      monthly: 3800, // $38.00
      annual: 2900, // $29.00/mo (billed $348/yr)
      annualTotal: 34800,
    },
    limits: {
      projects: null,
      seats: 5,
      extraSeatPriceMonthly: 700, // $7.00 per extra seat
      attachmentsPerProject: null,
      maxFileSizeMb: 50,
      aiChatsPerMonth: 50,
      portals: null, // unlimited
      versionHistoryDays: null, // full
      exportFormats: ["pdf", "google_docs"],
    },
    features: {
      shareViewOnly: true,
      shareEdit: true,
      maxShares: null, // unlimited
      archiveRestore: true,
      customDomain: true,
      docApproval: true,
      progressTracker: true,
      openApiImporter: true,
      apiWebhookAccess: true,
      githubSync: true,
    },
  },

  // ── Team ──────────────────────────────────────────────────────
  team: {
    id: "team",
    name: "Team",
    tagline: "Mid-size companies (6+ users)",
    prices: {
      monthly: 2400, // $24.00/user/mo
      annual: 1900, // $19.00/user/mo (billed annually)
      annualTotal: null, // computed: 1900 * 12 * seats
    },
    limits: {
      projects: null,
      seats: null, // unlimited
      extraSeatPriceMonthly: 2400, // each extra seat = $24/mo (monthly plan)
      attachmentsPerProject: null,
      maxFileSizeMb: 100,
      aiChatsPerMonth: null, // unlimited
      portals: null,
      versionHistoryDays: null,
      exportFormats: ["pdf", "google_docs", "notion"],
    },
    features: {
      shareViewOnly: true,
      shareEdit: true,
      maxShares: null,
      archiveRestore: true,
      customDomain: true,
      docApproval: true,
      progressTracker: true,
      openApiImporter: true,
      apiWebhookAccess: true,
      githubSync: true,
    },
  },
};

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Compute the monthly price (cents) for a given plan, cycle, and seat count.
 * @param {string}  planId
 * @param {'monthly'|'annual'} cycle
 * @param {number}  seats   - only meaningful for 'team' plan
 */
export function computeMonthlyPrice(planId, cycle, seats = 1) {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  const perUnit = plan.prices[cycle];
  if (planId === "team") return perUnit * seats;
  return perUnit;
}

/**
 * Compute the amount to charge NOW for an annual subscription.
 * @param {string} planId
 * @param {number} seats   - for team plan
 */
export function computeAnnualTotal(planId, seats = 1) {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  if (planId === "team") return plan.prices.annual * 12 * seats;
  return plan.prices.annualTotal;
}

/**
 * Get the plan config object. Throws if not found.
 */
export function getPlan(planId) {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Unknown plan: "${planId}"`);
  return plan;
}

/**
 * Return true if targetPlan is higher than currentPlan.
 */
export function isUpgrade(currentPlanId, targetPlanId) {
  return (PLAN_LEVEL[targetPlanId] ?? 0) > (PLAN_LEVEL[currentPlanId] ?? 0);
}

/**
 * Return true if targetPlan is lower than currentPlan.
 */
export function isDowngrade(currentPlanId, targetPlanId) {
  return (PLAN_LEVEL[targetPlanId] ?? 0) < (PLAN_LEVEL[currentPlanId] ?? 0);
}

export const TRIAL_DAYS = 14;
export const DUNNING_MAX_DAYS = 14;
export const DUNNING_RETRY_DAYS = [0, 3, 7]; // retry on day 0, 3, 7
export const DUNNING_EMAIL_DAYS = [1, 5, 10]; // email on day 1, 5, 10
