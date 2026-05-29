/**
 * Build EnClawsConfig from DB sys_config tables and inject into runtime.
 */

import { loadAllSysConfig } from "../db/models/sys-config.js";
import type {
  SysGatewayConfigRow,
  SysLoggingConfigRow,
  SysPluginsConfigRow,
  SysToolsConfigRow,
} from "../db/types.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot, loadConfig } from "./io.js";
import type { LoggingConfig } from "./types.base.js";
import type { GatewayConfig } from "./types.gateway.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import type { PluginsConfig } from "./types.plugins.js";
import type { ToolsConfig } from "./types.tools.js";

/**
 * Build an EnClawsConfig from the 3 sys_config DB tables.
 * Gateway auth is forced to `{ mode: "none" }` — JWT handles auth now.
 */
export async function buildSysConfig(): Promise<OpenClawConfig> {
  const { gateway: gw, logging: lg, plugins: pl, tools: tl } = await loadAllSysConfig();

  const gateway = buildGatewayConfig(gw);
  const logging = buildLoggingConfig(lg);
  const plugins = buildPluginsConfig(pl);
  const tools = buildToolsConfig(tl);

  const config: OpenClawConfig = {
    gateway,
    logging,
    plugins,
    tools,
  };

  // .env overrides for startup-essential fields
  const envPort = process.env.ENCLAWS_GATEWAY_PORT;
  if (envPort && config.gateway) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed)) {
      config.gateway.port = parsed;
    }
  }

  // control_ui: built entirely from env vars
  if (config.gateway) {
    const port = config.gateway.port ?? 18888;
    const envDisableAuth = process.env.ENCLAWS_CONTROL_UI_DISABLE_DEVICE_AUTH;
    const envOrigins = process.env.ENCLAWS_CONTROL_UI_ALLOWED_ORIGINS;

    config.gateway.controlUi = {
      dangerouslyDisableDeviceAuth: envDisableAuth === "true",
      allowedOrigins: envOrigins
        ? envOrigins
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
    };
  }

  return config;
}

function buildGatewayConfig(row: SysGatewayConfigRow): GatewayConfig {
  const cfg: GatewayConfig = {
    port: row.port,
    auth: { mode: "none" }, // force no gateway auth — JWT handles it
  };
  if (row.mode) {
    cfg.mode = row.mode as GatewayConfig["mode"];
  }
  if (row.bind) {
    cfg.bind = row.bind as GatewayConfig["bind"];
  }
  if (row.customBindHost) {
    cfg.customBindHost = row.customBindHost;
  }
  if (row.tailscale && Object.keys(row.tailscale).length > 0) {
    cfg.tailscale = row.tailscale as GatewayConfig["tailscale"];
  }
  if (row.remote && Object.keys(row.remote).length > 0) {
    cfg.remote = row.remote as GatewayConfig["remote"];
  }
  if (row.reload && Object.keys(row.reload).length > 0) {
    cfg.reload = row.reload as GatewayConfig["reload"];
  }
  if (row.tls && Object.keys(row.tls).length > 0) {
    cfg.tls = row.tls as GatewayConfig["tls"];
  }
  if (row.http && Object.keys(row.http).length > 0) {
    cfg.http = row.http as GatewayConfig["http"];
  }
  if (row.nodes && Object.keys(row.nodes).length > 0) {
    cfg.nodes = row.nodes as GatewayConfig["nodes"];
  }
  if (row.trustedProxies && row.trustedProxies.length > 0) {
    cfg.trustedProxies = row.trustedProxies;
  }
  if (row.allowRealIpFallback) {
    cfg.allowRealIpFallback = true;
  }
  if (row.tools && Object.keys(row.tools).length > 0) {
    cfg.tools = row.tools as GatewayConfig["tools"];
  }
  if (row.channelHealthCheckMinutes != null) {
    cfg.channelHealthCheckMinutes = row.channelHealthCheckMinutes;
  }
  if (row.multiTenant && Object.keys(row.multiTenant).length > 0) {
    cfg.multiTenant = row.multiTenant as GatewayConfig["multiTenant"];
  }
  return cfg;
}

function buildLoggingConfig(row: SysLoggingConfigRow): LoggingConfig {
  const cfg: LoggingConfig = {};
  if (row.level) {
    cfg.level = row.level as LoggingConfig["level"];
  }
  if (row.file) {
    cfg.file = row.file;
  }
  if (row.maxFileBytes != null) {
    cfg.maxFileBytes = row.maxFileBytes;
  }
  if (row.consoleLevel) {
    cfg.consoleLevel = row.consoleLevel as LoggingConfig["consoleLevel"];
  }
  if (row.consoleStyle) {
    cfg.consoleStyle = row.consoleStyle as LoggingConfig["consoleStyle"];
  }
  if (row.redactSensitive) {
    cfg.redactSensitive = row.redactSensitive as LoggingConfig["redactSensitive"];
  }
  if (row.redactPatterns && row.redactPatterns.length > 0) {
    cfg.redactPatterns = row.redactPatterns;
  }
  return cfg;
}

