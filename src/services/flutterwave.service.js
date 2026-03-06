// ===================================================================
// Flutterwave service — thin REST client over the FW v3 API.
//
// Never import this module on the client side. It uses the secret key.
//
// Required env vars:
//   FLW_SECRET_KEY        — Flutterwave secret key (sk_live_... or sk_test_...)
//   FLW_PUBLIC_KEY        — Flutterwave public key (PK_live_... or PK_...)
//   FLW_WEBHOOK_HASH      — Custom webhook hash set in FW dashboard
//   FRONTEND_URL          — Used to construct redirect URLs
//
// Docs: https://developer.flutterwave.com/docs
// ===================================================================

import axios from "axios";
import crypto from "crypto";

const FLW_BASE = "https://api.flutterwave.com/v3";

function getSecretKey() {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) throw new Error("FLW_SECRET_KEY is not configured");
  return key;
}

function flwClient() {
  return axios.create({
    baseURL: FLW_BASE,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      "Content-Type": "application/json",
    },
    timeout: 15_000,
  });
}

// ── Helpers ──────────────────────────────────────────────────────

function handleFLWError(err, context) {
  const status = err.response?.status;
  const msg =
    err.response?.data?.message ||
    err.response?.data?.error ||
    err.message ||
    "Flutterwave error";
  console.error(`[FLW:${context}] ${status || ""} ${msg}`);
  const error = new Error(msg);
  error.flwStatus = status;
  throw error;
}

// ── Payment initialisation ───────────────────────────────────────

/**
 * Create a Flutterwave hosted-payment link (standard checkout).
 * Used for the initial checkout where we don't have a saved token.
 *
 * @param {Object} opts
 * @param {string}  opts.txRef        - Unique reference (stored in Invoice)
 * @param {number}  opts.amount       - Amount in USD (not cents)
 * @param {string}  opts.currency     - e.g. "USD"
 * @param {string}  opts.email
 * @param {string}  opts.name
 * @param {string}  opts.phone        - optional
 * @param {string}  opts.planId       - for tagging
 * @param {string}  opts.redirectUrl  - where FW sends the user after payment
 * @returns {Promise<{paymentLink: string}>}
 */
export async function initializePayment({
  txRef,
  amount,
  currency = "USD",
  email,
  name,
  phone,
  planId,
  redirectUrl,
}) {
  const client = flwClient();
  try {
    const { data } = await client.post("/payments", {
      tx_ref: txRef,
      amount,
      currency,
      redirect_url:
        redirectUrl || `${process.env.FRONTEND_URL}/billing?status=paid`,
      customer: { email, name, phonenumber: phone || undefined },
      customizations: {
        title: "Docnine",
        description: `Subscribe to ${planId} plan`,
        logo: `${process.env.FRONTEND_URL}/logo.png`,
      },
      meta: { plan: planId },
    });
    return { paymentLink: data.data.link };
  } catch (err) {
    handleFLWError(err, "initializePayment");
  }
}

// ── Transaction verification ─────────────────────────────────────

/**
 * Verify a transaction by ID. Use after receiving webhook or redirect.
 * @param {number|string} transactionId
 * @returns {Promise<Object>} FW transaction data
 */
export async function verifyTransaction(transactionId) {
  const client = flwClient();
  try {
    const { data } = await client.get(`/transactions/${transactionId}/verify`);
    return data.data; // raw FW transaction object
  } catch (err) {
    handleFLWError(err, "verifyTransaction");
  }
}

/**
 * Verify a transaction by tx_ref (our reference).
 * @param {string} txRef
 */
export async function verifyByRef(txRef) {
  const client = flwClient();
  try {
    const { data } = await client.get("/transactions", {
      params: { tx_ref: txRef },
    });
    const transactions = data.data;
    if (!transactions || transactions.length === 0) {
      throw new Error(`No transaction found for tx_ref: ${txRef}`);
    }
    return transactions[0];
  } catch (err) {
    handleFLWError(err, "verifyByRef");
  }
}

