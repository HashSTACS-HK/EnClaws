/**
 * Customer Service module — core type definitions.
 *
 * 客服模块核心类型定义。
 */

// -- Session state (deterministic, system-level) --
// 会话状态（确定性，系统层控制）
export type CSSessionState = "ai_active" | "human_active";

// -- Message roles (three-party conversation) --
// 消息角色（三方对话）
export type CSMessageRole = "customer" | "ai" | "boss" | "system";

// -- Confidence verdict (pure rules, no LLM) --
// 置信度判定（纯规则，不依赖 LLM）
export type CSConfidenceVerdict = "ok" | "knowledge_gap" | "suspect_badcase";

export interface CSConfidence {
  score: number;
  verdict: CSConfidenceVerdict;
}

// -- Session --
// 会话
export interface CSSession {
  id: string;
  tenantId: string;
  visitorId: string;
  visitorName: string | null;
  state: CSSessionState;
  channel: string;
  tags: string[];
  identityAnchors: Record<string, string>;
  metadata: Record<string, unknown>;
  assignedTo: string | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

// -- Message --
// 消息
export interface CSMessage {
  id: string;
  sessionId: string;
  tenantId: string;
  role: CSMessageRole;
  content: string;
  confidence: CSConfidence | null;
  feedbackType: string | null;
  sourceChunks: unknown[] | null;
  /** Link to llm_interaction_traces.turn_id; null for customer/human/legacy messages. */
  // 关联 llm_interaction_traces.turn_id；客户/人工/历史消息为 null。
  turnId: string | null;
  createdAt: Date;
}

// -- State machine event types --
// 状态机事件类型
export type CSEvent =
  | { type: "customer_message"; text: string }
  | { type: "boss_click_reply" }
  | { type: "boss_reply"; text: string }
  | { type: "boss_click_ai_takeover" }
  | { type: "timeout" };

// -- State machine transition action --
// 状态机转换动作
export type CSAction =
  | "run_rag"
  | "forward_to_boss"
  | "forward_to_customer"
  | "inject_context_and_activate_ai"
  | "noop";

export interface CSTransitionResult {
  nextState: CSSessionState;
  action: CSAction;
}

// -- Role labels for display --
// 角色显示标签
export const CS_ROLE_LABELS: Record<CSMessageRole, string> = {
  customer: "客户",
  ai: "🤖 AI 助手",
  boss: "👔 负责人",
  system: "系统",
};
