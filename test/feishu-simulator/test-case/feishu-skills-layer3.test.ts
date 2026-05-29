/**
 * Layer 3 — LLM Quality Evaluation for feishu-skills.
 *
 * Extends Layer 2 (E2E via Feishu API) with LLM-based quality assessment.
 * After receiving the bot's reply, an LLM judge evaluates reply quality
 * based on criteria defined in each test case's `llmEvaluate` field.
 *
 * Prerequisites:
 *   - All Layer 2 prerequisites (Gateway + Lark plugin + permissions)
 *   - LLM_JUDGE_API_KEY environment variable set
 *
 * Usage:
 *   LLM_JUDGE_API_KEY=sk-ant-xxx \
 *   pnpm vitest run test/feishu-simulator/test-case/feishu-skills-layer3.test.ts
 */

import { config } from "dotenv";
config({ override: true });

import path from "node:path";
import { describe, it } from "vitest";
import { runLayer3TestFiles } from "../test-runner/index.js";

const SIMULATOR_DIR = path.resolve(
  new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
  "..",
);

describe("feishu-skills Layer 3 (LLM Judge)", () => {
  it("run test cases", async () => {
    const apiKey = process.env.LLM_JUDGE_API_KEY;
    if (!apiKey) {
      throw new Error("LLM_JUDGE_API_KEY environment variable is required for Layer 3 tests");
    }

    const { errors } = await runLayer3TestFiles({
      dataDir:
        process.env.TEST_DATA_DIR ?? path.join(SIMULATOR_DIR, "test-data/feishu-skills-layer3"),
      csvOutput:
        process.env.TEST_CSV_OUTPUT ??
        path.join(
          SIMULATOR_DIR,
          `test-results/layer3-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`,
        ),
      continueOnFailure: true,
      concurrency: Number(process.env.TEST_CONCURRENCY) || 1,
      replyTimeoutMs: Number(process.env.TEST_REPLY_TIMEOUT) || 120_000,
      pollIntervalMs: Number(process.env.TEST_POLL_INTERVAL) || 2000,
      llmApiKey: apiKey,
      llmProvider: process.env.LLM_JUDGE_PROVIDER ?? "anthropic",
      llmModel: process.env.LLM_JUDGE_MODEL ?? "claude-haiku-4-5-20251001",
      llmBaseUrl: process.env.LLM_JUDGE_BASE_URL,
    });

    if (errors.length > 0) {
      throw new Error(
        `${errors.length} case(s) failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
  }, 1_800_000);
});
