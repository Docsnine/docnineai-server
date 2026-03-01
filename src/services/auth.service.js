// ===================================================================
// All auth business logic lives here. Controllers call these
// functions — they never touch the database directly.
// ===================================================================

import { User } from "../../models/User.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../utils/jwt.util.js"; // verifyRefreshToken was missing
import { hashToken, generateSecureToken } from "../../utils/crypto.util.js";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "../../config/email.js";

// ── Signup ────────────────────────────────────────────────────

/**
 * Create a new user and send a verification email.
 * @returns {{ user: User, accessToken: string, refreshToken: string }}
 * @throws with code EMAIL_TAKEN if email already registered
 */
export async function signup({ name, email, password }) {
  const existing = await User.findOne({ email });
  if (existing) {
    const err = new Error("An account with this email already exists.");
    err.code = "EMAIL_TAKEN";
    err.status = 409;
    throw err;
  }

  // Raw token goes in the email link; only its hash is stored in DB.
  const rawToken = generateSecureToken();
  const hashedToken = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  const user = await User.create({
    name,
    email,
    password, // pre-save hook bcrypt-hashes this
    emailVerificationToken: hashedToken,
    emailVerificationExpires: expiresAt,
  });

  // Send verification email — fire-and-forget (don't fail signup if SMTP is down)
  sendVerificationEmail({ to: email, token: rawToken, name }).catch((err) =>
    console.error("⚠️  Failed to send verification email:", err.message),
  );

  const { accessToken, refreshToken } = await issueTokens(user);
  return { user, accessToken, refreshToken };
}

// ── Login ─────────────────────────────────────────────────────

/**
 * Validate credentials and issue tokens.
 * @returns {{ user: User, accessToken: string, refreshToken: string }}
 * @throws with code INVALID_CREDENTIALS (same message for bad email or bad password)
 */
export async function login({ email, password }) {
  // Select password field — excluded by default via schema
  const user = await User.findOne({ email }).select("+password");

  // Identical error for "not found" and "wrong password" to prevent email enumeration
  const invalidErr = () => {
    const e = new Error("Incorrect email or password.");
    e.code = "INVALID_CREDENTIALS";
    e.status = 401;
    return e;
  };

  if (!user) throw invalidErr();

  let match;
  try {
    match = await user.comparePassword(password);
  } catch (e) {
    if (e.message === "PASSWORD_LOGIN_NOT_AVAILABLE") {
      // OAuth-only account — tell the user which provider to use
      const providerName = user.provider === "github" ? "GitHub" : "Google";
      const oauthErr = new Error(
        `This account was created with ${providerName}. Please use "Continue with ${providerName}" to sign in.`,
      );
      oauthErr.code = "USE_OAUTH_PROVIDER";
      oauthErr.status = 400;
      throw oauthErr;
    }
    throw e;
  }
  if (!match) throw invalidErr();

  const { accessToken, refreshToken } = await issueTokens(user);
  return { user, accessToken, refreshToken };
}

// ── Logout ────────────────────────────────────────────────────

/**
 * Invalidate the refresh token in the database.
 * The httpOnly cookie is cleared by the controller.
 * @param {string} userId
 */
export async function logout(userId) {
  await User.findByIdAndUpdate(userId, { $unset: { refreshTokenHash: 1 } });
}

// ── Refresh session ───────────────────────────────────────────

/**
 * Validate the refresh token, rotate it, and return a new access token.
 *
 * Rotation strategy: each use mints a new refresh token and immediately
 * invalidates the old one. Any replay of the old token triggers a full
 * revocation (both DB hash cleared, forcing re-login).
 *
 * @param {string} rawRefreshToken  — value from the httpOnly cookie
 * @returns {{ user: User, accessToken: string, refreshToken: string }}
 */
