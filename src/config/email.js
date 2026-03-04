// ===================================================================
// Nodemailer transporter — configure via SMTP env vars.
// Falls back gracefully so the server starts even without email config.
//
// Required env (for real sending):
//   SMTP_HOST     — e.g. smtp.sendgrid.net | smtp.gmail.com
//   SMTP_PORT     — e.g. 587 (STARTTLS) | 465 (SSL)
//   SMTP_USER     — SMTP username / API key
//   SMTP_PASS     — SMTP password / API key
//   EMAIL_FROM    — sender address, e.g. noreply@yourdomain.com
//   FRONTEND_URL  — public frontend URL, e.g. https://docnine.vercel.app (used in email links)
//
// Without SMTP config: emails are logged to console (dev mode).
// ===================================================================

import nodemailer from "nodemailer";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const FROM =
  process.env.EMAIL_FROM || "Docnine <noreply@project-documentor.dev>";

// Lazy singleton — created on first use
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    // Dev fallback: log emails instead of sending
    console.warn("⚠️  SMTP not configured — emails will be logged to console");
    _transporter = {
      sendMail: async (opts) => {
        console.log("\n📧 [EMAIL — not sent, SMTP unconfigured]");
        console.log(`   To:      ${opts.to}`);
        console.log(`   Subject: ${opts.subject}`);
        console.log(`   Body:    ${opts.text || "(html only)"}\n`);
        return { messageId: "dev-mode" };
      },
    };
    return _transporter;
  }

  _transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || "587", 10),
    secure: parseInt(SMTP_PORT || "587", 10) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  return _transporter;
}

// ── Email senders ─────────────────────────────────────────────

/**
 * Send an email verification link.
 * @param {{ to: string, token: string, name: string }} opts
 */
export async function sendVerificationEmail({ to, token, name }) {
  const link = `${FRONTEND_URL}/verify?token=${token}`;
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: "Verify your Docnine email",
    text: `Hi ${name},\n\nVerify your email:\n${link}\n\nThis link expires in 24 hours.\n\nIgnore this if you didn't sign up.`,
    html: emailTemplate({
      title: "Verify your email",
      body: `<p>Hi <strong>${name}</strong>,</p><p>Click the button below to verify your email address. This link expires in <strong>24 hours</strong>.</p>`,
      ctaText: "Verify Email",
      ctaUrl: link,
      footer:
        "If you didn't create a Docnine account, you can ignore this email.",
    }),
  });
}

/**
 * Send a password reset link.
 * @param {{ to: string, token: string, name: string }} opts
 */
export async function sendPasswordResetEmail({ to, token, name }) {
  const link = `${FRONTEND_URL}/reset-password?token=${token}`;
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: "Reset your Docnine password",
    text: `Hi ${name},\n\nReset your password:\n${link}\n\nThis link expires in 1 hour.\n\nIgnore this if you didn't request a password reset.`,
    html: emailTemplate({
      title: "Reset your password",
      body: `<p>Hi <strong>${name}</strong>,</p><p>Click the button below to reset your password. This link expires in <strong>1 hour</strong>.</p>`,
      ctaText: "Reset Password",
      ctaUrl: link,
      footer:
        "If you didn't request a password reset, you can ignore this email. Your password won't change.",
    }),
  });
}

/**
 * Send a project share invitation.
 * @param {{ to: string, inviterName: string, projectName: string, role: string, token: string }} opts
 */
export async function sendProjectInviteEmail({
  to,
  inviterName,
  projectName,
  role,
  token,
}) {
  const link = `${FRONTEND_URL}/share/accept/${token}`;
  const roleLabel = role === "editor" ? "Editor" : "Viewer";
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: `${inviterName} invited you to "${projectName}" on Docnine`,
    text: `Hi,\n\n${inviterName} has invited you to collaborate on "${projectName}" as ${roleLabel}.\n\nAccept the invitation:\n${link}\n\nThis link expires in 7 days.`,
    html: emailTemplate({
      title: `You've been invited to "${projectName}"`,
      body: `<p><strong>${inviterName}</strong> has invited you to collaborate on the <strong>${projectName}</strong> project as <strong>${roleLabel}</strong>.</p><p>Click the button below to accept the invitation. This link expires in <strong>7 days</strong>.</p>`,
      ctaText: "Accept Invitation",
      ctaUrl: link,
      footer: "If you weren't expecting this invite, you can safely ignore it.",
    }),
  });
}

