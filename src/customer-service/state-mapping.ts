/**
 * cs-api enum (4 值): ai-handling / notifying / human-handling / closed.
 * DB 字段可能存：① S1 legacy "ai_active" / "human_active"  ② 新值 4 个
 * 映射规则（v1.2 §F.2 选项 A 双值并存）：
 *   读：legacy → cs-api 新值；新值透传
 *   写：永远写新值（不回写 legacy）
 *
 * Bi-directional mapping between cs-api enum (4 states) and the DB state field
 * which may hold either S1 legacy values (ai_active/human_active) or the new
 * 4-state enum. Reads map legacy → new; writes always emit new values.
 */

export type CsApiState = "ai-handling" | "notifying" | "human-handling" | "closed";

export function dbStateToCsApi(dbValue: string): CsApiState | null {
  switch (dbValue) {
    case "ai_active":
    case "ai-handling":
      return "ai-handling";
    case "human_active":
    case "human-handling":
      return "human-handling";
    case "notifying":
      return "notifying";
    case "closed":
      return "closed";
    default:
      return null;
  }
}

export function csApiToDbState(apiValue: CsApiState): string {
  return apiValue; // 新写入永远用新值（不主动回写 legacy）。Writes always emit the new enum.
}