export async function refreshSession(rawRefreshToken) {
  if (!rawRefreshToken) {
    const err = new Error("Refresh token is required.");
    err.code = "NO_REFRESH_TOKEN";
    err.status = 401;
    throw err;
  }

  // 1. Verify JWT signature and expiry
  let payload;
  try {
    payload = verifyRefreshToken(rawRefreshToken); // static import — no dynamic import needed
  } catch {
    const err = new Error(
      "Refresh token is invalid or has expired. Please log in again.",
    );
    err.code = "INVALID_REFRESH_TOKEN";
    err.status = 401;
    throw err;
  }

  // 2. Compare hash against DB to detect replay attacks
  const user = await User.findById(payload.sub).select("+refreshTokenHash");

  const storedHash = user?.refreshTokenHash;
  const incomingHash = hashToken(rawRefreshToken); // already statically imported

  if (!user || storedHash !== incomingHash) {
    // Hash mismatch: token was already rotated or user logged out.
    // Wipe the DB hash to force full re-login — assume token theft.
    if (user) {
      user.refreshTokenHash = undefined;
      await user.save();
    }
    const err = new Error(
      "Refresh token has already been used or revoked. Please log in again.",
    );
    err.code = "REFRESH_TOKEN_REUSED";
    err.status = 401;
    throw err;
  }

  // 3. Rotate: issue new pair (old token is now dead)
  const { accessToken, refreshToken } = await issueTokens(user);
  return { user, accessToken, refreshToken };
}

// ── Email verification ────────────────────────────────────────

/**
 * Mark email as verified using the token from the email link.
 * @param {string} rawToken
 */
export async function verifyEmail(rawToken) {
  const hashedToken = hashToken(rawToken);

  const user = await User.findOne({
    emailVerificationToken: hashedToken,
    emailVerificationExpires: { $gt: new Date() },
  }).select("+emailVerificationToken +emailVerificationExpires");

  if (!user) {
    const err = new Error("Email verification link is invalid or has expired.");
    err.code = "INVALID_VERIFICATION_TOKEN";
    err.status = 400;
    throw err;
  }

  user.isEmailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save();

  return user;
}

// ── Forgot password ───────────────────────────────────────────

/**
 * Generate a password-reset token and email it.
 * Always returns without throwing — prevents email enumeration.
 * @param {string} email
 */
export async function forgotPassword(email) {
  const user = await User.findOne({ email });
  if (!user) return; // No user — silently no-op; controller always sends 200

  const rawToken = generateSecureToken();
  const hashedToken = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  user.passwordResetToken = hashedToken;
  user.passwordResetExpires = expiresAt;
  await user.save();

  sendPasswordResetEmail({ to: email, token: rawToken, name: user.name }).catch(
    (err) =>
      console.error("⚠️  Failed to send password-reset email:", err.message),
  );
}

// ── Reset password ────────────────────────────────────────────

/**
 * Validate the reset token and set a new password.
 * @param {{ token: string, password: string }}
 */
export async function resetPassword({ token, password }) {
  const hashedToken = hashToken(token);

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: new Date() },
  }).select("+passwordResetToken +passwordResetExpires +password");

  if (!user) {
    const err = new Error("Password reset link is invalid or has expired.");
    err.code = "INVALID_RESET_TOKEN";
    err.status = 400;
    throw err;
  }

  user.password = password; // pre-save hook will re-hash
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  user.refreshTokenHash = undefined; // invalidate all sessions after reset
  await user.save();

  return user;
}

// ── Get current user ──────────────────────────────────────────

/**
 * Fetch the authenticated user's public profile.
 * @param {string} userId
 */
export async function getMe(userId) {
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error("User not found.");
    err.code = "USER_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  return user;
}

// ── Update profile ────────────────────────────────────────────

/**
 * Update user's name and/or email.
 */
export async function updateProfile(userId, { name, email }) {
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error("User not found.");
    err.code = "USER_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  if (name) user.name = name;
  if (email && email !== user.email) {
    const taken = await User.findOne({ email });
    if (taken) {
      const err = new Error("This email is already in use.");
      err.code = "EMAIL_TAKEN";
      err.status = 409;
      throw err;
    }
    user.email = email;
    user.isEmailVerified = false;
  }
  await user.save();
  return user;
}

