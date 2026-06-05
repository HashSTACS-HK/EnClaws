import { config } from "dotenv";

config({ override: true });

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TestEnv } from "../index.js";

const GATEWAY_URL = process.env.TEST_GATEWAY_URL ?? "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.ENCLAWS_GATEWAY_TOKEN ?? "";

describe("full setup → chat", () => {
  const env = new TestEnv({ url: GATEWAY_URL, gatewayToken: GATEWAY_TOKEN });
  const slug = `test-${Date.now()}`;
  const email = `admin${slug}@stacs.cn`;
  const password = "Aa123456!";
  const agentId = `agent${slug}`;

  beforeAll(async () => {
    // 1. Register tenant
    await env.register({
      tenantName: "IM Simulator Test",
      email: email,
      password: password,
    });

    // await env.inviteUser({ email: "alice@acme.com", password: password, role: "member" });
    // await env.inviteUser({ email: "bob@acme.com", password: password, role: "member" });

    // 2. Create model
    const model = await env.createModel({
      providerType: "openai",
      providerName: `openai Test ${slug}`,
      baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
      apiKey: process.env.TEST_DEEPSEEK_API_KEY ?? "sk-sp-b54ca01394e44a048cbb24484842c1fa",
      models: [{ id: "qwen3.5-plus", name: `qwen3.5-plus${slug}` }],
    });
    console.log(`Model created: ${model.id}`);

    // 3. Create agent
    await env.createAgent({
      agentId: agentId,
      name: "Greeter Bot",
      systemPrompt: "你是一个友好的问候机器人。用户说什么你都热情回复。回复要简短。",
      modelConfig: [{ providerId: model.id, modelId: "qwen3.5-plus", isDefault: true }],
    });
  }, 30_000);

  afterAll(async () => {
    await env.disconnect();
  });

  it("register tenant succeeds", () => {
    // beforeAll already ran register(); if we got here it succeeded.
    expect(true).toBe(true);
  });
});
