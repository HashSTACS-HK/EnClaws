/**
 * Layer 2 — End-to-end testing for feishu-skills via Feishu API.
 *
 * Sends natural language messages through Feishu IM API to the bot,
 * waits for replies, and validates with text/file/card assertions.
 *
 * Prerequisites:
 *   - EnClaws Gateway running with Lark plugin connected
 *   - Feishu app has im:message + im:message.send_as_user permissions
 *   - User authorization completed (or will be prompted via Device Flow)
 *
 * Credentials (env vars take precedence over JSON values; placeholders like cli_xxx ignored):
 *   TEST_FEISHU_APP_ID         — Feishu app ID
 *   TEST_FEISHU_APP_SECRET     — Feishu app secret
 *   TEST_FEISHU_USER_OPEN_ID   — User open_id for Device Flow auth
 *
 * Usage:
 *   TEST_FEISHU_APP_ID=cli_xxx \
 *   TEST_FEISHU_APP_SECRET=xxx \
 *   TEST_FEISHU_USER_OPEN_ID=ou_xxx \
 *     pnpm vitest run test/feishu-simulator/test-case/feishu-skills-layer2.test.ts
 *
 * Or place the same vars in test/.env (loaded automatically via dotenv).
 */

import { config } from "dotenv";
config({ override: true });

import path from "node:path";
import { describe, it } from "vitest";
import { runTestFiles } from "../test-runner/index.js";

const SIMULATOR_DIR = path.resolve(
  new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
  "..",
);

describe("feishu-skills Layer 2 (e2e)", () => {
  it("run test cases", async () => {
    const { errors } = await runTestFiles({
      dataDir:
        process.env.TEST_DATA_DIR ?? path.join(SIMULATOR_DIR, "test-data/feishu-skills-layer2"),
      csvOutput:
        process.env.TEST_CSV_OUTPUT ??
        path.join(
          SIMULATOR_DIR,
          `test-results/layer2-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`,
        ),
      continueOnFailure: true,
      concurrency: Number(process.env.TEST_CONCURRENCY) || 1,
      replyTimeoutMs: Number(process.env.TEST_REPLY_TIMEOUT) || 120_000000,
      pollIntervalMs: Number(process.env.TEST_POLL_INTERVAL) || 2000,
    });

    if (errors.length > 0) {
      throw new Error(
        `${errors.length} case(s) failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
  }, 1_800_0000);
});
