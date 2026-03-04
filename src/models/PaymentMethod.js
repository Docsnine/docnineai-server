// ===================================================================
// PaymentMethod — saved payment methods per user.
//
// Security:
//   • Docnine NEVER stores raw card numbers, CVVs, or PINs.
//   • flutterwaveToken (select:false) holds a FW-issued opaque token
//     that allows future charges without re-entering card details.
//   • All PCI-sensitive data lives exclusively in Flutterwave's vault.
// ===================================================================

import mongoose from "mongoose";

const { Schema, model } = mongoose;

const CardDetailsSchema = new Schema(
  {
    last4: { type: String }, // e.g. "4242"
    brand: { type: String }, // e.g. "Visa", "Mastercard"
    expMonth: { type: Number }, // 1-12
    expYear: { type: Number }, // e.g. 2027
  },
  { _id: false },
);

const MobileMoneyDetailsSchema = new Schema(
  {
    phone: { type: String }, // e.g. "+250788123456"
    network: { type: String }, // e.g. "MTN", "Airtel", "M-Pesa"
    country: { type: String }, // ISO-2: RW, UG, GH, KE, TZ
  },
  { _id: false },
);

const PaymentMethodSchema = new Schema(
  {
    // ── Identity ──────────────────────────────────────────────
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ── Type ──────────────────────────────────────────────────
    type: {
      type: String,
      enum: ["card", "mobile_money", "bank_transfer"],
      required: true,
    },

    // ── Display details ───────────────────────────────────────
    card: { type: CardDetailsSchema, default: null },
    mobileMoney: { type: MobileMoneyDetailsSchema, default: null },
    // Bank transfers have no displayable details to save

    // ── Default flag ──────────────────────────────────────────
    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },

    // ── Flutterwave opaque charge token ───────────────────────
    // Used to re-charge without the user re-entering details.
    // select:false — NEVER returned in API responses.
    flutterwaveToken: {
      type: String,
      required: true,
      select: false,
    },

    // ── Currency the token was issued in ─────────────────────
    // Flutterwave tokenized charges MUST use the token's original
    // currency (e.g. NGN, KES, GHS). Stored here so every retry
    // charge uses the right currency without hardcoding USD.
    currency: {
      type: String,
      default: "USD",
      uppercase: true,
    },

    // ── Soft delete ───────────────────────────────────────────
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Only one default payment method per user
PaymentMethodSchema.index({ userId: 1, isDefault: 1 });

// ── Virtual display label ─────────────────────────────────────
PaymentMethodSchema.virtual("displayLabel").get(function () {
  if (this.type === "card" && this.card) {
    return `${this.card.brand} ****${this.card.last4} (${this.card.expMonth}/${this.card.expYear})`;
  }
  if (this.type === "mobile_money" && this.mobileMoney) {
    return `${this.mobileMoney.network} ${this.mobileMoney.phone}`;
  }
  return "Bank Transfer";
});

PaymentMethodSchema.set("toJSON", { virtuals: true });

export const PaymentMethod = model("PaymentMethod", PaymentMethodSchema);
