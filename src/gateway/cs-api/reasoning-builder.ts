/**
 * Reasoning struct builder — converts llm_interaction_traces into a structured
 * reasoning summary for the cs-api GET reasoning endpoint (P7-B2).
 *
 * 推理结构构建器：将 llm_interaction_traces 转换为 cs-api 推理摘要。
 *
 * Pure functions, unit-testable without DB or HTTP dependencies.
 */

import type { LlmInteractionTrace } from "../../db/types.js";
import type { CSConfidence } from "../../customer-service/types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** A parsed tool call extracted from the trace messages JSONB. */
// 从 trace messages JSONB 解析出的工具调用记录。
export interface ParsedToolCall {
  /** Tool name, e.g. "search_knowledge_base". */
  name: string;
  /** Tool input arguments as provided by the model. */
  input: unknown;
  /** Truncated result summary from the corresponding tool_result block (≤500 chars). */
  resultSummary: string;
}

/** Aggregated reasoning struct returned to the caller. */
// 返回给调用方的推理摘要结构。
export interface ReasoningStruct {
  turnId: string;
  /** Model used for the turn — taken from the last/primary trace. */
  // 本次 turn 使用的模型，取最后一条 trace（主 trace）的 model 字段。
  model: string;
  /** Token usage summed across all traces in the turn. */
  // turn 内所有 trace 的 token 用量总和。
  tokensUsed: {
    prompt: number;
    completion: number;
    total: number;
  };
  /**
   * Confidence from cs_message.confidence. Null for messages without a
   * stored confidence verdict (e.g. tools-only turns or legacy messages).
   *
   * 来自 cs_messages.confidence 字段。无置信度记录的消息（纯工具调用轮次、历史消息）为 null。
   */
  confidence: CSConfidence | null;
  /**
   * KB knowledge hits. Currently [] — sourceChunks are NOT persisted per-message
   * via appendCsApiMessage (only surfaced in the SSE done event). Persistence
   * of sourceChunks per-message is a P8 follow-up.
   *
   * 知识库命中列表。当前恒为 []：appendCsApiMessage 不持久化 sourceChunks
   * （仅在 SSE done 事件中传递），per-message 持久化为 P8 后续任务。
   */
  knowledgeHits: unknown[];
  /** Tool calls extracted from the trace messages JSONB. */
  // 从 trace messages JSONB 解析出的工具调用列表。
  toolCalls: ParsedToolCall[];
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Max chars for a tool result summary to keep the response payload bounded. */
// 工具结果摘要最大字符数，防止响应体过大。
const TOOL_RESULT_MAX_CHARS = 500;

// ── Tool-call parser (pure, unit-testable) ──────────────────────────────────

/**
 * Parse tool calls from a trace's messages array (Anthropic content-block format).
 *
 * Iterates messages to pair each `tool_use` block with its corresponding
 * `tool_result` block (matched by tool_use_id), and returns the list.
 * Unmatched tool_use blocks are included with resultSummary = "".
 *
 * 从 Anthropic content-block 格式的 messages 数组中解析工具调用对。
 * 将 tool_use 与对应的 tool_result（按 tool_use_id 匹配）配对返回。
 * 无对应 tool_result 的条目 resultSummary 为空字符串。
 */
export function parseToolCallsFromMessages(messages: unknown[]): ParsedToolCall[] {
  // Step 1: collect all tool_use blocks from assistant messages.
  // 第一步：收集所有 assistant 消息中的 tool_use 块。
  const toolUseBlocks: Array<{
    id: string;
    name: string;
    input: unknown;
  }> = [];

  // Step 2: collect all tool_result content from user messages, keyed by tool_use_id.
  // 第二步：收集所有 user 消息中的 tool_result 内容，按 tool_use_id 索引。
  const toolResultMap = new Map<string, string>();

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const content = message.content;

    if (!Array.isArray(content)) {
      continue;
    }

    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }

      if (block.type === "tool_use") {
        const id = block.id as string | undefined;
        const name = block.name as string | undefined;
        if (id && name) {
          toolUseBlocks.push({ id, name, input: block.input ?? null });
        }
      }

      if (block.type === "tool_result") {
        const toolUseId = block.tool_use_id as string | undefined;
        if (toolUseId) {
          const rawContent = block.content;
          let text = "";
          if (typeof rawContent === "string") {
            text = rawContent;
          } else if (Array.isArray(rawContent)) {
            // Array of content blocks, pick text blocks.
            // 内容块数组，提取文本块。
            text = rawContent
              .filter((c) => isRecord(c) && c.type === "text")
              .map((c) => (isRecord(c) ? (c.text as string | undefined) ?? "" : ""))
              .join("\n");
          }
          toolResultMap.set(toolUseId, text.slice(0, TOOL_RESULT_MAX_CHARS));
        }
      }
    }
  }

  // Step 3: pair and return.
  // 第三步：配对并返回。
  return toolUseBlocks.map((tu) => ({
    name: tu.name,
    input: tu.input,
    resultSummary: toolResultMap.get(tu.id) ?? "",
  }));
}

// ── Reasoning aggregator ─────────────────────────────────────────────────────

/**
 * Build a ReasoningStruct from a set of traces + the message's confidence.
 *
 * - model: taken from the last trace with a non-null model value (primary trace).
 * - tokensUsed: summed across all traces.
 * - toolCalls: union of all tool_use/tool_result pairs across all traces.
 *
 * 从一组 trace 和消息置信度构建 ReasoningStruct。
 * - model：取最后一条有 model 值的 trace（主 trace）。
 * - tokensUsed：所有 trace 累加。
 * - toolCalls：所有 trace 的 tool_use/tool_result 对的并集。
 */
export function buildReasoningFromTraces(
  traces: LlmInteractionTrace[],
  confidence: CSConfidence | null,
): ReasoningStruct {
  // Sort by turn_index ascending for deterministic processing.
  // 按 turn_index 升序排列以保证确定性处理顺序。
  const sorted = traces.toSorted((a, b) => a.turnIndex - b.turnIndex);

  // Primary model: last trace's model (most recent/final LLM call in the turn).
  // 主模型：最后一条 trace 的 model（turn 内最新/最终的 LLM 调用）。
  let model = "unknown";
  for (const trace of sorted) {
    if (trace.model) {
      model = trace.model;
    }
  }

  // Sum tokens across all traces in the turn.
  // 累加 turn 内所有 trace 的 token 用量。
  let promptTokens = 0;
  let completionTokens = 0;
  for (const trace of sorted) {
    promptTokens += trace.inputTokens ?? 0;
    completionTokens += trace.outputTokens ?? 0;
  }

  // Collect tool calls from all traces.
  // 收集所有 trace 的工具调用。
  const allToolCalls: ParsedToolCall[] = [];
  for (const trace of sorted) {
    const msgs = Array.isArray(trace.messages) ? trace.messages : [];
    const calls = parseToolCallsFromMessages(msgs);
    allToolCalls.push(...calls);
  }

  return {
    turnId: sorted[0]?.turnId ?? "",
    model,
    tokensUsed: {
      prompt: promptTokens,
      completion: completionTokens,
      total: promptTokens + completionTokens,
    },
    confidence,
    knowledgeHits: [], // sourceChunks not persisted per-message — P8 follow-up
    toolCalls: allToolCalls,
  };
}

// ── Utility ──────────────────────────────────────────────────────────────────

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}
