/**
 * Tests for the Customer Service session state machine.
 *
 * 客服会话状态机测试。
 */

import { describe, expect, it } from "vitest";
import { transition } from "./session-state-machine.js";

describe("CS session state machine", () => {
  // -- AI_ACTIVE state --
  describe("AI_ACTIVE", () => {
    it("customer_message → run_rag, stay ai_active", () => {
      const result = transition("ai_active", { type: "customer_message", text: "hello" });
      expect(result.nextState).toBe("ai_active");
      expect(result.action).toBe("run_rag");
    });

    it("boss_click_reply → human_active", () => {
      const result = transition("ai_active", { type: "boss_click_reply" });
      expect(result.nextState).toBe("human_active");
      expect(result.action).toBe("noop");
    });

    it("boss_reply → human_active + forward_to_customer", () => {
      const result = transition("ai_active", { type: "boss_reply", text: "I'll handle this" });
      expect(result.nextState).toBe("human_active");
      expect(result.action).toBe("forward_to_customer");
    });

    it("timeout → noop, stay ai_active", () => {
      const result = transition("ai_active", { type: "timeout" });
      expect(result.nextState).toBe("ai_active");
      expect(result.action).toBe("noop");
    });
  });

  // -- HUMAN_ACTIVE state --
  describe("HUMAN_ACTIVE", () => {
    it("customer_message → forward_to_boss, stay human_active", () => {
      const result = transition("human_active", {
        type: "customer_message",
        text: "still waiting",
      });
      expect(result.nextState).toBe("human_active");
      expect(result.action).toBe("forward_to_boss");
    });

    it("boss_reply → forward_to_customer, stay human_active", () => {
      const result = transition("human_active", { type: "boss_reply", text: "here's your answer" });
      expect(result.nextState).toBe("human_active");
      expect(result.action).toBe("forward_to_customer");
    });

    it("boss_click_ai_takeover → ai_active + inject_context", () => {
      const result = transition("human_active", { type: "boss_click_ai_takeover" });
      expect(result.nextState).toBe("ai_active");
      expect(result.action).toBe("inject_context_and_activate_ai");
    });

    it("timeout → ai_active", () => {
      const result = transition("human_active", { type: "timeout" });
      expect(result.nextState).toBe("ai_active");
      expect(result.action).toBe("noop");
    });
  });

  // -- Core invariant --
  describe("core invariant", () => {
    it("only AI_ACTIVE + customer_message triggers LLM (run_rag)", () => {
      // All combinations that should NOT trigger run_rag
      // 所有不应触发 run_rag 的组合
      const nonRagCombinations: Array<
        [Parameters<typeof transition>[0], Parameters<typeof transition>[1]]
      > = [
        ["human_active", { type: "customer_message", text: "test" }],
        ["ai_active", { type: "boss_click_reply" }],
        ["ai_active", { type: "boss_reply", text: "test" }],
        ["ai_active", { type: "boss_click_ai_takeover" }],
        ["ai_active", { type: "timeout" }],
        ["human_active", { type: "boss_reply", text: "test" }],
        ["human_active", { type: "boss_click_ai_takeover" }],
        ["human_active", { type: "timeout" }],
      ];

      for (const [state, event] of nonRagCombinations) {
        const result = transition(state, event);
        expect(result.action, `${state} + ${event.type} should not trigger run_rag`).not.toBe(
          "run_rag",
        );
      }

      // The only combination that triggers run_rag
      // 唯一触发 run_rag 的组合
      const ragResult = transition("ai_active", { type: "customer_message", text: "test" });
      expect(ragResult.action).toBe("run_rag");
    });
  });
});
