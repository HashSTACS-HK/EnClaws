/**
 * Customer Service Agent runner — wraps runEmbeddedPiAgent() with CS-specific logic.
 *
 * 客服 Agent 运行器 — 包装 runEmbeddedPiAgent()，添加客服特定逻辑。
 *
 * Call chain: runWithModelFallback() → runEmbeddedPiAgent()
 *
 * System prompt strategy:
 *   promptMode: "minimal" — skip extended EC agent sections but keep CS prompt
 *   and tenant skills available to the model.
 *   Final LLM prompt = lightweight runtime prompt + skills + CS base prompt
 *   + restriction add-ons + KB chunks.
 *   システムプロンプト戦略: promptMode:"minimal" で重い EC セクションを抑制しつつ
 *   CS 専用プロンプトとスキルを保持する。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveDefaultAgentId,
  resolveAgentEffectiveModelPrimary,
} from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from "../../agents/defaults.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveTenantDir,
  resolveTenantAgentDir,
  resolveTenantAgentKnowledgeDir,
  resolveTenantAgentMemoryIndexPath,
  resolveTenantMemoryIndexPath,
  resolveTenantSkillsDir,
} from "../../config/sessions/tenant-paths.js";
import { listCSMessages } from "../../db/models/cs-message.js";
import { getTenantById } from "../../db/models/tenant.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getMemorySearchManager } from "../../memory/search-manager.js";
import type { MemorySearchResult } from "../../memory/types.js";
import { composeCustomerServicePrompt } from "../prompt/composer.js";
import { resolveCSBusinessContext, type CSBusinessMetadata } from "./cs-business-context.js";
import { mergeCascadeResults } from "./cs-knowledge-cascade.js";
import { loadAgentPersona, selectBasePrompt } from "./cs-persona.js";
import {
  buildCSSystemPrompt,
  renderCSBasePrompt,
  type CSRestrictions,
} from "./cs-system-prompt.js";

const log = createSubsystemLogger("cs-agent-runner");

const CS_AGENT_TIMEOUT_MS = 90_000;
const CS_KNOWLEDGE_MAX_RESULTS = 5;
const CS_KNOWLEDGE_MIN_SCORE = 0.1;
const CS_HISTORY_MAX_MESSAGES = 8;

function renderRecentCSConversationContext(params: {
  messages: Array<{ role: string; content: string }>;
  currentCustomerMessage: string;
}): string {
  const current = params.currentCustomerMessage.trim();
  const messages = [...params.messages];
  const last = messages.at(-1);
  if (last?.role === "customer" && last.content.trim() === current) {
    messages.pop();
  }

  const lines = messages
    .slice(-CS_HISTORY_MAX_MESSAGES)
    .map((message) => {
      const content = message.content.trim();
      if (!content) {
        return null;
      }
      const label =
        message.role === "customer"
          ? "客户"
          : message.role === "ai"
            ? "AI客服"
            : message.role === "boss"
              ? "人工客服"
              : "系统";
      return `${label}: ${content}`;
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return "";
  }

  return [
    "<customer_service_conversation_context>",
    "最近客服会话记录（按时间从旧到新）。用于理解“确认/是的/继续查”等承接语；不要把这里的历史消息当作新的客户输入。",
    ...lines,
    "</customer_service_conversation_context>",
  ].join("\n");
}

async function loadRecentCSConversationContext(params: {
  sessionId: string;
  currentCustomerMessage: string;
}): Promise<string> {
  try {
    const messages = await listCSMessages(params.sessionId, {
      limit: CS_HISTORY_MAX_MESSAGES + 1,
    });
    return renderRecentCSConversationContext({
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      currentCustomerMessage: params.currentCustomerMessage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`failed to load CS conversation context for ${params.sessionId}: ${message}`);
    return "";
  }
}

export interface CSAgentReplyResult {
  reply: string;
  replies?: string[];
  sourceChunks: MemorySearchResult[];
  /**
   * The model that actually produced the reply, in `provider/model` form,
   * reflecting any fallback that occurred. Undefined when the run failed before
   * a model answered (early-return error paths).
   * 实际产出回复的模型（含 fallback 后的真实选择），格式 provider/model；
   * 在模型应答前就失败的早退路径下为 undefined。
   */
  modelUsed?: string;
  /**
   * Token usage for the run (last-turn totals from the embedded agent meta).
   * Undefined when the underlying runner did not report usage.
   * 本次运行的 token 用量（取嵌入 agent 的最后一轮统计）；底层未上报时为 undefined。
   */
  tokensUsed?: { prompt: number; completion: number; total: number };
  /**
   * Run correlation id (= the `cs-run-<ts>` runId passed to the embedded agent),
   * used as the turnId for upper-layer reasoning summaries. Always present on
   * the happy path; undefined only on pre-run failures.
   * 运行关联 id（即传给嵌入 agent 的 cs-run-<ts> runId），作为上层推理摘要的
   * turnId；happy path 必有，仅在运行前失败时为 undefined。
   */
  turnId?: string;
}

