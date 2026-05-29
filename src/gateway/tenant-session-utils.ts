/**
 * Tenant-aware session utilities.
 *
 * Wraps existing session operations (session-utils.ts) with tenant context.
 * In multi-tenant mode, all session operations are scoped to the tenant:
 *
 * 1. Session keys are prefixed with t:{tenantId}:
 * 2. Session store paths are tenant-scoped
 * 3. Session listing only shows tenant's own sessions
 * 4. Config is loaded per-tenant from DB
 *
 * When not in multi-tenant mode, these functions fall through to the
 * original behavior.
 */

import fs from "node:fs";
import {
  tenantScopedSessionKey,
  extractTenantFromSessionKey,
  type TenantContext,
} from "../auth/middleware.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath, type SessionEntry } from "../config/sessions.js";
import {
  resolveTenantDir,
  resolveTenantSessionStorePath,
  ensureTenantSessionDirs,
} from "../config/sessions/tenant-paths.js";
import { loadTenantConfig } from "../config/tenant-config.js";
import { isDbInitialized } from "../db/index.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  DEFAULT_AGENT_ID,
} from "../routing/session-key.js";

/**
 * Resolve the config to use for a request, tenant-scoped if applicable.
 */
export async function resolveRequestConfig(tenant?: TenantContext): Promise<OpenClawConfig> {
  if (tenant && isDbInitialized()) {
    return loadTenantConfig(tenant.tenantId, {
      userId: tenant.userId,
      userRole: tenant.role,
    });
  }
  return loadConfig();
}

/**
 * Resolve the session store path, tenant-scoped if applicable.
 */
export function resolveRequestStorePath(
  cfg: OpenClawConfig,
  agentId: string,
  tenantId?: string,
  userId?: string,
): string {
  if (tenantId) {
    // In multi-tenant mode, never create the default "main" agent directory.
    // Real agents must be explicitly created via tenant.agents.create.
    if (agentId !== DEFAULT_AGENT_ID) {
      ensureTenantSessionDirs(tenantId, agentId, userId);
    }
    return resolveTenantSessionStorePath(tenantId, agentId, userId);
  }
  return resolveStorePath(cfg.session?.store, { agentId });
}

/**
 * Transform a session key for storage — adds tenant prefix in multi-tenant mode.
 */
export function toStorageSessionKey(sessionKey: string, tenantId?: string): string {
  if (!tenantId) {
    return sessionKey;
  }
  // Don't double-prefix
  if (sessionKey.startsWith(`t:${tenantId}:`)) {
    return sessionKey;
  }
  return tenantScopedSessionKey(tenantId, sessionKey);
}

/**
 * Transform a storage session key back to the inner key for display/logic.
 */
export function fromStorageSessionKey(sessionKey: string): {
  innerKey: string;
  tenantId?: string;
} {
  const parsed = extractTenantFromSessionKey(sessionKey);
  if (parsed) {
    return { innerKey: parsed.innerKey, tenantId: parsed.tenantId };
  }
  return { innerKey: sessionKey };
}

/**
 * Load all sessions for a tenant user.
 *
 * In the new layout all sessions live in a single sessions.json per user,
 * so there is no need to iterate across agent directories.
 */
export function loadTenantSessionStore(
  tenantId: string,
  cfg: OpenClawConfig,
  userId?: string,
): Record<string, SessionEntry> {
  const storePath = resolveRequestStorePath(cfg, DEFAULT_AGENT_ID, tenantId, userId);
  try {
    return loadSessionStore(storePath);
  } catch {
    return {};
  }
}

/**
 * Load sessions from ALL users under a tenant.
 * Used by admin/owner views to see the full tenant session list.
 */
export function loadAllTenantSessionStores(
  tenantId: string,
  cfg: OpenClawConfig,
): Record<string, SessionEntry> {
  const tenantDir = resolveTenantDir(tenantId);
  const usersDir = `${tenantDir}/users`;
  let userDirs: string[];
  try {
    userDirs = fs
      .readdirSync(usersDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return {};
  }
  const merged: Record<string, SessionEntry> = {};
  for (const userId of userDirs) {
    const storePath = resolveTenantSessionStorePath(tenantId, DEFAULT_AGENT_ID, userId);
    try {
      const store = loadSessionStore(storePath);
      for (const [key, entry] of Object.entries(store)) {
        merged[key] = entry;
      }
    } catch {
      // Skip users with no session store.
    }
  }
  return merged;
}

/**
 * Find the store path that contains a given session key across all users in a tenant.
 * Used by admin operations (patch/delete) that may target other users' sessions.
 * Falls back to the requesting user's store if no match is found.
 */
export function findTenantStorePathForKey(
  tenantId: string,
  cfg: OpenClawConfig,
  sessionKey: string,
  fallbackUserId?: string,
): string {
  const agentId = normalizeAgentId(parseAgentSessionKey(sessionKey)?.agentId ?? DEFAULT_AGENT_ID);
  const tenantDir = resolveTenantDir(tenantId);
  const usersDir = `${tenantDir}/users`;
  let userDirs: string[];
  try {
    userDirs = fs
      .readdirSync(usersDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return resolveTenantSessionStorePath(tenantId, agentId, fallbackUserId);
  }
  const canonical = sessionKey.trim().toLowerCase();
  for (const userId of userDirs) {
    const storePath = resolveTenantSessionStorePath(tenantId, agentId, userId);
    try {
      const store = loadSessionStore(storePath);
      for (const storeKey of Object.keys(store)) {
        if (storeKey.toLowerCase() === canonical) {
          return storePath;
        }
      }
    } catch {
      // Skip unreadable stores.
    }
  }
  return resolveTenantSessionStorePath(tenantId, agentId, fallbackUserId);
}

/**
 * Verify that a session key belongs to the given tenant.
 * Returns true if:
 * - No tenant context (single-tenant mode)
 * - The session key has the correct tenant prefix
 * - The session key has no tenant prefix (legacy, allowed in transition)
 */
export function verifySessionTenantAccess(sessionKey: string, tenantId?: string): boolean {
  if (!tenantId) {
    return true;
  }

  const parsed = extractTenantFromSessionKey(sessionKey);
  if (!parsed) {
    // No tenant prefix — allow in transition period
    return true;
  }
  return parsed.tenantId === tenantId;
}

/**
 * Resolve session agent ID from a possibly tenant-prefixed key.
 */
export function resolveSessionAgentIdFromKey(cfg: OpenClawConfig, sessionKey: string): string {
  // Strip tenant prefix if present
  const { innerKey } = fromStorageSessionKey(sessionKey);

  const parsed = parseAgentSessionKey(innerKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return DEFAULT_AGENT_ID;
}
