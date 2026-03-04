// ===================================================================
// Admin controller — super-admin only endpoints.
// All routes protected by protect + requireRole('super-admin').
// ===================================================================

import { User } from "../../models/User.js";
import { Project } from "../../models/Project.js";
import { Subscription } from "../../models/Subscription.js";
import { ok, fail, serverError } from "../../utils/response.util.js";

// Plan pricing (monthly equivalent) for MRR estimation
const PLAN_PRICE_MONTHLY = { free: 0, starter: 15, pro: 49, team: 99 };

// ── GET /admin/stats ──────────────────────────────────────────
export async function getStats(req, res) {
  try {
    const [
      totalUsers,
      totalProjects,
      usersByPlan,
      recentUsers,
      recentProjects,
    ] = await Promise.all([
      User.countDocuments(),
      Project.countDocuments(),
      Subscription.aggregate([
        {
          $group: {
            _id: "$plan",
            count: { $sum: 1 },
          },
        },
      ]),
      User.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      }),
      Project.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      }),
    ]);

    // Build plan breakdown map
    const planBreakdown = { free: 0, starter: 0, pro: 0, team: 0 };
    for (const { _id, count } of usersByPlan) {
      if (_id in planBreakdown) planBreakdown[_id] = count;
    }

    // Estimate MRR: count active/trialing paid subscriptions * monthly price
    const paidSubs = await Subscription.find({
      plan: { $in: ["starter", "pro", "team"] },
      status: { $in: ["active", "trialing"] },
    }).select("plan billingCycle");

    let mrr = 0;
    for (const sub of paidSubs) {
      const monthly = PLAN_PRICE_MONTHLY[sub.plan] ?? 0;
      // Annual billing: price * 12 * 0.8 (20% discount assumed) / 12
      mrr += sub.billingCycle === "annual" ? monthly * 0.8 : monthly;
    }

    return ok(res, {
      totalUsers,
      totalProjects,
      newUsersLast30Days: recentUsers,
      newProjectsLast30Days: recentProjects,
      planBreakdown,
      estimatedMRR: Math.round(mrr),
      paidSubscriptions: paidSubs.length,
    });
  } catch (err) {
    return serverError(res, err, "admin.getStats");
  }
}

// ── GET /admin/users ──────────────────────────────────────────
// Query params: page (default 1), limit (default 20), search (name/email)
export async function listUsers(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const search = req.query.search?.trim();

    const filter = search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(filter),
    ]);

    // Attach subscription info
    const userIds = users.map((u) => u._id);
    const subs = await Subscription.find({ userId: { $in: userIds } })
      .select("userId plan status billingCycle")
      .lean();

    const subMap = Object.fromEntries(
      subs.map((s) => [s.userId.toString(), s]),
    );

    const enriched = users.map((u) => ({
      ...u,
      subscription: subMap[u._id.toString()] ?? {
        plan: "free",
        status: "free",
      },
    }));

    return ok(res, {
      users: enriched,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return serverError(res, err, "admin.listUsers");
  }
}

// ── DELETE /admin/users/:id ───────────────────────────────────
export async function deleteUser(req, res) {
  try {
    const { id } = req.params;

    // Super-admin cannot delete themselves
    if (id === req.user.userId) {
      return fail(
        res,
        "SELF_DELETE",
        "You cannot delete your own account.",
        400,
      );
    }

    const user = await User.findById(id);
    if (!user) return fail(res, "NOT_FOUND", "User not found.", 404);

    // Delete all user data in parallel
    await Promise.all([
      Project.deleteMany({ userId: id }),
      Subscription.deleteMany({ userId: id }),
      User.findByIdAndDelete(id),
    ]);

    return ok(res, null, "User and all associated data deleted.");
  } catch (err) {
    return serverError(res, err, "admin.deleteUser");
  }
}

// ── GET /admin/projects ───────────────────────────────────────
// Query params: page, limit, search (name), userId (filter by owner)
export async function listProjects(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const search = req.query.search?.trim();
    const userId = req.query.userId;

    const filter = {};
    if (userId) filter.userId = userId;
    if (search) filter.name = { $regex: search, $options: "i" };

    const [projects, total] = await Promise.all([
      Project.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("userId", "name email")
        .lean(),
      Project.countDocuments(filter),
    ]);

    return ok(res, {
      projects,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return serverError(res, err, "admin.listProjects");
  }
}

// ── DELETE /admin/projects/:id ────────────────────────────────
export async function deleteProject(req, res) {
  try {
    const { id } = req.params;
    const project = await Project.findByIdAndDelete(id);
    if (!project) return fail(res, "NOT_FOUND", "Project not found.", 404);
    return ok(res, null, "Project deleted.");
  } catch (err) {
    return serverError(res, err, "admin.deleteProject");
  }
}

// ── GET /admin/subscriptions ──────────────────────────────────
// Overview of all paid subscriptions
export async function listSubscriptions(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const plan = req.query.plan;
    const status = req.query.status;

    const filter = {};
    if (plan) filter.plan = plan;
    if (status) filter.status = status;

    const [subs, total] = await Promise.all([
      Subscription.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("userId", "name email")
        .lean(),
      Subscription.countDocuments(filter),
    ]);

    return ok(res, {
      subscriptions: subs,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return serverError(res, err, "admin.listSubscriptions");
  }
}
