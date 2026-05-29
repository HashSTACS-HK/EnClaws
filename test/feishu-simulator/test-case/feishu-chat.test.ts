import { config } from "dotenv";
config({ override: true });

import path from "node:path";
import { describe, it } from "vitest";
import { runTestFiles } from "../test-runner/index.js";

const SIMULATOR_DIR = path.resolve(
  new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
  "..",
);

describe("feishu-chat (e2e)", () => {
  it("run test cases", async () => {
    const { errors } = await runTestFiles({
      dataDir: process.env.TEST_DATA_DIR ?? path.join(SIMULATOR_DIR, "test-data"),
      csvOutput:
        process.env.TEST_CSV_OUTPUT ??
        path.join(
          SIMULATOR_DIR,
          `test-results/${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`,
        ),
      continueOnFailure: true,
      concurrency: Number(process.env.TEST_CONCURRENCY) || 2,
      replyTimeoutMs: Number(process.env.TEST_REPLY_TIMEOUT) || 60_000,
      pollIntervalMs: Number(process.env.TEST_POLL_INTERVAL) || 1000,
    });

    if (errors.length > 0) {
      throw new Error(
        `${errors.length} case(s) failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
  }, 600_000);
});
