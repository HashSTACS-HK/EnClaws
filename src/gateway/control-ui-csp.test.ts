import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildControlUiCspHeader } from "./control-ui-csp.js";

describe("buildControlUiCspHeader", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.AGENORA_FRAME_ANCESTORS;
    delete process.env.AGENORA_FRAME_ANCESTORS;
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENORA_FRAME_ANCESTORS;
    } else {
      process.env.AGENORA_FRAME_ANCESTORS = originalEnv;
    }
  });

  it("blocks inline scripts while allowing inline styles", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("allows Google Fonts for style and font loading", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: https:");
    expect(csp).toContain("font-src 'self'");
  });

  it("defaults frame-ancestors to 'self' + jiumi prod + local dev when env unset", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain(
      "frame-ancestors 'self' https://jiumi-demo.enclaws.com http://localhost:5001",
    );
  });

  it("uses AGENORA_FRAME_ANCESTORS env var when set (comma-separated)", () => {
    process.env.AGENORA_FRAME_ANCESTORS = "'self', https://a.example.com, https://b.example.com";
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("frame-ancestors 'self' https://a.example.com https://b.example.com");
  });
});
