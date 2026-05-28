import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildAllowedModelSet } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/config.js";
import { loadTenantConfig } from "../../config/tenant-config.js";
import { isDbInitialized } from "../../db/index.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Build a model catalog from the tenant config's provider definitions.
 * In multi-tenant mode, models live in the DB (tenant_models table) and are
 * merged into the tenant config by loadTenantConfig.  We extract them here
 * so that models.list returns the up-to-date set without relying on the
 * process-lifetime model-catalog cache.
 */
function catalogFromConfig(
  cfg: import("../../config/config.js").OpenClawConfig,
): import("../../agents/model-catalog.js").ModelCatalogEntry[] {
  const providers = (cfg as any).models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }
  const entries: import("../../agents/model-catalog.js").ModelCatalogEntry[] = [];
  for (const [providerId, providerValue] of Object.entries(providers)) {
    if (!providerValue || typeof providerValue !== "object") {
      continue;
    }
    const models = (providerValue as { models?: unknown[] }).models;
    if (!Array.isArray(models)) {
      continue;
    }
    for (const m of models) {
      if (!m || typeof m !== "object") {
        continue;
      }
      const id = String((m as { id?: string }).id ?? "").trim();
      if (!id) {
        continue;
      }
      const name = String((m as { name?: string }).name ?? id).trim() || id;
      const contextWindow =
        typeof (m as any).contextWindow === "number" && (m as any).contextWindow > 0
          ? (m as any).contextWindow
          : undefined;
      const reasoning =
        typeof (m as any).reasoning === "boolean" ? (m as any).reasoning : undefined;
      const input = Array.isArray((m as any).input) ? (m as any).input : undefined;
      entries.push({ id, name, provider: providerId, contextWindow, reasoning, input });
    }
  }
  return entries;
}

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context, client }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const tenant = client?.tenant;
      const isTenantRequest = tenant?.tenantId && isDbInitialized();

      // In multi-tenant mode, build the catalog from the (fresh) tenant config
      // so that model management changes are reflected immediately.
      const cfg = isTenantRequest
        ? await loadTenantConfig(tenant.tenantId, {
            userId: tenant.userId,
            userRole: tenant.role,
          })
        : loadConfig();

      const catalog = isTenantRequest
        ? catalogFromConfig(cfg)
        : await context.loadGatewayModelCatalog();

      const { allowedCatalog } = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
      });
      const models = allowedCatalog.length > 0 ? allowedCatalog : catalog;
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
