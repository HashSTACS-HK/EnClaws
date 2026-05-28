/**
 * Gateway RPC handlers for tenant-scoped session operations.
 *
 * These handlers provide multi-tenant session management, using the tenant
 * context from JWT auth to isolate sessions per tenant.
 *
 * Methods:
 *   tenant.sessions.list    - List sessions for the current tenant
 *   tenant.sessions.get     - Get a specific session
 *   tenant.sessions.delete  - Delete a session
 */

import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { isDbInitialized } from "../../db/index.js";
import { assertPermission, RbacError } from "../../auth/rbac.js";
import type { TenantContext } from "../../auth/middleware.js";
import {
  resolveRequestConfig,
  loadTenantSessionStore,
  resolveRequestStorePath,
  resolveSessionAgentIdFromKey,
  verifySessionTenantAccess,
} from "../tenant-session-utils.js";
import { loadSessionStore } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions/store.js";
import { archiveSessionTranscripts } from "../session-utils.fs.js";
import { createAuditLog } from "../../db/models/audit-log.js";

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

export const tenantSessionsHandlers: GatewayRequestHandlers = {
  /**
   * List sessions for the current tenant.
   *
   * Params:
   *   agentId?: string    - filter by agent
   *   limit?: number
   *   offset?: number
   */
  "tenant.sessions.list": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "session.list");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const cfg = await resolveRequestConfig(ctx);
    const store = loadTenantSessionStore(ctx.tenantId, cfg, ctx.userId);

    const { agentId, limit = 50, offset = 0 } = params as {
      agentId?: string;
      limit?: number;
      offset?: number;
    };

    // Convert store entries to list
    let entries = Object.entries(store).map(([key, entry]) => ({
      key,
      sessionId: entry.sessionId ?? key,
      agentId: resolveSessionAgentIdFromKey(cfg, key),
      channel: entry.channel ?? entry.lastChannel ?? null,
      chatType: entry.chatType ?? null,
      subject: entry.subject ?? entry.groupName ?? null,
      updatedAt: entry.updatedAt ?? null,
      model: entry.model ?? null,
      modelProvider: entry.modelProvider ?? null,
    }));

    // Filter by agent if specified
    if (agentId) {
      entries = entries.filter((e) => e.agentId === agentId);
    }

    // Sort by updatedAt descending
    entries.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    const total = entries.length;
    const paged = entries.slice(offset, offset + limit);

    respond(true, { sessions: paged, total });
  },

  /**
   * Get details about a specific session.
   *
   * Params:
   *   key: string  - session key
   */
  "tenant.sessions.get": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "session.list");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { key } = params as { key: string };
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing session key"));
      return;
    }

    if (!verifySessionTenantAccess(key, ctx.tenantId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Session not found"));
      return;
    }

    const cfg = await resolveRequestConfig(ctx);
    const agentId = resolveSessionAgentIdFromKey(cfg, key);
    const storePath = resolveRequestStorePath(cfg, agentId, ctx.tenantId, ctx.userId);

    try {
      const store = loadSessionStore(storePath);
      const entry = store[key];
      if (!entry) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Session not found"));
        return;
      }

      respond(true, {
        key,
        sessionId: entry.sessionId ?? key,
        agentId,
        channel: entry.channel ?? entry.lastChannel ?? null,
        chatType: entry.chatType ?? null,
        subject: entry.subject ?? entry.groupName ?? null,
        model: entry.model ?? null,
        modelProvider: entry.modelProvider ?? null,
        updatedAt: entry.updatedAt ?? null,
        metadata: entry,
      });
    } catch {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Session not found"));
    }
  },

  /**
   * Delete a session.
   *
   * Params:
   *   key: string  - session key
   */
  "tenant.sessions.delete": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "session.delete");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { key } = params as { key: string };
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "Missing session key"));
      return;
    }

    if (!verifySessionTenantAccess(key, ctx.tenantId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Session not found"));
      return;
    }

    const cfg = await resolveRequestConfig(ctx);
    const agentId = resolveSessionAgentIdFromKey(cfg, key);
    const storePath = resolveRequestStorePath(cfg, agentId, ctx.tenantId, ctx.userId);

    try {
      // Read entry before deletion so we can archive its transcript file.
      const store = loadSessionStore(storePath);
      const entry = store[key];

      const deleted = await updateSessionStore(storePath, (s) => {
        if (!s[key]) {return false;}
        delete s[key];
        return true;
      });

      if (!deleted) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Session not found"));
        return;
      }

      // Archive transcript to tenant-scoped sessions dir (soft-delete).
      if (entry?.sessionId) {
        archiveSessionTranscripts({
          sessionId: entry.sessionId,
          storePath,
          sessionFile: entry.sessionFile,
          reason: "deleted",
          restrictToStoreDir: true,
        });
      }

      await createAuditLog({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: "session.delete",
        resource: `session:${key}`,
      });

      respond(true, { deleted: true });
    } catch (err) {
      respond(false, undefined, errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Failed to delete session: ${err instanceof Error ? err.message : "unknown error"}`,
      ));
    }
  },
};
