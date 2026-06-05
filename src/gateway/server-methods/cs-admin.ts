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

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { TenantContext } from "../../auth/middleware.js";
import { resolveTenantDir } from "../../config/sessions/tenant-paths.js";
import { buildRecommendedPersona } from "../../customer-service/rag/cs-recommended-persona.js";
import {
  DEFAULT_CS_BASE_PROMPT,
  renderCSBasePrompt,
} from "../../customer-service/rag/cs-system-prompt.js";
import {
  listCSMessages,
  getLastCSMessageForSession,
  countCSMessagesForSession,
} from "../../db/models/cs-message.js";
import { countCSSessions, listCSSessions } from "../../db/models/cs-session.js";
import { getTenantById } from "../../db/models/tenant.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";

const log = createSubsystemLogger("cs-admin-handler");

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function resolveAccessSource(session: {
  channel: string;
  appObjectId?: string | null;
  metadata?: Record<string, unknown>;
}): string {
  if (!session.appObjectId) {
    return session.channel || "web_widget";
  }
  const metadata = session.metadata ?? {};
  const wecom = asRecord(metadata.wecom);
  const scenario = asRecord(metadata.scenario);
  const scene = firstString(
    metadata.sceneName,
    metadata.scenarioName,
    metadata.channelName,
    scenario?.name,
    wecom?.sceneName,
    wecom?.scene,
    wecom?.scene_param,
    metadata.scene,
    metadata.scene_param,
    wecom?.open_kfid,
    metadata.open_kfid,
    metadata.channelId,
    session.channel,
  );
  return scene ?? "API 接入";
}

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
  /**
   * Saved widget channels (embed codes). Each is an independent widget instance.
   * Capped at MAX_CHANNELS (3).
   *
   * Fields:
   *   id      — stable unique id for the widget instance. Used by management UI
   *             (and, later, per-widget runtime binding). Generated on read for
   *             legacy configs that predate this field (see normalizeCSConfig).
   *   label   — display name shown in the admin list and embed snippet.
   *   html    — the embed snippet HTML.
   *   agentId — optional per-widget AI 员工 binding. When unset, the widget falls
   *             back to the tenant's default CS agent.
   *   enabled — widget status. Defaults to true. A disabled widget is kept in
   *             config but treated as inactive by the UI.
   *
   * 已保存的 widget 渠道（嵌入代码），每个是独立的 widget 实例，上限 MAX_CHANNELS(3)。
   * id 稳定唯一；agentId 可选，未设置时回退到租户默认客服 agent；enabled 默认 true。
   * 旧配置缺 id/enabled 时在读取时规范化补齐（见 normalizeCSConfig）。
   */
  channels?: Array<{
    id: string;
    label: string;
    html: string;
    agentId?: string;
    enabled: boolean;
  }>;
  // csMode was removed in ST-C0 (dropped cs_mode mutex; widget and API now
  // coexist, each independently enabled/disabled via their own switch).
  // 已在 ST-C0 中删除：不再有 widget/API 互斥模式，各实例独立启用/禁用。
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

/**
 * Maximum number of widget channels per tenant. Enforced server-side on write.
 * 每租户 widget 渠道上限，写入时在服务端强制。
 */
export const MAX_CHANNELS = 3;

export function csConfigPath(tenantId: string): string {
  return path.join(resolveTenantDir(tenantId), "customer-service", "config.json");
}

/**
 * Raw channel shape as it may appear on disk, including legacy configs that
 * predate the id/agentId/enabled fields. All new fields are optional here so
 * old config.json files parse without loss before normalization.
 * 磁盘上可能出现的原始 channel 结构，含早于 id/agentId/enabled 字段的旧配置。
 */
type RawChannel = {
  id?: string;
  label?: string;
  html?: string;
  agentId?: string;
  enabled?: boolean;
};

/**
 * Derive a stable, deterministic id for a legacy channel that has no id.
 * Same (index + label + html) always yields the same id, so repeated reads of an
 * unchanged config produce stable ids without needing a write-back. The id is
 * unique within a channel list because the index is part of the input.
 * 为缺 id 的旧 channel 生成稳定确定的 id：相同（序号+label+html）总产生相同 id，
 * 因此对未变更配置的重复读取得到稳定 id，无需回写。序号入参保证列表内唯一。
 */
function deriveStableChannelId(channel: RawChannel, index: number): string {
  const basis = `${index}\u0000${channel.label ?? ""}\u0000${channel.html ?? ""}`;
  const hash = crypto.createHash("sha256").update(basis).digest("hex").slice(0, 12);
  return `ch_${hash}`;
}

