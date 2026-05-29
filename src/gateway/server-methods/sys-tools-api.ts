/**
 * Gateway RPC handlers for platform-level tools configuration.
 *
 * Methods:
 *   sys.tools.get    - Read current sys_tools_config (deny list, profile)
 *   sys.tools.update - Update sys_tools_config (deny list, profile, etc.)
 */

import { loadAndActivateSysConfig } from "../../config/sys-config.js";
import { isDbInitialized } from "../../db/index.js";
import { getSysToolsConfig, upsertSysToolsConfig } from "../../db/models/sys-config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";

export const sysToolsHandlers: GatewayRequestHandlers = {
  "sys.tools.get": async ({ respond }: GatewayRequestHandlerOptions) => {
    if (!isDbInitialized()) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Database not initialized"));
      return;
    }
    const row = await getSysToolsConfig();
    respond(true, {
      profile: row.profile,
      deny: row.deny,
      allow: row.allow,
      alsoAllow: row.alsoAllow,
    });
  },

  "sys.tools.update": async ({ params, respond }: GatewayRequestHandlerOptions) => {
    if (!isDbInitialized()) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Database not initialized"));
      return;
    }
    const { deny, profile } = params as {
      deny?: string[];
      profile?: string;
    };
    const updates: Record<string, unknown> = {};
    if (deny !== undefined) {
      updates.deny = deny;
    }
    if (profile !== undefined) {
      updates.profile = profile;
    }

    if (Object.keys(updates).length === 0) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_PARAMS, "No fields to update"));
      return;
    }

    const row = await upsertSysToolsConfig(updates as any);
    // Reload runtime config to apply changes
    await loadAndActivateSysConfig();
    respond(true, {
      profile: row.profile,
      deny: row.deny,
    });
  },
};
