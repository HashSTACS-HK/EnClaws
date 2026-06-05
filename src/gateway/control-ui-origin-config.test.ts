import { describe, expect, it } from "vitest";
import { resolveControlUiOriginConfig } from "./control-ui-origin-config.js";

describe("resolveControlUiOriginConfig", () => {
  it("keeps runtime allowed origins when present", () => {
    const resolved = resolveControlUiOriginConfig(
      { allowedOrigins: ["https://runtime.example.com"] },
      () => ({ allowedOrigins: ["https://file.example.com"] }),
    );

    expect(resolved?.allowedOrigins).toEqual(["https://runtime.example.com"]);
  });

  it("falls back to file allowed origins when runtime origins are empty", () => {
    const resolved = resolveControlUiOriginConfig(
      { allowedOrigins: [] },
      () => ({ allowedOrigins: ["https://70320ef0.r27.cpolar.top", "   "] }),
    );

    expect(resolved?.allowedOrigins).toEqual(["https://70320ef0.r27.cpolar.top"]);
  });

  it("keeps runtime config when file config cannot be read", () => {
    const resolved = resolveControlUiOriginConfig({ allowedOrigins: [] }, () => {
      throw new Error("read failed");
    });

    expect(resolved).toEqual({ allowedOrigins: [] });
  });
});
