// src/utils/crypto.util.js
// ─────────────────────────────────────────────────────────────
// AES-256-GCM authenticated encryption for secrets stored in MongoDB.
// Used to encrypt GitHub OAuth access tokens before persistence.
//
// Format: "<iv_hex>.<authTag_hex>.<ciphertext_hex>"
// All three parts are needed to decrypt. Tampering with any part
// causes authentication failure (authTag mismatch).
//
// WHY lazy key read: same ESM/dotenv race as jwt.util.js — env vars
// from .env are not available at module evaluation time.
//
// Required env:
//   ENCRYPTION_KEY — exactly 64 hex characters (= 32 bytes)
//   Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// ─────────────────────────────────────────────────────────────

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "crypto";

const ALG = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV — GCM recommendation (NIST SP 800-38D)

/** Read and validate the encryption key at call-time (after dotenv.config). */
function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be exactly 64 hex characters in .env\n" +
        "Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return Buffer.from(raw, "hex");
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param {string} plaintext
 * @returns {string}  "<iv>.<authTag>.<ciphertext>" — safe to store in MongoDB
 */
export function encrypt(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag(); // 128-bit tag (GCM default)

  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(".");
}

/**
 * Decrypt a value produced by encrypt().
 * @param {string} stored  "<iv>.<authTag>.<ciphertext>"
 * @returns {string}  original plaintext
 * @throws if the ciphertext has been tampered with
 */
export function decrypt(stored) {
  const parts = stored.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted value format");

  const [ivHex, authTagHex, dataHex] = parts;
  const key = getKey();
  const decipher = createDecipheriv(ALG, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  return (
    decipher.update(Buffer.from(dataHex, "hex"), undefined, "utf8") +
    decipher.final("utf8")
  );
}

/**
 * One-way hash for tokens that need only equality checks (e.g. refresh tokens).
 * SHA-256 is sufficient — these tokens have high entropy (JWT/random hex).
 * @param {string} token
 * @returns {string} hex digest
 */
export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Generate a cryptographically secure random hex token.
 * @param {number} bytes  default 32 → 64-char hex string
 * @returns {string}
 */
export function generateSecureToken(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}
