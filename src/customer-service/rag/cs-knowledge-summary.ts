/**
 * CS knowledge-hits summary — distil RAG hits into a compact reasoning trace.
 *
 * 客服知识库命中摘要 — 把 RAG 检索命中压缩成精简的推理依据列表，
 * 供 SSE done 事件的 knowledgeHits 字段使用（jiumi 需求1 / P6 Step1）。
 *
 * Pure function: no I/O, no LLM. Inputs are the merged sourceChunks already
 * produced by the cascade (score-sorted, minScore-filtered, deduped, capped).
 * This only reshapes them for transport and truncates long snippets.
 * 纯函数：无 I/O、无 LLM。入参为级联已合并的 sourceChunks（已排序/过滤/去重/截断），
 * 本函数只做投影 + snippet 截断，便于通过 SSE 传出。
 */

import type { MemorySearchResult } from "../../memory/types.js";

/** Max characters of snippet kept per hit before truncation. 单条片段最大保留字符数。 */
const SNIPPET_MAX_CHARS = 200;

export type KnowledgeHitSummary = {
  /** Human-readable source (sourceLabel when set, else the chunk path). 来源标签或路径。 */
  source: string;
  /** Relevance score from the embedding search. 检索相关性分数。 */
  score: number;
  /** Whitespace-collapsed, truncated snippet of the matched content. 归一化并截断后的片段。 */
  snippet: string;
};

/**
 * Collapse runs of whitespace (incl. newlines/tabs) into single spaces and trim.
 * 把连续空白（含换行/制表）折叠为单空格并去除首尾空白。
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Truncate to SNIPPET_MAX_CHARS, appending an ellipsis only when content was cut.
 * 截断到上限，仅在确实截断时追加省略号。
 */
function truncateSnippet(text: string): string {
  if (text.length <= SNIPPET_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, SNIPPET_MAX_CHARS)}…`;
}

/**
 * Summarize the top-N knowledge hits into {source, score, snippet} entries.
 *
 * @param sourceChunks merged cascade hits (already score-sorted upstream)
 * @param max          cap on the number of hits returned
 */
export function summarizeKnowledgeHits(
  sourceChunks: MemorySearchResult[],
  max: number,
): KnowledgeHitSummary[] {
  if (max <= 0 || sourceChunks.length === 0) {
    return [];
  }
  return sourceChunks.slice(0, max).map((chunk) => ({
    source: chunk.sourceLabel ?? chunk.path,
    score: chunk.score,
    snippet: truncateSnippet(collapseWhitespace(chunk.snippet)),
  }));
}