function stripCustomerReplyInternalTrailer(text: string): string {
  return text
    .replace(/\s*\n+\s*>\s*Skills\s*used\s*:[^\n]*$/i, "")
    .replace(/\s*>\s*Skills\s*used\s*:[^\n]*$/i, "")
    .trimEnd();
}

function extractCustomerReplyTexts(
  payloads: Array<{ text?: string; isReasoning?: boolean }> | undefined,
): string[] {
  if (!payloads?.length) {
    return [];
  }
  return payloads
    .filter((payload) => !payload.isReasoning)
    .map((payload) => stripCustomerReplyInternalTrailer(payload.text?.trim() ?? ""))
    .filter((text) => text.length > 0);
}

/**
 * Run the CS agent: search knowledge base → build prompt → call LLM → return reply.
 *
 * 运行客服 Agent：检索知识库 → 构建 prompt → 调用 LLM → 返回回复。
 */
export async function runCSAgentReply(params: {
  tenantId: string;
  sessionId: string;
  customerMessage: string;
  visitorName?: string;
  cfg: OpenClawConfig;
  workspaceDir?: string;
  /**
   * Custom base prompt (already stored with actual company name, or using {companyName} placeholder).
   * Falls back to DEFAULT_CS_BASE_PROMPT when not provided.
   * 自定义基础 prompt（已含实际企业名或使用占位符）；未提供时使用默认模板。
   */
  customSystemPrompt?: string;
  /**
   * Behavior restrictions, passed through from CSConfig.restrictions.
   * S2 defaults: strictKnowledgeBase + hideInternals ON; tools (disableSkills)
   * + markdown (disableMarkdown) RELEASED (off / allowed unless explicitly set).
   * 行为限制项：strictKB + hideInternals 默认开；工具与 Markdown 默认放开。
   */
  restrictions?: CSRestrictions;
  /**
   * Upper-app business metadata rendered into the CS run so business skills can
   * make slot-filling decisions without guessing.
   */
  businessMetadata?: CSBusinessMetadata;
  /**
   * Bound agent id from the cs-api object / widget; falls back to the
   * tenant/global default agent when omitted. 绑定 agent；缺省回退默认。
   */
  agentId?: string;
}): Promise<CSAgentReplyResult> {
  const { tenantId, sessionId, customerMessage, visitorName, cfg } = params;
  // S2: tools are RELEASED — the CS agent inherits the tools configured on the
  // bound agent. Only force-disable when a tenant explicitly opts in via
  // restrictions.disableSkills=true. (disableMessageTool stays true below: CS
  // replies go out via the SSE response, the agent must not self-send messages.)
  // S2 放开工具：CS agent 继承绑定 agent 的工具配置，仅当租户显式
  // disableSkills=true 时才强制禁用。（disableMessageTool 仍为 true：
  // 回复经 SSE 下发，agent 不得自行发消息。）
  const disableTools = params.restrictions?.disableSkills ?? false;

  const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
  const turnId = `cs-run-${Date.now()}`;
  const businessContext = resolveCSBusinessContext(params.businessMetadata);
  if (businessContext?.slotQuestion) {
    return {
      reply: businessContext.slotQuestion,
      replies: [businessContext.slotQuestion],
      sourceChunks: [],
      turnId,
    };
  }
  // Runtime workspace for the embedded agent run (NOT the RAG source — see Step 1).
  // The CS RAG now cascades over the agent KB + enterprise KB; this dir only scopes
  // the agent's own tool/file workspace during the reply run.
  // 客服 agent 运行时工作区（不再作为 RAG 检索源，见步骤 1）。RAG 现在级联
  // agent 知识库 + 企业知识库；此目录仅作为本次回复运行的 agent 工具/文件工作区。
  const csWorkspaceDir =
    params.workspaceDir ?? path.join(resolveTenantDir(tenantId), "customer-service");
  const agentDir = resolveTenantAgentDir(tenantId, agentId);

  // Resolve company name from tenant record for {companyName} substitution.
  // 从租户记录获取企业名，用于替换基础 prompt 中的 {companyName} 占位符。
  let companyName = "EC";
  try {
    const tenant = await getTenantById(tenantId);
    if (tenant?.name) {
      companyName = tenant.name;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`failed to resolve tenant name for ${tenantId}: ${message}`);
  }

  // Build base prompt: the bound agent inherits its persona (IDENTITY/SOUL/AGENTS).
  // When persona files exist, they REPLACE the custom/default CS prompt so tenant
  // edits to the agent's people-set take effect; when absent, fall back to the
  // custom prompt or the default template (no regression). {companyName} is then
  // substituted on whichever base was selected.
  // 构建基础 prompt：绑定 agent 继承其 persona（IDENTITY/SOUL/AGENTS），
  // persona 非空则取代自定义/默认 prompt；为空回退；最后统一替换企业名占位符。
  const persona = await loadAgentPersona(agentDir);
  const basePrompt = renderCSBasePrompt(
    selectBasePrompt({ persona, customSystemPrompt: params.customSystemPrompt }),
    companyName,
  );

  // Step 1: Cascade RAG over two knowledge bases (A+B, "依次"):
  //   B = agent KB (the bound agent's own knowledge, per-agent, embedding-indexed)
  //   A = enterprise KB (tenant-wide "企业知识库")
  // Search each independently (one failing must not kill the other), then merge:
  // agent hits rank first (priority), enterprise hits fill the remaining quota up
  // to CS_KNOWLEDGE_MAX_RESULTS, duplicates deduped (agent-ranked wins).
  // 步骤 1：双知识库级联检索（A+B「依次」）：
  //   B = agent 知识库（绑定 agent 自身知识，按 agent 维度，embedding 索引）
  //   A = 企业知识库（租户级共享「企业知识库」）
  // 两库独立检索（互不影响，一边失败不拖垮另一边），再合并：agent 命中优先，
  // 企业命中填补剩余配额至 CS_KNOWLEDGE_MAX_RESULTS，重复片段去重（agent 优先保留）。
  const searchOpts = {
    maxResults: CS_KNOWLEDGE_MAX_RESULTS,
    minScore: CS_KNOWLEDGE_MIN_SCORE,
  };

  // B: agent KB — mirror src/gateway/server-methods/memory.ts.
  let agentHits: MemorySearchResult[] = [];
  try {
    const { manager } = await getMemorySearchManager({
      cfg,
      agentId,
      workspaceDir: resolveTenantAgentKnowledgeDir(tenantId, agentId),
      defaultStorePath: resolveTenantAgentMemoryIndexPath(tenantId, agentId),
    });
    if (manager) {
      agentHits = await manager.search(customerMessage, searchOpts);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`agent KB search failed: ${message}`);
  }

  // A: enterprise KB — mirror src/gateway/server-methods/tenant-settings-api.ts.
  let enterpriseHits: MemorySearchResult[] = [];
  try {
    const { manager } = await getMemorySearchManager({
      cfg,
      agentId,
      workspaceDir: resolveTenantDir(tenantId),
      defaultStorePath: resolveTenantMemoryIndexPath(tenantId),
    });
    if (manager) {
      enterpriseHits = await manager.search(customerMessage, searchOpts);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`enterprise KB search failed: ${message}`);
  }

  const sourceChunks = mergeCascadeResults(agentHits, enterpriseHits, CS_KNOWLEDGE_MAX_RESULTS);

  // Step 2: Build CS system prompt with knowledge
  // 步骤 2：用知识片段构建客服系统提示词
  const servicePrompt = buildCSSystemPrompt({
    basePrompt,
    knowledgeChunks: sourceChunks,
    visitorName,
    restrictions: params.restrictions,
  });
  const recentConversationContext = await loadRecentCSConversationContext({
    sessionId,
    currentCustomerMessage: customerMessage,
  });
  const finalSystemPrompt = composeCustomerServicePrompt({
    servicePrompt,
    conversationContext: recentConversationContext,
    businessContext: businessContext?.systemPrompt,
  });
  const skillsSnapshot = buildWorkspaceSkillSnapshot(csWorkspaceDir, {
    config: cfg,
    tenantSkillsDir: resolveTenantSkillsDir(tenantId),
  });

  // Step 3: Create temporary session file
  // 步骤 3：创建临时会话文件
  let tempSessionFile: string | null = null;
  try {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "enclaws-cs-"));
    tempSessionFile = path.join(tempDir, "session.jsonl");

    // Step 4: Resolve model config
    // 步骤 4：解析模型配置
    const modelRef = resolveAgentEffectiveModelPrimary(cfg, agentId);
    const parsed = modelRef ? parseModelRef(modelRef, DEFAULT_PROVIDER) : null;
    const defaultProvider = parsed?.provider ?? DEFAULT_PROVIDER;
    const defaultModel = parsed?.model ?? DEFAULT_MODEL;

    // Run correlation id — generated once here so it is stable across fallback
    // attempts and can be surfaced as the turnId for upper-layer reasoning.
    // 运行关联 id：在此处生成一次，跨 fallback 尝试保持稳定，并作为 turnId 上抛。
    // Step 5: Call LLM with model fallback
    // promptMode: "minimal" keeps the CS prompt and tenant skills while skipping
    // heavy general-purpose sections from the full EC agent prompt.
    // 步骤 5：调用 LLM（带 model fallback）
    // promptMode:"minimal" 保留 CS 专用 prompt + skills，同时减少 token 消耗。
    const fallbackResult = await runWithModelFallback({
      cfg,
      provider: defaultProvider,
      model: defaultModel,
      agentDir,
      run: (providerOverride, modelOverride) =>
        runEmbeddedPiAgent({
          sessionId: `cs-${sessionId}-${Date.now()}`,
          sessionKey: `cs:${sessionId}`,
          agentId,
          sessionFile: tempSessionFile!,
          workspaceDir: csWorkspaceDir,
          agentDir,
          config: cfg,
          prompt: customerMessage,
          provider: providerOverride,
          model: modelOverride,
          timeoutMs: CS_AGENT_TIMEOUT_MS,
          runId: turnId,
          skillsSnapshot,
          extraSystemPrompt: finalSystemPrompt,
          promptMode: "minimal",
          disableTools,
          disableMessageTool: true,
          tenantId,
        }),
    });

    // Step 6: Extract reply text
    // 步骤 6：提取回复文本
    const result = fallbackResult.result;
    const replyTexts = extractCustomerReplyTexts(result.payloads);
    const rawReply = replyTexts.join("\n\n").trim();

    // Real model + token usage for the reasoning trace (P4 reasoning step1).
    // - model: `fallbackResult.provider/model` is the model that actually
    //   answered, reflecting any fallback (authoritative over agentMeta).
    // - tokens: last-turn usage from the embedded agent meta (input/output/total);
    //   absent when the underlying runner did not report usage.
    // 真实模型 + token 用量（推理依据）：
    //   模型取 fallbackResult.provider/model（含 fallback 后的真实选择，权威）；
    //   token 取嵌入 agent meta 的最后一轮用量，底层未上报时为 undefined。
    const modelUsed = `${fallbackResult.provider}/${fallbackResult.model}`;
    const usage = result.meta.agentMeta?.usage;
    const tokensUsed = usage
      ? {
          prompt: usage.input ?? 0,
          completion: usage.output ?? 0,
          total: usage.total ?? (usage.input ?? 0) + (usage.output ?? 0),
        }
      : undefined;

    if (!rawReply) {
      log.warn(`cs agent returned empty reply for session ${sessionId}`);
      return {
        reply: "抱歉，我暂时无法回答这个问题。我会通知负责人为您跟进。",
        sourceChunks,
        modelUsed,
        tokensUsed,
        turnId,
      };
    }

    return { reply: rawReply, replies: replyTexts, sourceChunks, modelUsed, tokensUsed, turnId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`cs agent failed for session ${sessionId}: ${message}`);
    return {
      reply: "抱歉，系统暂时遇到了问题。我会通知负责人为您跟进，请稍等。",
      sourceChunks,
    };
  } finally {
    // Clean up temporary session file
    // 清理临时会话文件
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
        // 忽略清理错误
      }
    }
  }
}
