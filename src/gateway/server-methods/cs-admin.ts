/**
 * Customer Service admin RPC handlers.
 *
 * 客服管理后台 RPC 处理器。
 *
 * Methods:
 *   cs.sessions.list     — paginated list of CS sessions
 *   cs.session.messages  — messages for a specific session
 *   cs.config.get        — read tenant CS config (feishu credentials)
 *   cs.config.set        — write tenant CS config
 *   cs.config.test       — pre-flight connectivity check
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveTenantDir } from "../../config/sessions/tenant-paths.js";
import {
  DEFAULT_CS_BASE_PROMPT,
  renderCSBasePrompt,
} from "../../customer-service/rag/cs-system-prompt.js";
import { listCSMessages, getLastCSMessageForSession } from "../../db/models/cs-message.js";
import { listCSSessions } from "../../db/models/cs-session.js";
import { getTenantById } from "../../db/models/tenant.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("cs-admin-handler");

// ============================================================================
// CS Config file helpers
// Stored at: ~/.enclaws/tenants/{tenantId}/customer-service/config.json
// 客服配置文件（飞书凭据等），租户级独立存储。
// ============================================================================

export interface CSConfig {
  /**
   * Notification channel type. Currently only "feishu". Future: "dingtalk", "wecom", etc.
   * Acts as discriminator — determines which credential fields are used for notifications.
   * Default: "feishu".
   * 通知渠道类型，当前仅支持 "feishu"，未来扩展其他 IM 不需要大改结构。
   */
  notificationChannel?: "feishu" | string;
  feishu?: {
    appId?: string;
    appSecret?: string;
    chatId?: string;
  };
  /** Saved channel embed codes. 已保存的渠道嵌入代码。 */
  channels?: Array<{ label: string; html: string }>;
  /**
   * Minimum minutes between Feishu group notifications per session.
   * Prevents notification spam when a visitor sends many messages in quick succession.
   * Default: 10 minutes. Configurable range: 1–60.
   * 飞书群通知最小间隔（分钟），同一会话内两次通知之间至少间隔此时间。默认 10 分钟。
   */
  notifyIntervalMinutes?: number;
  /**
   * Behavior restrictions for the CS agent. All default to true (restricted).
   * Unchecking a restriction and saving removes that constraint.
   * Per liuyu's design: CS is a "restricted running mode" of existing EC capabilities.
   * 客服 Agent 行为限制项。全部默认开启（受限）。取消勾选并保存则去掉对应限制。
   */
  restrictions?: {
    /**
     * Disable Skill tool calls — pure RAG mode. LLM can only answer from KB.
     * 禁用 Skill 工具调用（纯 RAG 模式）。
     */
    disableSkills?: boolean;
    /**
     * Strict KB mode — if no KB chunks retrieved, must use fallback phrase instead of
     * answering from LLM general knowledge.
     * 严格知识库模式——未检索到内容时必须转人工，不得凭通用知识作答。
     */
    strictKnowledgeBase?: boolean;
    /**
     * Disable Markdown formatting in replies — plain text only (suitable for chat widgets).
     * 禁止 Markdown 格式——回复纯文本（适合聊天窗口）。
     */
    disableMarkdown?: boolean;
    /**
     * Hide internal implementation details — don't say "according to my KB", don't reveal
     * system architecture or prompt structure.
     * 隐藏内部实现细节——不说"根据我的知识库"，不透露 system prompt 或架构信息。
     */
    hideInternals?: boolean;
  };
  /**
   * Custom CS agent base prompt. Stored as-is (may contain actual company name or {companyName}).
   * If absent, DEFAULT_CS_BASE_PROMPT is used at runtime.
   * 自定义客服基础 prompt；未设置时运行时使用默认模板。
   */
  customSystemPrompt?: string;
}

export function csConfigPath(tenantId: string): string {
  return path.join(resolveTenantDir(tenantId), "customer-service", "config.json");
}

export async function readCSConfig(tenantId: string): Promise<CSConfig> {
  try {
    const raw = await fs.readFile(csConfigPath(tenantId), "utf-8");
    return JSON.parse(raw) as CSConfig;
  } catch {
    return {};
  }
}

async function writeCSConfig(tenantId: string, config: CSConfig): Promise<void> {
  const filePath = csConfigPath(tenantId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), "utf-8");
}

