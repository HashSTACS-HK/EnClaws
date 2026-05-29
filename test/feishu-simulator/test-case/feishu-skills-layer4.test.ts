/**
 * Layer 4 — Group chat end-to-end testing for feishu-skills via Feishu API.
 *
 * Sends @bot messages in a group chat, waits for bot replies, and validates
 * with text/file/card assertions. Tests the same skill set as Layer 2 but
 * through group chat context instead of P2P.
 *
 * Prerequisites:
 *   - All Layer 2 prerequisites (Gateway + Lark plugin + permissions)
 *   - Bot must be a member of the target group chat
 *
 * Credentials (env vars take precedence over JSON values; placeholders ignored):
 *   TEST_FEISHU_APP_ID            — Feishu app ID
 *   TEST_FEISHU_APP_SECRET        — Feishu app secret
 *   TEST_FEISHU_USER_OPEN_ID      — User open_id for Device Flow auth
 *   TEST_FEISHU_GROUP_CHAT_ID     — Target group chat_id (oc_xxx)
 *
 * Usage:
 *   TEST_FEISHU_APP_ID=cli_xxx \
 *   TEST_FEISHU_APP_SECRET=xxx \
 *   TEST_FEISHU_USER_OPEN_ID=ou_xxx \
 *   TEST_FEISHU_GROUP_CHAT_ID=oc_xxx \
 *     pnpm vitest run test/feishu-simulator/test-case/feishu-skills-layer4.test.ts
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

describe("feishu-skills Layer 4 (group chat e2e)", () => {
  it("run test cases", async () => {
    const { errors } = await runTestFiles({
      dataDir:
        process.env.TEST_DATA_DIR ?? path.join(SIMULATOR_DIR, "test-data/feishu-skills-layer4"),
      csvOutput:
        process.env.TEST_CSV_OUTPUT ??
        path.join(
          SIMULATOR_DIR,
          `test-results/layer4-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`,
        ),
      continueOnFailure: true,
      concurrency: Number(process.env.TEST_CONCURRENCY) || 1,
      replyTimeoutMs: Number(process.env.TEST_REPLY_TIMEOUT) || 120_000,
      pollIntervalMs: Number(process.env.TEST_POLL_INTERVAL) || 2000,
    });

    if (errors.length > 0) {
      throw new Error(
        `${errors.length} case(s) failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
  }, 1_800_000);
});
