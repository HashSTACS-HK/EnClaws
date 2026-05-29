/**
 * Layer 1 — Script-level testing for feishu-skills.
 *
 * Directly invokes skill scripts (e.g. `node feishu-drive/drive.js --action list ...`)
 * and validates JSON output. No Feishu message sending — only tests the script contract.
 *
 * Prerequisites:
 *   - User token already cached (run feishu-auth first)
 *   - SKILLS_REPO_DIR env var points to feishu-skills repo root
 *
 * Usage:
 *   SKILLS_REPO_DIR=C:/Users/15769/WebstormProjects/feishu-skills \
 *   pnpm vitest run test/feishu-simulator/test-case/feishu-skills-layer1.test.ts
 */

import { config } from "dotenv";
config({ override: true });

import path from "node:path";
import { describe, it } from "vitest";
import { runScriptTestFiles as runLayer1TestFiles } from "../test-runner/index.js";

const SIMULATOR_DIR = path.resolve(
  new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
  "..",
);

const SKILLS_REPO_DIR =
  process.env.SKILLS_REPO_DIR ??
  path.resolve(SIMULATOR_DIR, "../../../../WebstormProjects/feishu-skills");

describe("feishu-skills Layer 1 (script-level)", () => {
  it("run test cases", async () => {
    const { errors } = await runLayer1TestFiles({
      dataDir:
        process.env.TEST_DATA_DIR ?? path.join(SIMULATOR_DIR, "test-data/feishu-skills-layer1"),
      csvOutput:
        process.env.TEST_CSV_OUTPUT ??
        path.join(
          SIMULATOR_DIR,
          `test-results/layer1-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`,
        ),
      continueOnFailure: true,
      concurrency: Number(process.env.TEST_CONCURRENCY) || 1,
      skillsRepoDir: SKILLS_REPO_DIR,
      commandTimeoutMs: Number(process.env.TEST_COMMAND_TIMEOUT) || 30_000,
    });

    if (errors.length > 0) {
      throw new Error(
        `${errors.length} case(s) failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
  }, 600_000);
});
