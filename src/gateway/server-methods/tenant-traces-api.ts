/**
 * Gateway RPC handlers for LLM interaction traces.
 *
 * Methods:
 *   tenant.traces.turns   - List turns (grouped by user question)
 *   tenant.traces.turn    - Get all interactions for a specific turn
 *   tenant.traces.list    - List individual interaction traces
 *   tenant.traces.detail  - Get a single trace with full payload
 */

import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { isDbInitialized } from "../../db/index.js";
import {
  listInteractionTurns,
  getInteractionsByTurn,
  listInteractionTraces,
  getInteractionTrace,
} from "../../db/models/interaction-trace.js";
import { assertPermission, RbacError } from "../../auth/rbac.js";
import type { TenantContext } from "../../auth/middleware.js";
import { loadSessionEntry } from "../session-utils.js";

/** Parse a date-only string and set to end of day (23:59:59.999). */
function parseUntilDate(s: string): Date {
  const d = new Date(s);
  d.setHours(23, 59, 59, 999);
  return d;
}

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

/**
 * Enrich turns with session displayName and channel from sessions.json.
 *
 * Reads session store files (sync I/O, typically < 1ms each) to look up
 * the authoritative displayName that was already resolved and cached by
 * the inbound pipeline (metadata.ts). This avoids fragile regex parsing
 * of raw LLM prompt text on the client side.
 */
function enrichTurnsWithSessionMeta(
  turns: Array<{
    sessionKey: string | null;
    userId: string | null;
    [k: string]: unknown;
  }>,
  tenantId: string,
): Array<Record<string, unknown>> {
  return turns.map((turn) => {
    let sessionDisplayName: string | null = null;
    let sessionChannel: string | null = null;
    if (turn.sessionKey) {
      try {
        const { entry } = loadSessionEntry(turn.sessionKey, {
          tenantId,
          userId: turn.userId ?? undefined,
        });
        if (entry?.displayName) {sessionDisplayName = entry.displayName;}
        if (entry?.channel) {sessionChannel = entry.channel;}
      } catch {
        // Non-fatal: session file may not exist for old/pruned sessions
      }
    }
    return { ...turn, sessionDisplayName, sessionChannel };
  });
}

export const tenantTracesHandlers: GatewayRequestHandlers = {
  /**
   * List turns (one row per user question, with aggregated stats).
   */
  "tenant.traces.turns": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "audit.read");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { sessionKey, agentId, userId, since, until, limit, offset } = params as {
      sessionKey?: string;
      agentId?: string;
      userId?: string;
      since?: string;
      until?: string;
      limit?: number;
      offset?: number;
    };

    const result = await listInteractionTurns(ctx.tenantId, {
      sessionKey,
      agentId,
      userId,
      since: since ? new Date(since) : undefined,
      until: until ? parseUntilDate(until) : undefined,
      limit,
      offset,
    });

    const enrichedTurns = enrichTurnsWithSessionMeta(result.turns, ctx.tenantId);
    respond(true, { turns: enrichedTurns, total: result.total });
  },

  /**
   * Get all interactions for a specific turn (one user question → multiple LLM calls).
   */
  "tenant.traces.turn": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "audit.read");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { turnId } = params as { turnId?: string };
    if (!turnId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "turnId is required"));
      return;
    }

    const traces = await getInteractionsByTurn(turnId);
    // Verify tenant ownership
    if (traces.length > 0 && traces[0].tenantId !== ctx.tenantId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Turn not found"));
      return;
    }

    respond(true, { turnId, traces });
  },

  /**
   * List individual interaction traces with filters.
   */
  "tenant.traces.list": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "audit.read");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { sessionKey, agentId, userId, since, until, limit, offset } = params as {
      sessionKey?: string;
      agentId?: string;
      userId?: string;
      since?: string;
      until?: string;
      limit?: number;
      offset?: number;
    };

    const result = await listInteractionTraces(ctx.tenantId, {
      sessionKey,
      agentId,
      userId,
      since: since ? new Date(since) : undefined,
      until: until ? parseUntilDate(until) : undefined,
      limit,
      offset,
    });

    respond(true, result);
  },

  /**
   * Get a single trace with full payload (messages, response, system prompt).
   */
  "tenant.traces.detail": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}

    try {
      assertPermission(ctx.role, "audit.read");
    } catch (err) {
      if (err instanceof RbacError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }

    const { id } = params as { id?: string };
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }

    const trace = await getInteractionTrace(id);
    if (!trace || trace.tenantId !== ctx.tenantId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Trace not found"));
      return;
    }

    respond(true, trace);
  },
};
