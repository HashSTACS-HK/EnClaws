export type ConfidenceVerdict = "ok" | "knowledge_gap" | "suspect_badcase";

export function confidenceToVerdict(confidence: number): ConfidenceVerdict {
  if (confidence >= 0.75) {
    return "ok";
  }
  if (confidence < 0.35) {
    return "suspect_badcase";
  }
  return "knowledge_gap";
}