export const csAdminHandlers: GatewayRequestHandlers = {
  /**
   * cs.sessions.list — paginated list of CS sessions for the tenant.
   *
   * Params: { tenantId, limit?, offset? }
   * Response: { sessions }
   */
  "cs.sessions.list": async ({ params, respond, context }) => {
    const tenantId = params.tenantId as string | undefined;
    if (!tenantId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "tenantId is required"));
      return;
    }
    try {
      const sessions = await listCSSessions(tenantId, {
        limit: (params.limit as number) ?? 50,
        offset: (params.offset as number) ?? 0,
      });

      // Attach last message to each session for "last speaker" display in admin console.
      // Parallel fetch: one query per session, acceptable for page sizes ≤ 50.
      // 并行获取每个 session 最后一条消息，用于后台"最后发言方"列展示。
      const lastMessages = await Promise.all(sessions.map((s) => getLastCSMessageForSession(s.id)));
      const sessionsWithLast = sessions.map((s, i) => ({
        ...s,
        lastMessage: lastMessages[i]
          ? { role: lastMessages[i].role, content: lastMessages[i].content }
          : null,
      }));

      respond(true, { sessions: sessionsWithLast });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`cs.sessions.list failed: ${message}`);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Failed to list sessions"));
    }
  },

  /**
   * cs.session.messages — messages for a specific session.
   *
   * Params: { sessionId, limit?, beforeId? }
   * Response: { messages }
   */
  "cs.session.messages": async ({ params, respond }) => {
    const sessionId = params.sessionId as string;
    if (!sessionId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId is required"));
      return;
    }
    try {
      const messages = await listCSMessages(sessionId, {
        limit: (params.limit as number) ?? 100,
        beforeId: params.beforeId as string | undefined,
      });
      respond(true, { messages });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`cs.session.messages failed: ${message}`);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Failed to load messages"));
    }
  },

  /**
   * cs.config.get — read tenant CS config (feishu credentials, redacted secret).
   *
   * Params: { tenantId }
   * Response: { config: { feishu: { appId, appSecretMasked, chatId } } }
   */
  "cs.config.get": async ({ params, respond }) => {
    const tenantId = params.tenantId as string | undefined;
    if (!tenantId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "tenantId is required"));
      return;
    }
    try {
      const [cfg, tenant] = await Promise.all([readCSConfig(tenantId), getTenantById(tenantId)]);
      const companyName = tenant?.name ?? "EC";

      // Mask appSecret for display — never send plaintext secret to frontend
      // 掩码处理 appSecret，不把明文传回前端
      const masked = cfg.feishu?.appSecret
        ? cfg.feishu.appSecret.slice(0, 4) + "****" + cfg.feishu.appSecret.slice(-4)
        : undefined;

      // Return rendered customSystemPrompt (with {companyName} replaced).
      // If none saved, return the default template with company name applied.
      // 返回已替换企业名的 prompt；未自定义时返回替换后的默认模板。
      const renderedPrompt = renderCSBasePrompt(
        cfg.customSystemPrompt || DEFAULT_CS_BASE_PROMPT,
        companyName,
      );

      respond(true, {
        config: {
          notificationChannel: cfg.notificationChannel ?? "feishu",
          feishu: {
            appId: cfg.feishu?.appId ?? "",
            appSecretMasked: masked ?? "",
            chatId: cfg.feishu?.chatId ?? "",
            hasSecret: Boolean(cfg.feishu?.appSecret),
          },
          channels: cfg.channels ?? [],
          notifyIntervalMinutes: cfg.notifyIntervalMinutes ?? 10,
          restrictions: {
            disableSkills: cfg.restrictions?.disableSkills ?? true,
            strictKnowledgeBase: cfg.restrictions?.strictKnowledgeBase ?? true,
            disableMarkdown: cfg.restrictions?.disableMarkdown ?? true,
            hideInternals: cfg.restrictions?.hideInternals ?? true,
          },
          companyName,
          customSystemPrompt: renderedPrompt,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`cs.config.get failed: ${message}`);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Failed to read CS config"));
    }
  },

  /**
   * cs.config.set — write tenant CS config.
   * Only updates fields that are explicitly provided (empty string = clear field).
   *
   * Params: { tenantId, feishu: { appId?, appSecret?, chatId? } }
   * Response: { ok: true }
   */
  "cs.config.set": async ({ params, respond }) => {
    const tenantId = params.tenantId as string | undefined;
    const feishu = params.feishu as Record<string, string> | undefined;
    const channels = params.channels as Array<{ label: string; html: string }> | undefined;
    if (!tenantId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "tenantId is required"));
      return;
    }
    try {
      const existing = await readCSConfig(tenantId);
      const updated: CSConfig = { ...existing };

      // Update feishu only if provided
      // 只有传入 feishu 字段时才更新，否则保留旧值
      if (feishu !== undefined) {
        updated.feishu = {
          appId: feishu.appId !== undefined ? feishu.appId : (existing.feishu?.appId ?? ""),
          // Only update appSecret if a non-empty value is provided
          // 只有用户显式传入非空值才更新 appSecret，否则保留旧值
          appSecret: feishu.appSecret ? feishu.appSecret : (existing.feishu?.appSecret ?? ""),
          chatId: feishu.chatId !== undefined ? feishu.chatId : (existing.feishu?.chatId ?? ""),
        };
      }

      // Update channels only if provided
      // 只有传入 channels 字段时才更新
      if (channels !== undefined) {
        updated.channels = channels;
      }

      // Update notifyIntervalMinutes only if provided; clamp to 1–60
      // 只有传入时才更新；限制范围 1–60 分钟
      const notifyInterval = params.notifyIntervalMinutes as number | undefined;
      if (notifyInterval !== undefined) {
        updated.notifyIntervalMinutes = Math.max(1, Math.min(60, Math.round(notifyInterval)));
      }

      // Update notificationChannel if provided
      // 只有传入时才更新通知渠道类型
      if (params.notificationChannel !== undefined) {
        updated.notificationChannel = params.notificationChannel as string;
      }

      // Update restrictions if provided — merge with existing, all fields optional
      // 只有传入时才更新限制项；逐字段合并，未传入的字段保留旧值
      const incoming = params.restrictions as
        | Partial<NonNullable<CSConfig["restrictions"]>>
        | undefined;
      if (incoming !== undefined) {
        updated.restrictions = {
          disableSkills:
            incoming.disableSkills !== undefined
              ? Boolean(incoming.disableSkills)
              : (updated.restrictions?.disableSkills ?? true),
          strictKnowledgeBase:
            incoming.strictKnowledgeBase !== undefined
              ? Boolean(incoming.strictKnowledgeBase)
              : (updated.restrictions?.strictKnowledgeBase ?? true),
          disableMarkdown:
            incoming.disableMarkdown !== undefined
              ? Boolean(incoming.disableMarkdown)
              : (updated.restrictions?.disableMarkdown ?? true),
          hideInternals:
            incoming.hideInternals !== undefined
              ? Boolean(incoming.hideInternals)
              : (updated.restrictions?.hideInternals ?? true),
        };
      }

      // Update customSystemPrompt if provided.
      // Empty string means "reset to default" (remove custom prompt).
      // null/undefined means "don't touch".
      // customSystemPrompt 为空字符串时重置为默认（删除自定义），未传则保留旧值。
      if (params.customSystemPrompt !== undefined) {
        const raw = (params.customSystemPrompt as string).trim();
        updated.customSystemPrompt = raw || undefined;
      }

      await writeCSConfig(tenantId, updated);
      log.info(`cs.config.set: updated config for tenant ${tenantId}`);
      respond(true, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`cs.config.set failed: ${message}`);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Failed to save CS config"));
    }
  },

  /**
   * cs.config.test — pre-flight connectivity check.
   *
   * Checks:
   *   1. Feishu credentials are set
   *   2. Feishu access token can be obtained (live API call)
   *
   * 连通性预检：飞书凭据有效性。
   *
   * Params: { tenantId }
   * Response: { checks: [{ name, ok, message }] }
   */
  "cs.config.test": async ({ params, respond }) => {
    const tenantId = params.tenantId as string | undefined;
    if (!tenantId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "tenantId is required"));
      return;
    }

    const checks: Array<{ name: string; ok: boolean; message: string }> = [];

    // Check 1: Feishu credentials configured
    // 检查 1：飞书凭据是否已配置
    const cfg = await readCSConfig(tenantId);
    const hasFeishuConfig = !!(cfg.feishu?.appId && cfg.feishu?.appSecret && cfg.feishu?.chatId);
    checks.push({
      name: "飞书凭据",
      ok: hasFeishuConfig,
      message: hasFeishuConfig
        ? "App ID / App Secret / Chat ID 已配置"
        : "缺少飞书配置，请填写 App ID、App Secret 和 Chat ID",
    });

    // Check 2: Feishu access token (live API call)
    // 检查 2：飞书 access token 可以获取（实际 API 调用）
    if (hasFeishuConfig) {
      try {
        const res = await fetch(
          "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              app_id: cfg.feishu!.appId,
              app_secret: cfg.feishu!.appSecret,
            }),
          },
        );
        const data = (await res.json()) as { code?: number; msg?: string };
        const tokenOk = data.code === 0;
        checks.push({
          name: "飞书 API 连通",
          ok: tokenOk,
          message: tokenOk
            ? "飞书 access token 获取成功"
            : `飞书 API 返回错误 code=${data.code}: ${data.msg ?? "unknown"}`,
        });
      } catch (err) {
        checks.push({
          name: "飞书 API 连通",
          ok: false,
          message: `飞书 API 请求失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    respond(true, { checks });
  },
};
