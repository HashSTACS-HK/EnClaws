/**
 * Password history — prevents reuse of the last N passwords.
 *
 * Phase 2 requirement (auth-security-roadmap.md §7):
 *   - every password change archives the OLD hash into password_history
 *   - a new password is rejected if it matches ANY of the last 5 hashes
 *
 * bcrypt comparison is per-hash (no way to fingerprint across salts), so
 * we do up to N bcrypt.compare() calls.  N=5 on bcrypt-12 = ~200ms in
 * the worst case, which is acceptable for an interactive change-password
 * action but would be expensive under load — the call site runs it AFTER
 * the user's current password is already verified.
 */

import crypto from "node:crypto";
import { query, getDbType, DB_SQLITE } from "../db/index.js";
import { verifyPassword } from "./password.js";

/** Number of prior passwords to check against. */
export const PASSWORD_HISTORY_LIMIT = 5;

/** Hard cap on rows retained per user (prevents unbounded growth). */
const PASSWORD_HISTORY_RETAIN = 20;

/**
 * Record the CURRENT password hash into history before it gets overwritten.
 * Call this BEFORE updating the user's password_hash.
 */
export async function archivePasswordHash(
  userId: string,
  currentHash: string,
): Promise<void> {
  if (!currentHash) {return;}
  if (getDbType() === DB_SQLITE) {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO password_history (id, user_id, password_hash) VALUES ($1, $2, $3)`,
      [id, userId, currentHash],
    );
  } else {
    await query(
      `INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)`,
      [userId, currentHash],
    );
  }
  await pruneHistory(userId);
}

/**
 * Check whether a new plaintext password matches any of the last
 * {@link PASSWORD_HISTORY_LIMIT} archived hashes for this user.
 *
 * Returns true if the password has been used recently (→ reject).
 */
export async function isPasswordInHistory(
  userId: string,
  newPassword: string,
): Promise<boolean> {
  const result = await query<{ password_hash: string }>(
    `SELECT password_hash FROM password_history
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, PASSWORD_HISTORY_LIMIT],
  );
  for (const row of result.rows) {
    if (await verifyPassword(newPassword, row.password_hash)) {
      return true;
    }
  }
  return false;
}

/**
 * Keep only the last {@link PASSWORD_HISTORY_RETAIN} rows per user.
 */
async function pruneHistory(userId: string): Promise<void> {
  // Note: the PG→SQLite adapter rewrites each $N → ? positionally, so a
  // placeholder that appears twice must be bound twice.  We pass userId
  // twice and use $1/$2 for the two occurrences accordingly.
  await query(
    `DELETE FROM password_history
      WHERE user_id = $1
        AND id NOT IN (
          SELECT id FROM password_history
           WHERE user_id = $2
           ORDER BY created_at DESC
           LIMIT $3
        )`,
    [userId, userId, PASSWORD_HISTORY_RETAIN],
  );
}

/** Test helper: wipe all history for a user. */
export async function clearPasswordHistory(userId: string): Promise<void> {
  await query(`DELETE FROM password_history WHERE user_id = $1`, [userId]);
}
