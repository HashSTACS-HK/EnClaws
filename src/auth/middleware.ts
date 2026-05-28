/**
 * Authentication middleware for the gateway.
 *
 * Adds JWT-based authentication as a new auth method alongside the existing
 * token/password/tailscale methods. When JWT is present, the request is
 * enriched with tenant and user context.
 */

import type { IncomingMessage } from "node:http";
import { verifyAccessToken } from "./jwt.js";
import { hasPermission, mapMethodToPermission, mapRoleToGatewayScopes } from "./rbac.js";
import { getUserById } from "../db/models/user.js";
import { getTenantById } from "../db/models/tenant.js";
import { isDbInitialized } from "../db/index.js";
import type { JwtPayload, UserRole, Permission } from "../db/types.js";
import type { GatewayAuthResult } from "../gateway/auth.js";
import type { TenantContext as BaseTenantContext } from "../types/tenant-context.js";

/**
 * Tenant context attached to authenticated requests.
 *
 * Extends the base TenantContext (tenantId + userId) with auth-specific fields.
 * Since this is a structural superset, it can be passed anywhere a BaseTenantContext
 * is expected (e.g. path resolution functions).
 */
export interface TenantContext extends BaseTenantContext {
  email?: string;
  role: UserRole;
  /** Gateway scopes derived from the user's role */
  scopes: string[];
}

/**
 * Extended auth result with tenant context for JWT auth.
 */
export interface MultiTenantAuthResult extends GatewayAuthResult {
  tenant?: TenantContext;
}

/**
 * Extract Bearer token from Authorization header.
 */
function extractBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) {return null;}
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Try JWT authentication. Returns null if no JWT is present (fall through to
 * legacy auth), or a MultiTenantAuthResult if a JWT was found.
 */
export async function tryJwtAuth(req: IncomingMessage): Promise<MultiTenantAuthResult | null> {
  // Only attempt JWT auth if DB is initialized (multi-tenant mode)
  if (!isDbInitialized()) {return null;}

  const token = extractBearerToken(req);
  if (!token) {return null;}

  // Don't intercept legacy gateway tokens (they're typically hex strings, not JWTs)
  if (!token.includes(".")) {return null;}

  let payload: JwtPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return {
      ok: false,
      method: "token",
      reason: "Invalid or expired JWT token",
    };
  }

  // Validate user and tenant still exist and are active
  const [user, tenant] = await Promise.all([
    getUserById(payload.sub),
    getTenantById(payload.tid),
  ]);

  if (!user || user.status !== "active") {
    return { ok: false, method: "token", reason: "User account is not active" };
  }
  if (!tenant || tenant.status !== "active") {
    return { ok: false, method: "token", reason: "Tenant is not active" };
  }

  const scopes = mapRoleToGatewayScopes(user.role);

  return {
    ok: true,
    method: "token",
    user: user.email ?? undefined,
    tenant: {
      tenantId: tenant.id,
      userId: user.id,
      email: user.email ?? undefined,
      role: user.role,
      scopes,
    },
  };
}

/**
 * Check if the current tenant context has permission for a gateway method.
 */
export function authorizeTenantMethod(
  method: string,
  tenant: TenantContext,
): { allowed: true } | { allowed: false; reason: string } {
  const permission = mapMethodToPermission(method);
  if (!permission) {
    // No specific permission required — just need to be authenticated
    return { allowed: true };
  }

  if (hasPermission(tenant.role, permission)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Role '${tenant.role}' lacks permission '${permission}' for method '${method}'`,
  };
}

/**
 * Build a tenant-scoped session key prefix.
 * Transforms: agent:{agentId}:{session}
 * Into:       t:{tenantId}:agent:{agentId}:{session}
 */
export function tenantScopedSessionKey(tenantId: string, sessionKey: string): string {
  return `t:${tenantId}:${sessionKey}`;
}

/**
 * Extract tenant ID from a tenant-scoped session key.
 * Returns null if the key is not tenant-scoped.
 */
export function extractTenantFromSessionKey(
  sessionKey: string,
): { tenantId: string; innerKey: string } | null {
  const match = sessionKey.match(/^t:([^:]+):(.+)$/);
  if (!match) {return null;}
  return { tenantId: match[1], innerKey: match[2] };
}
