/**
 * CS knowledge cascade merge — agent KB (B) + enterprise KB (A).
 *
 * 客服知识库级联合并 — agent 知识库（B） + 企业知识库（A）。
 *
 * Cascade rule ("依次", user-confirmed default):
 *   - agent-KB hits rank FIRST (priority), in their incoming (score) order
 *   - enterprise-KB hits FILL the remaining quota up to `max`
 *   - dedup overlapping chunks by content; the agent-ranked copy wins
 *   - cap total at `max`
 *
 * Inputs are assumed pre-sorted by score (as returned by manager.search) and
 * pre-filtered by minScore; this function only merges, dedups, and caps.
 * 入参假定已按分数排序且已按 minScore 过滤；此函数只负责合并 / 去重 / 截断。
 */

import type { MemorySearchResult } from "../../memory/types.js";

/**
 * Identity key for dedup. Two chunks are "the same" when their normalized
 * content matches, regardless of which KB / directory they came from (agent
 * and enterprise KBs live in different dirs, so paths differ for identical
 * content). Content is the stable cross-store identity.
 * 去重标识：内容归一化后相同即视为同一片段，不依赖路径（两库目录不同）。
 */
function dedupKey(result: MemorySearchResult): string {
  return result.snippet.trim();
}

/**
 * Merge agent-KB and enterprise-KB search results per the cascade rule.
 *
 * @param agentResults      agent KB (B) hits, score-sorted
 * @param enterpriseResults enterprise KB (A) hits, score-sorted
 * @param max               overall cap (CS_KNOWLEDGE_MAX_RESULTS)
 */
export function mergeCascadeResults(
  agentResults: MemorySearchResult[],
  enterpriseResults: MemorySearchResult[],
  max: number,
): MemorySearchResult[] {
  if (max <= 0) {
    return [];
  }

  const merged: MemorySearchResult[] = [];
  const seen = new Set<string>();

  // Agent KB first (priority).
  for (const result of agentResults) {
    if (merged.length >= max) {
      break;
    }
    const key = dedupKey(result);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(result);
  }

  // Enterprise KB fills the remaining quota, skipping content already present.
  for (const result of enterpriseResults) {
    if (merged.length >= max) {
      break;
    }
    const key = dedupKey(result);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(result);
  }

  return merged;
}