/**
 * Change the user's password.
 */
export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await User.findById(userId).select("+password");
  if (!user) {
    const err = new Error("User not found.");
    err.code = "USER_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  if (!user.password) {
    const err = new Error("Password change is not available for OAuth accounts.");
    err.code = "OAUTH_ACCOUNT";
    err.status = 400;
    throw err;
  }
  const match = await user.comparePassword(currentPassword);
  if (!match) {
    const err = new Error("Current password is incorrect.");
    err.code = "INVALID_CREDENTIALS";
    err.status = 401;
    throw err;
  }
  user.password = newPassword;
  await user.save();
  return user;
}

// ── GitHub Social Login ───────────────────────────────────────

/**
 * Exchange a GitHub OAuth code (identity scope only) for a user,
 * find-or-create the account, and issue app tokens.
 *
 * IMPORTANT: This is separate from the GitHub repo-access OAuth.
 * Scopes used: read:user  user:email
 *
 * Env: GITHUB_LOGIN_CLIENT_ID  GITHUB_LOGIN_CLIENT_SECRET
 */
export async function githubSocialLogin(code) {
  const { GITHUB_LOGIN_CLIENT_ID, GITHUB_LOGIN_CLIENT_SECRET } = process.env;
  if (!GITHUB_LOGIN_CLIENT_ID || !GITHUB_LOGIN_CLIENT_SECRET) {
    const err = new Error(
      "GitHub Login requires GITHUB_LOGIN_CLIENT_ID and GITHUB_LOGIN_CLIENT_SECRET.",
    );
    err.code = "GITHUB_LOGIN_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }

  // 1. Exchange code for access token
  const { default: axios } = await import("axios");
  const tokenRes = await axios.post(
    "https://github.com/login/oauth/access_token",
    { client_id: GITHUB_LOGIN_CLIENT_ID, client_secret: GITHUB_LOGIN_CLIENT_SECRET, code },
    { headers: { Accept: "application/json" } },
  );
  const githubAccessToken = tokenRes.data.access_token;
  if (!githubAccessToken) {
    const err = new Error("GitHub did not return an access token. The code may have expired.");
    err.code = "GITHUB_CODE_INVALID";
    err.status = 400;
    throw err;
  }

  const ghHeaders = { Authorization: `Bearer ${githubAccessToken}` };

  // 2. Fetch profile and primary verified email in parallel
  const [userRes, emailsRes] = await Promise.all([
    axios.get("https://api.github.com/user", { headers: ghHeaders }),
    axios.get("https://api.github.com/user/emails", { headers: ghHeaders }),
  ]);

  const ghUser = userRes.data;
  const primaryEmail = emailsRes.data.find((e) => e.primary && e.verified)?.email;

  if (!primaryEmail) {
    const err = new Error("No verified primary email found on your GitHub account.");
    err.code = "GITHUB_NO_EMAIL";
    err.status = 400;
    throw err;
  }

  // 3. Find-or-create user
  let user = await User.findOne({ $or: [{ githubId: String(ghUser.id) }, { email: primaryEmail }] });

  if (!user) {
    user = await User.create({
      name: ghUser.name || ghUser.login,
      email: primaryEmail,
      provider: "github",
      githubId: String(ghUser.id),
      githubUsername: ghUser.login,
      isEmailVerified: true, // GitHub verified the email
    });
  } else {
    // Link GitHub identity if not already linked
    let changed = false;
    if (!user.githubId) {
      user.githubId = String(ghUser.id);
      user.githubUsername = ghUser.login;
      changed = true;
    }
    // Ensure email is marked verified (GitHub already verified it)
    if (!user.isEmailVerified) {
      user.isEmailVerified = true;
      changed = true;
    }
    if (changed) await user.save();
  }

  const { accessToken, refreshToken } = await issueTokens(user);
  return { user, accessToken, refreshToken };
}

// ── Google Social Login ───────────────────────────────────────

/**
 * Exchange a Google OAuth code (identity scope only) for a user,
 * find-or-create the account, and issue app tokens.
 *
 * Env: GOOGLE_LOGIN_CLIENT_ID  GOOGLE_LOGIN_CLIENT_SECRET  GOOGLE_LOGIN_REDIRECT_URI
 */
export async function googleSocialLogin(code) {
  const {
    GOOGLE_LOGIN_CLIENT_ID,
    GOOGLE_LOGIN_CLIENT_SECRET,
    GOOGLE_LOGIN_REDIRECT_URI,
  } = process.env;

  if (!GOOGLE_LOGIN_CLIENT_ID || !GOOGLE_LOGIN_CLIENT_SECRET || !GOOGLE_LOGIN_REDIRECT_URI) {
    const err = new Error(
      "Google Login requires GOOGLE_LOGIN_CLIENT_ID, GOOGLE_LOGIN_CLIENT_SECRET, " +
        "and GOOGLE_LOGIN_REDIRECT_URI.",
    );
    err.code = "GOOGLE_LOGIN_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }

  const { google } = await import("googleapis");
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_LOGIN_CLIENT_ID,
    GOOGLE_LOGIN_CLIENT_SECRET,
    GOOGLE_LOGIN_REDIRECT_URI,
  );

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const { data: profile } = await oauth2.userinfo.get();

  if (!profile.email || !profile.verified_email) {
    const err = new Error("No verified email found on your Google account.");
    err.code = "GOOGLE_NO_EMAIL";
    err.status = 400;
    throw err;
  }

  // Find-or-create user
  let user = await User.findOne({
    $or: [{ googleId: profile.id }, { email: profile.email }],
  });

  if (!user) {
    user = await User.create({
      name: profile.name,
      email: profile.email,
      provider: "google",
      googleId: profile.id,
      googleUsername: profile.name,
      isEmailVerified: true,
    });
  } else {
    let changed = false;
    if (!user.googleId) {
      user.googleId = profile.id;
      user.googleUsername = profile.name;
      changed = true;
    }
    if (!user.isEmailVerified) {
      user.isEmailVerified = true;
      changed = true;
    }
    if (changed) await user.save();
  }

  const { accessToken, refreshToken } = await issueTokens(user);
  return { user, accessToken, refreshToken };
}

// ── Generate OAuth start URLs ─────────────────────────────────

export function getGithubLoginUrl() {
  const { GITHUB_LOGIN_CLIENT_ID } = process.env;
  if (!GITHUB_LOGIN_CLIENT_ID) {
    const err = new Error("GITHUB_LOGIN_CLIENT_ID not configured.");
    err.code = "GITHUB_LOGIN_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }
  const params = new URLSearchParams({
    client_id: GITHUB_LOGIN_CLIENT_ID,
    scope: "read:user user:email",
    redirect_uri: process.env.GITHUB_LOGIN_REDIRECT_URI || "",
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export function getGoogleLoginUrl() {
  const {
    GOOGLE_LOGIN_CLIENT_ID,
    GOOGLE_LOGIN_REDIRECT_URI,
  } = process.env;
  if (!GOOGLE_LOGIN_CLIENT_ID || !GOOGLE_LOGIN_REDIRECT_URI) {
    const err = new Error("Google Login env vars not configured.");
    err.code = "GOOGLE_LOGIN_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_LOGIN_CLIENT_ID,
    redirect_uri: GOOGLE_LOGIN_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ── Internal ──────────────────────────────────────────────────

/**
 * Issue a new access+refresh token pair and persist the refresh token hash.
 * Called after every successful login/signup/token-rotation.
 */
async function issueTokens(user) {
  const accessToken = signAccessToken({
    userId: user._id.toString(),
    email: user.email,
  });
  const refreshToken = signRefreshToken({ userId: user._id.toString() });

  user.refreshTokenHash = hashToken(refreshToken);
  await user.save();

  return { accessToken, refreshToken };
}
