import { describe, it, expect } from "vitest";
import { csApiToDbState, dbStateToCsApi } from "./state-mapping.js";

describe("state-mapping", () => {
  it("maps DB legacy values to cs-api enum on read", () => {
    expect(dbStateToCsApi("ai_active")).toBe("ai-handling");
    expect(dbStateToCsApi("human_active")).toBe("human-handling");
    expect(dbStateToCsApi("ai-handling")).toBe("ai-handling");
    expect(dbStateToCsApi("notifying")).toBe("notifying");
    expect(dbStateToCsApi("human-handling")).toBe("human-handling");
    expect(dbStateToCsApi("closed")).toBe("closed");
  });

  it("maps cs-api enum to DB new values on write (no legacy regression)", () => {
    expect(csApiToDbState("ai-handling")).toBe("ai-handling");
    expect(csApiToDbState("notifying")).toBe("notifying");
    expect(csApiToDbState("human-handling")).toBe("human-handling");
    expect(csApiToDbState("closed")).toBe("closed");
  });

  it("dbStateToCsApi returns null for unknown values", () => {
    expect(dbStateToCsApi("paused")).toBeNull();
    expect(dbStateToCsApi("")).toBeNull();
  });
});