/**
 * Normalize a parsed config for backward compatibility. For each channel: keep an
 * existing id, otherwise derive a stable one; default `enabled` to true only when
 * absent (an explicit `false` is preserved); leave `agentId` and `csMode` untouched
 * (undefined defaults are handled by the UI). Existing (non-channel) fields pass
 * through unchanged. Never mutates the input.
 * 规范化已解析配置以向后兼容：每个 channel 保留已有 id，否则派生稳定 id；
 * enabled 仅在缺失时默认 true（显式 false 保留）；agentId 不动（由 UI 兜底）。
 * ST-C0：csMode 字段已删除，从旧配置中读取时自动丢弃。其余字段原样透传，不修改入参。
 */
export function normalizeCSConfig(raw: CSConfig & { csMode?: unknown }): CSConfig {
  // ST-C0: strip the dead csMode field from any config read off disk.
  // Destructure it out so it never propagates into the returned CSConfig.
  // _csMode prefix satisfies the no-unused-vars rule (underscore convention).
  // ST-C0：丢弃磁盘上旧配置中的 csMode 字段，不再传播到返回结果。
  const { csMode: _csMode, ...rest } = raw as CSConfig & { csMode?: unknown };
  const rawChannels = rest.channels as RawChannel[] | undefined;
  if (!rawChannels) {
    return rest as CSConfig;
  }
  const channels = rawChannels.map((ch, index) => ({
    ...ch,
    id: ch.id && ch.id.length > 0 ? ch.id : deriveStableChannelId(ch, index),
    label: ch.label ?? "",
    html: ch.html ?? "",
    enabled: ch.enabled ?? true,
  }));
  return { ...rest, channels };
}

/**
 * Resolve the per-widget bound agentId for a given widgetId (P5-T3b).
 *
 * The embedded widget forwards its `data-widget-id` (the channel id) on
 * cs.widget.send; the gateway calls this to find that channel's bound agentId,
 * then passes it into runCSAgentReply. Returns undefined — so the runner falls
 * back to the tenant/global default agent (S1 unchanged) — when the widgetId is
 * absent, matches no channel, or the matched channel has no agentId bound.
 *
 * Note: the enabled gate check is done in cs-widget.ts BEFORE this call (ST-C0).
 * This function only resolves the agentId; it does not re-check enabled.
 *
 * 为给定 widgetId 解析每 widget 绑定的 agentId（P5-T3b）。嵌入 widget 把
 * data-widget-id（即 channel id）随 cs.widget.send 上送，gateway 调用此函数找到
 * 对应 channel 的绑定 agentId 后传入 runCSAgentReply。当 widgetId 缺失、匹配不到
 * channel、或匹配到的 channel 未绑定 agentId 时返回 undefined，使 runner 回退到
 * 租户/全局默认 agent（保持 S1）。enabled 门控在 cs-widget.ts 中先行检查（ST-C0）。
 */
export function resolveWidgetAgentId(
  channels: CSConfig["channels"],
  widgetId: string | undefined,
): string | undefined {
  if (!channels || !widgetId) {
    return undefined;
  }
  const match = channels.find((ch) => ch.id === widgetId);
  return match?.agentId;
}

export async function readCSConfig(tenantId: string): Promise<CSConfig> {
  try {
    const raw = await fs.readFile(csConfigPath(tenantId), "utf-8");
    return normalizeCSConfig(JSON.parse(raw) as CSConfig);
  } catch {
    return {};
  }
}

