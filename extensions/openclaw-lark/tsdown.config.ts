import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "index.ts" },
  format: "esm",
  target: "node22",
  platform: "node",
  clean: true,
  outDir: "dist",
  dts: true,
  deps: {
    neverBundle: [
      /^openclaw(\/.*)?$/,
      /^@larksuiteoapi\//,
      /^@sinclair\//,
      "image-size",
      "zod",
      /^node:/,
    ],
  },
});