// ── Billing email senders ─────────────────────────────────────

export async function sendTrialStartedEmail({
  to,
  name,
  planName,
  trialEndsAt,
}) {
  const billingUrl = `${FRONTEND_URL}/billing`;
  const endDate = new Date(trialEndsAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: `Your ${planName} trial has started`,
    text: `Hi ${name},\n\nYour 14-day free trial of Docnine ${planName} has started. It ends on ${endDate}.\n\nAdd a payment method before then to keep your access:\n${billingUrl}`,
    html: emailTemplate({
      title: `Your ${planName} trial has started 🎉`,
      body: `<p>Hi <strong>${name}</strong>,</p><p>Your 14-day free trial of the <strong>${planName}</strong> plan is now active. Your trial ends on <strong>${endDate}</strong>.</p><p>Add a payment method before then to continue without interruption.</p>`,
      ctaText: "Manage Billing",
      ctaUrl: billingUrl,
      footer: "No charge until your trial ends. Cancel anytime.",
    }),
  });
}

export async function sendTrialExpiryReminderEmail({
  to,
  name,
  daysLeft,
  trialEndsAt,
  billingUrl,
}) {
  const endDate = new Date(trialEndsAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: `Your Docnine trial ends in ${daysLeft} day${daysLeft > 1 ? "s" : ""}`,
    text: `Hi ${name},\n\nYour Docnine trial ends in ${daysLeft} day${daysLeft > 1 ? "s" : ""} (${endDate}). Add a payment method to keep your access:\n${billingUrl}`,
    html: emailTemplate({
      title: `Your trial ends in ${daysLeft} day${daysLeft > 1 ? "s" : ""}`,
      body: `<p>Hi <strong>${name}</strong>,</p><p>Your Docnine free trial ends on <strong>${endDate}</strong>. Add a payment method now to keep your access to all paid features.</p><p>If you don't add one, your account will move to the free plan. <strong>Your data will be kept — no deletions.</strong></p>`,
      ctaText: "Add Payment Method",
      ctaUrl: billingUrl,
      footer: "No action needed if you want to continue on the Free plan.",
    }),
  });
}

export async function sendTrialExpiredEmail({ to, name }) {
  const billingUrl = `${FRONTEND_URL}/billing`;
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: "Your Docnine trial has ended",
    text: `Hi ${name},\n\nYour Docnine trial has ended and your account has moved to the Free plan. Your projects and documents are safe. Resubscribe anytime:\n${billingUrl}`,
    html: emailTemplate({
      title: "Your trial has ended",
      body: `<p>Hi <strong>${name}</strong>,</p><p>Your 14-day free trial has ended and your account has moved to the <strong>Free plan</strong>.</p><p>Don't worry — all your projects and documents are still there. Upgrade anytime to restore full access instantly.</p>`,
      ctaText: "Resubscribe",
      ctaUrl: billingUrl,
      footer: "No data has been deleted.",
    }),
  });
}

export async function sendSubscriptionActivatedEmail({
  to,
  name,
  planName,
  nextRenewalDate,
}) {
  const billingUrl = `${FRONTEND_URL}/billing`;
  const renewDate = new Date(nextRenewalDate).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: `Welcome to Docnine ${planName}!`,
    text: `Hi ${name},\n\nYour ${planName} subscription is now active. Your next renewal is on ${renewDate}.\n\nManage your billing: ${billingUrl}`,
    html: emailTemplate({
      title: `Welcome to ${planName}!`,
      body: `<p>Hi <strong>${name}</strong>,</p><p>Your <strong>${planName}</strong> subscription is now active. Your next renewal date is <strong>${renewDate}</strong>.</p>`,
      ctaText: "View Billing",
      ctaUrl: billingUrl,
      footer: "Thank you for choosing Docnine.",
    }),
  });
}

