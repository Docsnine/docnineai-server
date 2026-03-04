// ===================================================================
// Subscription — tracks a user's active billing state.
//
// One Subscription document per user. Even Free users have one
// (plan = 'free', status = 'free') so gate queries are uniform.
//
// Status state machine:
//   free       → trialing (when they start a paid trial)
//   trialing   → active   (when they pay after trial)
//   trialing   → free     (trial expires without payment)
//   active     → past_due (payment fails at renewal)
//   past_due   → active   (payment recovers within grace period)
//   past_due   → free     (dunning window expires after 14 days)
//   active     → cancelled (user cancels — stays active until period end)
//   cancelled  → free     (period ends after cancelling)
//   active     → paused   (user pauses)
//   paused     → active   (pause period ends)
// ===================================================================

import mongoose from "mongoose";

const { Schema, model } = mongoose;

const SubscriptionSchema = new Schema(
  {
    // ── Identity ──────────────────────────────────────────────
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    // ── Plan ──────────────────────────────────────────────────
    plan: {
      type: String,
      enum: ["free", "starter", "pro", "team"],
      default: "free",
    },
    billingCycle: {
      type: String,
      enum: ["monthly", "annual", null],
      default: null,
    },
    // Number of seats — meaningful for pro & team plans
    seats: {
      type: Number,
      default: 1,
      min: 1,
    },
    // Extra seats beyond the included base (Pro: base 5)
    extraSeats: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ── Status ────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["free", "trialing", "active", "past_due", "cancelled", "paused"],
      default: "free",
      index: true,
    },

    // ── Trial ─────────────────────────────────────────────────
    trialEndsAt: {
      type: Date,
      default: null,
    },

    // ── Billing period ────────────────────────────────────────
    currentPeriodStart: {
      type: Date,
      default: null,
    },
    currentPeriodEnd: {
      type: Date,
      default: null,
      index: true, // queried by cron renewals job
    },

    // ── Cancellation ──────────────────────────────────────────
    // True when user has requested cancellation but billing period hasn't ended
    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },

    // ── Pending plan change (downgrade) ───────────────────────
    // Set when a downgrade is scheduled for period end
    pendingPlan: {
      type: String,
      enum: ["free", "starter", "pro", "team", null],
      default: null,
    },
    pendingBillingCycle: {
      type: String,
      enum: ["monthly", "annual", null],
      default: null,
    },

    // ── Pause ─────────────────────────────────────────────────
    pausedAt: {
      type: Date,
      default: null,
    },
    pauseEndsAt: {
      type: Date,
      default: null,
    },

    // ── Dunning ───────────────────────────────────────────────
    dunningAttemptCount: {
      type: Number,
      default: 0,
    },
    dunningStartedAt: {
      type: Date,
      default: null,
      index: true, // queried by dunning cron
    },

    // ── Flutterwave references ────────────────────────────────
    // The Flutterwave customer/transaction token for recurring charges.
    // Never store raw card numbers — only FW-issued tokens.
    flutterwaveCustomerId: {
      type: String,
      default: null,
      select: false,
    },

    // ── Misc ──────────────────────────────────────────────────
    // Retention offer tracking — to avoid showing the same offer twice
    retentionOfferUsed: {
      type: Boolean,
      default: false,
    },
    lastBillingNote: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ── Compound indexes for cron queries ─────────────────────────
SubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });
SubscriptionSchema.index({ status: 1, trialEndsAt: 1 });
SubscriptionSchema.index({ status: 1, dunningStartedAt: 1 });

export const Subscription = model("Subscription", SubscriptionSchema);
