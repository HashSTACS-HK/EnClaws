/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * feishu_im_user_message tool -- 以用户身份发送/回复 IM 消息
 *
 * Actions: send, reply
 *
 * Uses the Feishu IM API:
 *   - send:  POST /open-apis/im/v1/messages?receive_id_type=...
 *   - reply: POST /open-apis/im/v1/messages/:message_id/reply
 *
 * 全部以用户身份（user_access_token）调用，scope 来自 real-scope.json。
 */

import { Type } from "@sinclair/typebox";
import type { ClawdbotConfig, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createAccountScopedConfig } from "../../../core/accounts";
import { LarkClient } from "../../../core/lark-client";
import {
  StringEnum,
  assertLarkOk,
  createToolContext,
  handleInvokeErrorWithAutoAuth,
  json,
  registerTool,
} from "../helpers";

interface FeishuPostContentBlock {
  tag?: string;
  text?: string;
  [key: string]: unknown;
}

interface FeishuPostLocaleContent {
  title?: string;
  content?: FeishuPostContentBlock[][];
  [key: string]: unknown;
}

const FEISHU_POST_LOCALE_PRIORITY = ["zh_cn", "en_us", "ja_jp"] as const;

/**
 * Check whether a value is a non-null object whose properties can be read.
 *
 * @param value - The value to check
 * @returns Whether the value is a non-null object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

/**
 * Collect post content bodies from a parsed Feishu post payload.
 * Handles both flat (title/content at root) and multi-locale wrapper structures.
 *
 * @param parsed - The parsed JSON object
 * @returns List of post content bodies to process
 */
function collectPostContents(parsed: Record<string, unknown>): FeishuPostLocaleContent[] {
  if ("title" in parsed || "content" in parsed) {
    return [parsed as FeishuPostLocaleContent];
  }

  const bodies: FeishuPostLocaleContent[] = [];
  const seen = new Set<FeishuPostLocaleContent>();

  // Process well-known locales first
  for (const locale of FEISHU_POST_LOCALE_PRIORITY) {
    const localeContent = parsed[locale];
    if (!isRecord(localeContent)) {
      continue;
    }

    const body = localeContent as FeishuPostLocaleContent;
    if (!seen.has(body)) {
      bodies.push(body);
      seen.add(body);
    }
  }

  // Process remaining locales
  for (const value of Object.values(parsed)) {
    if (!isRecord(value)) {
      continue;
    }

    const body = value as FeishuPostLocaleContent;
    if (!seen.has(body)) {
      bodies.push(body);
      seen.add(body);
    }
  }

  return bodies;
}

/**
 * Convert markdown tables to the Feishu-compatible list format.
 *
 * Reuses the channel runtime's existing converter so the tool send path
 * behaves identically to the main reply path.
 *
 * @param cfg - Current tool configuration
 * @param text - Raw markdown text
 * @returns Converted text, or the original text when runtime is unavailable
 */
function convertMarkdownTablesForLark(cfg: ClawdbotConfig, text: string): string {
  try {
    const runtime = LarkClient.runtime;
    if (
      runtime?.channel?.text?.convertMarkdownTables &&
      runtime.channel.text.resolveMarkdownTableMode
    ) {
      const tableMode = runtime.channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "feishu",
      });
      return runtime.channel.text.convertMarkdownTables(text, tableMode);
    }
  } catch {
    // Runtime converter unavailable -- keep text as-is.
  }

  return text;
}

/**
 * Pre-process `tag="md"` text nodes inside `post` messages so the tool send
 * path also renders markdown tables correctly.
 *
 * @param cfg - Current tool configuration
 * @param msgType - Feishu message type
 * @param content - The JSON string from tool parameters
 * @returns Pre-processed JSON string
 */
