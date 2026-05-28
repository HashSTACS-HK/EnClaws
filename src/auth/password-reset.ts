/**
 * Password reset token store.
 *
 * Two distinct token purposes share the `password_reset_tokens` table:
 *
 *   - "reset"      → forgot-password email link.  Holds no payload.
 *                    The user supplies a new password when consuming it.
 *   - "view-temp"  → admin-generated one-time link that reveals a
 *                    system-generated temporary password ONCE, then is
 *                    deleted.  The temp password is stored in `payload`
 *                    encrypted under ENCLAWS_TEMP_PW_KEY (or, if absent,
 *                    a per-process ephemeral key — equivalent to "lost
 *                    on restart" semantics).
 *
 * Tokens are stored as SHA-256 hashes; only the original 48-byte token
 * (base64url) is ever returned to the caller, never persisted in plain.
 */

import crypto from "node:crypto";
import { query, getDbType, DB_SQLITE } from "../db/index.js";

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

const TOKEN_BYTES = 48;

function generateToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

// ---------------------------------------------------------------------------
// Payload encryption (for view-temp tokens)
// ---------------------------------------------------------------------------

let ephemeralPayloadKey: Buffer | null = null;

function getPayloadKey(): Buffer {
  const explicit = process.env.ENCLAWS_TEMP_PW_KEY;
  if (explicit) {
    // Accept either hex (64 chars = 32 bytes) or any-length string hashed to 32 bytes.
    if (/^[0-9a-fA-F]{64}$/.test(explicit)) {
      return Buffer.from(explicit, "hex");
    }
    return crypto.createHash("sha256").update(explicit).digest();
  }
  if (!ephemeralPayloadKey) {
    ephemeralPayloadKey = crypto.randomBytes(32);
    console.log("[password-reset] No ENCLAWS_TEMP_PW_KEY set — temp passwords are lost on restart");
  }
  return ephemeralPayloadKey;
}

function encryptPayload(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getPayloadKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptPayload(b64: string): string | null {
  try {
    const buf = Buffer.from(b64, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", getPayloadKey(), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ResetTokenPurpose = "reset" | "view-temp";

export interface IssuedToken {
  /** The plaintext token to deliver to the recipient. Never persisted. */
  token: string;
  /** When the token expires (epoch ms). */
  expiresAt: Date;
}

/**
 * Issue a forgot-password reset token (no payload).
 */
export async function issueResetToken(
  userId: string,
  ttlMinutes = 30,
): Promise<IssuedToken> {
  const { token, tokenHash } = generateToken();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  await insertToken({ userId, tokenHash, purpose: "reset", payload: null, expiresAt });
  return { token, expiresAt };
}

/**
 * Issue a view-temp link that reveals a one-time temporary password.
 * Default TTL is 24h to give a busy admin time to forward the link.
 */
export async function issueViewTempToken(
  userId: string,
  tempPassword: string,
  ttlMinutes = 24 * 60,
): Promise<IssuedToken> {
  const { token, tokenHash } = generateToken();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  await insertToken({
    userId,
    tokenHash,
    purpose: "view-temp",
    payload: encryptPayload(tempPassword),
    expiresAt,
  });
  return { token, expiresAt };
}

/**
 * Look up a reset token by its plaintext value.
 * Does NOT mark it as used — call {@link consumeResetToken} after the
 * caller has actually performed the action.
 */
export async function findResetToken(
  token: string,
  purpose: ResetTokenPurpose,
): Promise<{ id: string; userId: string; payload: string | null } | null> {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  // Critical: in SQLite mode we wrap BOTH sides of the comparison in
  // datetime() so the stored ISO-8601 string (with 'T' separator and 'Z'
  // suffix) and the runtime `datetime('now')` (with space separator, no
  // 'Z') normalize to the same canonical format.  Without this, the raw
  // string compare would make "2026-04-09T09:00:00.000Z" > "2026-04-09
  // 10:00:00" always true (because 'T' (0x54) > ' ' (0x20)), and
  // expired tokens would stay valid forever.
  const isSqlite = getDbType() === DB_SQLITE;
  const lhs = isSqlite ? "datetime(expires_at)" : "expires_at";
  const rhs = isSqlite ? "datetime('now')" : "NOW()";
  const result = await query(
    `SELECT id, user_id AS "user_id", payload
       FROM password_reset_tokens
      WHERE token_hash = $1
        AND purpose = $2
        AND used_at IS NULL
        AND ${lhs} > ${rhs}
      LIMIT 1`,
    [tokenHash, purpose],
  );
  if (result.rows.length === 0) {return null;}
  const row = result.rows[0] as Record<string, unknown>;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    payload: (row.payload as string | null) ?? null,
  };
}

/**
 * Mark a token as consumed.  Idempotent: a second call is a no-op.
 */
export async function consumeResetToken(id: string): Promise<void> {
  const nowExpr = getDbType() === DB_SQLITE ? "datetime('now')" : "NOW()";
  await query(
    `UPDATE password_reset_tokens SET used_at = ${nowExpr} WHERE id = $1 AND used_at IS NULL`,
    [id],
  );
}

/**
 * Decrypt a view-temp token payload.  Returns null if the payload is
 * missing or the ciphertext is invalid (e.g. key changed).
 */
export function decryptTempPasswordPayload(payload: string | null): string | null {
  if (!payload) {return null;}
  return decryptPayload(payload);
}

/**
 * Revoke any outstanding reset tokens for a user (called after a
 * successful password change so old links can't be replayed).
 */
export async function revokeAllResetTokens(userId: string): Promise<void> {
  const nowExpr = getDbType() === DB_SQLITE ? "datetime('now')" : "NOW()";
  await query(
    `UPDATE password_reset_tokens SET used_at = ${nowExpr} WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
}

// ---------------------------------------------------------------------------
// Internal: insert
// ---------------------------------------------------------------------------

async function insertToken(opts: {
  userId: string;
  tokenHash: string;
  purpose: ResetTokenPurpose;
  payload: string | null;
  expiresAt: Date;
}): Promise<void> {
  if (getDbType() === DB_SQLITE) {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, purpose, payload, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, opts.userId, opts.tokenHash, opts.purpose, opts.payload, opts.expiresAt.toISOString()],
    );
    return;
  }
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, purpose, payload, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [opts.userId, opts.tokenHash, opts.purpose, opts.payload, opts.expiresAt],
  );
}

// ---------------------------------------------------------------------------
// Per-email forgot-password throttle (5 minutes per address)
// ---------------------------------------------------------------------------

const FORGOT_THROTTLE_MS = 5 * 60_000;
const forgotLastSeen = new Map<string, number>();

export function shouldThrottleForgot(email: string): boolean {
  const key = email.trim().toLowerCase();
  if (!key) {return false;}
  const last = forgotLastSeen.get(key) ?? 0;
  return Date.now() - last < FORGOT_THROTTLE_MS;
}

export function noteForgotIssued(email: string): void {
  const key = email.trim().toLowerCase();
  if (key) {forgotLastSeen.set(key, Date.now());}
}