function buildPluginsConfig(row: SysPluginsConfigRow): PluginsConfig {
  const cfg: PluginsConfig = {
    enabled: row.enabled,
  };
  if (row.allow && row.allow.length > 0) {
    cfg.allow = row.allow;
  }
  if (row.deny && row.deny.length > 0) {
    cfg.deny = row.deny;
  }
  if (row.load && Object.keys(row.load).length > 0) {
    cfg.load = row.load as PluginsConfig["load"];
  }
  if (row.slots && Object.keys(row.slots).length > 0) {
    cfg.slots = row.slots as PluginsConfig["slots"];
  }
  if (row.entries && Object.keys(row.entries).length > 0) {
    cfg.entries = row.entries as PluginsConfig["entries"];
  }
  if (row.installs && Object.keys(row.installs).length > 0) {
    cfg.installs = row.installs as PluginsConfig["installs"];
  }
  return cfg;
}

function buildToolsConfig(row: SysToolsConfigRow): ToolsConfig {
  const cfg: ToolsConfig = {};
  if (row.allowDangerousToolsOverride) {
    cfg.allowDangerousToolsOverride = true;
  }
  if (row.profile) {
    cfg.profile = row.profile as ToolsConfig["profile"];
  }
  if (row.allow && row.allow.length > 0) {
    cfg.allow = row.allow;
  }
  if (row.alsoAllow && row.alsoAllow.length > 0) {
    cfg.alsoAllow = row.alsoAllow;
  }
  if (row.deny && row.deny.length > 0) {
    cfg.deny = row.deny;
  }
  if (row.byProvider && Object.keys(row.byProvider).length > 0) {
    cfg.byProvider = row.byProvider as ToolsConfig["byProvider"];
  }
  if (row.web && Object.keys(row.web).length > 0) {
    cfg.web = row.web as ToolsConfig["web"];
  }
  if (row.media && Object.keys(row.media).length > 0) {
    cfg.media = row.media as ToolsConfig["media"];
  }
  if (row.links && Object.keys(row.links).length > 0) {
    cfg.links = row.links as ToolsConfig["links"];
  }
  if (row.message && Object.keys(row.message).length > 0) {
    cfg.message = row.message as ToolsConfig["message"];
  }
  if (row.agentToAgent && Object.keys(row.agentToAgent).length > 0) {
    cfg.agentToAgent = row.agentToAgent as ToolsConfig["agentToAgent"];
  }
  if (row.sessions && Object.keys(row.sessions).length > 0) {
    cfg.sessions = row.sessions as ToolsConfig["sessions"];
  }
  if (row.elevated && Object.keys(row.elevated).length > 0) {
    cfg.elevated = row.elevated as ToolsConfig["elevated"];
  }
  if (row.exec && Object.keys(row.exec).length > 0) {
    cfg.exec = row.exec as ToolsConfig["exec"];
  }
  if (row.fs && Object.keys(row.fs).length > 0) {
    cfg.fs = row.fs as ToolsConfig["fs"];
  }
  if (row.loopDetection && Object.keys(row.loopDetection).length > 0) {
    cfg.loopDetection = row.loopDetection as ToolsConfig["loopDetection"];
  }
  if (row.subagents && Object.keys(row.subagents).length > 0) {
    cfg.subagents = row.subagents as ToolsConfig["subagents"];
  }
  if (row.sandbox && Object.keys(row.sandbox).length > 0) {
    cfg.sandbox = row.sandbox as ToolsConfig["sandbox"];
  }
  return cfg;
}

/**
 * Load sys config from DB, build EnClawsConfig, and merge it into the runtime snapshot.
 * Only updates gateway/logging/plugins/tools fields — preserves existing channels, agents,
 * bindings, and other runtime state.
 *
 * At gateway startup, loadAndActivateSysConfig may be called before any loadConfig()
 * populates the runtime snapshot. In that case `getRuntimeConfigSnapshot()` returns
 * null and spreading it contributes nothing, silently dropping file-based config
 * (e.g. agents.defaults.memorySearch from ~/.enclaws/enclaws.json). To preserve
 * file-based config across startup, fall back to loadConfig() as the base when the
 * snapshot has not been seeded yet.
 *
 * 启动时 loadAndActivateSysConfig 可能先于 loadConfig() 跑，snapshot 为 null，
 * spread null 会丢掉文件配置（如 agents.defaults.memorySearch）。
 * 为此，snapshot 为空时 fallback 到 loadConfig() 作为 base。
 */
export async function loadAndActivateSysConfig(): Promise<void> {
  const sysConfig = await buildSysConfig();
  const base = getRuntimeConfigSnapshot() ?? loadConfig();
  const merged: OpenClawConfig = {
    ...base,
    ...sysConfig,
  };
  setRuntimeConfigSnapshot(merged);
}
