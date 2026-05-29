/**
 * Customer Service Agent runner — wraps runEmbeddedPiAgent() with CS-specific logic.
 *
 * 客服 Agent 运行器 — 包装 runEmbeddedPiAgent()，添加客服特定逻辑。
 *
 * Call chain: runWithModelFallback() → runEmbeddedPiAgent()
 *
 * System prompt strategy:
 *   promptMode: "none" — skip the 800+ line EC agent prompt, use only the CS prompt.
 *   Final LLM prompt = identity line + CS base prompt + restriction add-ons + KB chunks.
 *   システムプロンプト戦略: promptMode:"none" で EC フルプロンプトを排除し CS 専用プロンプトのみ使用。
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
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveTenantDir,
  resolveTenantAgentDir,
  resolveTenantAgentKnowledgeDir,
  resolveTenantAgentMemoryIndexPath,
  resolveTenantMemoryIndexPath,
} from "../../config/sessions/tenant-paths.js";
import { getTenantById } from "../../db/models/tenant.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getMemorySearchManager } from "../../memory/search-manager.js";
import type { MemorySearchResult } from "../../memory/types.js";
import { mergeCascadeResults } from "./cs-knowledge-cascade.js";
import { loadAgentPersona, selectBasePrompt } from "./cs-persona.js";
import {
  buildCSSystemPrompt,
  renderCSBasePrompt,
  type CSRestrictions,
} from "./cs-system-prompt.js";

const log = createSubsystemLogger("cs-agent-runner");

const CS_AGENT_TIMEOUT_MS = 30_000;
const CS_KNOWLEDGE_MAX_RESULTS = 5;
const CS_KNOWLEDGE_MIN_SCORE = 0.1;

export interface CSAgentReplyResult {
  reply: string;
  sourceChunks: MemorySearchResult[];
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
  const extraSystemPrompt = buildCSSystemPrompt({
    basePrompt,
    knowledgeChunks: sourceChunks,
    visitorName,
    restrictions: params.restrictions,
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

    // Step 5: Call LLM with model fallback
    // promptMode: "none" — skip the 800+ line EC agent prompt entirely.
    // The full system prompt is: "You are a personal assistant running inside EnClaws." + extraSystemPrompt.
    // 步骤 5：调用 LLM（带 model fallback）
    // promptMode:"none" 跳过 EC agent 主 prompt，只用 CS 专用 prompt，大幅减少 token 消耗。
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
          runId: `cs-run-${Date.now()}`,
          extraSystemPrompt,
          promptMode: "none",
          disableTools,
          disableMessageTool: true,
          tenantId,
        }),
    });

    // Step 6: Extract reply text
    // 步骤 6：提取回复文本
    const result = fallbackResult.result;
    const rawReply = result.payloads?.[0]?.text?.trim();

    if (!rawReply) {
      log.warn(`cs agent returned empty reply for session ${sessionId}`);
      return {
        reply: "抱歉，我暂时无法回答这个问题。我会通知负责人为您跟进。",
        sourceChunks,
      };
    }

    // Strip the model-injected "Skills Reporting" trailer.
    // Even with promptMode:"none" excluding the Skills Reporting instruction,
    // some models (e.g. qwen) carry this pattern as training prior and emit
    // a trailing `> Skills used: ...` line that's irrelevant for CS customers.
    // 剥掉模型脑补的 Skills Reporting 末尾行——CS 场景下客户看到 meta 信息很突兀。
    const replyText = rawReply
      .replace(/\s*\n+\s*>\s*Skills\s*used\s*:[^\n]*$/i, "")
      .replace(/\s*>\s*Skills\s*used\s*:[^\n]*$/i, "")
      .trimEnd();

    return { reply: replyText, sourceChunks };
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
