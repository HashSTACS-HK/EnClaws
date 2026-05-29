import { FeishuTestClient } from "../feishu-client.js";
import type {
  RunnerOptions,
  ResultRow,
  TestFile,
  TestCaseWithJudge,
  LlmJudgeConfig,
} from "../types.js";
import { formatAssert, checkAssertions } from "./asserter.js";
import { CsvWriter } from "./csv-writer.js";
import { loadTestFiles } from "./file-loader.js";
import { evaluateReply } from "./llm-judge.js";

type FileResult = { results: ResultRow[]; errors: string[] };

export async function runTestFiles(
  opts: RunnerOptions & { llmJudge?: LlmJudgeConfig },
): Promise<{ results: ResultRow[]; errors: string[] }> {
  const testFiles = loadTestFiles(opts.dataDir);

  if (testFiles.length === 0) {
    console.log(`No test JSON files found in: ${opts.dataDir}`);
    return { results: [], errors: [] };
  }

  const concurrency = opts.concurrency ?? 1;

  if (concurrency <= 1) {
    const csv = new CsvWriter(opts.csvOutput);
    const allResults: ResultRow[] = [];
    const allErrors: string[] = [];

    for (const { fileName, data } of testFiles) {
      const { results, errors } = await runSingleFile(fileName, data, opts, csv);
      allResults.push(...results);
      allErrors.push(...errors);
    }

    console.log(`\nCSV report: ${csv.path}`);
    return { results: allResults, errors: allErrors };
  }

  // Parallel
  const tempCsvPaths: string[] = [];
  const tasks = testFiles.map(({ fileName, data }, idx) => {
    const tempCsv = opts.csvOutput.replace(/\.csv$/, `.part-${idx}.csv`);
    tempCsvPaths.push(tempCsv);
    return { fileName, data, csv: new CsvWriter(tempCsv) };
  });

  const allResults: ResultRow[] = [];
  const allErrors: string[] = [];

  let cursor = 0;
  while (cursor < tasks.length) {
    const batch = tasks.slice(cursor, cursor + concurrency);
    const batchResults = await Promise.all(
      batch.map(({ fileName, data, csv }) => runSingleFile(fileName, data, opts, csv)),
    );
    for (const { results, errors } of batchResults) {
      allResults.push(...results);
      allErrors.push(...errors);
    }
    cursor += concurrency;
  }

  CsvWriter.merge(tempCsvPaths, opts.csvOutput);
  console.log(`\nCSV report: ${opts.csvOutput}`);

  return { results: allResults, errors: allErrors };
}

// Re-export for convenience so callers don't need a separate import
export type { LlmJudgeConfig };

/**
 * Layer 3 wrapper — delegates to runTestFiles with LLM judge enabled.
 * Accepts flat llm* options (layer3 test entry style) and converts to llmJudge config.
 */
export async function runLayer3TestFiles(
  opts: RunnerOptions & {
    llmApiKey: string;
    llmProvider?: string;
    llmModel?: string;
    llmBaseUrl?: string;
  },
): Promise<{ results: ResultRow[]; errors: string[] }> {
  const { llmApiKey, llmProvider, llmModel, llmBaseUrl, ...runnerOpts } = opts;
  return runTestFiles({
    ...runnerOpts,
    llmJudge: {
      provider: (llmProvider as "anthropic" | "openai") ?? "anthropic",
      model: llmModel ?? "claude-haiku-4-5-20251001",
      apiKey: llmApiKey,
      baseUrl: llmBaseUrl,
    },
  });
}

/**
 * Resolve a credential field, preferring env var over the JSON value.
 * Detects common placeholder values (cli_xxx, xxx, ou_xxx, empty) as "missing".
 */
function resolveCredential(jsonValue: string | undefined, envVar: string): string | undefined {
  const isPlaceholder = (v?: string): boolean => {
    if (!v) {
      return true;
    }
    const trimmed = v.trim();
    if (!trimmed) {
      return true;
    }
    return (
      trimmed === "xxx" ||
      trimmed === "cli_xxx" ||
      trimmed === "ou_xxx" ||
      trimmed === "oc_xxx" ||
      trimmed.startsWith("oc_xxxxxxxx") ||
      /^x+$/i.test(trimmed)
    );
  };
  // Env var always wins if it's set
  const envValue = process.env[envVar];
  if (envValue && !isPlaceholder(envValue)) {
    return envValue;
  }
  // Otherwise, fall back to JSON value if it's not a placeholder
  if (!isPlaceholder(jsonValue)) {
    return jsonValue;
  }
  return undefined;
}

