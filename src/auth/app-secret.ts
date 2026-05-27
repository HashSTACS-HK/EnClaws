/**
 * Bearer <appSecret> authentication for Agenora S2 jiumi integration.
 *
 * External upstream apps authenticate with a Bearer token that is a plain-text
 * app secret. The secret is stored as a bcrypt hash. During a rotation grace
 * period both the old and new secrets are accepted.
 *
 * 上层应用通过 Bearer appSecret 鉴权。密钥以 bcrypt 哈希存储。
 * 轮换宽限期内新旧密钥均有效。
 */

import bcrypt from "bcryptjs";
import type { IncomingMessage } from "node:http";
import {
  getCsApiObjectByAppId,
  touchLastUsed,
  clearExpiredRotation,
} from "../db/models/cs-api-object.js";

// ── Return type ───────────────────────────────────────────────────────────────

/** Context returned on successful authentication. */
export interface AppSecretTenantContext {
  tenantId: string;
  appId: string;
  appObjectId: string;
  agentId: string;
}

export type AppSecretAuthResult =
  | { ok: true; tenant: AppSecretTenantContext }
  | {
      ok: false;
      code: "INVALID_APP_SECRET" | "OBJECT_NOT_FOUND" | "OBJECT_INACTIVE" | "MISSING_AUTH";
      message: string;
    };

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the raw secret from the Authorization: Bearer <secret> header.
 * Returns null if the header is absent or malformed.
 */
function extractBearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") { return null; }
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Try to authenticate a request using a Bearer app secret.
 *
 * Order of checks:
 *   1. Header presence
 *   2. appId lookup (global, no tenant scope needed — appId is already unique)
 *   3. isActive flag
 *   4. Lazy-clear expired rotation window
 *   5. bcrypt compare against primary hash (appSecretHash)
 *   6. bcrypt compare against rotating-from hash if within grace period
 *
 * 鉴权顺序：Header → appId → isActive → 过期清理 → 主密钥比对 → 轮换旧密钥比对
 */
export async function tryAppSecretAuth(
  req: IncomingMessage,
  appId: string,
): Promise<AppSecretAuthResult> {
  const secret = extractBearer(req);
  if (!secret) {
    return { ok: false, code: "MISSING_AUTH", message: "Authorization Bearer header missing" };
  }

  const obj = await getCsApiObjectByAppId(appId);
  if (!obj) {
    return { ok: false, code: "OBJECT_NOT_FOUND", message: `appId not found: ${appId}` };
  }
  if (!obj.isActive) {
    return { ok: false, code: "OBJECT_INACTIVE", message: "API Object is inactive" };
  }

  // Lazy-clear rotation state that has already expired
  if (obj.rotatingUntil && obj.rotatingUntil < new Date()) {
    await clearExpiredRotation(obj.id);
  }

  // Try primary (current) secret
  if (await bcrypt.compare(secret, obj.appSecretHash)) {
    await touchLastUsed(obj.id);
    return {
      ok: true,
      tenant: {
        tenantId: obj.tenantId,
        appId: obj.appId,
        appObjectId: obj.id,
        agentId: obj.agentId,
      },
    };
  }

  // Try old (rotating-from) secret while still within the grace period
  if (obj.rotatingFromHash && obj.rotatingUntil && obj.rotatingUntil > new Date()) {
    if (await bcrypt.compare(secret, obj.rotatingFromHash)) {
      await touchLastUsed(obj.id);
      return {
        ok: true,
        tenant: {
          tenantId: obj.tenantId,
          appId: obj.appId,
          appObjectId: obj.id,
          agentId: obj.agentId,
        },
      };
    }
  }

  return { ok: false, code: "INVALID_APP_SECRET", message: "Invalid app secret" };
}
