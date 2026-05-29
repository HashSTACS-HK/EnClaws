/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Tests for @all (mention_all) support in group chats.
 * Covers: config schema, mention detection, config resolution, parseMessageEvent integration.
 */

import { describe, expect, it } from "vitest";
import { FeishuAccountConfigSchema, FeishuGroupSchema } from "../src/core/config-schema";
import { resolveRespondToMentionAll } from "../src/messaging/inbound/gate";
import { isMentionAll } from "../src/messaging/inbound/mention";
import { parseMessageEvent } from "../src/messaging/inbound/parse";

describe("respondToMentionAll config schema", () => {
  it("FeishuGroupSchema preserves value", () => {
    const result = FeishuGroupSchema.safeParse({ respondToMentionAll: true });
    expect(result.success).toBe(true);
    expect(result.data!.respondToMentionAll).toBe(true);
  });

  it("FeishuAccountConfigSchema preserves value", () => {
    const result = FeishuAccountConfigSchema.safeParse({ respondToMentionAll: false });
    expect(result.success).toBe(true);
    expect(result.data!.respondToMentionAll).toBe(false);
  });

  it("defaults to undefined when omitted", () => {
    const result = FeishuGroupSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data!.respondToMentionAll).toBeUndefined();
  });
});

describe("isMentionAll", () => {
  it("detects @_all key", () => {
    expect(isMentionAll({ key: "@_all" })).toBe(true);
  });

  it("rejects normal user mention", () => {
    expect(isMentionAll({ key: "@_user_1" })).toBe(false);
  });
});

describe("parseMessageEvent integration", () => {
  it("sets mentionAll=true when @_all is present", async () => {
    const event = {
      sender: { sender_id: { open_id: "ou_sender" } },
      message: {
        message_id: "msg_1",
        chat_id: "oc_test",
        chat_type: "group" as const,
        message_type: "text",
        content: JSON.stringify({ text: "@_all hello everyone" }),
        mentions: [
          { key: "@_all", id: { open_id: "", user_id: "", union_id: "" }, name: "所有人" },
        ],
      },
    };
    const ctx = await parseMessageEvent(event);
    expect(ctx.mentionAll).toBe(true);
    expect(ctx.mentions).toHaveLength(0);
  });

  it("sets mentionAll=false when no @_all", async () => {
    const event = {
      sender: { sender_id: { open_id: "ou_sender" } },
      message: {
        message_id: "msg_2",
        chat_id: "oc_test",
        chat_type: "group" as const,
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1 hello" }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Bot" }],
      },
    };
    const ctx = await parseMessageEvent(event, "ou_bot");
    expect(ctx.mentionAll).toBe(false);
    expect(ctx.mentions).toHaveLength(1);
    expect(ctx.mentions[0].isBot).toBe(true);
  });
});

describe("resolveRespondToMentionAll", () => {
  it("per-group true overrides global false", () => {
    expect(
      resolveRespondToMentionAll({
        groupConfig: { respondToMentionAll: true },
        defaultConfig: undefined,
        accountFeishuCfg: { respondToMentionAll: false },
      }),
    ).toBe(true);
  });

  it('default ("*") group overrides global', () => {
    expect(
      resolveRespondToMentionAll({
        groupConfig: undefined,
        defaultConfig: { respondToMentionAll: true },
        accountFeishuCfg: { respondToMentionAll: false },
      }),
    ).toBe(true);
  });

  it("falls back to global", () => {
    expect(
      resolveRespondToMentionAll({
        groupConfig: undefined,
        defaultConfig: undefined,
        accountFeishuCfg: { respondToMentionAll: true },
      }),
    ).toBe(true);
  });

  it("defaults to false when unset", () => {
    expect(
      resolveRespondToMentionAll({
        groupConfig: undefined,
        defaultConfig: undefined,
        accountFeishuCfg: undefined,
      }),
    ).toBe(false);
  });

  it("per-group false overrides global true", () => {
    expect(
      resolveRespondToMentionAll({
        groupConfig: { respondToMentionAll: false },
        defaultConfig: undefined,
        accountFeishuCfg: { respondToMentionAll: true },
      }),
    ).toBe(false);
  });
});
