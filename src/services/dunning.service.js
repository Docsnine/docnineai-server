// ===================================================================
// Dunning service — handles failed payment retry flow.
//
// When a payment fails, the subscription enters 'past_due' status.
// Over 14 days, we retry automatically and send escalating emails.
//
// Retry schedule:
//   Day 0  — payment fails → first retry immediately
//   Day 3  — second retry
//   Day 7  — third (final) retry
//
// Email schedule:
//   Day 1  — "payment failed" notification
//   Day 5  — "please update payment method"
//   Day 10 — "account downgrade in 4 days" warning
//   Day 14 — downgrade to Free if still unresolved
// ===================================================================

import { Subscription } from "../models/Subscription.js";
import { Invoice } from "../models/Invoice.js";
import { PaymentMethod } from "../models/PaymentMethod.js";
import { User } from "../models/User.js";
import {
  DUNNING_MAX_DAYS,
  DUNNING_RETRY_DAYS,
  DUNNING_EMAIL_DAYS,
  getPlan,
} from "../config/plans.js";
import {
  chargeToken,
  buildTxRef,
  centsToUsd,
  buildPaymentMethodSnapshot,
} from "./flutterwave.service.js";
import { downgradeToFree } from "./billing.service.js";
import {
  sendPaymentFailedEmail,
  sendPaymentUpdateReminderEmail,
  sendDowngradeWarningEmail,
  sendAccountDowngradedEmail,
  sendPaymentReceiptEmail,
} from "../config/email.js";
import { computeMonthlyPrice } from "../config/plans.js";

/**
 * Process all past_due subscriptions.
 * Called daily by the cron job at 00:00 UTC.
 */
export async function processDunning() {
  const pastDueSubs = await Subscription.find({ status: "past_due" });
  console.log(
    `[dunning] Processing ${pastDueSubs.length} past-due subscriptions`,
  );

  for (const sub of pastDueSubs) {
    try {
      await processSingleDunning(sub);
    } catch (err) {
      console.error(
        `[dunning] Error processing sub ${sub._id}: ${err.message}`,
      );
    }
  }
}

async function processSingleDunning(sub) {
  const dunningDay = daysSince(sub.dunningStartedAt);
  const user = await User.findById(sub.userId).select("name email");
  if (!user) return;

  // ── Final downgrade ─────────────────────────────────────────
  if (dunningDay >= DUNNING_MAX_DAYS) {
    console.log(`[dunning] Downgrading ${sub.userId} after ${dunningDay} days`);
    await downgradeToFree(sub);
    await sendAccountDowngradedEmail({ to: user.email, name: user.name });
    return;
  }

  // ── Automatic retry ──────────────────────────────────────────
  if (DUNNING_RETRY_DAYS.includes(dunningDay)) {
    const recharged = await attemptRetryCharge(sub, user);
    if (recharged) return; // dunning resolved — charge succeeded
  }

  // ── Email reminders ──────────────────────────────────────────
  if (DUNNING_EMAIL_DAYS.includes(dunningDay)) {
    await sendDunningEmail(dunningDay, user, sub);
  }

  // Increment attempt count
  sub.dunningAttemptCount = (sub.dunningAttemptCount || 0) + 1;
  await sub.save();
}

async function attemptRetryCharge(sub, user) {
  const savedMethod = await PaymentMethod.findOne({
    userId: sub.userId,
    isDefault: true,
    deletedAt: null,
  }).select("+flutterwaveToken");

  if (!savedMethod?.flutterwaveToken) return false;

  const plan = getPlan(sub.plan);
  const amountCents = computeMonthlyPrice(
    sub.plan,
    sub.billingCycle || "monthly",
    sub.seats,
  );
  const txRef = buildTxRef("dunning");

  try {
    const fwTx = await chargeToken({
      token: savedMethod.flutterwaveToken,
      txRef,
      amount: centsToUsd(amountCents),
      currency: savedMethod.currency || "USD",
      email: user.email,
      narration: `Docnine ${plan.name} — retry`,
    });

    // Create a paid invoice
    const invoice = await Invoice.create({
      userId: sub.userId,
      subscriptionId: sub._id,
      amount: amountCents,
      currency: "USD",
      description: `${plan.name} Plan renewal (retry)`,
      status: "paid",
      flutterwaveRef: txRef,
      flutterwaveTxId: fwTx.id,
      paymentMethodSnapshot: buildPaymentMethodSnapshot(fwTx),
      paidAt: new Date(),
      customerName: user.name,
      customerEmail: user.email,
    });

    // Resolve dunning — restore to active
    const addPeriod = (date, cycle) => {
      const d = new Date(date);
      if (cycle === "annual") d.setFullYear(d.getFullYear() + 1);
      else d.setMonth(d.getMonth() + 1);
      return d;
    };

    sub.status = "active";
    sub.dunningAttemptCount = 0;
    sub.dunningStartedAt = null;
    sub.currentPeriodEnd = addPeriod(new Date(), sub.billingCycle || "monthly");
    await sub.save();

    await sendPaymentReceiptEmail({
      to: user.email,
      name: user.name,
      invoiceNumber: invoice.invoiceNumber,
      amount: centsToUsd(amountCents),
      description: invoice.description,
      paidAt: invoice.paidAt,
    });

    console.log(`[dunning] Retry succeeded for ${user.email} (${txRef})`);
    return true;
  } catch (err) {
    console.log(`[dunning] Retry failed for ${user.email}: ${err.message}`);
    return false;
  }
}

async function sendDunningEmail(dunningDay, user, sub) {
  const planName = getPlan(sub.plan).name;
  const billingUrl = `${process.env.FRONTEND_URL}/billing`;

  if (dunningDay === 1) {
    await sendPaymentFailedEmail({
      to: user.email,
      name: user.name,
      planName,
      billingUrl,
    });
  } else if (dunningDay === 5) {
    await sendPaymentUpdateReminderEmail({
      to: user.email,
      name: user.name,
      billingUrl,
    });
  } else if (dunningDay === 10) {
    const daysLeft = DUNNING_MAX_DAYS - dunningDay;
    await sendDowngradeWarningEmail({
      to: user.email,
      name: user.name,
      daysLeft,
      billingUrl,
    });
  }
}

function daysSince(date) {
  if (!date) return 0;
  const ms = Date.now() - new Date(date).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