async function runSingleFile(
  fileName: string,
  data: TestFile,
  opts: RunnerOptions & { llmJudge?: LlmJudgeConfig },
  csv: CsvWriter,
): Promise<FileResult> {
  const results: ResultRow[] = [];
  const errors: string[] = [];

  console.log(`\n--- ${fileName} ---`);

  function record(row: ResultRow, error?: string) {
    results.push(row);
    csv.append(row);
    if (error) {
      errors.push(error);
    }
  }

  // Resolve credentials: env vars take precedence, JSON values are fallback.
  // Placeholder values (cli_xxx, xxx, ou_xxx) are treated as missing.
  const appId = resolveCredential(data.appId, "TEST_FEISHU_APP_ID");
  const appSecret = resolveCredential(data.appSecret, "TEST_FEISHU_APP_SECRET");
  const userOpenId = resolveCredential(data.userOpenId, "TEST_FEISHU_USER_OPEN_ID");
  const chatId = resolveCredential(data.chatId, "TEST_FEISHU_GROUP_CHAT_ID");

  if (!appId || !appSecret || !userOpenId) {
    const missing = [
      !appId && "appId (TEST_FEISHU_APP_ID)",
      !appSecret && "appSecret (TEST_FEISHU_APP_SECRET)",
      !userOpenId && "userOpenId (TEST_FEISHU_USER_OPEN_ID)",
    ]
      .filter(Boolean)
      .join(", ");
    const errMsg = `Missing credentials: ${missing}. Set in JSON file or via env vars.`;
    console.log(`  ${errMsg}`);
    for (const tc of data.cases) {
      const label = tc.name ?? tc.message.slice(0, 30);
      record(
        {
          file: fileName,
          name: label,
          message: tc.message,
          expected: formatAssert(tc.assert),
          actual: "",
          failures: `ERROR: ${errMsg}`,
          passed: false,
          duration: "-",
        },
        `[${fileName}] "${label}": ${errMsg}`,
      );
    }
    return { results, errors };
  }

  const client = new FeishuTestClient({
    appId,
    appSecret,
    userOpenId,
    replyTimeoutMs: opts.replyTimeoutMs,
    pollIntervalMs: opts.pollIntervalMs,
    chatId,
  });

  if (data.chatName) {
    console.log(`  Group: ${data.chatName} (${chatId})`);
  }

  try {
    await client.init();
  } catch (e) {
    const errMsg = `Init failed: ${(e as Error).message}`;
    console.log(`  ${errMsg}`);
    for (const tc of data.cases) {
      const label = tc.name ?? tc.message.slice(0, 30);
      record(
        {
          file: fileName,
          name: label,
          message: tc.message,
          expected: formatAssert(tc.assert),
          actual: "",
          failures: `ERROR: ${errMsg}`,
          passed: false,
          duration: "-",
        },
        `[${fileName}] "${label}": ${errMsg}`,
      );
    }
    return { results, errors };
  }

  for (const [i, tc] of data.cases.entries()) {
    const label = tc.name ?? tc.message.slice(0, 30);
    let caseFailed = false;

    let reply: Awaited<ReturnType<typeof client.send>>;
    try {
      reply = await client.send(tc.message, { mentionBot: tc.mentionBot });
    } catch (e) {
      console.log(`  [${i + 1}/${data.cases.length}] FAIL ❌ ${label}`);
      console.log(`    Message: ${tc.message}`);
      console.log(`    Error: ${(e as Error).message}`);
      record(
        {
          file: fileName,
          name: label,
          message: tc.message,
          expected: formatAssert(tc.assert),
          actual: "",
          failures: `ERROR: ${(e as Error).message}`,
          passed: false,
          duration: "-",
        },
        `[${fileName}] "${label}": ${(e as Error).message}`,
      );
      if (!opts.continueOnFailure) {
        break;
      }
      continue;
    }

    const failures = checkAssertions(reply.text, tc.assert, reply.reply);

    // Layer 3: LLM-as-Judge evaluation (if configured and test case has llmJudge)
    const tcWithJudge = tc as TestCaseWithJudge;
    let judgeInfo = "";
    if (tcWithJudge.llmJudge && opts.llmJudge) {
      try {
        const judgeResult = await evaluateReply(
          opts.llmJudge,
          tc.message,
          reply.text,
          tcWithJudge.llmJudge,
        );
        const judgeDetails = judgeResult.criteriaResults
          .map((c) => `${c.passed ? "✅" : "❌"} ${c.criterion}: ${c.reason}`)
          .join("\n      ");
        judgeInfo = `\n    [LLM Judge] score=${(judgeResult.score * 100).toFixed(0)}% ${judgeResult.passed ? "PASS" : "FAIL"}\n      ${judgeDetails}`;

        if (!judgeResult.passed) {
          failures.push(
            `LLM Judge: score ${(judgeResult.score * 100).toFixed(0)}% < threshold ${((tcWithJudge.llmJudge.passThreshold ?? 0.75) * 100).toFixed(0)}%`,
          );
        }
      } catch (e) {
        console.log(`    [LLM Judge] Error: ${(e as Error).message}`);
        // Judge failure is non-blocking — don't add to failures
      }
    }

    if (failures.length > 0) {
      caseFailed = true;
      console.log(`  [${i + 1}/${data.cases.length}] FAIL ❌ ${label}`);
      console.log(`    Message:  ${tc.message}`);
      console.log(`    Reply:    ${reply.text}`);
      console.log(`    Failures: ${failures.join("; ")}${judgeInfo}`);
    } else {
      console.log(`  [${i + 1}/${data.cases.length}] PASS ✅ ${label} (${reply.durationMs}ms)`);
      console.log(`    Reply: ${reply.text}${judgeInfo}`);
    }

    record(
      {
        file: fileName,
        name: label,
        message: tc.message,
        expected: formatAssert(tc.assert),
        actual: reply.text,
        failures: failures.length > 0 ? failures.join("; ") : "",
        passed: failures.length === 0,
        duration: `${reply.durationMs}ms`,
      },
      failures.length > 0 ? `[${fileName}] "${label}": ${failures.join("; ")}` : undefined,
    );

    if (caseFailed && !opts.continueOnFailure) {
      break;
    }
  }

  return { results, errors };
}
