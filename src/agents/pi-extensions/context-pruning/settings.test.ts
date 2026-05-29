import { describe, it, expect, afterEach } from "vitest";
import { getEffectiveSoftTrimSettings } from "./settings.js";

describe("getEffectiveSoftTrimSettings", () => {
  afterEach(() => {
    delete process.env.ENCLAWS_TOKEN_OPT_TRIM;
  });

  it("returns default settings when TRIM toggle is off", () => {
    process.env.ENCLAWS_TOKEN_OPT_TRIM = "false";
    const result = getEffectiveSoftTrimSettings("exec");
    expect(result).toEqual({ maxChars: 4_000, headChars: 1_500, tailChars: 1_500 });
  });

  it("returns aggressive settings for exec when TRIM is on (default)", () => {
    expect(getEffectiveSoftTrimSettings("exec")).toEqual({
      maxChars: 2_500,
      headChars: 1_000,
      tailChars: 1_000,
    });
  });

  it("returns aggressive settings for web_fetch when TRIM is on (default)", () => {
    expect(getEffectiveSoftTrimSettings("web_fetch")).toEqual({
      maxChars: 2_000,
      headChars: 800,
      tailChars: 800,
    });
  });

  it("returns default for unknown tool when TRIM is on (default)", () => {
    expect(getEffectiveSoftTrimSettings("some_tool")).toEqual({
      maxChars: 4_000,
      headChars: 1_500,
      tailChars: 1_500,
    });
  });

  it("returns default for undefined tool name", () => {
    expect(getEffectiveSoftTrimSettings()).toEqual({
      maxChars: 4_000,
      headChars: 1_500,
      tailChars: 1_500,
    });
  });
});
