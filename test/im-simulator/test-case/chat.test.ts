import { config } from "dotenv";

config({ override: true });

import path from "node:path";
import { describe, it } from "vitest";
import { runTestFiles } from "../test-runner/index.js";

const SIMULATOR_DIR = path.resolve(
  new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
  "..",
);

describe("test-example", () => {
  it("run test cases", async () => {
    const { errors } = await runTestFiles({
      gatewayUrl: process.env.TEST_GATEWAY_URL ?? "ws://127.0.0.1:18789",
      gatewayToken: process.env.ENCLAWS_GATEWAY_TOKEN ?? "",
      dataDir: process.env.TEST_DATA_DIR ?? path.join(SIMULATOR_DIR, "test-data"),
      csvOutput:
        process.env.TEST_CSV_OUTPUT ??
        path.join(
          SIMULATOR_DIR,
          `test-results/${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`,
        ),
      continueOnFailure: false,
      concurrency: Number(process.env.TEST_CONCURRENCY) || 2,
    });

    if (errors.length > 0) {
      throw new Error(
        `${errors.length} case(s) failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
  }, 300_000);
});
