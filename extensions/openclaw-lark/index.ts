/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * OpenClaw Lark/Feishu plugin entry point.
 *
 * Registers the Feishu channel and all tool families:
 * doc, wiki, drive, perm, bitable, task, calendar.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { feishuPlugin } from "./src/channel/plugin";
import {
  analyzeTrace,
  formatDiagReportCli,
  formatTraceOutput,
  runDiagnosis,
  traceByMessageId,
} from "./src/commands/diagnose";
import { registerCommands } from "./src/commands/index";
import { LarkClient } from "./src/core/lark-client";
import { larkLogger } from "./src/core/lark-logger";
import { emitSecurityWarnings } from "./src/core/security-check";
import { registerAskUserQuestionTool } from "./src/tools/ask-user-question";
// 只注册与租户飞书 skill（13 个）不重复的 tool；重复能力由 skill 承担。
// 保留的 tool 均为 skill 未覆盖的独特能力：用户查询、会话管理、IM 发送、
// 电子表格、知识库结构、Bot 侧图片下载、交互式卡片表单。
// import { registerGetUserTool } from './src/tools/oapi/common/index';
import { registerFeishuChatTools } from "./src/tools/oapi/chat/index";
import { registerFeishuSheetsTools } from "./src/tools/oapi/sheets/index";
// import { registerFeishuImUserMessageTool } from './src/tools/oapi/im/message';
import { registerFeishuWikiTools } from "./src/tools/oapi/wiki/index";
import { registerFeishuImTools as registerFeishuImBotTools } from "./src/tools/tat/im/index";

const log = larkLogger("plugin");

// ---------------------------------------------------------------------------
// Re-exports for external consumers
// ---------------------------------------------------------------------------

export { monitorFeishuProvider } from "./src/channel/monitor";
export {
  sendMessageFeishu,
  sendCardFeishu,
  updateCardFeishu,
  editMessageFeishu,
} from "./src/messaging/outbound/send";
export { getMessageFeishu } from "./src/messaging/outbound/fetch";
export {
  uploadImageLark,
  uploadFileLark,
  sendImageLark,
  sendFileLark,
  sendAudioLark,
  uploadAndSendMediaLark,
} from "./src/messaging/outbound/media";
export {
  sendTextLark,
  sendCardLark,
  sendMediaLark,
  type SendTextLarkParams,
  type SendCardLarkParams,
  type SendMediaLarkParams,
} from "./src/messaging/outbound/deliver";
export { type FeishuChannelData } from "./src/messaging/outbound/outbound";
export { probeFeishu } from "./src/channel/probe";
export {
  addReactionFeishu,
  removeReactionFeishu,
  listReactionsFeishu,
  FeishuEmoji,
  VALID_FEISHU_EMOJI_TYPES,
} from "./src/messaging/outbound/reactions";
export { forwardMessageFeishu } from "./src/messaging/outbound/forward";
export {
  updateChatFeishu,
  addChatMembersFeishu,
  removeChatMembersFeishu,
  listChatMembersFeishu,
} from "./src/messaging/outbound/chat-manage";
export { feishuMessageActions } from "./src/messaging/outbound/actions";
export {
  mentionedBot,
  nonBotMentions,
  extractMessageBody,
  formatMentionForText,
  formatMentionForCard,
  formatMentionAllForText,
  formatMentionAllForCard,
  buildMentionedMessage,
  buildMentionedCardContent,
  type MentionInfo,
} from "./src/messaging/inbound/mention";
export { feishuPlugin } from "./src/channel/plugin";
export type {
  MessageContext,
  RawMessage,
  RawSender,
  FeishuMessageContext,
  FeishuReactionCreatedEvent,
} from "./src/messaging/types";
export { handleFeishuReaction } from "./src/messaging/inbound/reaction-handler";
export { parseMessageEvent } from "./src/messaging/inbound/parse";
export { checkMessageGate } from "./src/messaging/inbound/gate";
export { isMessageExpired } from "./src/messaging/inbound/dedup";

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = {
  id: "openclaw-lark",
  name: "Feishu",
  description: "Lark/Feishu channel plugin with im/doc/wiki/drive/task/calendar tools",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi): void {
    LarkClient.setRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });

    // ========================================
    // 仅注册与租户飞书 skill 不重复的 tool。
    // 已由 skill 接管的能力（文档 CRUD、IM 读取、日历、任务、多维表格、
    // 云盘、搜索、用户搜索、OAuth 授权）不再注册对应 tool。

    // 用户查询（skill 只覆盖 search_user，未覆盖按 open_id 直接 get_user）
    // registerGetUserTool(api);

    // 会话管理（创建/修改群、成员增删查，skill 未覆盖）
    registerFeishuChatTools(api);

    // IM 发送（feishu-im-read skill 仅只读，不覆盖发送）
    // registerFeishuImUserMessageTool(api);

    // 知识库空间/节点结构（skill 未覆盖）
    registerFeishuWikiTools(api);

    // 电子表格（skill 未覆盖）
    registerFeishuSheetsTools(api);

    // Bot 身份下载图片（feishu-image-ocr 走 OCR，非原图下载）
    registerFeishuImBotTools(api);

    // AskUserQuestion 交互卡片表单（skill 无法替代）
    registerAskUserQuestionTool(api);

    // ---- Tool call hooks (trace Feishu-owned tool invocations only) ----
    api.on("before_tool_call", (event) => {
      if (!event.toolName.startsWith("feishu_")) return;
      log.info(`tool call: ${event.toolName} params=${JSON.stringify(event.params)}`);
    });

    api.on("after_tool_call", (event) => {
      if (!event.toolName.startsWith("feishu_")) return;
      if (event.error) {
        log.error(`tool fail: ${event.toolName} ${event.error} (${event.durationMs ?? 0}ms)`);
      } else {
        log.info(`tool done: ${event.toolName} ok (${event.durationMs ?? 0}ms)`);
      }
    });

    // ---- Diagnostic commands ----

    // CLI: openclaw feishu-diagnose [--trace <messageId>]
    api.registerCli(
      (ctx) => {
        ctx.program
          .command("feishu-diagnose")
          .description("运行飞书插件诊断，检查配置、连通性和权限状态")
          .option("--trace <messageId>", "按 message_id 追踪完整处理链路")
          .option("--analyze", "分析追踪日志（需配合 --trace 使用）")
          .action(async (opts: { trace?: string; analyze?: boolean }) => {
            try {
              if (opts.trace) {
                const lines = await traceByMessageId(opts.trace);
                // eslint-disable-next-line no-console -- CLI 命令直接输出到终端
                console.log(formatTraceOutput(lines, opts.trace));
                if (opts.analyze && lines.length > 0) {
                  // eslint-disable-next-line no-console -- CLI 命令直接输出到终端
                  console.log(analyzeTrace(lines, opts.trace));
                }
              } else {
                const report = await runDiagnosis({
                  config: ctx.config,
                  logger: ctx.logger,
                });
                // eslint-disable-next-line no-console -- CLI 命令直接输出到终端
                console.log(formatDiagReportCli(report));
                if (report.overallStatus === "unhealthy") {
                  process.exitCode = 1;
                }
              }
            } catch (err) {
              ctx.logger.error(`诊断命令执行失败: ${err}`);
              process.exitCode = 1;
            }
          });
      },
      { commands: ["feishu-diagnose"] },
    );

    // Chat commands: /feishu_diagnose, /feishu_doctor, /feishu_auth, /feishu
    registerCommands(api);

    // ---- Multi-account security checks ----
    if (api.config) {
      emitSecurityWarnings(api.config, api.logger);
    }
  },
};

export default plugin;
