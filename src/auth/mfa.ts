/**
 * MFA lifecycle management (Phase 3, §11).
 *
 * Coordinates between the TOTP primitives (mfa-totp.ts) and the users
 * table.  The TOTP secret is encrypted at rest using the same
 * AES-256-GCM key as the temp-password payload (ENCLAWS_TEMP_PW_KEY or
 * an ephemeral per-process key).
 *
 * Challenge tokens:
 *   When a user with MFA enabled logs in, auth.login does NOT return
 *   real JWT tokens.  Instead it returns a short-lived "mfa challenge"
 *   token that can only be exchanged for real tokens via
 *   auth.mfa.verify.  Challenge tokens are stored in-memory (Map) and
 *   auto-expire after 5 minutes.
 */

import crypto from "node:crypto";
import { query, getDbType, DB_SQLITE } from "../db/index.js";
import {
  generateTOTPSecret,
  buildOtpauthUri,
  verifyTOTP,
  generateBackupCodes,
  verifyBackupCode,
} from "./mfa-totp.js";

// ---------------------------------------------------------------------------
// Secret encryption (same key derivation as password-reset.ts)
// ---------------------------------------------------------------------------

let ephemeralKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  const explicit = process.env.ENCLAWS_TEMP_PW_KEY;
  if (explicit) {
    if (/^[0-9a-fA-F]{64}$/.test(explicit)) {return Buffer.from(explicit, "hex");}
    return crypto.createHash("sha256").update(explicit).digest();
  }
  if (!ephemeralKey) {
    ephemeralKey = crypto.randomBytes(32);
  }
  return ephemeralKey;
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(b64: string): string | null {
  try {
    const buf = Buffer.from(b64, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MFA setup flow
// ---------------------------------------------------------------------------

export interface MfaSetupResult {
  secret: string;          // base32, shown to user once (they scan QR)
  otpauthUri: string;      // otpauth://totp/... for QR
  backupCodes: string[];   // plain, shown once
}

/**
 * Begin MFA setup: generate a secret + backup codes.  The secret is NOT
 * persisted until the user proves possession by calling `completeMfaSetup`.
 */
export function beginMfaSetup(email: string): MfaSetupResult {
  const secret = generateTOTPSecret();
  const uri = buildOtpauthUri(secret, email);
  const { plain } = generateBackupCodes();
  return { secret, otpauthUri: uri, backupCodes: plain };
}

/**
 * Complete MFA setup after the user has verified their first TOTP code.
 * Stores the encrypted secret + hashed backup codes on the user row.
 */
export async function completeMfaSetup(
  userId: string,
  base32Secret: string,
  backupCodesPlain: string[],
): Promise<void> {
  const encryptedSecret = encrypt(base32Secret);
  const hashedCodes = backupCodesPlain.map((c) =>
    crypto.createHash("sha256").update(c.trim().toUpperCase()).digest("hex"),
  );
  const codesJson = JSON.stringify(hashedCodes);
  const isSqlite = getDbType() === DB_SQLITE;
  const nowExpr = isSqlite ? "datetime('now')" : "NOW()";
  await query(
    `UPDATE users SET mfa_secret = $1, mfa_enabled = $2, mfa_backup_codes = $3, updated_at = ${nowExpr} WHERE id = $4`,
    [encryptedSecret, isSqlite ? 1 : true, codesJson, userId],
  );
}

/**
 * Disable MFA for a user (after password verification by the caller).
 */
export async function disableMfa(userId: string): Promise<void> {
  const isSqlite = getDbType() === DB_SQLITE;
  const nowExpr = isSqlite ? "datetime('now')" : "NOW()";
  await query(
    `UPDATE users SET mfa_secret = NULL, mfa_enabled = $1, mfa_backup_codes = NULL, updated_at = ${nowExpr} WHERE id = $2`,
    [isSqlite ? 0 : false, userId],
  );
}

/**
 * Verify a TOTP code for a user.  Returns true on success.
 */
export function verifyUserTotp(user: { mfaSecret: string | null }, code: string): boolean {
  if (!user.mfaSecret) {return false;}
  const plainSecret = decrypt(user.mfaSecret);
  if (!plainSecret) {return false;}
  return verifyTOTP(plainSecret, code);
}

/**
 * Try a backup code.  On match, removes it from the user's stored set
 * so it can't be replayed.  Returns true on success.
 */
export async function tryBackupCode(
  userId: string,
  mfaBackupCodes: string | null,
  code: string,
): Promise<boolean> {
  if (!mfaBackupCodes) {return false;}
  let hashes: string[];
  try {
    hashes = JSON.parse(mfaBackupCodes);
    if (!Array.isArray(hashes)) {return false;}
  } catch {
    return false;
  }

  const idx = verifyBackupCode(code, hashes);
  if (idx < 0) {return false;}

  // Remove the consumed code
  hashes.splice(idx, 1);
  const isSqlite = getDbType() === DB_SQLITE;
  const nowExpr = isSqlite ? "datetime('now')" : "NOW()";
  await query(
    `UPDATE users SET mfa_backup_codes = $1, updated_at = ${nowExpr} WHERE id = $2`,
    [JSON.stringify(hashes), userId],
  );
  return true;
}

// ---------------------------------------------------------------------------
// MFA challenge tokens (in-memory, auto-expire)
// ---------------------------------------------------------------------------

const CHALLENGE_TTL_MS = 5 * 60_000; // 5 minutes

interface ChallengeEntry {
  userId: string;
  tenantId: string;
  email: string | null;
  role: string;
  expiresAt: number;
}

const challengeStore = new Map<string, ChallengeEntry>();

// Prune timer
const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of challengeStore) {
    if (entry.expiresAt <= now) {challengeStore.delete(key);}
  }
}, 60_000);
if (pruneTimer.unref) {pruneTimer.unref();}

/**
 * Issue a challenge token after password-only login succeeds for an
 * MFA-enabled user.  The token is opaque and short-lived.
 */
export function issueMfaChallenge(params: {
  userId: string;
  tenantId: string;
  email: string | null;
  role: string;
}): string {
  const token = crypto.randomBytes(32).toString("base64url");
  challengeStore.set(token, {
    userId: params.userId,
    tenantId: params.tenantId,
    email: params.email,
    role: params.role,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return token;
}

/**
 * Consume a challenge token.  Returns the associated user info, or null
 * if expired/unknown.  The token is deleted on first use.
 */
export function consumeMfaChallenge(token: string): ChallengeEntry | null {
  const entry = challengeStore.get(token);
  if (!entry) {return null;}
  challengeStore.delete(token);
  if (entry.expiresAt <= Date.now()) {return null;}
  return entry;
}
