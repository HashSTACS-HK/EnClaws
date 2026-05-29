/**
 * Active-sessions API (Phase 3, §10).
 *
 * Surfaces the per-user list of active refresh tokens so that the
 * sessions UI can show "this is me on Chrome/macOS, signed in 2 days
 * ago from 114.5.6.7" entries and let the user revoke individual
 * sessions or "all others".
 *
 * A "session" in this layer is exactly one non-revoked, non-expired
 * row in `refresh_tokens`.  When the access token is refreshed, the
 * row's `last_used_at` is bumped so the UI can sort by recency.
 */

import crypto from "node:crypto";
import { query, getDbType, DB_SQLITE } from "../db/index.js";
import { parseUserAgent } from "./user-agent-parser.js";

export interface SessionSummary {
  id: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  label: string;
  isCurrent: boolean;
}

interface DeviceInfoBlob {
  ip?: string | null;
  ua?: string | null;
  label?: string | null;
}

function parseDeviceInfo(raw: unknown): DeviceInfoBlob {
  if (!raw) {
    return {};
  }
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as DeviceInfoBlob;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function toDate(value: unknown): Date | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  const d = new Date(String(value));
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * List all currently-active sessions for a user (non-revoked, not expired).
 *
 * The currently-used refresh token (if any) is marked `isCurrent: true`
 * so the UI can render a "this device" tag and nudge the user to pick
 * something else before revoking it.
 */
export async function listUserSessions(
  userId: string,
  currentRefreshToken?: string | null,
): Promise<SessionSummary[]> {
  const isSqlite = getDbType() === DB_SQLITE;
  const lhs = isSqlite ? "datetime(expires_at)" : "expires_at";
  const rhs = isSqlite ? "datetime('now')" : "NOW()";
  // SQLite stores revoked as INTEGER (0/1), PG as BOOLEAN.  Use a
  // db-specific predicate to stay type-correct on both.
  const notRevoked = isSqlite ? "revoked = 0" : "revoked = false";

  const result = await query<Record<string, unknown>>(
    `SELECT id, token_hash, device_info, ip_address, expires_at,
            last_used_at, created_at, revoked
       FROM refresh_tokens
      WHERE user_id = $1
        AND ${notRevoked}
        AND ${lhs} > ${rhs}
      ORDER BY COALESCE(last_used_at, created_at) DESC
      LIMIT 100`,
    [userId],
  );

  const rows = result.rows;

  const currentHash = currentRefreshToken
    ? crypto.createHash("sha256").update(currentRefreshToken).digest("hex")
    : null;

  return rows.map((row) => {
    const info = parseDeviceInfo(row.device_info);
    const ua = info.ua ?? null;
    const label = info.label ?? parseUserAgent(ua).label;
    const tokenHash = String(row.token_hash);
    const createdAt = toDate(row.created_at) ?? new Date(0);
    const expiresAt = toDate(row.expires_at) ?? new Date(0);
    return {
      id: String(row.id),
      createdAt,
      lastUsedAt: toDate(row.last_used_at),
      expiresAt,
      ipAddress: (row.ip_address as string) ?? info.ip ?? null,
      userAgent: ua,
      label,
      isCurrent: currentHash !== null && tokenHash === currentHash,
    };
  });
}

/**
 * Bump last_used_at on a specific refresh token (called from auth.refresh).
 * Best-effort; never throws.
 */
export async function touchSession(refreshToken: string): Promise<void> {
  const hash = crypto.createHash("sha256").update(refreshToken).digest("hex");
  const nowExpr = getDbType() === DB_SQLITE ? "datetime('now')" : "NOW()";
  try {
    await query(`UPDATE refresh_tokens SET last_used_at = ${nowExpr} WHERE token_hash = $1`, [
      hash,
    ]);
  } catch {
    /* ignore */
  }
}

/**
 * Revoke a single session by id.  The session must belong to the
 * requesting user — caller is expected to enforce that.
 */
export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const isSqlite = getDbType() === DB_SQLITE;
  const trueVal = isSqlite ? 1 : true;
  const result = await query(
    `UPDATE refresh_tokens SET revoked = $1 WHERE id = $2 AND user_id = $3`,
    [trueVal, sessionId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Revoke every session for this user EXCEPT the one that the current
 * refresh token belongs to.  Useful for "log out other devices".
 */
export async function revokeOtherSessions(
  userId: string,
  keepRefreshToken: string,
): Promise<number> {
  const isSqlite = getDbType() === DB_SQLITE;
  const trueVal = isSqlite ? 1 : true;
  const notRevoked = isSqlite ? "revoked = 0" : "revoked = false";
  const keepHash = crypto.createHash("sha256").update(keepRefreshToken).digest("hex");
  const result = await query(
    `UPDATE refresh_tokens SET revoked = $1
      WHERE user_id = $2
        AND token_hash <> $3
        AND ${notRevoked}`,
    [trueVal, userId, keepHash],
  );
  return result.rowCount ?? 0;
}
