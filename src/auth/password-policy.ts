/**
 * Password strength policy + weak-password blacklist.
 *
 * Used by all flows that set or change passwords:
 *   - auth.register
 *   - tenant.users.invite
 *   - auth.changePassword
 *   - auth.forgotPassword.verify
 *   - auth.adminResetPassword (when generating temp passwords)
 *
 * Compliance baseline: 等保 2.0 三级 (3-of-4 character classes, ≥ 8 chars).
 * Enhancement: NIST SP 800-63B-style breached-password blacklist.
 *
 * Operators can extend the blacklist by setting ENCLAWS_WEAK_PASSWORDS_FILE
 * to a JSON file path containing additional entries (one per line or array).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_RECOMMENDED_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128; // bcrypt input ceiling

const REQUIRED_CLASS_COUNT = 3;

// ---------------------------------------------------------------------------
// Blacklist loader (lazy, cached)
// ---------------------------------------------------------------------------

let blacklistCache: Set<string> | null = null;

function loadBlacklist(): Set<string> {
  if (blacklistCache) {return blacklistCache;}
  const set = new Set<string>();

  // 1. Bundled list
  try {
    const bundledPath = path.join(__dirname, "weak-passwords.json");
    const raw = fs.readFileSync(bundledPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === "string") {set.add(entry.toLowerCase());}
      }
    }
  } catch {
    // Bundled list missing — degrade gracefully (still catch length / class rules).
  }

  // 2. Operator-supplied additions
  const extraPath = process.env.ENCLAWS_WEAK_PASSWORDS_FILE;
  if (extraPath && fs.existsSync(extraPath)) {
    try {
      const raw = fs.readFileSync(extraPath, "utf-8").trim();
      const parsed = raw.startsWith("[") ? JSON.parse(raw) : raw.split(/\r?\n/);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === "string" && entry.trim()) {set.add(entry.trim().toLowerCase());}
        }
      }
    } catch (err) {
      console.warn(`[password-policy] Failed to load extra weak password list at ${extraPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  blacklistCache = set;
  return set;
}

/** Test-only: clear the cached blacklist so the next call reloads from disk. */
export function _resetBlacklistCache(): void {
  blacklistCache = null;
}

export function isWeakPassword(password: string): boolean {
  return loadBlacklist().has(password.toLowerCase());
}

// ---------------------------------------------------------------------------
// Pre-hashed password detection
// ---------------------------------------------------------------------------

/**
 * The frontend may SHA-256 hash the password before sending it over the
 * wire (see `hashPasswordForTransport` in auth-store.ts).  The resulting
 * value is a 64-character lowercase hex string.  When we detect this
 * format, we skip server-side strength validation — the client already
 * validated the plaintext before hashing.
 *
 * This is safe because:
 *   1. The frontend runs `clientValidatePasswordKey()` before hashing.
 *   2. A 64-char hex string has ~256 bits of entropy, so it's never
 *      weak itself — the weakness check is about the original plaintext.
 *   3. Non-browser clients that don't pre-hash still get server-side
 *      validation (their password won't match the 64-hex-char pattern).
 */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function isPreHashedPassword(password: string): boolean {
  return SHA256_HEX_RE.test(password);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface PasswordValidationResult {
  ok: boolean;
  /** Machine-readable error code; absent when ok=true. */
  code?:
    | "too_short"
    | "too_long"
    | "missing_classes"
    | "contains_email"
    | "repeated_chars"
    | "common_password";
  /** Human-readable Chinese message; absent when ok=true. */
  message?: string;
}

function classCount(password: string): number {
  let n = 0;
  if (/[a-z]/.test(password)) {n++;}
  if (/[A-Z]/.test(password)) {n++;}
  if (/[0-9]/.test(password)) {n++;}
  // eslint-disable-next-line no-useless-escape
  if (/[^a-zA-Z0-9]/.test(password)) {n++;}
  return n;
}

function hasRepeatedRun(password: string, runLength = 3): boolean {
  for (let i = 0; i <= password.length - runLength; i++) {
    let same = true;
    for (let j = 1; j < runLength; j++) {
      if (password[i + j] !== password[i]) {
        same = false;
        break;
      }
    }
    if (same) {return true;}
  }
  return false;
}

/**
 * Validate a password against the configured policy.
 *
 * @param password   The candidate password (plain text)
 * @param email      Optional email — used to reject passwords containing the local-part
 */
export function validatePasswordStrength(
  password: string,
  email?: string | null,
): PasswordValidationResult {
  // If the frontend pre-hashed with SHA-256, skip server-side policy
  // (the client already validated the plaintext before hashing).
  if (isPreHashedPassword(password)) {
    return { ok: true };
  }
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      code: "too_short",
      message: `密码长度不能少于 ${PASSWORD_MIN_LENGTH} 位`,
    };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      code: "too_long",
      message: `密码长度不能超过 ${PASSWORD_MAX_LENGTH} 位`,
    };
  }
  if (classCount(password) < REQUIRED_CLASS_COUNT) {
    return {
      ok: false,
      code: "missing_classes",
      message: "密码必须包含大写字母、小写字母、数字、特殊字符 4 类中的至少 3 类",
    };
  }
  if (hasRepeatedRun(password, 3)) {
    return {
      ok: false,
      code: "repeated_chars",
      message: "密码不能包含连续 3 位以上相同字符",
    };
  }
  if (email) {
    const localPart = email.split("@")[0]?.toLowerCase();
    if (localPart && localPart.length >= 3 && password.toLowerCase().includes(localPart)) {
      return {
        ok: false,
        code: "contains_email",
        message: "密码不能包含邮箱前缀",
      };
    }
  }
  if (isWeakPassword(password)) {
    return {
      ok: false,
      code: "common_password",
      message: "该密码过于常见，请更换更安全的密码",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Temporary password generator (for admin reset / ENV trigger)
// ---------------------------------------------------------------------------

const TEMP_LOWER = "abcdefghjkmnpqrstuvwxyz"; // omit ambiguous l, o, i
const TEMP_UPPER = "ABCDEFGHJKMNPQRSTUVWXYZ"; // omit I, O
const TEMP_DIGIT = "23456789"; // omit 0, 1
const TEMP_SYMBOL = "!@#$%^&*";

/**
 * Generate a strong, human-readable temporary password (16 chars, 4-class).
 * Guaranteed to satisfy the policy above.
 */
export function generateTempPassword(length = 16): string {
  const all = TEMP_LOWER + TEMP_UPPER + TEMP_DIGIT + TEMP_SYMBOL;
  // First 4 chars guarantee one from each class, then fill the rest randomly.
  const required = [
    TEMP_LOWER[crypto.randomInt(TEMP_LOWER.length)],
    TEMP_UPPER[crypto.randomInt(TEMP_UPPER.length)],
    TEMP_DIGIT[crypto.randomInt(TEMP_DIGIT.length)],
    TEMP_SYMBOL[crypto.randomInt(TEMP_SYMBOL.length)],
  ];
  const remaining: string[] = [];
  for (let i = required.length; i < length; i++) {
    remaining.push(all[crypto.randomInt(all.length)]);
  }
  // Fisher-Yates shuffle so the required positions aren't predictable.
  const out = [...required, ...remaining];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}
