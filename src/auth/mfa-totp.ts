/**
 * TOTP (Time-based One-Time Password) — RFC 6238 / RFC 4226 implementation.
 *
 * Zero external dependencies: uses only Node.js built-in `crypto`.
 *
 * Design decisions:
 *   - SHA-1 HMAC (required by Google Authenticator compatibility)
 *   - 6-digit codes, 30-second step
 *   - ±1 step window for clock drift tolerance (covers ±30s)
 *   - base32 encoding for the secret (standard for otpauth:// URIs)
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Base32 (RFC 4648) — encode/decode for TOTP secrets
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.replace(/[=\s]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      throw new Error(`Invalid base32 character: ${ch}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// HOTP (RFC 4226) — core HMAC-based OTP
// ---------------------------------------------------------------------------

function hotp(secret: Buffer, counter: bigint, digits = 6): string {
  // Counter as big-endian 8-byte buffer
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);

  const hmac = crypto.createHmac("sha1", secret).update(counterBuf).digest();

  // Dynamic truncation (§5.4)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 10 ** digits).padStart(digits, "0");
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) — time-based wrapper around HOTP
// ---------------------------------------------------------------------------

const TOTP_STEP = 30; // seconds
const TOTP_DIGITS = 6;

function currentCounter(nowMs = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000 / TOTP_STEP));
}

/**
 * Generate the current TOTP code for a base32-encoded secret.
 */
export function generateTOTP(base32Secret: string, nowMs = Date.now()): string {
  const secret = base32Decode(base32Secret);
  return hotp(secret, currentCounter(nowMs), TOTP_DIGITS);
}

/**
 * Verify a user-supplied TOTP code against a base32-encoded secret.
 * Allows ±1 step (30s) window to tolerate clock drift.
 */
export function verifyTOTP(
  base32Secret: string,
  code: string,
  nowMs = Date.now(),
  windowSteps = 1,
): boolean {
  const secret = base32Decode(base32Secret);
  const counter = currentCounter(nowMs);
  const cleaned = code.replace(/\s/g, "");
  for (let i = -windowSteps; i <= windowSteps; i++) {
    if (hotp(secret, counter + BigInt(i), TOTP_DIGITS) === cleaned) {
      return true;
    }
  }
  return false;
}

/**
 * Generate a fresh 20-byte (160-bit) random TOTP secret.
 * Returns base32-encoded (the format used in otpauth:// URIs).
 */
export function generateTOTPSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Build the otpauth:// URI that QR code generators consume.
 *
 * @param secret  base32-encoded secret
 * @param email   account identifier (shown in authenticator apps)
 * @param issuer  display label (typically "EnClaws")
 */
export function buildOtpauthUri(secret: string, email: string, issuer = "EnClaws"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP}`;
}

// ---------------------------------------------------------------------------
// Backup codes — 10 one-time-use codes, stored as SHA-256 hashes
// ---------------------------------------------------------------------------

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 8;

/**
 * Generate a set of backup codes.  Returns both the plain codes (shown
 * once to the user) and their SHA-256 hashes (stored in the DB).
 */
export function generateBackupCodes(): {
  plain: string[];
  hashed: string[];
} {
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    // 8 alphanumeric chars, easy to type on mobile
    const code = crypto
      .randomBytes(6)
      .toString("base64url")
      .slice(0, BACKUP_CODE_LENGTH)
      .toUpperCase();
    plain.push(code);
    hashed.push(crypto.createHash("sha256").update(code).digest("hex"));
  }
  return { plain, hashed };
}

/**
 * Check a user-entered backup code against the stored hash array.
 * Returns the index of the matching code, or -1 if no match.
 * The caller should splice the matched hash out of the array after a
 * successful use so the code cannot be replayed.
 */
export function verifyBackupCode(code: string, hashedCodes: string[]): number {
  const hash = crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
  return hashedCodes.indexOf(hash);
}