function preprocessPostContent(cfg: ClawdbotConfig, msgType: string, content: string): string {
  if (msgType !== "post") {
    return content;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return content;
    }

    const postContents = collectPostContents(parsed);
    if (postContents.length === 0) {
      return content;
    }

    let changed = false;

    for (const postContent of postContents) {
      if (!postContent.content || !Array.isArray(postContent.content)) {
        continue;
      }

      for (const line of postContent.content) {
        if (!Array.isArray(line)) {
          continue;
        }

        for (const block of line) {
          if (!isRecord(block) || block.tag !== "md" || typeof block.text !== "string") {
            continue;
          }

          const convertedText = convertMarkdownTablesForLark(cfg, block.text);
          if (convertedText !== block.text) {
            block.text = convertedText;
            changed = true;
          }
        }
      }
    }

    return changed ? JSON.stringify(parsed) : content;
  } catch {
    return content;
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuImMessageSchema = Type.Union([
  // SEND
  Type.Object({
    action: Type.Literal("send"),
    receive_id_type: StringEnum(["open_id", "chat_id"], {
      description: "接收者 ID 类型：open_id（私聊，ou_xxx）、chat_id（群聊，oc_xxx）",
    }),
    receive_id: Type.String({
      description: "接收者 ID，与 receive_id_type 对应。open_id 填 'ou_xxx'，chat_id 填 'oc_xxx'",
    }),
    msg_type: StringEnum(
      [
        "text",
        "post",
        "image",
        "file",
        "audio",
        "media",
        "interactive",
        "share_chat",
        "share_user",
      ],
      {
        description:
          "消息类型：text（纯文本）、post（富文本）、image（图片）、file（文件）、interactive（消息卡片）、share_chat（群名片）、share_user（个人名片）等",
      },
    ),
    content: Type.String({
      description:
        "消息内容（JSON 字符串），格式取决于 msg_type。" +
        '示例：text → \'{"text":"你好"}\'，' +
        'image → \'{"image_key":"img_xxx"}\'，' +
        'share_chat → \'{"chat_id":"oc_xxx"}\'，' +
        'post → \'{"zh_cn":{"title":"标题","content":[[{"tag":"text","text":"正文"}]]}}\'',
    }),
    uuid: Type.Optional(
      Type.String({
        description: "幂等唯一标识。同一 uuid 在 1 小时内只会发送一条消息，用于去重",
      }),
    ),
  }),

  // REPLY
  Type.Object({
    action: Type.Literal("reply"),
    message_id: Type.String({
      description: "被回复消息的 ID（om_xxx 格式）",
    }),
    msg_type: StringEnum(
      [
        "text",
        "post",
        "image",
        "file",
        "audio",
        "media",
        "interactive",
        "share_chat",
        "share_user",
      ],
      {
        description:
          "消息类型：text（纯文本）、post（富文本）、image（图片）、interactive（消息卡片）等",
      },
    ),
    content: Type.String({
      description: "回复消息内容（JSON 字符串），格式同 send 的 content",
    }),
    reply_in_thread: Type.Optional(
      Type.Boolean({
        description:
          "是否以话题形式回复。true 则消息出现在该消息的话题中，false（默认）则出现在聊天主流",
      }),
    ),
    uuid: Type.Optional(
      Type.String({
        description: "幂等唯一标识",
      }),
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuImMessageParams =
  | {
      action: "send";
      receive_id_type: "open_id" | "chat_id";
      receive_id: string;
      msg_type: string;
      content: string;
      uuid?: string;
    }
  | {
      action: "reply";
      message_id: string;
      msg_type: string;
      content: string;
      reply_in_thread?: boolean;
      uuid?: string;
    };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuImUserMessageTool(api: OpenClawPluginApi): boolean {
  if (!api.config) return false;
  const cfg = api.config;
  const { toolClient, log } = createToolContext(api, "feishu_im_user_message");

  return registerTool(
    api,
    {
      name: "feishu_im_user_message",
      label: "Feishu: IM User Message",
      description:
        "飞书用户身份 IM 消息工具。**有且仅当用户明确要求以自己身份发消息、回复消息时使用，当没有明确要求时优先使用message系统工具**。" +
        "\n\nActions:" +
        "\n- send（发送消息）：发送消息到私聊或群聊。私聊用 receive_id_type=open_id，群聊用 receive_id_type=chat_id" +
        "\n- reply（回复消息）：回复指定 message_id 的消息，支持话题回复（reply_in_thread=true）" +
        "\n\n【重要】content 必须是合法 JSON 字符串，格式取决于 msg_type。" +
        '最常用：text 类型 content 为 \'{"text":"消息内容"}\'。' +
        "\n\n【安全约束】此工具以用户身份发送消息，发出后对方看到的发送者是用户本人。" +
        "调用前必须先向用户确认：1) 发送对象（哪个人或哪个群）2) 消息内容。" +
        "禁止在用户未明确同意的情况下自行发送消息。",
      parameters: FeishuImMessageSchema,
      async execute(_toolCallId: string, params: unknown) {
        const p = params as FeishuImMessageParams;
        try {
          const client = toolClient();

          switch (p.action) {
            // -----------------------------------------------------------------
            // SEND MESSAGE
            // -----------------------------------------------------------------
            case "send": {
              log.info(
                `send: receive_id_type=${p.receive_id_type}, receive_id=${p.receive_id}, msg_type=${p.msg_type}`,
              );
              const accountScopedCfg = createAccountScopedConfig(cfg, client.account.accountId);
              const processedContent = preprocessPostContent(
                accountScopedCfg,
                p.msg_type,
                p.content,
              );

              const res = await client.invoke(
                "feishu_im_user_message.send",
                (sdk, opts) =>
                  sdk.im.v1.message.create(
                    {
                      params: { receive_id_type: p.receive_id_type },
                      data: {
                        receive_id: p.receive_id,
                        msg_type: p.msg_type,
                        content: processedContent,
                        uuid: p.uuid,
                      },
                    },
                    opts,
                  ),
                {
                  as: "user",
                },
              );
              assertLarkOk(res);

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const data = res.data as any;
              log.info(`send: message sent, message_id=${data?.message_id}`);

              return json({
                message_id: data?.message_id,
                chat_id: data?.chat_id,
                create_time: data?.create_time,
              });
            }

            // -----------------------------------------------------------------
            // REPLY MESSAGE
            // -----------------------------------------------------------------
            case "reply": {
              log.info(
                `reply: message_id=${p.message_id}, msg_type=${p.msg_type}, reply_in_thread=${p.reply_in_thread ?? false}`,
              );
              const accountScopedCfg = createAccountScopedConfig(cfg, client.account.accountId);
              const processedContent = preprocessPostContent(
                accountScopedCfg,
                p.msg_type,
                p.content,
              );

              const res = await client.invoke(
                "feishu_im_user_message.reply",
                (sdk, opts) =>
                  sdk.im.v1.message.reply(
                    {
                      path: { message_id: p.message_id },
                      data: {
                        content: processedContent,
                        msg_type: p.msg_type,
                        reply_in_thread: p.reply_in_thread,
                        uuid: p.uuid,
                      },
                    },
                    opts,
                  ),
                {
                  as: "user",
                },
              );
              assertLarkOk(res);

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const data = res.data as any;
              log.info(`reply: message sent, message_id=${data?.message_id}`);

              return json({
                message_id: data?.message_id,
                chat_id: data?.chat_id,
                create_time: data?.create_time,
              });
            }
          }
        } catch (err) {
          return await handleInvokeErrorWithAutoAuth(err, cfg);
        }
      },
    },
    { name: "feishu_im_user_message" },
  );
}
