// src/models/User.js
// ─────────────────────────────────────────────────────────────
// User model — stores all auth-related state.
//
// Security notes:
//   • password     — bcrypt hashed (NEVER stored in plain text)
//   • refreshTokenHash — SHA-256 hash of the refresh JWT
//                        (raw token lives in httpOnly cookie only)
//   • emailVerificationToken — SHA-256 hash of the raw token sent in email
//   • passwordResetToken     — SHA-256 hash of the raw token sent in email
//   All *Token fields store hashes. Raw values are only in transit.
// ─────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const { Schema, model } = mongoose;

const UserSchema = new Schema(
  {
    // ── Identity ──────────────────────────────────────────────
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      maxlength: [80, "Name must be 80 characters or fewer"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email format"],
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
      select: false, // never returned in queries by default
    },

    // ── Email verification ────────────────────────────────────
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerificationToken: {
      type: String,
      select: false,
    },
    emailVerificationExpires: {
      type: Date,
      select: false,
    },

    // ── Password reset ────────────────────────────────────────
    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
    },

    // ── Session management ────────────────────────────────────
    // Hash of the current refresh JWT — allows server-side invalidation.
    // Set to null on logout. One active session per user.
    refreshTokenHash: {
      type: String,
      select: false,
    },

    // ── GitHub connection (optional) ──────────────────────────
    githubId: {
      type: String,
      sparse: true, // allows null + unique index
      unique: true,
    },
    githubUsername: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true, // adds createdAt, updatedAt automatically
    versionKey: false,
  },
);

// ── Indexes ───────────────────────────────────────────────────
UserSchema.index({ email: 1 }); // login lookup
UserSchema.index({ emailVerificationToken: 1 }); // verify-email
UserSchema.index({ passwordResetToken: 1 }); // reset-password

// ── Pre-save hook — hash password if modified ─────────────────
UserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// ── Instance method — compare candidate password ──────────────
UserSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

// ── toJSON transform — strip internal fields from API responses ─
UserSchema.set("toJSON", {
  transform(doc, ret) {
    delete ret.password;
    delete ret.refreshTokenHash;
    delete ret.emailVerificationToken;
    delete ret.emailVerificationExpires;
    delete ret.passwordResetToken;
    delete ret.passwordResetExpires;
    return ret;
  },
});

export const User = model("User", UserSchema);
