/**
 * Unit tests for CS config read/write normalization (P5 widget data model).
 *
 * Covers backward compatibility: OLD-shape config.json (channels with only
 * {label, html}, no csMode) must be normalized on read — every channel gains a
 * stable `id` + `enabled: true`, `agentId` stays undefined, `csMode` stays
 * undefined. New-shape configs must round-trip unchanged.
 *
 * 客服配置读写规范化单测（P5 widget 数据模型）。重点验证向后兼容：
 * 旧结构 config.json（channel 只有 label/html，无 csMode）读取时必须被规范化——
 * 每个 channel 补上稳定 id + enabled:true，agentId 保持 undefined，csMode 保持
 * undefined。新结构配置必须无损往返。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { csConfigPath, readCSConfig, writeCSConfig } from "./cs-admin.js";

describe("CS config normalization (backward compat)", () => {
  const envSnapshot = captureEnv(["ENCLAWS_STATE_DIR"]);
  let tmpDir: string;
  const tenantId = "tenant-test";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-config-test-"));
    process.env.ENCLAWS_STATE_DIR = tmpDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeRawConfig(raw: unknown): Promise<void> {
    const filePath = csConfigPath(tenantId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf-8");
  }

  it("returns {} for a missing config file (no crash)", async () => {
    const cfg = await readCSConfig(tenantId);
    expect(cfg).toEqual({});
  });

  it("normalizes an OLD-shape config: channels get id + enabled, csMode undefined", async () => {
    // OLD shape: channels have only label + html, no id/enabled, no csMode.
    await writeRawConfig({
      feishu: { appId: "cli_x", appSecret: "secret", chatId: "oc_x" },
      channels: [
        { label: "官网", html: "<div>a</div>" },
        { label: "App", html: "<div>b</div>" },
      ],
    });

    const cfg = await readCSConfig(tenantId);

    expect(cfg.channels).toHaveLength(2);
    for (const ch of cfg.channels ?? []) {
      expect(typeof ch.id).toBe("string");
      expect(ch.id.length).toBeGreaterThan(0);
      expect(ch.enabled).toBe(true);
      expect(ch.agentId).toBeUndefined();
    }
    // Labels/html preserved
    expect(cfg.channels?.[0]).toMatchObject({ label: "官网", html: "<div>a</div>" });
    expect(cfg.channels?.[1]).toMatchObject({ label: "App", html: "<div>b</div>" });
    // csMode not invented on read
    expect(cfg.csMode).toBeUndefined();
    // Other fields untouched
    expect(cfg.feishu?.appId).toBe("cli_x");
  });

  it("generates unique ids across channels in the same config", async () => {
    await writeRawConfig({
      channels: [
        { label: "A", html: "<x>1</x>" },
        { label: "B", html: "<x>2</x>" },
        { label: "C", html: "<x>3</x>" },
      ],
    });

    const cfg = await readCSConfig(tenantId);
    const ids = (cfg.channels ?? []).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("generates the same id on repeated reads of an unchanged OLD config (deterministic/stable)", async () => {
    await writeRawConfig({
      channels: [{ label: "官网", html: "<div>a</div>" }],
    });

    const first = await readCSConfig(tenantId);
    const second = await readCSConfig(tenantId);
    expect(first.channels?.[0].id).toBe(second.channels?.[0].id);
  });

  it("preserves an existing id and does NOT overwrite it", async () => {
    await writeRawConfig({
      channels: [{ id: "fixed-id-123", label: "官网", html: "<div>a</div>", enabled: false }],
    });

    const cfg = await readCSConfig(tenantId);
    expect(cfg.channels?.[0].id).toBe("fixed-id-123");
    // explicit enabled:false must be respected, not defaulted to true
    expect(cfg.channels?.[0].enabled).toBe(false);
  });

  it("round-trips a NEW-shape config with id/agentId/enabled + csMode", async () => {
    const config = {
      channels: [
        { id: "w1", label: "官网", html: "<div>a</div>", agentId: "agent-x", enabled: true },
        { id: "w2", label: "App", html: "<div>b</div>", enabled: false },
      ],
      csMode: "widget" as const,
    };

    await writeCSConfig(tenantId, config);
    const cfg = await readCSConfig(tenantId);

    expect(cfg.csMode).toBe("widget");
    expect(cfg.channels?.[0]).toMatchObject({
      id: "w1",
      label: "官网",
      html: "<div>a</div>",
      agentId: "agent-x",
      enabled: true,
    });
    expect(cfg.channels?.[1]).toMatchObject({
      id: "w2",
      label: "App",
      enabled: false,
    });
    expect(cfg.channels?.[1].agentId).toBeUndefined();
  });

  it("accepts csMode = 'api' and round-trips it", async () => {
    await writeCSConfig(tenantId, { csMode: "api", channels: [] });
    const cfg = await readCSConfig(tenantId);
    expect(cfg.csMode).toBe("api");
  });
});
