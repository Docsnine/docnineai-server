// src/config/email.js
// ─────────────────────────────────────────────────────────────
// Nodemailer transporter — configure via SMTP env vars.
// Falls back gracefully so the server starts even without email config.
//
// Required env (for real sending):
//   SMTP_HOST     — e.g. smtp.sendgrid.net | smtp.gmail.com
//   SMTP_PORT     — e.g. 587 (STARTTLS) | 465 (SSL)
//   SMTP_USER     — SMTP username / API key
//   SMTP_PASS     — SMTP password / API key
//   EMAIL_FROM    — sender address, e.g. noreply@yourdomain.com
//   APP_URL       — public URL, e.g. https://yourdomain.com (for links in emails)
//
// Without SMTP config: emails are logged to console (dev mode).
// ─────────────────────────────────────────────────────────────

import nodemailer from "nodemailer";

const APP_URL = process.env.APP_URL || "http://localhost:3000";
const FROM =
  process.env.EMAIL_FROM ||
  "Project Documentor <noreply@project-documentor.dev>";

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
  const link = `${APP_URL}/auth/verify-email?token=${token}`;
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: "Verify your Project Documentor email",
    text: `Hi ${name},\n\nVerify your email:\n${link}\n\nThis link expires in 24 hours.\n\nIgnore this if you didn't sign up.`,
    html: emailTemplate({
      title: "Verify your email",
      body: `<p>Hi <strong>${name}</strong>,</p><p>Click the button below to verify your email address. This link expires in <strong>24 hours</strong>.</p>`,
      ctaText: "Verify Email",
      ctaUrl: link,
      footer:
        "If you didn't create a Project Documentor account, you can ignore this email.",
    }),
  });
}

/**
 * Send a password reset link.
 * @param {{ to: string, token: string, name: string }} opts
 */
export async function sendPasswordResetEmail({ to, token, name }) {
  const link = `${APP_URL}/auth/reset-password?token=${token}`;
  await getTransporter().sendMail({
    from: FROM,
    to,
    subject: "Reset your Project Documentor password",
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

// ── Minimal branded HTML template ─────────────────────────────
function emailTemplate({ title, body, ctaText, ctaUrl, footer }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:40px 20px">
  <div style="max-width:480px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden">
    <div style="background:#1f6feb;padding:20px 28px">
      <p style="margin:0;font-size:1.1rem;font-weight:700;color:#fff">⚡ Project Documentor</p>
    </div>
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
