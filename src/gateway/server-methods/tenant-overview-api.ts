/**
 * Gateway RPC handlers for tenant (enterprise) overview dashboard.
 *
 * Methods:
 *   tenant.overview.summary             - Tenant summary (cards data)
 *   tenant.overview.trend               - Token usage trend by day
 *   tenant.overview.rank                - Token consumption ranking (users/agents/models)
 *   tenant.overview.llm                 - LLM interaction statistics
 *   tenant.overview.channelDistribution - Channel type distribution
 *   tenant.overview.recentTraces        - Recent LLM interaction traces
 *
 * All methods require authenticated tenant context.
 */

import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { isDbInitialized } from "../../db/index.js";
import type { TenantContext } from "../../auth/middleware.js";
import {
  getTenantSummary,
  getTenantTokenTrend,
  getTenantTokenRank,
  getTenantLlmStats,
  getTenantChannelDistribution,
  getTenantRecentTraces,
} from "../../db/models/tenant-stats.js";

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

export const tenantOverviewHandlers: GatewayRequestHandlers = {
  "tenant.overview.summary": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}
    try {
      const result = await getTenantSummary(ctx.tenantId);
      respond(true, result);
    } catch (err) {
      console.error("[tenant.overview.summary] error:", err);
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  "tenant.overview.trend": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}
    try {
      const { period } = (params ?? {}) as { period?: string };
      const days = period === "30d" ? 30 : 7;
      const items = await getTenantTokenTrend(ctx.tenantId, days);
      respond(true, { items });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  "tenant.overview.rank": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}
    try {
      const { period } = (params ?? {}) as { period?: "all" | "month" | "today" };
      const result = await getTenantTokenRank(ctx.tenantId, period ?? "all");
      respond(true, result);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  "tenant.overview.llm": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}
    try {
      const { period } = (params ?? {}) as { period?: "all" | "month" | "today" };
      const result = await getTenantLlmStats(ctx.tenantId, period ?? "all");
      respond(true, result);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  "tenant.overview.channelDistribution": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}
    try {
      const channels = await getTenantChannelDistribution(ctx.tenantId);
      respond(true, { channels });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },

  "tenant.overview.recentTraces": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {return;}
    try {
      const traces = await getTenantRecentTraces(ctx.tenantId, 10);
      respond(true, { traces });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, (err as Error).message));
    }
  },
};