export async function writeCSConfig(tenantId: string, config: CSConfig): Promise<void> {
  const filePath = csConfigPath(tenantId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Extract tenant context from the client; sends an error response and returns null when absent.
 * Mirrors the pattern used in tenant-api.ts for tenant-scoped RPC handlers.
 *
 * 从 client 中提取租户上下文；缺失时发送错误并返回 null，与 tenant-api.ts 保持一致。
 */
function getTenantCtx(
  client: GatewayRequestHandlerOptions["client"],
  respond: GatewayRequestHandlerOptions["respond"],
): TenantContext | null {
  const tenant = (client as unknown as { tenant?: TenantContext })?.tenant;
  if (!tenant) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Authentication required"));
    return null;
  }
  return tenant;
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
      const rawLimit = Number(params.limit ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 50;
      const rawOffset = Number(params.offset ?? 0);
      const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;
      const q = typeof params.q === "string" ? params.q.trim().slice(0, 100) : undefined;
      const state = typeof params.state === "string" && params.state ? params.state : undefined;
      const accessMode =
        params.accessMode === "api" || params.accessMode === "widget"
          ? params.accessMode
          : undefined;
      const listOpts = {
        limit,
        offset,
        requireMessages: true,
        q,
        state,
        accessMode,
      };
      const [sessions, total] = await Promise.all([
        listCSSessions(tenantId, listOpts),
        countCSSessions(tenantId, {
          requireMessages: true,
          q,
          state,
          accessMode,
        }),
      ]);

      // Attach last message to each session for "last speaker" display in admin console.
      // Parallel fetch: one query per session, acceptable for page sizes ≤ 50.
      // 并行获取每个 session 最后一条消息，用于后台"最后发言方"列展示。
      const [lastMessages, messageCounts] = await Promise.all([
        Promise.all(sessions.map((s) => getLastCSMessageForSession(s.id))),
        Promise.all(sessions.map((s) => countCSMessagesForSession(s.id))),
      ]);
      const sessionsWithLast = sessions.map((s, i) => ({
        ...s,
        messageCount: messageCounts[i] ?? 0,
        accessMode: s.appObjectId ? "api" : "widget",
        accessModeLabel: s.appObjectId ? "API模式" : "Widget模式",
        accessSource: resolveAccessSource(s),
        lastMessage: lastMessages[i]
          ? { role: lastMessages[i].role, content: lastMessages[i].content }
          : null,
      }));

      respond(true, { sessions: sessionsWithLast, total, limit, offset });
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
          // csMode was removed in ST-C0; widget and API now coexist independently.
          // csMode 在 ST-C0 中已删除，widget 和 API 现各自独立启用/禁用。
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
    const channels = params.channels as
      | Array<{ id?: string; label: string; html: string; agentId?: string; enabled?: boolean }>
      | undefined;
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

      // Update channels only if provided. Enforce MAX_CHANNELS server-side, then
      // normalize so every channel ends up with a stable id + defaulted enabled
      // (clients may omit these on create). agentId stays optional.
      // 只有传入 channels 字段时才更新。先在服务端强制 MAX_CHANNELS 上限，再规范化，
      // 保证每个 channel 都有稳定 id 与 enabled 默认值（创建时客户端可能不传）；agentId 仍可选。
      if (channels !== undefined) {
        const capped = channels.slice(0, MAX_CHANNELS);
        updated.channels = normalizeCSConfig({ channels: capped } as CSConfig).channels;
      }

      // csMode was removed in ST-C0; widget and API now coexist independently.
      // Any csMode passed in params is silently ignored. Old persisted csMode
      // is stripped by normalizeCSConfig on read.
      // csMode 在 ST-C0 中已删除；params 中若传入 csMode 则静默忽略。

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

  /**
   * tenant.cs.recommended-persona.get — return the 3 recommended persona MDs with
   * {companyName} substituted to the tenant's real company name.
   *
   * 租户推荐人设读取 RPC：返回三段推荐人设 MD（IDENTITY/SOUL/AGENTS），
   * 将 {companyName} 替换为租户实际企业名。无需参数，从 JWT 上下文读取 tenantId。
   *
   * Params: none (tenant id resolved from JWT context)
   * Response: { identity: string; soul: string; agents: string }
   *
   * Used by: P5 UI "启用推荐配置" button — reads these, then writes them via
   *          agents.files.set to the bound agent's IDENTITY/SOUL/AGENTS.md.
   * P5 UI「启用推荐配置」按钮：读取三段内容后，通过 agents.files.set 写入绑定 agent。
   */
  "tenant.cs.recommended-persona.get": async ({ client, respond }) => {
    const ctx = getTenantCtx(client, respond);
    if (!ctx) {
      return;
    }

    try {
      // Resolve company name from tenant record (same pattern as cs-agent-runner).
      // Falls back to "EC" when tenant has no name set.
      // 与 cs-agent-runner 保持一致：从租户记录获取企业名，无名称时回退 "EC"。
      let companyName = "EC";
      const tenant = await getTenantById(ctx.tenantId);
      if (tenant?.name) {
        companyName = tenant.name;
      }

      const persona = buildRecommendedPersona(companyName);
      respond(true, persona);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`tenant.cs.recommended-persona.get failed: ${message}`);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Failed to build recommended persona"),
      );
    }
  },
};
