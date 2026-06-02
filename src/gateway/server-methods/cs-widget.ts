/**
 * Customer Service Widget RPC handlers.
 *
 * 客服 Widget RPC 处理器。
 *
 * Methods:
 *   cs.widget.connect  — resume existing session (session created lazily on first send)
 *   cs.widget.send     — customer message → RAG → reply
 *   cs.widget.history  — paginated message history
 */

import { loadTenantConfig } from "../../config/tenant-config.js";
import { sendCSNotification } from "../../customer-service/feishu/notify.js";
import { runCSAgentReply } from "../../customer-service/rag/cs-agent-runner.js";
import { transition } from "../../customer-service/session-state-machine.js";
import { CS_ROLE_LABELS } from "../../customer-service/types.js";
import { createCSMessage, listCSMessages } from "../../db/models/cs-message.js";
import {
  createCSSession,
  deleteCSSessionIfNoMessages,
  findActiveCSSession,
  updateCSSessionNotifiedAt,
} from "../../db/models/cs-session.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { readCSConfig, resolveWidgetAgentId } from "./cs-admin.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("cs-widget-handler");

export const csWidgetHandlers: GatewayRequestHandlers = {
  /**
   * cs.widget.connect — resume existing session if any; do NOT create a new one.
   * Session is created lazily on the visitor's first message (cs.widget.send).
   * This prevents empty session records when a visitor opens the widget but never sends a message.
   *
   * 连接时只恢复已有会话，不主动创建。首次发消息时才建 session，避免空会话记录。
   *
   * Params: { tenantId, visitorId }
   * Response: { sessionId | null, state, messages }
   */
  "cs.widget.connect": async ({ params, respond }) => {
    const tenantId = params.tenantId as string;
    const visitorId = params.visitorId as string;

    if (!tenantId || !visitorId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "tenantId and visitorId are required"),
      );
      return;
    }

    let createdSessionId: string | null = null;
    try {
      // Only resume — do not create. Creation happens in cs.widget.send.
      // 只恢复，不创建。session 在 cs.widget.send 中按需创建。
      const session = await findActiveCSSession(tenantId, visitorId);
      const messages = session ? await listCSMessages(session.id, { limit: 50 }) : [];

      respond(true, {
        sessionId: session?.id ?? null,
        state: session?.state ?? "ai_active",
        messages,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`cs.widget.connect failed: ${message}`);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Failed to connect"));
    }
  },

  /**
   * cs.widget.send — customer sends a message.
   * Creates session lazily on first message.
   * Sends Feishu notification only on the first customer message of the session.
   *
   * 按需建 session；飞书通知只在每个会话的第一条消息时发送一次。
   *
   * Params: { tenantId, visitorId, text }
   * Response: { messageId, role, text, roleLabel }
   */
  "cs.widget.send": async ({ params, respond, context, client }) => {
    const tenantId = params.tenantId as string;
    const visitorId = params.visitorId as string;
    const text = (params.text as string)?.trim();

    if (!tenantId || !visitorId || !text) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "tenantId, visitorId, and text are required"),
      );
      return;
    }

    try {
      // Find or create session lazily.
      // 懒加载：找到已有 session 或按需创建。
      let session = await findActiveCSSession(tenantId, visitorId);
      const isNewSession = !session;
      if (!session) {
        session = await createCSSession({
          tenantId,
          visitorId,
          visitorName: params.visitorName as string | undefined,
          channel: (params.channel as string | undefined) ?? "web_widget",
          metadata: params.metadata as Record<string, unknown> | undefined,
        });
        createdSessionId = session.id;
        log.info(`created cs session ${session.id} for visitor ${visitorId}`);
      }

      // Check if this is the first message in the session (for Feishu notify).
      // New sessions always have 0 prior messages; existing sessions may have some.
      // 检查是否为 session 第一条消息，用于飞书通知去重。
      const priorMessages = isNewSession ? [] : await listCSMessages(session.id, { limit: 1 });
      const isFirstMessage = priorMessages.length === 0;

      // Save customer message
      // 保存客户消息
      await createCSMessage({
        sessionId: session.id,
        tenantId,
        role: "customer",
        content: text,
      });

      // State machine transition
      // 状态机转换
      const { action } = transition(session.state, { type: "customer_message", text });

      if (action === "run_rag") {
        // Widget is a visitor connection (no authenticated user), so client.tenant
        // is always undefined. Load tenant config directly by the tenantId sent from
        // the widget — this is the CS operator tenant whose agent/model we must use.
        // Using resolveRequestConfig(client?.tenant) here would fall back to the
        // platform-level config and miss all tenant-configured agents/models,
        // causing the LLM call to fail with "Model Not Exist".
        // Widget 是游客连接（无用户 auth），client.tenant 永远 undefined；必须用
        // params.tenantId 直接加载租户 config（即客服运营方租户的配置），
        // 否则会 fallback 到平台级 config，找不到租户配置的 agent/model，
        // 导致 LLM 调用报 "Model Not Exist"。
        const cfg = await loadTenantConfig(tenantId);
        // Read CS config for skillsEnabled flag (and notify settings used below).
        // 读客服配置获取 skillsEnabled，与飞书通知配置一并加载。
        const csCfg = await readCSConfig(tenantId);
        // ST-C0: Widget runtime enable-gate. When widgetId is provided and
        // matches a channel with enabled=false, reject immediately before
        // touching the RAG stack. Legacy embeds without widgetId keep working
        // (S1 preserved): no widgetId means no channel match, no gate check.
        // ST-C0：widget 运行时启用门控。widgetId 匹配到 enabled=false 的 channel
        // 时立即拒绝，不进入 RAG。无 widgetId 的旧 embed 不受影响（保持 S1）。
        const widgetId = params.widgetId as string | undefined;
        if (widgetId) {
          const matchedChannel = csCfg.channels?.find((ch) => ch.id === widgetId);
          if (matchedChannel && !matchedChannel.enabled) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.WIDGET_DISABLED, "This widget has been disabled"),
            );
            return;
          }
        }
        // Resolve the per-widget bound agent (P5-T3b). The embedded widget forwards
        // its data-widget-id as `widgetId`; resolveWidgetAgentId returns undefined
        // when widgetId is absent / unmatched / unbound, so runCSAgentReply falls back
        // to the tenant default agent (S1 unchanged).
        // 解析每 widget 绑定 agent（P5-T3b）。嵌入 widget 把 data-widget-id 作为 widgetId
        // 上送；缺失/匹配不到/未绑定时返回 undefined，runCSAgentReply 回退租户默认 agent
        // （保持 S1）。
        const agentId = resolveWidgetAgentId(csCfg.channels, widgetId);
        const { reply, sourceChunks } = await runCSAgentReply({
          tenantId,
          sessionId: session.id,
          customerMessage: text,
          visitorName: session.visitorName ?? undefined,
          cfg,
          restrictions: csCfg.restrictions,
          customSystemPrompt: csCfg.customSystemPrompt,
          agentId,
        });

        // Save AI reply
        // 保存 AI 回复
        const aiMessage = await createCSMessage({
          sessionId: session.id,
          tenantId,
          role: "ai",
          content: reply,
          sourceChunks,
        });

        // Notify Feishu at most once per notifyIntervalMinutes per session (default: 10 min).
        // csCfg already loaded above for skillsEnabled — reuse it here, no second read.
        // 飞书通知间隔：同一会话内，两次通知至少间隔 notifyIntervalMinutes 分钟（默认 10）。
        // csCfg 已在上方 readCSConfig 时加载，此处直接复用，不再二次读取。
        Promise.resolve(csCfg)
          .then(async (csCfg) => {
            const { appId, appSecret, chatId } = csCfg.feishu ?? {};
            if (!appId || !appSecret || !chatId) {
              return;
            }

            const intervalMs = (csCfg.notifyIntervalMinutes ?? 10) * 60 * 1000;
            const lastNotifiedAt = session.metadata?.lastNotifiedAt as string | undefined;
            const lastNotifiedMs = lastNotifiedAt ? new Date(lastNotifiedAt).getTime() : 0;
            const shouldNotify = Date.now() - lastNotifiedMs >= intervalMs;

            if (!shouldNotify) {
              return;
            }

            await updateCSSessionNotifiedAt(session.id, new Date().toISOString());
            return sendCSNotification({
              appId,
              appSecret,
              chatId,
              customerMessage: text,
              aiReply: reply,
              sessionId: session.id,
              visitorName: session.visitorName ?? undefined,
              channel: session.channel,
            });
          })
          .catch((err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error(`feishu notification failed: ${errMsg}`);
          });

        respond(true, {
          sessionId: session.id,
          messageId: aiMessage.id,
          role: "ai",
          text: reply,
          roleLabel: CS_ROLE_LABELS.ai,
        });
      } else if (action === "forward_to_boss") {
        // S3: forward to boss
        respond(true, { forwarded: true });
      } else {
        respond(true, { action });
      }
    } catch (err) {
      if (createdSessionId) {
        await deleteCSSessionIfNoMessages(createdSessionId).catch((cleanupErr) => {
          log.warn(`cs.widget.send empty-session cleanup failed: ${String(cleanupErr)}`);
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error(`cs.widget.send failed: ${message}`);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Failed to process message"));
    }
  },

  /**
   * cs.widget.history — paginated message history.
   *
   * Params: { sessionId, limit?, beforeId? }
   * Response: { messages }
   */
  "cs.widget.history": async ({ params, respond }) => {
    const sessionId = params.sessionId as string;
    if (!sessionId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }

    try {
      const messages = await listCSMessages(sessionId, {
        limit: (params.limit as number) ?? 50,
        beforeId: params.beforeId as string | undefined,
      });
      respond(true, { messages });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`cs.widget.history failed: ${message}`);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Failed to load history"));
    }
  },
};
