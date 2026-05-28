/**
 * System config CRUD — SQLite implementation.
 */

import { sqliteQuery } from "../index.js";
import type {
  SysGatewayConfigRow,
  SysLoggingConfigRow,
  SysPluginsConfigRow,
  SysToolsConfigRow,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Row adapters
// ---------------------------------------------------------------------------

function rowToGatewayConfig(row: Record<string, unknown>): SysGatewayConfigRow {
  return {
    id: row.id as number,
    port: row.port as number,
    mode: row.mode as string | null,
    bind: row.bind as string | null,
    customBindHost: row.custom_bind_host as string | null,
    tailscale: (row.tailscale ?? {}) as Record<string, unknown>,
    remote: (row.remote ?? {}) as Record<string, unknown>,
    reload: (row.reload ?? {}) as Record<string, unknown>,
    tls: (row.tls ?? {}) as Record<string, unknown>,
    http: (row.http ?? {}) as Record<string, unknown>,
    nodes: (row.nodes ?? {}) as Record<string, unknown>,
    trustedProxies: (row.trusted_proxies ?? []) as string[],
    allowRealIpFallback: Boolean(row.allow_real_ip_fallback),
    auth: (row.auth ?? {}) as Record<string, unknown>,
    tools: (row.tools ?? {}) as Record<string, unknown>,
    channelHealthCheckMinutes: row.channel_health_check_minutes as number | null,
    multiTenant: (row.multi_tenant ?? {}) as Record<string, unknown>,
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToLoggingConfig(row: Record<string, unknown>): SysLoggingConfigRow {
  return {
    id: row.id as number,
    level: row.level as string | null,
    file: row.file as string | null,
    maxFileBytes: row.max_file_bytes as number | null,
    consoleLevel: row.console_level as string | null,
    consoleStyle: row.console_style as string | null,
    redactSensitive: row.redact_sensitive as string | null,
    redactPatterns: (row.redact_patterns ?? []) as string[],
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToPluginsConfig(row: Record<string, unknown>): SysPluginsConfigRow {
  return {
    id: row.id as number,
    enabled: Boolean(row.enabled),
    allow: (row.allow ?? []) as string[],
    deny: (row.deny ?? []) as string[],
    load: (row.load ?? {}) as Record<string, unknown>,
    slots: (row.slots ?? {}) as Record<string, unknown>,
    entries: (row.entries ?? {}) as Record<string, unknown>,
    installs: (row.installs ?? {}) as Record<string, unknown>,
    updatedAt: new Date(row.updated_at as string),
  };
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export async function getSysGatewayConfig(): Promise<SysGatewayConfigRow> {
  const result = sqliteQuery("SELECT * FROM sys_gateway_config WHERE id = 1");
  return rowToGatewayConfig(result.rows[0]);
}

export async function upsertSysGatewayConfig(
  data: Partial<Omit<SysGatewayConfigRow, "id" | "updatedAt">>,
): Promise<SysGatewayConfigRow> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (data.port !== undefined) { sets.push("port = ?"); values.push(data.port); }
  if (data.mode !== undefined) { sets.push("mode = ?"); values.push(data.mode); }
  if (data.bind !== undefined) { sets.push("bind = ?"); values.push(data.bind); }
  if (data.customBindHost !== undefined) { sets.push("custom_bind_host = ?"); values.push(data.customBindHost); }
  if (data.tailscale !== undefined) { sets.push("tailscale = ?"); values.push(JSON.stringify(data.tailscale)); }
  if (data.remote !== undefined) { sets.push("remote = ?"); values.push(JSON.stringify(data.remote)); }
  if (data.reload !== undefined) { sets.push("reload = ?"); values.push(JSON.stringify(data.reload)); }
  if (data.tls !== undefined) { sets.push("tls = ?"); values.push(JSON.stringify(data.tls)); }
  if (data.http !== undefined) { sets.push("http = ?"); values.push(JSON.stringify(data.http)); }
  if (data.nodes !== undefined) { sets.push("nodes = ?"); values.push(JSON.stringify(data.nodes)); }
  if (data.trustedProxies !== undefined) { sets.push("trusted_proxies = ?"); values.push(JSON.stringify(data.trustedProxies)); }
  if (data.allowRealIpFallback !== undefined) { sets.push("allow_real_ip_fallback = ?"); values.push(data.allowRealIpFallback ? 1 : 0); }
  if (data.auth !== undefined) { sets.push("auth = ?"); values.push(JSON.stringify(data.auth)); }
  if (data.tools !== undefined) { sets.push("tools = ?"); values.push(JSON.stringify(data.tools)); }
  if (data.channelHealthCheckMinutes !== undefined) { sets.push("channel_health_check_minutes = ?"); values.push(data.channelHealthCheckMinutes); }
  if (data.multiTenant !== undefined) { sets.push("multi_tenant = ?"); values.push(JSON.stringify(data.multiTenant)); }

  if (sets.length > 0) {
    sqliteQuery(`UPDATE sys_gateway_config SET ${sets.join(", ")} WHERE id = 1`, values);
  }
  return getSysGatewayConfig();
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export async function getSysLoggingConfig(): Promise<SysLoggingConfigRow> {
  const result = sqliteQuery("SELECT * FROM sys_logging_config WHERE id = 1");
  return rowToLoggingConfig(result.rows[0]);
}

export async function upsertSysLoggingConfig(
  data: Partial<Omit<SysLoggingConfigRow, "id" | "updatedAt">>,
): Promise<SysLoggingConfigRow> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (data.level !== undefined) { sets.push("level = ?"); values.push(data.level); }
  if (data.file !== undefined) { sets.push("file = ?"); values.push(data.file); }
  if (data.maxFileBytes !== undefined) { sets.push("max_file_bytes = ?"); values.push(data.maxFileBytes); }
  if (data.consoleLevel !== undefined) { sets.push("console_level = ?"); values.push(data.consoleLevel); }
  if (data.consoleStyle !== undefined) { sets.push("console_style = ?"); values.push(data.consoleStyle); }
  if (data.redactSensitive !== undefined) { sets.push("redact_sensitive = ?"); values.push(data.redactSensitive); }
  if (data.redactPatterns !== undefined) { sets.push("redact_patterns = ?"); values.push(JSON.stringify(data.redactPatterns)); }

  if (sets.length > 0) {
    sqliteQuery(`UPDATE sys_logging_config SET ${sets.join(", ")} WHERE id = 1`, values);
  }
  return getSysLoggingConfig();
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export async function getSysPluginsConfig(): Promise<SysPluginsConfigRow> {
  const result = sqliteQuery("SELECT * FROM sys_plugins_config WHERE id = 1");
  return rowToPluginsConfig(result.rows[0]);
}

export async function upsertSysPluginsConfig(
  data: Partial<Omit<SysPluginsConfigRow, "id" | "updatedAt">>,
): Promise<SysPluginsConfigRow> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (data.enabled !== undefined) { sets.push("enabled = ?"); values.push(data.enabled ? 1 : 0); }
  if (data.allow !== undefined) { sets.push("allow = ?"); values.push(JSON.stringify(data.allow)); }
  if (data.deny !== undefined) { sets.push("deny = ?"); values.push(JSON.stringify(data.deny)); }
  if (data.load !== undefined) { sets.push("load = ?"); values.push(JSON.stringify(data.load)); }
  if (data.slots !== undefined) { sets.push("slots = ?"); values.push(JSON.stringify(data.slots)); }
  if (data.entries !== undefined) { sets.push("entries = ?"); values.push(JSON.stringify(data.entries)); }
  if (data.installs !== undefined) { sets.push("installs = ?"); values.push(JSON.stringify(data.installs)); }

  if (sets.length > 0) {
    sqliteQuery(`UPDATE sys_plugins_config SET ${sets.join(", ")} WHERE id = 1`, values);
  }
  return getSysPluginsConfig();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function rowToToolsConfig(row: Record<string, unknown>): SysToolsConfigRow {
  return {
    id: row.id as number,
    allowDangerousToolsOverride: Boolean(row.allow_dangerous_tools_override),
    profile: row.profile as string | null,
    allow: (row.allow ?? []) as string[],
    alsoAllow: (row.also_allow ?? []) as string[],
    deny: (row.deny ?? []) as string[],
    byProvider: (row.by_provider ?? {}) as Record<string, unknown>,
    web: (row.web ?? {}) as Record<string, unknown>,
    media: (row.media ?? {}) as Record<string, unknown>,
    links: (row.links ?? {}) as Record<string, unknown>,
    message: (row.message ?? {}) as Record<string, unknown>,
    agentToAgent: (row.agent_to_agent ?? {}) as Record<string, unknown>,
    sessions: (row.sessions ?? {}) as Record<string, unknown>,
    elevated: (row.elevated ?? {}) as Record<string, unknown>,
    exec: (row.exec ?? {}) as Record<string, unknown>,
    fs: (row.fs ?? {}) as Record<string, unknown>,
    loopDetection: (row.loop_detection ?? {}) as Record<string, unknown>,
    subagents: (row.subagents ?? {}) as Record<string, unknown>,
    sandbox: (row.sandbox ?? {}) as Record<string, unknown>,
    updatedAt: new Date(row.updated_at as string),
  };
}

export async function getSysToolsConfig(): Promise<SysToolsConfigRow> {
  const result = sqliteQuery("SELECT * FROM sys_tools_config WHERE id = 1");
  return rowToToolsConfig(result.rows[0]);
}

export async function upsertSysToolsConfig(
  data: Partial<Omit<SysToolsConfigRow, "id" | "updatedAt">>,
): Promise<SysToolsConfigRow> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (data.allowDangerousToolsOverride !== undefined) { sets.push("allow_dangerous_tools_override = ?"); values.push(data.allowDangerousToolsOverride ? 1 : 0); }
  if (data.profile !== undefined) { sets.push("profile = ?"); values.push(data.profile); }
  if (data.allow !== undefined) { sets.push("allow = ?"); values.push(JSON.stringify(data.allow)); }
  if (data.alsoAllow !== undefined) { sets.push("also_allow = ?"); values.push(JSON.stringify(data.alsoAllow)); }
  if (data.deny !== undefined) { sets.push("deny = ?"); values.push(JSON.stringify(data.deny)); }
  if (data.byProvider !== undefined) { sets.push("by_provider = ?"); values.push(JSON.stringify(data.byProvider)); }
  if (data.web !== undefined) { sets.push("web = ?"); values.push(JSON.stringify(data.web)); }
  if (data.media !== undefined) { sets.push("media = ?"); values.push(JSON.stringify(data.media)); }
  if (data.links !== undefined) { sets.push("links = ?"); values.push(JSON.stringify(data.links)); }
  if (data.message !== undefined) { sets.push("message = ?"); values.push(JSON.stringify(data.message)); }
  if (data.agentToAgent !== undefined) { sets.push("agent_to_agent = ?"); values.push(JSON.stringify(data.agentToAgent)); }
  if (data.sessions !== undefined) { sets.push("sessions = ?"); values.push(JSON.stringify(data.sessions)); }
  if (data.elevated !== undefined) { sets.push("elevated = ?"); values.push(JSON.stringify(data.elevated)); }
  if (data.exec !== undefined) { sets.push("exec = ?"); values.push(JSON.stringify(data.exec)); }
  if (data.fs !== undefined) { sets.push("fs = ?"); values.push(JSON.stringify(data.fs)); }
  if (data.loopDetection !== undefined) { sets.push("loop_detection = ?"); values.push(JSON.stringify(data.loopDetection)); }
  if (data.subagents !== undefined) { sets.push("subagents = ?"); values.push(JSON.stringify(data.subagents)); }
  if (data.sandbox !== undefined) { sets.push("sandbox = ?"); values.push(JSON.stringify(data.sandbox)); }

  if (sets.length > 0) {
    sqliteQuery(`UPDATE sys_tools_config SET ${sets.join(", ")} WHERE id = 1`, values);
  }
  return getSysToolsConfig();
}

// ---------------------------------------------------------------------------
// Bulk load
// ---------------------------------------------------------------------------

export async function loadAllSysConfig(): Promise<{
  gateway: SysGatewayConfigRow;
  logging: SysLoggingConfigRow;
  plugins: SysPluginsConfigRow;
  tools: SysToolsConfigRow;
}> {
  return {
    gateway: await getSysGatewayConfig(),
    logging: await getSysLoggingConfig(),
    plugins: await getSysPluginsConfig(),
    tools: await getSysToolsConfig(),
  };
}
