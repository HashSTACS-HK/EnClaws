/**
 * Gateway RPC handlers for tenant and user management.
 *
 * Methods:
 *   tenant.get            - Get current tenant info
 *   tenant.update         - Update tenant settings
 *   tenant.users.list     - List users in tenant
 *   tenant.users.invite   - Invite a new user
 *   tenant.users.update   - Update user role/status
 *   tenant.users.remove   - Remove user from tenant
 *   tenant.audit.list     - List audit logs
 */

import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import { ErrorCodes, errorShape, getPlanUpgradeLink } from "../protocol/index.js";
import { getTenantById, updateTenant, checkTenantQuota, getMonthlyTokenUsage } from "../../db/models/tenant.js";
import { createUser, listUsers, updateUser, deleteUser, getUserById, findUserByEmail } from "../../db/models/user.js";
import { validatePasswordStrength } from "../../auth/password-policy.js";
import { listAuditLogs, createAuditLog } from "../../db/models/audit-log.js";
import { assertPermission } from "../../auth/rbac.js";
import { RbacError } from "../../auth/rbac.js";
import { isDbInitialized } from "../../db/index.js";
import type { TenantContext } from "../../auth/middleware.js";
import type { UserRole } from "../../db/types.js";

function getTenantCtx(
  client: GatewayRequestHandlerOptions["client"],
  respond: GatewayRequestHandlerOptions["respond"],
): TenantContext | null {
  if (!isDbInitialized()) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Multi-tenant mode not enabled"));
    return null;
  }
  const tenant = (client as unknown as { tenant?: TenantContext })?.tenant;
  if (!tenant) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Authentication required"));
    return null;
  }
  return tenant;
}

function handleRbacError(err: unknown, respond: GatewayRequestHandlerOptions["respond"]): boolean {
  if (err instanceof RbacError) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
    return true;
  }
  return false;
}

