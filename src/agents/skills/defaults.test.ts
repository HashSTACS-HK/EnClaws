import { describe, it, expect } from "vitest";
import { DEFAULT_DISABLED_BUNDLED_SKILLS } from "./defaults.js";

describe("DEFAULT_DISABLED_BUNDLED_SKILLS", () => {
  it("is empty after enterprise bundle trim (consumer skills removed from skills/)", () => {
    expect(DEFAULT_DISABLED_BUNDLED_SKILLS).toHaveLength(0);
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(DEFAULT_DISABLED_BUNDLED_SKILLS)).toBe(true);
  });
});
