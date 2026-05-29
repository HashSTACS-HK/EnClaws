/**
 * Tenant-scoped configuration overlay.
 *
 * In multi-tenant mode, each tenant has their own agents, channels, and settings
 * stored in PostgreSQL. This module merges tenant-specific config with the global
 * EnClawsConfig to produce a tenant-scoped view.
 *
 * Design principle: The global config provides system defaults and infrastructure
 * settings. Tenant config overlays agent definitions, channel configs, model
 * preferences, and session settings on top.
 */

// normalizeProviderId no longer needed — providers are keyed by tenant_models.id
import { isDbInitialized } from "../db/index.js";
import {
  listTenantAgents,
  toConfigAgentsList,
  buildTenantModelProviderKey,
} from "../db/models/tenant-agent.js";
import { listTenantChannels, toConfigChannels } from "../db/models/tenant-channel.js";
import { listTenantModels } from "../db/models/tenant-model.js";
import { getTenantById } from "../db/models/tenant.js";
import type { TenantSettings } from "../db/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadConfig, type OpenClawConfig } from "./config.js";

const log = createSubsystemLogger("tenant-config");

/** Cache tenant configs with short TTL to avoid DB hits on every request. */
const tenantConfigCache = new Map<string, { config: OpenClawConfig; expiresAt: number }>();
const TENANT_CONFIG_CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Load config for a specific tenant. Merges tenant-specific settings from DB
 * with the global system config.
 *
 * Falls back to global config if DB is not initialized or tenant not found.
 */
export async function loadTenantConfig(
  tenantId: string,
  opts?: { userId?: string; userRole?: string },
): Promise<OpenClawConfig> {
  if (!isDbInitialized()) {
    return loadConfig();
  }

  const userId = opts?.userId;
  const userRole = opts?.userRole;
  // Admin/owner see all agents; member/viewer only their own
  const isAdmin = userRole === "owner" || userRole === "admin";
  const agentFilter = userId && !isAdmin ? userId : undefined;
  const cacheKey = agentFilter ? `${tenantId}:${agentFilter}` : tenantId;

  // Check cache
  const cached = tenantConfigCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  const globalConfig = loadConfig();
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return globalConfig;
  }

  const [agents, channels, tenantModels] = await Promise.all([
    listTenantAgents(tenantId, { createdBy: agentFilter }),
    listTenantChannels(tenantId),
    listTenantModels(tenantId, { activeOnly: true }),
  ]);

  const tenantConfig = await buildTenantConfig(
    globalConfig,
    tenant.settings,
    agents,
    channels,
    tenantModels,
  );

  // Cache the result
  tenantConfigCache.set(cacheKey, {
    config: tenantConfig,
    expiresAt: Date.now() + TENANT_CONFIG_CACHE_TTL_MS,
  });

  return tenantConfig;
}

/**
 * Merge tenant-specific settings with global config.
 */
async function buildTenantConfig(
  globalConfig: OpenClawConfig,
  tenantSettings: TenantSettings,
  agents: Awaited<ReturnType<typeof listTenantAgents>>,
  channels: Awaited<ReturnType<typeof listTenantChannels>>,
  tenantModels: Awaited<ReturnType<typeof listTenantModels>>,
): Promise<OpenClawConfig> {
  const config = { ...globalConfig };

  // Build tenant models map for model_id FK resolution and register providers.
  const tenantModelsMap = new Map<string, import("../db/types.js").TenantModel>();
  if (tenantModels.length > 0) {
    const providers: Record<string, unknown> = {
      ...(config as any).models?.providers,
    };
    for (const tm of tenantModels) {
      tenantModelsMap.set(tm.id, tm);
      // Register each tenant_models record using a unique key "tm-{id}"
      const providerKey = buildTenantModelProviderKey(tm);
      providers[providerKey] = {
        baseUrl: tm.baseUrl ?? "",
        apiKey: tm.apiKeyEncrypted ?? undefined,
        api: tm.apiProtocol ?? "openai-completions",
        headers: tm.extraHeaders ?? {},
        models: (tm.models ?? []).map((m) => ({
          id: m.id,
          name: m.name,
          reasoning: m.reasoning ?? false,
          input: m.input ?? ["text"],
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 4096,
          cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      };
    }
    config.models = {
      ...(config as any).models,
      providers,
    };
  }

  // Override agents if tenant has their own.
  // Pass tenantModelsMap so agents with model_id FK resolve correctly.
  if (agents.length > 0) {
    const agentsList = toConfigAgentsList(agents, tenantModelsMap);
    config.agents = {
      ...config.agents,
      list: agentsList as any,
    };
  }

  // Override channels if tenant has their own
  if (channels.length > 0) {
    const tenantChannels = await toConfigChannels(channels);
    config.channels = {
      ...config.channels,
      ...tenantChannels,
    } as any;
  }

  // Apply tenant-level model restrictions
  if (tenantSettings.defaultModel) {
    config.agents = {
      ...config.agents,
      defaults: {
        ...(config.agents as any)?.defaults,
        model: tenantSettings.defaultModel,
      },
    } as any;
  }

  return config;
}

/**
 * Invalidate cached config for a tenant (e.g., after config update).
 */
export function invalidateTenantConfigCache(tenantId: string): void {
  // Clear the admin-level cache and all user-specific caches for this tenant.
  for (const key of tenantConfigCache.keys()) {
    if (key === tenantId || key.startsWith(`${tenantId}:`)) {
      tenantConfigCache.delete(key);
    }
  }
}

/**
 * Clear all tenant config caches.
 */
export function clearTenantConfigCache(): void {
  tenantConfigCache.clear();
}