export async function sendPaymentReceiptEmail({
  to,
  name,
  invoiceNumber,
  amount,
  description,
  paidAt,
}) {
  const billingUrl = `${FRONTEND_URL}/billing`;
  const dateStr = new Date(paidAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: `Receipt for $${amount.toFixed(2)} — Docnine`,
    text: `Hi ${name},\n\nPayment received: $${amount.toFixed(2)} for ${description} on ${dateStr}.\n\nInvoice #${invoiceNumber}. Download your invoice: ${billingUrl}`,
    html: emailTemplate({
      title: "Payment received",
      body: `<p>Hi <strong>${name}</strong>,</p><p>We've received your payment of <strong>$${amount.toFixed(2)} USD</strong> for <em>${description}</em>.</p><table style="width:100%;font-size:.85rem;color:#8b949e;border-collapse:collapse;margin-top:12px"><tr><td>Invoice #</td><td>${invoiceNumber}</td></tr><tr><td>Date</td><td>${dateStr}</td></tr><tr><td>Amount</td><td>$${amount.toFixed(2)} USD</td></tr></table>`,
      ctaText: "Download Invoice",
      ctaUrl: billingUrl,
      footer: "Thank you for your payment.",
    }),
  });
}

export async function sendPlanUpgradedEmail({
  to,
  name,
  newPlanName,
  nextRenewalDate,
}) {
  const billingUrl = `${FRONTEND_URL}/billing`;
  const renewDate = new Date(nextRenewalDate).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: `You've upgraded to ${newPlanName} — Docnine`,
    text: `Hi ${name},\n\nYou've been upgraded to ${newPlanName}. New features are available now. Next renewal: ${renewDate}.\n\nManage billing: ${billingUrl}`,
    html: emailTemplate({
      title: `Upgraded to ${newPlanName}`,
      body: `<p>Hi <strong>${name}</strong>,</p><p>You've successfully upgraded to the <strong>${newPlanName}</strong> plan. All new features are available right now. Your next renewal date is <strong>${renewDate}</strong>.</p>`,
      ctaText: "Explore New Features",
      ctaUrl: `${FRONTEND_URL}/projects`,
      footer: "Thank you for upgrading your Docnine plan.",
    }),
  });
}

export async function sendPlanDowngradeScheduledEmail({
  to,
  name,
  currentPlanName,
  newPlanName,
  effectiveAt,
}) {
  const billingUrl = `${FRONTEND_URL}/billing`;
  const effectiveDate = new Date(effectiveAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: `Your plan change is scheduled — Docnine`,
    text: `Hi ${name},\n\nYour plan will change from ${currentPlanName} to ${newPlanName} on ${effectiveDate}. You keep full access until then.\n\nCancel the downgrade anytime: ${billingUrl}`,
    html: emailTemplate({
      title: "Plan change scheduled",
      body: `<p>Hi <strong>${name}</strong>,</p><p>Your plan will change from <strong>${currentPlanName}</strong> to <strong>${newPlanName}</strong> on <strong>${effectiveDate}</strong>.</p><p>You'll keep full access to your current features until then. You can cancel this change anytime from your billing settings.</p>`,
      ctaText: "Manage Billing",
      ctaUrl: billingUrl,
      footer: "No action needed if you confirmed this change.",
    }),
  });
}

export async function sendCancellationConfirmEmail({
  to,
  name,
  planName,
  accessUntil,
}) {
  const billingUrl = `${FRONTEND_URL}/billing`;
  const untilDate = new Date(accessUntil).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: "Your Docnine subscription has been cancelled",
    text: `Hi ${name},\n\nYour ${planName} subscription has been cancelled. You'll keep access until ${untilDate}, then move to the Free plan. Your data is safe.\n${billingUrl}`,
    html: emailTemplate({
      title: "Subscription cancelled",
      body: `<p>Hi <strong>${name}</strong>,</p><p>Your <strong>${planName}</strong> subscription has been cancelled. You'll keep full access until <strong>${untilDate}</strong>, after which your account will move to the Free plan.</p><p><strong>No data will be deleted.</strong> You can resubscribe anytime to restore access instantly.</p>`,
      ctaText: "Resubscribe",
      ctaUrl: billingUrl,
      footer: "We're sorry to see you go. Feel free to come back anytime.",
    }),
  });
}

export async function sendPaymentFailedEmail({
  to,
  name,
  planName,
  billingUrl,
}) {
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: "Payment failed — action required",
    text: `Hi ${name},\n\nWe couldn't process your payment for Docnine ${planName}. Please update your payment method to avoid losing access:\n${billingUrl}`,
    html: emailTemplate({
      title: "Payment failed",
      body: `<p>Hi <strong>${name}</strong>,</p><p>We were unable to process your payment for the <strong>${planName}</strong> plan. Please update your payment method as soon as possible to keep your access.</p><p>We'll retry automatically over the next few days.</p>`,
      ctaText: "Update Payment Method",
      ctaUrl: billingUrl,
      footer: "Your account remains fully active during this grace period.",
    }),
  });
}

