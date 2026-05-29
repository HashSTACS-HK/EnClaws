/**
 * Customer Service session state machine — deterministic, system-level if/else.
 *
 * 客服会话状态机 — 确定性系统层控制，非 prompt。
 *
 * Core invariant: only `state=AI_ACTIVE AND event=customer_message` triggers LLM.
 * All other combinations follow deterministic code paths.
 *
 * 核心不变式：只有 state=AI_ACTIVE AND event=customer_message 才触发 LLM。
 * 其他组合全走确定性代码路径。
 */

import type { CSSessionState, CSEvent, CSTransitionResult } from "./types.js";

/**
 * Pure function — computes the next state and action for a given (state, event) pair.
 *
 * 纯函数 — 根据 (state, event) 计算下一个状态和动作。
 */
export function transition(state: CSSessionState, event: CSEvent): CSTransitionResult {
  // -- AI_ACTIVE state --
  if (state === "ai_active") {
    switch (event.type) {
      case "customer_message":
        // AI handles — trigger RAG pipeline
        // AI 处理 — 触发 RAG 管线
        return { nextState: "ai_active", action: "run_rag" };

      case "boss_click_reply":
        // Boss takes over — switch to human mode
        // 老板接管 — 切换到人工模式
        return { nextState: "human_active", action: "noop" };

      case "boss_reply":
        // Boss replied directly (implicit takeover)
        // 老板直接回复（隐式接管）
        return { nextState: "human_active", action: "forward_to_customer" };

      default:
        return { nextState: "ai_active", action: "noop" };
    }
  }

  // -- HUMAN_ACTIVE state --
  if (state === "human_active") {
    switch (event.type) {
      case "customer_message":
        // Forward to boss without LLM
        // 转发给老板，不调 LLM
        return { nextState: "human_active", action: "forward_to_boss" };

      case "boss_reply":
        // Forward boss reply to customer
        // 转发老板回复给客户
        return { nextState: "human_active", action: "forward_to_customer" };

      case "boss_click_ai_takeover":
        // Inject boss reply context, switch back to AI
        // 注入老板回复上下文，切回 AI
        return { nextState: "ai_active", action: "inject_context_and_activate_ai" };

      case "timeout":
        // Auto-revert to AI after inactivity
        // 超时后自动切回 AI
        return { nextState: "ai_active", action: "noop" };

      default:
        return { nextState: "human_active", action: "noop" };
    }
  }

  // Fallback — should never reach here
  // 兜底 — 不应到达此处
  return { nextState: state, action: "noop" };
}
