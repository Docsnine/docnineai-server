// ===================================================================
// Billing controller — handles all billing-related HTTP requests.
//
// Every handler returns using ok() / fail() / serverError() for
// consistency with the rest of the API.
// ===================================================================

import { ok, fail, serverError } from "../../utils/response.util.js";
import { PLANS, getPlan } from "../../config/plans.js";
import {
  getOrCreateSubscription,
  initiateCheckout,
  changePlan,
  cancelSubscription,
  pauseSubscription,
  addSeats,
  getBillingHistory,
  generateInvoicePdf,
} from "../../services/billing.service.js";
import { Subscription } from "../../models/Subscription.js";
import { Project } from "../../models/Project.js";
import { PaymentMethod } from "../../models/PaymentMethod.js";
import { PlanUsage } from "../../models/PlanUsage.js";
import { Invoice } from "../../models/Invoice.js";
import {
  verifyTransaction,
  verifyByRef,
  buildPaymentMethodSnapshot,
  extractChargeToken,
} from "../../services/flutterwave.service.js";
import {
  upsertPaymentMethod,
  activateFromPayment,
} from "../../services/billing.service.js";

// ── GET /billing/plans ────────────────────────────────────────────
export async function getPlans(req, res) {
  try {
    // Sanitise: remove internal pricing details, expose only what the UI needs
    const plans = Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      tagline: p.tagline,
      prices: {
        monthly: p.prices.monthly / 100, // in dollars
        annual: p.prices.annual / 100,
        annualTotal: p.prices.annualTotal ? p.prices.annualTotal / 100 : null,
        savingsPercent:
          p.prices.monthly > 0
            ? Math.round((1 - p.prices.annual / p.prices.monthly) * 100)
            : 0,
      },
      limits: p.limits,
      features: p.features,
    }));
    return ok(res, { plans }, "Plans loaded");
  } catch (err) {
    return serverError(res, err, "getPlans");
  }
}

// ── GET /billing/subscription ─────────────────────────────────────
export async function getSubscription(req, res) {
  try {
    const sub = await getOrCreateSubscription(req.user.userId);
    const usage = await PlanUsage.findOne({ userId: req.user.userId }).lean();
    const plan = getPlan(sub.plan);

    return ok(res, {
      subscription: {
        plan: sub.plan,
        planName: plan.name,
        billingCycle: sub.billingCycle,
        status: sub.status,
        seats: sub.seats,
        extraSeats: sub.extraSeats,
        trialEndsAt: sub.trialEndsAt,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        pendingPlan: sub.pendingPlan,
        pauseEndsAt: sub.pauseEndsAt,
        limits: plan.limits,
        features: plan.features,
      },
      usage: {
        aiChatsUsed: usage?.aiChatsUsed ?? 0,
        aiChatsResetAt: usage?.aiChatsResetAt ?? null,
        // Count real (non-archived) projects for accuracy
        projectCount: await Project.countDocuments({ userId: sub.userId, status: { $ne: "archived" } }),
        portalCount: usage?.portalCount ?? 0,
        activeShareCount: usage?.activeShareCount ?? 0,
      },
    });
  } catch (err) {
    return serverError(res, err, "getSubscription");
  }
}

// ── POST /billing/checkout ────────────────────────────────────────
export async function checkout(req, res) {
  try {
    const { planId, cycle, seats = 1, startTrial = true } = req.body;

    if (!["starter", "pro", "team"].includes(planId)) {
      return fail(res, "INVALID_PLAN", "Invalid plan selected", 400);
    }
    if (!["monthly", "annual"].includes(cycle)) {
      return fail(
        res,
        "INVALID_CYCLE",
        "Billing cycle must be monthly or annual",
        400,
      );
    }

    const result = await initiateCheckout({
      userId: req.user.userId,
      planId,
      cycle,
      seats: parseInt(seats, 10) || 1,
      startTrial,
    });

    return ok(
      res,
      result,
      result.type === "trial" ? "Trial started" : "Checkout initiated",
      200,
    );
  } catch (err) {
    return serverError(res, err, "checkout");
  }
}

// ── POST /billing/verify-payment ──────────────────────────────────
// Called from the FW redirect URL after payment completes.
export async function verifyPayment(req, res) {
  try {
    const { txRef, transactionId } = req.body;
    if (!txRef && !transactionId) {
      return fail(res, "MISSING_REF", "Provide txRef or transactionId", 400);
    }

    let fwTx;
    if (transactionId) {
      fwTx = await verifyTransaction(transactionId);
    } else {
      fwTx = await verifyByRef(txRef);
    }

    if (fwTx?.status !== "successful") {
      return fail(
        res,
        "PAYMENT_UNSUCCESSFUL",
        "Payment was not successful",
        402,
      );
    }

    await activateFromPayment(fwTx);
    const sub = await getOrCreateSubscription(req.user.userId);

    return ok(res, { subscription: sub }, "Payment verified — plan activated");
  } catch (err) {
    return serverError(res, err, "verifyPayment");
  }
}

