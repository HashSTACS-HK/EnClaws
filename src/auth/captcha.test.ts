import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock svg-captcha so tests can assert on known answers. The real
// library renders each glyph as an SVG <path>, so the answer isn't
// recoverable from the output string — tests would otherwise need OCR.
vi.mock("svg-captcha", () => {
  let counter = 0;
  return {
    default: {
      create: vi.fn(() => {
        counter += 1;
        const text = `ABcd${counter}`;
        return { text, data: `<svg data-mock="${text}"></svg>` };
      }),
    },
  };
});

// Import after mock so the module picks up the mocked svg-captcha.
const { __resetCaptchaStoreForTest, generateCaptcha, verifyCaptcha } = await import("./captcha.js");

describe("captcha", () => {
  beforeEach(() => {
    __resetCaptchaStoreForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("generates unique ids and SVG payloads", () => {
    const a = generateCaptcha();
    const b = generateCaptcha();
    expect(a.id).not.toEqual(b.id);
    expect(a.svg.startsWith("<svg")).toBe(true);
    expect(b.svg.startsWith("<svg")).toBe(true);
    expect(a.expiresAt).toBeGreaterThan(Date.now());
  });

  it("verifies the correct answer (case-insensitive, trimmed)", () => {
    const { id, svg } = generateCaptcha();
    const answer = answerFromMockSvg(svg);
    expect(verifyCaptcha(id, `  ${answer.toUpperCase()}  `)).toBe(true);
  });

  it("is one-shot: the same id cannot be verified twice", () => {
    const { id, svg } = generateCaptcha();
    const answer = answerFromMockSvg(svg);
    expect(verifyCaptcha(id, answer)).toBe(true);
    expect(verifyCaptcha(id, answer)).toBe(false);
  });

  it("deletes the entry even on a wrong attempt (cannot retry)", () => {
    const { id, svg } = generateCaptcha();
    const answer = answerFromMockSvg(svg);
    expect(verifyCaptcha(id, "definitely-wrong")).toBe(false);
    expect(verifyCaptcha(id, answer)).toBe(false);
  });

  it("rejects missing or malformed inputs", () => {
    expect(verifyCaptcha(undefined, "x")).toBe(false);
    expect(verifyCaptcha("nope", "x")).toBe(false);
    const { id } = generateCaptcha();
    expect(verifyCaptcha(id, undefined)).toBe(false);
    expect(verifyCaptcha(id, "")).toBe(false);
  });

  it("rejects expired challenges", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { id, svg } = generateCaptcha();
    const answer = answerFromMockSvg(svg);
    vi.setSystemTime(Date.now() + 4 * 60_000);
    expect(verifyCaptcha(id, answer)).toBe(false);
  });
});

function answerFromMockSvg(svg: string): string {
  const match = svg.match(/data-mock="([^"]+)"/);
  if (!match) {
    throw new Error("mock svg missing data-mock attribute");
  }
  return match[1];
}
