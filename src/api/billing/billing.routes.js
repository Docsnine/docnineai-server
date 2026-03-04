// ===================================================================
// Billing routes — mounted at /billing in the main router.
//
// Route map:
//   GET  /billing/plans                    — public plan list
//   GET  /billing/subscription             — current user's subscription + usage
//   POST /billing/checkout                 — start trial or get payment link
//   POST /billing/verify-payment           — verify FW payment after redirect
//   POST /billing/change-plan              — upgrade / downgrade
//   POST /billing/cancel                   — cancel at period end
//   POST /billing/pause                    — pause subscription
//   POST /billing/seats                    — add extra seats (Pro/Team)
//   GET  /billing/payment-methods          — list saved payment methods
//   DELETE /billing/payment-methods/:id    — remove payment method
//   PATCH  /billing/payment-methods/:id/default — set default
//   GET  /billing/history                  — paginated invoice list
//   GET  /billing/invoices/:id/pdf         — download invoice PDF
//   PATCH /billing/invoices/:id/details    — update company/VAT on invoice
// ===================================================================

import { Router } from "express";
import { protect } from "../../middleware/auth.middleware.js";
import { wrap } from "../../utils/response.util.js";
import * as ctrl from "./billing.controller.js";
import { apiLimiter } from "../../middleware/rateLimiter.middleware.js";

const router = Router();

// ── Public (no auth) ──────────────────────────────────────────────
router.get("/plans", wrap(ctrl.getPlans));

// ── Protected ─────────────────────────────────────────────────────
router.use(protect, apiLimiter);

router.get("/subscription", wrap(ctrl.getSubscription));
router.post("/checkout", wrap(ctrl.checkout));
router.post("/verify-payment", wrap(ctrl.verifyPayment));
router.post("/change-plan", wrap(ctrl.changePlanHandler));
router.post("/cancel", wrap(ctrl.cancelHandler));
router.post("/pause", wrap(ctrl.pauseHandler));
router.post("/seats", wrap(ctrl.addSeatsHandler));

router.get("/payment-methods", wrap(ctrl.getPaymentMethods));
router.delete("/payment-methods/:id", wrap(ctrl.deletePaymentMethod));
router.patch(
  "/payment-methods/:id/default",
  wrap(ctrl.setDefaultPaymentMethod),
);

router.get("/history", wrap(ctrl.getBillingHistoryHandler));
router.get("/invoices/:id/pdf", ctrl.downloadInvoicePdf); // not wrapped — streams binary
router.patch("/invoices/:id/details", wrap(ctrl.updateInvoiceDetails));

export default router;
