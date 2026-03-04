// ===================================================================
// Invoice — immutable record of every billing event.
//
// Invoices are append-only. Never update an invoice record; create
// a new one (e.g. for refunds, create a separate refund invoice).
//
// amount — stored in USD cents. Display / divide by 100.
// ===================================================================

import mongoose from "mongoose";

const { Schema, model } = mongoose;

let _invoiceCounter = null;

const InvoiceLineSchema = new Schema(
  {
    description: { type: String, required: true },
    amount: { type: Number, required: true }, // cents
  },
  { _id: false },
);

const InvoiceSchema = new Schema(
  {
    // ── Identity ──────────────────────────────────────────────
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: "Subscription",
      default: null,
    },

    // ── Human-readable invoice number (INV-YYYYMM-XXXX-DOC9) ──────
    invoiceNumber: {
      type: String,
      unique: true,
    },

    // ── Amounts (USD cents) ───────────────────────────────────
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: "USD",
      uppercase: true,
    },

    // ── Line items ────────────────────────────────────────────
    lineItems: {
      type: [InvoiceLineSchema],
      default: [],
    },

    // ── Status ────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded", "void"],
      default: "pending",
      index: true,
    },

    // ── Description (top-level summary) ──────────────────────
    description: {
      type: String,
      required: true,
    },

    // ── Payment method snapshot (display only — no raw data) ──
    paymentMethodSnapshot: {
      type: String,
      default: null, // e.g. "Visa ****4242" or "MTN +250..."
    },

    // ── Flutterwave reference ─────────────────────────────────
    flutterwaveRef: { type: String, default: null },
    flutterwaveTxId: { type: Number, default: null },

    // ── What was purchased (needed by activateFromPayment) ────
    planId: { type: String, default: null }, // e.g. 'starter', 'pro'
    billingCycle: { type: String, default: null }, // 'monthly' | 'annual'
    seats: { type: Number, default: 1 },    // For seat-addition invoices: how many seats to grant on payment
    seatDelta: { type: Number, default: 0 },
    // ── Dates ─────────────────────────────────────────────────
    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },

    // ── Customer details for PDF ──────────────────────────────
    customerName: { type: String, default: null },
    customerEmail: { type: String, default: null },
    // Optional for teams submitting expense reports
    vatNumber: { type: String, default: null },
    companyName: { type: String, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

InvoiceSchema.index({ userId: 1, createdAt: -1 });

// ── Auto-generate invoice number before save ──────────────────
InvoiceSchema.pre("save", async function (next) {
  if (this.invoiceNumber) return next(); // already set (idempotent)
  
  const now = new Date();
  const prefix = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-DOC9`;
  
  // Count existing invoices with this prefix to build the sequence
  const count = await mongoose.model("Invoice").countDocuments({
    invoiceNumber: new RegExp(`^${prefix}-`),
  });

  this.invoiceNumber = `${prefix}-${String(count + 1).padStart(4, "0")}`;

  next();
});

export const Invoice = model("Invoice", InvoiceSchema);
