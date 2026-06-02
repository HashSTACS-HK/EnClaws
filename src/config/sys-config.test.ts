import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SysGatewayConfigRow,
  SysLoggingConfigRow,
  SysPluginsConfigRow,
  SysToolsConfigRow,
} from "../db/types.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "./io.js";

const loadAllSysConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../db/models/sys-config.js", () => ({
  loadAllSysConfig: loadAllSysConfigMock,
}));

const now = new Date("2026-06-02T00:00:00Z");

function gatewayRow(overrides: Partial<SysGatewayConfigRow> = {}): SysGatewayConfigRow {
  return {
    id: 1,
    port: 19001,
    mode: "local",
    bind: "lan",
    customBindHost: null,
    tailscale: {},
    remote: {},
    reload: {},
    tls: {},
    http: {},
    nodes: {},
    trustedProxies: [],
    allowRealIpFallback: false,
    auth: {},
    tools: {},
    channelHealthCheckMinutes: null,
    multiTenant: {},
    updatedAt: now,
    ...overrides,
  };
}

function loggingRow(): SysLoggingConfigRow {
  return {
    id: 1,
    level: null,
    file: null,
    maxFileBytes: null,
    consoleLevel: null,
    consoleStyle: null,
    redactSensitive: null,
    redactPatterns: [],
    updatedAt: now,
  };
}

function pluginsRow(): SysPluginsConfigRow {
  return {
    id: 1,
    enabled: true,
    allow: [],
    deny: [],
    load: {},
    slots: {},
    entries: {},
    installs: {},
    updatedAt: now,
  };
}

function toolsRow(): SysToolsConfigRow {
  return {
    id: 1,
    allowDangerousToolsOverride: false,
    profile: null,
    allow: [],
    alsoAllow: [],
    deny: [],
    byProvider: {},
    web: {},
    media: {},
    links: {},
    message: {},
    agentToAgent: {},
    sessions: {},
    elevated: {},
    exec: {},
    fs: {},
    loopDetection: {},
    subagents: {},
    sandbox: {},
    updatedAt: now,
  };
}

describe("loadAndActivateSysConfig", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
    loadAllSysConfigMock.mockReset();
  });

  it("preserves file control UI allowed origins when sys config is activated", async () => {
    vi.stubEnv("ENCLAWS_GATEWAY_PORT", "19001");
    vi.stubEnv("ENCLAWS_CONTROL_UI_ALLOWED_ORIGINS", "");
    setRuntimeConfigSnapshot({
      gateway: {
        port: 19001,
        bind: "lan",
        controlUi: {
          allowedOrigins: ["https://70320ef0.r27.cpolar.top", "https://jiumi-demo.enclaws.com"],
        },
      },
    });
    loadAllSysConfigMock.mockResolvedValue({
      gateway: gatewayRow(),
      logging: loggingRow(),
      plugins: pluginsRow(),
      tools: toolsRow(),
    });

    const { loadAndActivateSysConfig } = await import("./sys-config.js");
    await loadAndActivateSysConfig();

    expect(getRuntimeConfigSnapshot()?.gateway?.controlUi?.allowedOrigins).toEqual([
      "https://70320ef0.r27.cpolar.top",
      "https://jiumi-demo.enclaws.com",
    ]);
  });
});
