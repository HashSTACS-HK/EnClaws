/**
 * Gateway RPC handlers for platform tenant management.
 *
 * Methods:
 *   platform.tenants.list      - List all tenants (paginated)
 *   platform.tenants.get       - Get a single tenant by ID
 *   platform.tenants.update    - Update plan / quotas / name
 *   platform.tenants.suspend   - Suspend a tenant
 *   platform.tenants.unsuspend - Restore a suspended tenant
 *
 * All methods require platform-admin role.
 */

import type { TenantContext } from "../../auth/middleware.js";
import { isDbInitialized } from "../../db/index.js";
import { createAuditLog } from "../../db/models/audit-log.js";
import {
  listTenants,
  getTenantById,
  updateTenant,
  getPlanQuotas,
  resolveEffectiveQuotas,
} from "../../db/models/tenant.js";
import type { TenantPlan, TenantQuotas, TenantStatus } from "../../db/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";

function requirePlatformAdmin(
  client: GatewayRequestHandlerOptions["client"],
  respond: GatewayRequestHandlerOptions["respond"],
): TenantContext | null {
  if (!isDbInitialized()) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Multi-tenant mode not enabled"),
    );
    return null;
  }
  const tenant = (client as unknown as { tenant?: TenantContext })?.tenant;
  if (!tenant) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Authentication required"));
    return null;
  }
  if (tenant.role !== "platform-admin") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Platform admin access required"),
    );
    return null;
  }
  return tenant;
}

export const platformTenantsHandlers: GatewayRequestHandlers = {
  "platform.tenants.list": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requirePlatformAdmin(client, respond)) {
      return;
    }

    const { status, search, limit, offset } = params as {
      status?: TenantStatus;
      search?: string;
      limit?: number;
      offset?: number;
    };

    try {
      const result = await listTenants({
        status,
        search: search?.trim() || undefined,
        limit: Math.min(Math.max(limit ?? 20, 1), 100),
        offset: offset ?? 0,
      });
      const tenants = await Promise.all(
        result.tenants.map(async (tenant) => ({
          ...tenant,
          quotas: await resolveEffectiveQuotas(tenant),
        })),
      );
      respond(true, { ...result, tenants });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          err instanceof Error ? err.message : "Failed to list tenants",
        ),
      );
    }
  },

  "platform.tenants.get": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requirePlatformAdmin(client, respond)) {
      return;
    }

    const { tenantId } = params as { tenantId: string };
    if (!tenantId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Missing tenantId"));
      return;
    }

    try {
      const tenant = await getTenantById(tenantId);
      if (!tenant) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Tenant not found"));
        return;
      }
      respond(true, { ...tenant, quotas: await resolveEffectiveQuotas(tenant) });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          err instanceof Error ? err.message : "Failed to get tenant",
        ),
      );
    }
  },

  "platform.tenants.update": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = requirePlatformAdmin(client, respond);
    if (!ctx) {
      return;
    }

    const { tenantId, plan, quotas, name } = params as {
      tenantId: string;
      plan?: TenantPlan;
      quotas?: Partial<TenantQuotas>;
      name?: string;
    };

    if (!tenantId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Missing tenantId"));
      return;
    }

    try {
      let resolvedQuotas: TenantQuotas | undefined;
      if (plan || quotas) {
        const targetPlan = plan ?? (await getTenantById(tenantId))?.plan ?? "free";
        const planDefaults = await getPlanQuotas(targetPlan);
        resolvedQuotas = { ...planDefaults, ...quotas };
      }

      const updated = await updateTenant(tenantId, {
        ...(name !== undefined ? { name } : {}),
        ...(plan !== undefined ? { plan } : {}),
        ...(resolvedQuotas !== undefined ? { quotas: resolvedQuotas } : {}),
      });

      if (!updated) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Tenant not found"));
        return;
      }

      try {
        await createAuditLog({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          action: "platform.tenant.update",
          resource: `tenant:${tenantId}`,
          detail: { plan, quotas: resolvedQuotas, name },
        });
      } catch {
        /* audit failure must not mask successful mutation */
      }

      respond(true, updated);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          err instanceof Error ? err.message : "Failed to update tenant",
        ),
      );
    }
  },

  "platform.tenants.suspend": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = requirePlatformAdmin(client, respond);
    if (!ctx) {
      return;
    }

    const { tenantId } = params as { tenantId: string };
    if (!tenantId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Missing tenantId"));
      return;
    }

    try {
      const updated = await updateTenant(tenantId, { status: "suspended" });
      if (!updated) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Tenant not found"));
        return;
      }
      try {
        await createAuditLog({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          action: "platform.tenant.suspend",
          resource: `tenant:${tenantId}`,
          detail: {},
        });
      } catch {
        /* audit failure must not mask successful mutation */
      }
      respond(true, { id: updated.id, status: updated.status });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          err instanceof Error ? err.message : "Failed to suspend tenant",
        ),
      );
    }
  },

  /**
   * Return the default quotas for each known plan so the tenant-edit UI
   * can reset quota inputs when the admin picks a different plan.
   */
  "platform.plans.quotas": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    if (!requirePlatformAdmin(client, respond)) {
      return;
    }
    try {
      const [free, pro, enterprise] = await Promise.all([
        getPlanQuotas("free"),
        getPlanQuotas("pro"),
        getPlanQuotas("enterprise"),
      ]);
      respond(true, { free, pro, enterprise });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          err instanceof Error ? err.message : "Failed to load plan quotas",
        ),
      );
    }
  },

  "platform.tenants.unsuspend": async ({
    params,
    client,
    respond,
  }: GatewayRequestHandlerOptions) => {
    const ctx = requirePlatformAdmin(client, respond);
    if (!ctx) {
      return;
    }

    const { tenantId } = params as { tenantId: string };
    if (!tenantId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Missing tenantId"));
      return;
    }

    try {
      const updated = await updateTenant(tenantId, { status: "active" });
      if (!updated) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Tenant not found"));
        return;
      }
      try {
        await createAuditLog({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          action: "platform.tenant.unsuspend",
          resource: `tenant:${tenantId}`,
          detail: {},
        });
      } catch {
        /* audit failure must not mask successful mutation */
      }
      respond(true, { id: updated.id, status: updated.status });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          err instanceof Error ? err.message : "Failed to unsuspend tenant",
        ),
      );
    }
  },
};