// ── POST /billing/change-plan ─────────────────────────────────────
export async function changePlanHandler(req, res) {
  try {
    const { planId, cycle, seats = 1 } = req.body;
    if (!planId) return fail(res, "MISSING_PLAN", "planId is required", 400);
    if (!["monthly", "annual"].includes(cycle)) {
      return fail(res, "INVALID_CYCLE", "cycle must be monthly or annual", 400);
    }

    const result = await changePlan({
      userId: req.user.userId,
      newPlanId: planId,
      newCycle: cycle,
      seats: parseInt(seats, 10) || 1,
    });

    return ok(res, result, "Plan change processed");
  } catch (err) {
    return serverError(res, err, "changePlan");
  }
}

// ── POST /billing/cancel ──────────────────────────────────────────
export async function cancelHandler(req, res) {
  try {
    const { reason } = req.body;
    const result = await cancelSubscription(req.user.userId, reason);
    return ok(
      res,
      result,
      "Subscription cancelled. Access continues until period end.",
    );
  } catch (err) {
    if (err.message === "No active subscription to cancel") {
      return fail(res, "NO_ACTIVE_SUBSCRIPTION", err.message, 400);
    }
    return serverError(res, err, "cancel");
  }
}

// ── POST /billing/pause ───────────────────────────────────────────
export async function pauseHandler(req, res) {
  try {
    const { months = 1 } = req.body;
    const result = await pauseSubscription(req.user.userId, months);
    return ok(res, result, "Subscription paused");
  } catch (err) {
    if (err.message.startsWith("Only active")) {
      return fail(res, "INVALID_STATUS", err.message, 400);
    }
    return serverError(res, err, "pause");
  }
}

// ── POST /billing/seats ───────────────────────────────────────────
export async function addSeatsHandler(req, res) {
  try {
    const { seats } = req.body;
    const n = parseInt(seats, 10);
    if (!n || n < 1)
      return fail(
        res,
        "INVALID_SEATS",
        "seats must be a positive integer",
        400,
      );
    const result = await addSeats(req.user.userId, n);
    return ok(res, result, "Seats added");
  } catch (err) {
    return serverError(res, err, "addSeats");
  }
}

// ── GET /billing/payment-methods ──────────────────────────────────
export async function getPaymentMethods(req, res) {
  try {
    // Do NOT use .lean() — we need Mongoose virtuals (displayLabel) serialized.
    const methods = await PaymentMethod.find({
      userId: req.user.userId,
      deletedAt: null,
    });
    return ok(res, { methods });
  } catch (err) {
    return serverError(res, err, "getPaymentMethods");
  }
}

// ── DELETE /billing/payment-methods/:id ───────────────────────────
export async function deletePaymentMethod(req, res) {
  try {
    const pm = await PaymentMethod.findOne({
      _id: req.params.id,
      userId: req.user.userId,
      deletedAt: null,
    });
    if (!pm) return fail(res, "NOT_FOUND", "Payment method not found", 404);

    pm.deletedAt = new Date();
    await pm.save();
    return ok(res, null, "Payment method removed");
  } catch (err) {
    return serverError(res, err, "deletePaymentMethod");
  }
}

// ── PATCH /billing/payment-methods/:id/default ────────────────────
export async function setDefaultPaymentMethod(req, res) {
  try {
    // Clear all defaults for this user, then set the selected one
    await PaymentMethod.updateMany(
      { userId: req.user.userId, deletedAt: null },
      { $set: { isDefault: false } },
    );
    const pm = await PaymentMethod.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.userId, deletedAt: null },
      { $set: { isDefault: true } },
      { new: true },
    );
    if (!pm) return fail(res, "NOT_FOUND", "Payment method not found", 404);
    return ok(res, null, "Default payment method updated");
  } catch (err) {
    return serverError(res, err, "setDefaultPaymentMethod");
  }
}

// ── GET /billing/history ──────────────────────────────────────────
export async function getBillingHistoryHandler(req, res) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const result = await getBillingHistory(req.user.userId, { page, limit });
    return ok(res, result);
  } catch (err) {
    return serverError(res, err, "getBillingHistory");
  }
}

// ── GET /billing/invoices/:id/pdf ─────────────────────────────────
export async function downloadInvoicePdf(req, res) {
  try {
    const pdfBuffer = await generateInvoicePdf(req.params.id, req.user.userId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="invoice-${req.params.id}.pdf"`,
    );
    return res.end(pdfBuffer);
  } catch (err) {
    if (err.status === 404)
      return fail(res, "NOT_FOUND", "Invoice not found", 404);
    return serverError(res, err, "downloadInvoicePdf");
  }
}

// ── PATCH /billing/invoice/:id/details ───────────────────────────
// Allow users to set company name / VAT on their invoice (for expense reports)
export async function updateInvoiceDetails(req, res) {
  try {
    const { companyName, vatNumber } = req.body;
    const invoice = await Invoice.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.userId },
      { $set: { companyName, vatNumber } },
      { new: true },
    );
    if (!invoice) return fail(res, "NOT_FOUND", "Invoice not found", 404);
    return ok(res, null, "Invoice details updated");
  } catch (err) {
    return serverError(res, err, "updateInvoiceDetails");
  }
}
