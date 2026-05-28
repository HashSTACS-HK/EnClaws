/**
 * Gateway RPC handlers for platform-level shared model management.
 *
 * Methods:
 *   platform.models.list    - List all shared models
 *   platform.models.create  - Create a shared model
 *   platform.models.update  - Update a shared model
 *   platform.models.delete  - Delete a shared model
 */

import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { isDbInitialized } from "../../db/index.js";
import {
  createTenantModel,
  listSharedModels,
  getModelById,
  updateModelById,
  deleteModelById,
} from "../../db/models/tenant-model.js";
import { createAuditLog } from "../../db/models/audit-log.js";
import { assertPermission, RbacError } from "../../auth/rbac.js";
import { clearTenantConfigCache } from "../../config/tenant-config.js";
import type { TenantContext } from "../../auth/middleware.js";
import type { TenantModelDefinition } from "../../db/types.js";
import { query as dbQuery, getDbType, DB_SQLITE } from "../../db/index.js";
import { sqliteQuery } from "../../db/sqlite/index.js";

/** Find agents that reference a specific providerId + modelId (exact JSON match). */
function findAgentsByModelRef(providerId: string, modelId: string): string[] {
  type AgentRow = { name: string; agent_id: string; model_config: string };
  let rows: AgentRow[];
  if (getDbType() === DB_SQLITE) {
    rows = sqliteQuery(
      `SELECT name, agent_id, model_config FROM tenant_agents WHERE model_config LIKE ?`,
      [`%${providerId}%`],
    ).rows as AgentRow[];
  } else {
    // Use synchronous approach not possible for PG — caller must await
    // This helper is only used in SQLite path; PG path uses findAgentsByModelRefAsync
    return [];
  }
  return rows
    .filter((r) => {
      try {
        const configs = typeof r.model_config === "string" ? JSON.parse(r.model_config) : r.model_config;
        return Array.isArray(configs) && configs.some(
          (mc: { providerId?: string; modelId?: string }) =>
            mc.providerId === providerId && mc.modelId === modelId,
        );
      } catch {
        return false;
      }
    })
    .map((r) => r.name || r.agent_id);
}

/** Async version for PostgreSQL. */
async function findAgentsByModelRefAsync(providerId: string, modelId: string): Promise<string[]> {
  if (getDbType() === DB_SQLITE) {
    return findAgentsByModelRef(providerId, modelId);
  }
  const res = await dbQuery(
    `SELECT name, agent_id, model_config FROM tenant_agents WHERE model_config::text LIKE $1`,
    [`%${providerId}%`],
  );
  return (res.rows as Array<{ name: string; agent_id: string; model_config: unknown }>)
    .filter((r) => {
      const configs = r.model_config;
      return Array.isArray(configs) && configs.some(
        (mc: { providerId?: string; modelId?: string }) =>
          mc.providerId === providerId && mc.modelId === modelId,
      );
    })
    .map((r) => r.name || r.agent_id);
}

function getPlatformCtx(
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

function sanitizeModel(m: Record<string, unknown>) {
  const { apiKeyEncrypted, ...rest } = m as Record<string, unknown> & { apiKeyEncrypted?: string };
  return { ...rest, hasApiKey: !!apiKeyEncrypted };
}

function validateModels(models: TenantModelDefinition[] | undefined, respond: GatewayRequestHandlerOptions["respond"]): boolean {
  if (models && !Array.isArray(models)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "models must be an array"));
    return false;
  }
  if (models) {
    const modelIds = new Set<string>();
    for (const m of models) {
      if (!m.id || !m.name) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Each model must have id and name"));
        return false;
      }
      if (modelIds.has(m.id)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, `Duplicate model id: ${m.id}`));
        return false;
      }
      modelIds.add(m.id);
      if (!m.contextWindow) {m.contextWindow = 128000;}
    }
  }
  return true;
}

