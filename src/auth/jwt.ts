/**
 * JWT token management for multi-tenant auth.
 *
 * Environment variables:
 *   ENCLAWS_JWT_SECRET            - Secret key for signing tokens (required)
 *   ENCLAWS_JWT_ACCESS_EXPIRES    - Access token TTL (default: "15m")
 *   ENCLAWS_JWT_REFRESH_EXPIRES   - Refresh token TTL (default: "7d")
 */

import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { query, getDbType, DB_SQLITE } from "../db/index.js";
import type { JwtPayload, JwtTokenPair } from "../db/types.js";

/**
 * Per-boot ephemeral secret: generated once on startup so that all
 * previously issued JWTs are automatically invalidated on restart.
 * Only used when ENCLAWS_JWT_SECRET is not explicitly configured.
 */
let ephemeralSecret: string | null = null;

function getSecret(): string {
  const secret = process.env.ENCLAWS_JWT_SECRET;
  if (secret) {
    return secret;
  }
  if (!ephemeralSecret) {
    ephemeralSecret = crypto.randomBytes(64).toString("hex");
    console.log(
      "[auth] No ENCLAWS_JWT_SECRET set — using ephemeral secret (JWTs invalidated on restart)",
    );
    // Revoke all refresh tokens so that old sessions cannot silently re-authenticate
    void revokeAllRefreshTokensOnBoot();
  }
  return ephemeralSecret;
}

async function revokeAllRefreshTokensOnBoot(): Promise<void> {
  try {
    const result = await query("UPDATE refresh_tokens SET revoked = true WHERE revoked = false");
    const count = result.rowCount ?? 0;
    if (count > 0) {
      console.log(`[auth] Revoked ${count} refresh token(s) on boot (ephemeral secret mode)`);
    }
  } catch {
    // DB may not be initialized yet; ignore — tokens will fail verification anyway
  }
}

function getAccessExpires(): string {
  return process.env.ENCLAWS_JWT_ACCESS_EXPIRES ?? "15m";
}

function getRefreshExpires(): string {
  return process.env.ENCLAWS_JWT_REFRESH_EXPIRES ?? "7d";
}

function parseExpiresIn(expr: string): number {
  const match = expr.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    return 900;
  } // default 15 minutes
  const num = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s":
      return num;
    case "m":
      return num * 60;
    case "h":
      return num * 3600;
    case "d":
      return num * 86400;
    default:
      return 900;
  }
}

/**
 * Generate an access + refresh token pair.
 *
 * @param deviceInfo  Phase 3: serializable summary of the device issuing
 *                    this session (user-agent label, IP).  Stored on the
 *                    refresh_tokens row so the sessions UI can list active
 *                    devices and let users revoke them individually.
 */
export async function generateTokenPair(
  payload: JwtPayload,
  deviceInfo?: { ip?: string | null; userAgent?: string | null; label?: string | null },
): Promise<JwtTokenPair> {
  const secret = getSecret();
  const accessExpiresExpr = getAccessExpires();
  const refreshExpiresExpr = getRefreshExpires();

  const accessToken = jwt.sign(payload, secret, {
    expiresIn: parseExpiresIn(accessExpiresExpr),
    issuer: "enclaws",
    audience: "enclaws-api",
  });

  // Refresh token is an opaque random string stored in DB
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const refreshTokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");

  const refreshExpiresInSeconds = parseExpiresIn(refreshExpiresExpr);
  const expiresAt = new Date(Date.now() + refreshExpiresInSeconds * 1000);

  // Serialize device_info as JSON so the UA string, label, and any
  // future fields can live in one column without another schema change.
  const deviceInfoJson = deviceInfo
    ? JSON.stringify({
        ip: deviceInfo.ip ?? null,
        ua: deviceInfo.userAgent ?? null,
        label: deviceInfo.label ?? null,
      })
    : null;

  const isSqlite = getDbType() === DB_SQLITE;
  const nowExpr = isSqlite ? "datetime('now')" : "NOW()";
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, device_info, ip_address, last_used_at)
     VALUES ($1, $2, $3, $4, $5, ${nowExpr})`,
    [payload.sub, refreshTokenHash, expiresAt, deviceInfoJson, deviceInfo?.ip ?? null],
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: parseExpiresIn(accessExpiresExpr),
  };
}

/**
 * Verify and decode an access token.
 */
export function verifyAccessToken(token: string): JwtPayload {
  const secret = getSecret();
  const decoded = jwt.verify(token, secret, {
    issuer: "enclaws",
    audience: "enclaws-api",
  });
  return decoded as JwtPayload;
}

/**
 * Verify a refresh token and return the associated user ID.
 * Consumes the refresh token (one-time use rotation).
 */
export async function verifyRefreshToken(refreshToken: string): Promise<{ userId: string } | null> {
  const tokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");

  const now = getDbType() === DB_SQLITE ? "datetime('now')" : "NOW()";
  const result = await query(
    `UPDATE refresh_tokens
     SET revoked = true
     WHERE token_hash = $1 AND revoked = false AND expires_at > ${now}
     RETURNING user_id`,
    [tokenHash],
  );

  if (result.rows.length === 0) {
    return null;
  }
  return { userId: result.rows[0].user_id as string };
}

/**
 * Revoke all refresh tokens for a user (e.g., on password change or logout-all).
 */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await query("UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND revoked = false", [
    userId,
  ]);
}

/**
 * Clean up expired refresh tokens (call periodically).
 */
export async function cleanupExpiredTokens(): Promise<number> {
  const now = getDbType() === DB_SQLITE ? "datetime('now')" : "NOW()";
  const result = await query(
    `DELETE FROM refresh_tokens WHERE expires_at < ${now} OR revoked = true`,
  );
  return result.rowCount ?? 0;
}
