import { createEmbedSsoKey, listEmbedSsoKeys, revokeEmbedSsoKey } from "../../auth/embed-sso.js";
import type { TenantContext } from "../../auth/middleware.js";
import { assertPermission, RbacError } from "../../auth/rbac.js";
import { isDbInitialized } from "../../db/index.js";
import { createAuditLog } from "../../db/models/audit-log.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";

function getTenantCtx(
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
  return tenant;
}

function requireTenantPermission(
  ctx: TenantContext,
  permission: "tenant.read" | "tenant.update",
  respond: GatewayRequestHandlerOptions["respond"],
): boolean {
  try {
    assertPermission(ctx.role, permission);
    return true;
  } catch (err) {
    if (err instanceof RbacError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
      return false;
    }
    throw err;
  }
}

export const tenantEmbedSsoHandlers: GatewayRequestHandlers = {
  "tenant.embedSso.status": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx || !requireTenantPermission(ctx, "tenant.read", respond)) {
      return;
    }
    const keys = await listEmbedSsoKeys(ctx.tenantId);
    respond(true, { tenantId: ctx.tenantId, keys });
  },

  "tenant.embedSso.rotate": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx || !requireTenantPermission(ctx, "tenant.update", respond)) {
      return;
    }
    const existing = await listEmbedSsoKeys(ctx.tenantId);
    for (const key of existing.filter((item) => item.isActive)) {
      await revokeEmbedSsoKey({ tenantId: ctx.tenantId, keyId: key.id });
    }
    const created = await createEmbedSsoKey({ tenantId: ctx.tenantId, createdBy: ctx.userId });
    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "tenant.embed_sso.rotate",
      resource: `tenant:${ctx.tenantId}`,
      detail: { keyId: created.record.id, keyPrefix: created.record.keyPrefix },
    }).catch(() => undefined);
    respond(true, {
      tenantId: ctx.tenantId,
      key: created.key,
      record: created.record,
    });
  },

  "tenant.embedSso.revoke": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx || !requireTenantPermission(ctx, "tenant.update", respond)) {
      return;
    }
    const { keyId } = params as { keyId?: string };
    if (!keyId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "keyId is required"));
      return;
    }
    const ok = await revokeEmbedSsoKey({ tenantId: ctx.tenantId, keyId });
    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "tenant.embed_sso.revoke",
      resource: `tenant:${ctx.tenantId}:embed-sso:${keyId}`,
      detail: { ok },
    }).catch(() => undefined);
    respond(true, { ok });
  },
};
