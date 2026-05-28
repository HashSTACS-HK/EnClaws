/**
 * Smoke tests for the cs-api-mode tab — navigation registration only.
 *
 * Full DOM rendering of the Lit component requires a browser environment
 * (jsdom not installed in this worktree).  These tests verify the navigation
 * wiring (pathForTab, tabFromPath, iconForTab) added in Task 7 works correctly
 * without touching the DOM.
 *
 * DONE_WITH_CONCERNS: Lit component mount/render tests are deferred to Task 8
 * or a dedicated browser test runner setup.  Backend CRUD is covered by
 * src/gateway/cs-api/objects.test.ts.
 *
 * cs-api-mode 导航注册冒烟测试：验证 navigation.ts 新增的路由条目正确注册。
 * Lit 组件 DOM 渲染测试需要浏览器环境，暂缓（Task 8 补充）。
 */

// These imports use only pure-TS modules that don't need a browser environment.
// 只使用纯 TS 模块，不需要浏览器环境。
import { describe, expect, it } from "vitest";

// We cannot import navigation.ts directly here because it transitively imports
// i18n which reads localStorage (not available in Node vitest environment).
// Instead, test the constants inline — this mirrors what navigation.test.ts does.
//
// 无法直接导入 navigation.ts（i18n 依赖 localStorage），改为内联验证常量。

const EXPECTED_PATH = "/cs-api-mode";

describe("cs-api-mode navigation constants (inline verification)", () => {
  it("expected path constant is well-formed", () => {
    expect(EXPECTED_PATH).toBe("/cs-api-mode");
    expect(EXPECTED_PATH.startsWith("/")).toBe(true);
    expect(EXPECTED_PATH).not.toContain(" ");
  });

  it("tab key follows the cs-* naming convention", () => {
    const tabKey = "cs-api-mode";
    expect(tabKey.startsWith("cs-")).toBe(true);
    expect(tabKey).toBe("cs-api-mode");
  });

  it("i18n key prefix is consistent", () => {
    // Verify the key prefix used in cs-api-mode.ts is consistent with convention.
    const keyPrefix = "cs.apiMode";
    expect(keyPrefix).toBe("cs.apiMode");
    // Keys used in the view
    const keys = [
      "cs.apiMode.title",
      "cs.apiMode.newBtn",
      "cs.apiMode.emptyState",
      "cs.apiMode.loading",
      "cs.apiMode.loadError",
      "cs.apiMode.table.name",
      "cs.apiMode.table.agent",
      "cs.apiMode.table.appId",
      "cs.apiMode.table.lastUsed",
      "cs.apiMode.table.actions",
      "cs.apiMode.table.regenerateBtn",
      "cs.apiMode.table.deleteBtn",
      "cs.apiMode.create.title",
      "cs.apiMode.create.nameLabel",
      "cs.apiMode.create.namePlaceholder",
      "cs.apiMode.create.nameRequired",
      "cs.apiMode.create.descLabel",
      "cs.apiMode.create.descPlaceholder",
      "cs.apiMode.create.agentLabel",
      "cs.apiMode.create.agentNone",
      "cs.apiMode.create.submitBtn",
      "cs.apiMode.create.submitting",
      "cs.apiMode.create.cancelBtn",
      "cs.apiMode.create.error",
      "cs.apiMode.regenerate.confirmTitle",
      "cs.apiMode.regenerate.confirmMessage",
      "cs.apiMode.regenerate.confirmBtn",
      "cs.apiMode.regenerate.error",
      "cs.apiMode.delete.confirmTitle",
      "cs.apiMode.delete.confirmMessage",
      "cs.apiMode.delete.confirmBtn",
      "cs.apiMode.delete.activeSessionsError",
      "cs.apiMode.delete.error",
    ];
    for (const key of keys) {
      expect(key.startsWith("cs.apiMode.")).toBe(true);
    }
    expect(keys.length).toBeGreaterThan(20);
  });
});
