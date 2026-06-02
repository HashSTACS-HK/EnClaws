import { describe, expect, it } from "vitest";
import { formatComingSoonLabel } from "./coming-soon-placeholder.ts";

describe("formatComingSoonLabel", () => {
  it("uses the current page name before the unified coming-soon suffix", () => {
    expect(formatComingSoonLabel("工作流", "即将上线")).toBe("工作流——即将上线");
    expect(formatComingSoonLabel("智能操作", "即将上线")).toBe("智能操作——即将上线");
  });

  it("handles missing labels without rendering dangling separators", () => {
    expect(formatComingSoonLabel("技能市场", "")).toBe("技能市场");
    expect(formatComingSoonLabel("", "即将上线")).toBe("即将上线");
  });
});
