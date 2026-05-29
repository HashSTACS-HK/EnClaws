/**
 * Email verification tokens (Phase 3, §9).
 *
 * Reuses the existing `password_reset_tokens` table by introducing a
 * new `purpose = 'verify-email'` value.  This avoids a schema change
 * and keeps all one-time auth tokens in one place.
 *
 * Flow:
 *   1. auth.register creates a user with status = 'invited' (the
 *      existing enum value — we overload its meaning for the SaaS
 *      self-verification case) and issues a verification token.
 *   2. A link is mailed to the user.  Clicking it hits
 *      auth.verifyEmail which flips status to 'active' and consumes
 *      the token.
 *   3. auth.login rejects 'invited' users with a special error so
 *      the frontend can render the "check your inbox" copy and offer
 *      a resend button.
 *
 * Configuration:
 *   ENCLAWS_REQUIRE_EMAIL_VERIFY=true   opt-in, default false
 */

import crypto from "node:crypto";
import { query, getDbType, DB_SQLITE } from "../db/index.js";

const TOKEN_BYTES = 48;

export function isEmailVerificationRequired(): boolean {
  return process.env.ENCLAWS_REQUIRE_EMAIL_VERIFY === "true";
}

function generateToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

/**
 * Issue a new verify-email token for the user.  Caller is responsible
 * for actually sending the email; this just writes the token row.
 */
export async function issueVerifyEmailToken(
  userId: string,
  ttlMinutes = 24 * 60,
): Promise<{ token: string; expiresAt: Date }> {
  const { token, tokenHash } = generateToken();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  if (getDbType() === DB_SQLITE) {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, purpose, expires_at)
       VALUES ($1, $2, $3, 'verify-email', $4)`,
      [id, userId, tokenHash, expiresAt.toISOString()],
    );
  } else {
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, purpose, expires_at)
       VALUES ($1, $2, 'verify-email', $3)`,
      [userId, tokenHash, expiresAt],
    );
  }
  return { token, expiresAt };
}

/**
 * Consume a verify-email token: returns the userId it belongs to on
 * success, or null if the token is unknown, expired, or already used.
 * Marks the token used atomically to prevent replays.
 */
export async function consumeVerifyEmailToken(token: string): Promise<string | null> {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const isSqlite = getDbType() === DB_SQLITE;
  const lhs = isSqlite ? "datetime(expires_at)" : "expires_at";
  const rhs = isSqlite ? "datetime('now')" : "NOW()";

  const found = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id AS "user_id"
       FROM password_reset_tokens
      WHERE token_hash = $1
        AND purpose = 'verify-email'
        AND used_at IS NULL
        AND ${lhs} > ${rhs}
      LIMIT 1`,
    [tokenHash],
  );
  if (found.rows.length === 0) {
    return null;
  }
  const id = String(found.rows[0].id);
  const userId = String(found.rows[0].user_id);
  const nowExpr = isSqlite ? "datetime('now')" : "NOW()";
  await query(
    `UPDATE password_reset_tokens SET used_at = ${nowExpr} WHERE id = $1 AND used_at IS NULL`,
    [id],
  );
  return userId;
}

// ---------------------------------------------------------------------------
// Per-email resend throttle — reuse the forgot-password throttle shape.
// ---------------------------------------------------------------------------

const RESEND_THROTTLE_MS = 5 * 60_000;
const lastSent = new Map<string, number>();

export function shouldThrottleResend(email: string): boolean {
  const key = email.trim().toLowerCase();
  if (!key) {
    return false;
  }
  const last = lastSent.get(key) ?? 0;
  return Date.now() - last < RESEND_THROTTLE_MS;
}

export function noteResendIssued(email: string): void {
  const key = email.trim().toLowerCase();
  if (key) {
    lastSent.set(key, Date.now());
  }
}