export const platformModelsHandlers: GatewayRequestHandlers = {
  "platform.models.list": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getPlatformCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "platform.models.list");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const models = await listSharedModels({ activeOnly: false });
    respond(true, {
      models: models.map((m) => sanitizeModel({
        id: m.id,
        tenantId: m.tenantId,
        providerType: m.providerType,
        providerName: m.providerName,
        baseUrl: m.baseUrl,
        apiProtocol: m.apiProtocol,
        authMode: m.authMode,
        apiKeyEncrypted: m.apiKeyEncrypted,
        extraHeaders: m.extraHeaders,
        extraConfig: m.extraConfig,
        models: m.models,
        visibility: m.visibility,
        isActive: m.isActive,
        createdAt: m.createdAt,
      })),
    });
  },

  "platform.models.create": async ({ params, client, respond, context }: GatewayRequestHandlerOptions) => {
    const ctx = getPlatformCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "platform.models.create");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const {
      providerType, providerName, baseUrl, apiProtocol, authMode,
      apiKey, extraHeaders, extraConfig, models,
    } = params as {
      providerType: string;
      providerName: string;
      baseUrl?: string;
      apiProtocol?: string;
      authMode?: string;
      apiKey?: string;
      extraHeaders?: Record<string, string>;
      extraConfig?: Record<string, unknown>;
      models?: TenantModelDefinition[];
    };

    if (!providerType || !providerName) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing providerType or providerName"));
      return;
    }
    if (!validateModels(models, respond)) {return;}

    try {
      const model = await createTenantModel({
        tenantId: ctx.tenantId,
        providerType,
        providerName,
        baseUrl,
        apiProtocol,
        authMode,
        apiKeyEncrypted: apiKey ?? undefined,
        extraHeaders,
        extraConfig,
        models,
        visibility: "shared",
        createdBy: ctx.userId,
      });

      clearTenantConfigCache();

      await createAuditLog({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: "platform.model.create",
        resource: `model:${model.id}`,
        detail: { providerType, providerName, visibility: "shared" },
      });

      respond(true, sanitizeModel({
        id: model.id,
        providerType: model.providerType,
        providerName: model.providerName,
        baseUrl: model.baseUrl,
        apiProtocol: model.apiProtocol,
        authMode: model.authMode,
        apiKeyEncrypted: model.apiKeyEncrypted,
        extraHeaders: model.extraHeaders,
        extraConfig: model.extraConfig,
        models: model.models,
        visibility: model.visibility,
        isActive: model.isActive,
      }));
    } catch (err: unknown) {
      throw err;
    }
  },

  "platform.models.update": async ({ params, client, respond, context }: GatewayRequestHandlerOptions) => {
    const ctx = getPlatformCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "platform.models.update");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { id, providerName, baseUrl, apiProtocol, authMode, apiKey, models, isActive } = params as {
      id: string;
      providerName?: string;
      baseUrl?: string;
      apiProtocol?: string;
      authMode?: string;
      apiKey?: string;
      models?: TenantModelDefinition[];
      isActive?: boolean;
    };

    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing id"));
      return;
    }
    if (!validateModels(models, respond)) {return;}

    const existing = await getModelById(id);
    if (!existing || existing.visibility !== "shared") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Shared model not found"));
      return;
    }

    // Check if any removed sub-models are referenced by agents
    if (models !== undefined) {
      const oldModelIds = new Set((existing.models ?? []).map((m) => m.id));
      const newModelIds = new Set(models.map((m) => m.id));
      const removedIds = [...oldModelIds].filter((mid) => !newModelIds.has(mid));
      if (removedIds.length > 0) {
        for (const removedModelId of removedIds) {
          const agentNames = await findAgentsByModelRefAsync(id, removedModelId);
          if (agentNames.length > 0) {
            respond(false, undefined, errorShape(
              ErrorCodes.INVALID_REQUEST,
              `platformModels.removeModelInUse:${removedModelId}:${agentNames.join(", ")}`,
            ));
            return;
          }
        }
      }
    }

    const updates: Record<string, unknown> = {};
    if (providerName !== undefined) {updates.providerName = providerName;}
    if (baseUrl !== undefined) {updates.baseUrl = baseUrl;}
    if (apiProtocol !== undefined) {updates.apiProtocol = apiProtocol;}
    if (authMode !== undefined) {updates.authMode = authMode;}
    if (apiKey !== undefined) {updates.apiKeyEncrypted = apiKey;}
    if (models !== undefined) {updates.models = models;}
    if (isActive !== undefined) {updates.isActive = isActive;}

    const updated = await updateModelById(id, updates);
    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Update failed"));
      return;
    }

    clearTenantConfigCache();

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "platform.model.update",
      resource: `model:${id}`,
      detail: { providerName: updated.providerName },
    });

    respond(true, sanitizeModel({
      id: updated.id,
      providerType: updated.providerType,
      providerName: updated.providerName,
      baseUrl: updated.baseUrl,
      apiProtocol: updated.apiProtocol,
      authMode: updated.authMode,
      apiKeyEncrypted: updated.apiKeyEncrypted,
      extraHeaders: updated.extraHeaders,
      extraConfig: updated.extraConfig,
      models: updated.models,
      visibility: updated.visibility,
      isActive: updated.isActive,
    }));
  },

  "platform.models.delete": async ({ params, client, respond, context }: GatewayRequestHandlerOptions) => {
    const ctx = getPlatformCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "platform.models.delete");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { id } = params as { id: string };
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing id"));
      return;
    }

    const existing = await getModelById(id);
    if (!existing || existing.visibility !== "shared") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Shared model not found"));
      return;
    }

    // Check if any agent across all tenants references any sub-model of this provider
    const allModelIds = (existing.models ?? []).map((m) => m.id);
    const allRefAgents: string[] = [];
    for (const mid of allModelIds) {
      const refs = await findAgentsByModelRefAsync(id, mid);
      for (const name of refs) {
        if (!allRefAgents.includes(name)) {allRefAgents.push(name);}
      }
    }
    if (allRefAgents.length > 0) {
      respond(false, undefined, errorShape(
        ErrorCodes.INVALID_REQUEST,
        `platformModels.deleteInUse:${allRefAgents.join(", ")}`,
      ));
      return;
    }

    await deleteModelById(id);
    clearTenantConfigCache();

    await createAuditLog({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "platform.model.delete",
      resource: `model:${id}`,
      detail: { providerName: existing.providerName },
    });

    respond(true, { ok: true });
  },

  "platform.models.checkModelUsage": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getPlatformCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "platform.models.update");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { providerId, modelId } = params as { providerId: string; modelId: string };
    if (!providerId || !modelId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing providerId or modelId"));
      return;
    }

    const agentNames = await findAgentsByModelRefAsync(providerId, modelId);

    respond(true, { agents: agentNames });
  },
};