// ── Tokenised charges ────────────────────────────────────────────

/**
 * Charge a customer using their saved Flutterwave token.
 * This is used for automatic subscription renewals.
 *
 * @param {Object} opts
 * @param {string}  opts.token     - FW charge token from previous payment
 * @param {string}  opts.txRef     - Unique ref for this charge
 * @param {number}  opts.amount    - USD (not cents)
 * @param {string}  opts.currency
 * @param {string}  opts.email
 * @param {string}  opts.narration - Description on customer statement
 * @returns {Promise<Object>}
 */
export async function chargeToken({
  token,
  txRef,
  amount,
  currency = "USD",
  email,
  narration,
}) {
  const client = flwClient();
  try {
    const { data } = await client.post("/charges?type=tokenized", {
      token,
      tx_ref: txRef,
      amount,
      currency,
      email,
      narration,
    });
    if (data.data?.status === "successful") {
      return data.data;
    }
    const error = new Error(
      data.data?.processor_response || data.message || "Charge failed",
    );
    error.flwStatus = 400;
    throw error;
  } catch (err) {
    if (err.flwStatus) throw err;
    handleFLWError(err, "chargeToken");
  }
}

// ── Refunds ──────────────────────────────────────────────────────

/**
 * Refund a transaction fully or partially.
 * @param {number|string} transactionId - FW transaction ID
 * @param {number}        amount        - USD amount to refund (optional = full)
 * @returns {Promise<Object>}
 */
export async function refundTransaction(transactionId, amount) {
  const client = flwClient();
  try {
    const body = {};
    if (amount !== undefined) body.amount = amount;
    const { data } = await client.post(
      `/transactions/${transactionId}/refund`,
      body,
    );
    return data.data;
  } catch (err) {
    handleFLWError(err, "refundTransaction");
  }
}

// ── Webhook signature verification ──────────────────────────────

/**
 * Verify that a Flutterwave webhook came from FW and not a spoofed request.
 *
 * FW sends a custom header `verif-hash` that matches the static hash
 * you configure in the FW dashboard (FLW_WEBHOOK_HASH env var).
 *
 * @param {string} headerHash - Value of the `verif-hash` request header
 * @returns {boolean}
 */
export function verifyWebhookSignature(headerHash) {
  const expected = process.env.FLW_WEBHOOK_HASH;
  if (!expected) {
    console.warn("⚠️  FLW_WEBHOOK_HASH not set — webhook verification skipped");
    return true;
  }
  // For extra safety, use timingSafeEqual to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(headerHash || ""),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

// ── Utility ──────────────────────────────────────────────────────

/** Convert cents (integer) to USD float for API calls. */
export function centsToUsd(cents) {
  return parseFloat((cents / 100).toFixed(2));
}

/** Build a unique transaction reference. */
export function buildTxRef(prefix = "sub") {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}_${ts}_${rand}`;
}

/**
 * Extract a reusable charge token from a completed FW transaction.
 * FW attaches a `card.token` or `account_token` field on the tx object.
 * @param {Object} fwTransaction  - The raw FW transaction data
 * @returns {string|null}
 */
export function extractChargeToken(fwTransaction) {
  return fwTransaction?.card?.token || fwTransaction?.account_token || null;
}

/**
 * Build a display label for a payment method from a FW transaction.
 * @param {Object} fwTransaction
 * @returns {string}
 */
export function buildPaymentMethodSnapshot(fwTransaction) {
  const card = fwTransaction?.card;
  if (card?.last_4digits) {
    return `${card.type || "Card"} ****${card.last_4digits}`;
  }
  const phone = fwTransaction?.customer?.phone_number;
  const network = fwTransaction?.payment_type;
  if (phone) {
    return `${network || "Mobile Money"} ${phone}`;
  }
  return fwTransaction?.payment_type || "Bank Transfer";
}