export async function sendPaymentUpdateReminderEmail({ to, name, billingUrl }) {
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: "Reminder: Update your payment method — Docnine",
    text: `Hi ${name},\n\nA reminder to update your payment method to avoid losing access to Docnine:\n${billingUrl}`,
    html: emailTemplate({
      title: "Update your payment method",
      body: `<p>Hi <strong>${name}</strong>,</p><p>We still haven't been able to process your payment. Please update your payment method as soon as possible. We'll retry again automatically, but your access may be affected if this isn't resolved soon.</p>`,
      ctaText: "Update Payment Method",
      ctaUrl: billingUrl,
      footer:
        "Your account is still fully accessible during this grace period.",
    }),
  });
}

export async function sendDowngradeWarningEmail({
  to,
  name,
  daysLeft,
  billingUrl,
}) {
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: `Action required: Your account will be downgraded in ${daysLeft} days`,
    text: `Hi ${name},\n\nIf we don't receive payment in the next ${daysLeft} days, your account will move to the Free plan. Update your payment method:\n${billingUrl}`,
    html: emailTemplate({
      title: `Account downgrade in ${daysLeft} days`,
      body: `<p>Hi <strong>${name}</strong>,</p><p>We've been unable to process your payment. If this isn't resolved in the next <strong>${daysLeft} days</strong>, your account will be moved to the <strong>Free plan</strong>.</p><p>Your projects and documents are safe — only premium features will be locked.</p>`,
      ctaText: "Update Payment Method Now",
      ctaUrl: billingUrl,
      footer:
        "We're sorry for the inconvenience. Please contact support if you need help.",
    }),
  });
}

export async function sendAccountDowngradedEmail({ to, name }) {
  const billingUrl = `${FRONTEND_URL}/billing`;
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: "Your Docnine account has been moved to the Free plan",
    text: `Hi ${name},\n\nWe couldn't collect payment after 14 days, so your account has moved to the Free plan. Your data is safe. Resubscribe anytime:\n${billingUrl}`,
    html: emailTemplate({
      title: "Account moved to Free plan",
      body: `<p>Hi <strong>${name}</strong>,</p><p>After 14 days of unsuccessful payment attempts, your account has been moved to the <strong>Free plan</strong>.</p><p>All your projects and documents are still there. You can resubscribe at any time to restore full access instantly.</p>`,
      ctaText: "Resubscribe",
      ctaUrl: billingUrl,
      footer: "No data has been deleted.",
    }),
  });
}

export async function sendCardExpiryWarningEmail({
  to,
  name,
  cardLabel,
  expMonth,
  expYear,
  billingUrl,
}) {
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: "Your payment card is expiring soon — Docnine",
    text: `Hi ${name},\n\nYour card ${cardLabel} expires at ${expMonth}/${expYear}. Update it to avoid payment failures:\n${billingUrl}`,
    html: emailTemplate({
      title: "Your card is expiring soon",
      body: `<p>Hi <strong>${name}</strong>,</p><p>Your card <strong>${cardLabel}</strong> expires at the end of <strong>${expMonth}/${expYear}</strong>.</p><p>Please update your payment method before then to ensure your subscription renews without interruption.</p>`,
      ctaText: "Update Payment Method",
      ctaUrl: billingUrl,
      footer: "Ignore this if you've already updated your card.",
    }),
  });
}

// ── Minimal branded HTML template ─────────────────────────────
function emailTemplate({ title, body, ctaText, ctaUrl, footer }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:40px 20px">
  <div style="max-width:480px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden">
    <div style="padding:28px">
      <h2 style="margin:0 0 16px;font-size:1.1rem;color:#e6edf3">${title}</h2>
      <div style="font-size:.9rem;line-height:1.7;color:#8b949e">${body}</div>
      <a href="${ctaUrl}"
         style="display:inline-block;margin-top:24px;padding:12px 24px;background:#238636;color:#fff;text-decoration:none;border-radius:7px;font-weight:600;font-size:.9rem">
        ${ctaText}
      </a>
      <p style="margin:24px 0 0;font-size:.75rem;color:#6e7681">${footer}</p>
    </div>
  </div>
</body>
</html>`;
}
