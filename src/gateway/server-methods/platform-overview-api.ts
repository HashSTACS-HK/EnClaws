/**
 * Gateway RPC handlers for platform overview dashboard.
 *
 * Methods:
 *   platform.overview.summary             - Platform summary stats
 *   platform.overview.tokenTrend          - Token usage trend by day
 *   platform.overview.tokenRank           - Token usage rankings (4 dimensions)
 *   platform.overview.llmStats            - LLM interaction statistics
 *   platform.overview.channelDistribution - Channel type distribution
 *   platform.overview.userActivity        - User activity metrics
 *
 * All methods require platform-admin role.
 */

import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { isDbInitialized } from "../../db/index.js";
import type { TenantContext } from "../../auth/middleware.js";
import {
  getPlatformSummary,
  getTokenTrend,
  getTokenRank,
  getLlmStats,
  getChannelDistribution,
  getUserActivity,
} from "../../db/models/platform-stats.js";

function requirePlatformAdmin(
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
  if (tenant.role !== "platform-admin") {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Platform admin access required"));
    return null;
  }
  return tenant;
}

export const platformOverviewHandlers: GatewayRequestHandlers = {
  "platform.overview.summary": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    if (!requirePlatformAdmin(client, respond)) {return;}

    try {
      const summary = await getPlatformSummary();

      // Get gateway uptime from process
      const uptimeMs = Math.floor(process.uptime() * 1000);

      respond(true, {
        gateway: { status: "running", uptimeMs },
        ...summary,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : "Failed to load summary"));
    }
  },

  "platform.overview.tokenTrend": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requirePlatformAdmin(client, respond)) {return;}

    const { days } = params as { days?: number };
    const d = days === 7 ? 7 : 30;

    try {
      const trend = await getTokenTrend(d);
      respond(true, { trend });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : "Failed to load token trend"));
    }
  },

  "platform.overview.tokenRank": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requirePlatformAdmin(client, respond)) {return;}

    const { period, limit } = params as { period?: string; limit?: number };
    const p = (period === "month" || period === "today") ? period : "all";
    const l = Math.min(Math.max(limit ?? 5, 1), 20);

    try {
      const rank = await getTokenRank(p, l);
      respond(true, rank);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : "Failed to load token rank"));
    }
  },

  "platform.overview.llmStats": async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
    if (!requirePlatformAdmin(client, respond)) {return;}

    const { period } = params as { period?: string };
    const p = (period === "month" || period === "today") ? period : "all";

    try {
      const stats = await getLlmStats(p);
      respond(true, stats);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : "Failed to load LLM stats"));
    }
  },

  "platform.overview.channelDistribution": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    if (!requirePlatformAdmin(client, respond)) {return;}

    try {
      const channels = await getChannelDistribution();
      respond(true, { channels });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : "Failed to load channel distribution"));
    }
  },

  "platform.overview.userActivity": async ({ client, respond }: GatewayRequestHandlerOptions) => {
    if (!requirePlatformAdmin(client, respond)) {return;}

    try {
      const activity = await getUserActivity();
      respond(true, activity);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : "Failed to load user activity"));
    }
  },
};