export const tenantHandlers: GatewayRequestHandlers = {
  /**
   * Get current tenant info and quotas.
   */
  "tenant.get": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "tenant.read");
    } catch (err) {
      if (handleRbacError(err, respond)) {return;}
      throw err;
    }

    const tenant = await getTenantById(ctx.tenantId);
    if (!tenant) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Tenant not found"));
      return;
    }

    respond(true, {
      id: tenant.id,
      name: tenant.name,
      plan: tenant.plan,
      status: tenant.status,
      settings: tenant.settings,
      quotas: tenant.quotas,
      createdAt: tenant.createdAt,
    });
  },

  /**
   * Update tenant settings.
   *
   * Params:
   *   name?: string
   *   settings?: object
   */
  "tenant.update": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "tenant.update");
    } catch (err) {
      if (handleRbacError(err, respond)) {return;}
      throw err;
    }

    const { name, settings } = params as { name?: string; settings?: Record<string, unknown> };

    const updated = await updateTenant(ctx.tenantId, {
      ...(name ? { name } : {}),
      ...(settings ? { settings } : {}),
    });

    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Tenant not found"));
      return;
    }

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "tenant.update",
      detail: { name, settings },
    });

    respond(true, {
      id: updated.id,
      name: updated.name,
      settings: updated.settings,
    });
  },

  /**
   * List users in the tenant.
   *
   * Params:
   *   status?: string
   *   role?: string
   *   limit?: number
   *   offset?: number
   */
  "tenant.users.list": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "user.list");
    } catch (err) {
      if (handleRbacError(err, respond)) {return;}
      throw err;
    }

    const { status, role, channelId, limit, offset } = params as {
      status?: string;
      role?: string;
      channelId?: string;
      limit?: number;
      offset?: number;
    };

    const result = await listUsers(ctx.tenantId, {
      status: status as any,
      role: role as any,
      channelId,
      limit,
      offset,
    });

    respond(true, result);
  },

  /**
   * Invite a new user to the tenant.
   *
   * Params:
   *   email: string
   *   role?: UserRole (default: "member")
   *   displayName?: string
   *   password: string   (temporary password; user should change on first login)
   */
  "tenant.users.invite": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "user.invite");
    } catch (err) {
      if (handleRbacError(err, respond)) {return;}
      throw err;
    }

    const { email, role, displayName, password } = params as {
      email: string;
      role?: UserRole;
      displayName?: string;
      password: string;
    };

    if (!email || !password) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing email or password"));
      return;
    }

    // Phase 1: enforce password policy on the temporary password the inviter chose.
    const policy = validatePasswordStrength(password, email);
    if (!policy.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, policy.message ?? "密码不符合安全策略"));
      return;
    }

    // Prevent non-owners from creating owner/admin users
    const targetRole = role ?? "member";
    if (targetRole === "owner") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Cannot invite owner users"));
      return;
    }
    if (targetRole === "admin" && ctx.role !== "owner") {
      respond(false, undefined, errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Only owner can invite admin users",
      ));
      return;
    }

    // Check global email uniqueness
    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      respond(false, undefined, errorShape(
        ErrorCodes.INVALID_REQUEST,
        "该邮箱已注册",
      ));
      return;
    }

    // Check quota
    const quota = await checkTenantQuota(ctx.tenantId, "users");
    if (!quota.allowed) {
      respond(false, undefined, errorShape(
        ErrorCodes.QUOTA_EXCEEDED,
        `User quota reached (${quota.current}/${quota.max}). Upgrade your plan.`,
        { details: { resource: "users", current: quota.current, max: quota.max, contactLink: getPlanUpgradeLink() } },
      ));
      return;
    }

    try {
      // Phase 1: invited users must change the temporary password on first login.
      const user = await createUser({
        tenantId: ctx.tenantId,
        email,
        password,
        displayName,
        role: targetRole,
        forceChangePassword: true,
      });

      await createAuditLog({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: "user.invite",
        resource: `user:${user.id}`,
        detail: { email, role: targetRole },
      });

      respond(true, user);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Invite failed";
      if (msg.includes("duplicate key") || msg.includes("unique constraint")) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "该邮箱已注册"));
      } else {
        respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, msg));
      }
    }
  },

  /**
   * Update a user's role or status.
   *
   * Params:
   *   userId: string
   *   role?: UserRole
   *   status?: string
   *   displayName?: string
   */
  "tenant.users.update": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    const { userId, role, status, displayName } = params as {
      userId: string;
      role?: UserRole;
      status?: string;
      displayName?: string;
    };

    if (!userId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing userId"));
      return;
    }

    // Check permissions
    try {
      if (role !== undefined) {
        assertPermission(ctx.role, "user.role.change");
      } else {
        assertPermission(ctx.role, "user.update");
      }
    } catch (err) {
      if (handleRbacError(err, respond)) {return;}
      throw err;
    }

    // Verify target user is in same tenant
    const targetUser = await getUserById(userId);
    if (!targetUser || targetUser.tenantId !== ctx.tenantId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "User not found"));
      return;
    }

    // Prevent demoting the last owner
    if (targetUser.role === "owner" && role && role !== "owner") {
      const { users } = await listUsers(ctx.tenantId, { role: "owner" });
      if (users.length <= 1) {
        respond(false, undefined, errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Cannot change role of the last owner",
        ));
        return;
      }
    }

    const updated = await updateUser(userId, {
      ...(role ? { role } : {}),
      ...(status ? { status: status as any } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    });

    // Evict auto-provision cache so the next session picks up the updated role from DB
    // instead of returning the stale cached value.
    try {
      const { evictAutoProvisionCacheByUser } = await import("../../infra/channel-auto-provision.js");
      evictAutoProvisionCacheByUser(ctx.tenantId, userId);
    } catch { /* non-critical — cache will expire naturally in 10 min */ }

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "user.update",
      resource: `user:${userId}`,
      detail: { role, status, displayName },
    });

    respond(true, updated);
  },

  /**
   * Remove (soft-delete) a user from the tenant.
   *
   * Params:
   *   userId: string
   */
  "tenant.users.remove": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "user.remove");
    } catch (err) {
      if (handleRbacError(err, respond)) {return;}
      throw err;
    }

    const { userId } = params as { userId: string };
    if (!userId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing userId"));
      return;
    }

    // Can't remove yourself
    if (userId === ctx.userId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Cannot remove yourself"));
      return;
    }

    // Verify same tenant
    const targetUser = await getUserById(userId);
    if (!targetUser || targetUser.tenantId !== ctx.tenantId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "User not found"));
      return;
    }

    const deleted = await deleteUser(userId);

    {
      const { clearAutoProvisionCache } = await import("../../infra/channel-auto-provision.js");
      clearAutoProvisionCache();
    }

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "user.remove",
      resource: `user:${userId}`,
      detail: { email: targetUser.email },
    });

    respond(true, { deleted });
  },

  /**
   * List audit logs for the tenant.
   *
   * Params:
   *   userId?: string
   *   action?: string
   *   limit?: number
   *   offset?: number
   *   since?: string (ISO date)
   */
  "tenant.audit.list": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "audit.read");
    } catch (err) {
      if (handleRbacError(err, respond)) {return;}
      throw err;
    }

    const { userId, action, limit, offset, since } = params as {
      userId?: string;
      action?: string;
      limit?: number;
      offset?: number;
      since?: string;
    };

    const result = await listAuditLogs(ctx.tenantId, {
      userId,
      action,
      limit,
      offset,
      since: since ? new Date(since) : undefined,
    });

    respond(true, result);
  },

  /**
   * Get the current tenant's plan, quotas, and real-time usage.
   */
  "tenant.plan.current": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "tenant.read");
    } catch (err) {
      if (handleRbacError(err, respond)) {return;}
      throw err;
    }

    const tenant = await getTenantById(ctx.tenantId);
    if (!tenant) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Tenant not found"));
      return;
    }

    const [usersQ, agentsQ, channelsQ, tokensCurrent] = await Promise.all([
      checkTenantQuota(ctx.tenantId, "users"),
      checkTenantQuota(ctx.tenantId, "agents"),
      checkTenantQuota(ctx.tenantId, "channels"),
      getMonthlyTokenUsage(ctx.tenantId),
    ]);

    respond(true, {
      plan: tenant.plan,
      status: tenant.status,
      quotas: tenant.quotas,
      usage: {
        users:           { current: usersQ.current,    max: usersQ.max },
        agents:          { current: agentsQ.current,   max: agentsQ.max },
        channels:        { current: channelsQ.current, max: channelsQ.max },
        tokensThisMonth: { current: tokensCurrent,     max: tenant.quotas.maxTokensPerMonth },
      },
    });
  },
};
