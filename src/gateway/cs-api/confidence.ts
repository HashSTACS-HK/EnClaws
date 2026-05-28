/**
 * Extract [confidence:X.XX] tag from agent output.
 *
 * 从 agent 输出中提取并移除置信度标签。
 */

const RE = /\[confidence:\s*([\d.]+)\s*\]\s*$/i;

export interface ConfidenceResult {
  stripped: string;
  confidence: number;
}

/**
 * Parse and remove the trailing [confidence:X.XX] tag from agent text.
 * Returns confidence clamped to [0, 1], defaulting to 0.5 if absent or invalid.
 *
 * 解析并移除 agent 回复末尾的置信度标签。
 * 置信度限定在 [0,1]，缺失或无效时默认 0.5。
 */
export function extractConfidence(text: string): ConfidenceResult {
  const m = text.match(RE);
  if (!m) {
    return { stripped: text, confidence: 0.5 };
  }
  const c = Number.parseFloat(m[1]);
  const conf = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5;
  return { stripped: text.replace(RE, "").trimEnd(), confidence: conf };
}
