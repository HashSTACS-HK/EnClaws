import { TestEnv } from "../index.js";
import { loadTestFiles } from "./file-loader.js";
import { CsvWriter } from "./csv-writer.js";
import { formatAssert, checkAssertions } from "./asserter.js";
import type { RunnerOptions, ResultRow, TestFile } from "./types.js";

type FileResult = { results: ResultRow[]; errors: string[] };

export async function runTestFiles(opts: RunnerOptions): Promise<{ results: ResultRow[]; errors: string[] }> {
  const testFiles = loadTestFiles(opts.dataDir);

  if (testFiles.length === 0) {
    console.log(`No test JSON files found in: ${opts.dataDir}`);
    return { results: [], errors: [] };
  }

  const concurrency = opts.concurrency ?? 1;

  if (concurrency <= 1) {
    // Sequential: single CSV, write as we go
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

  // Parallel: each file gets a temp CSV, merge at the end
  const tempCsvPaths: string[] = [];
  const tasks = testFiles.map(({ fileName, data }, idx) => {
    const tempCsv = opts.csvOutput.replace(/\.csv$/, `.part-${idx}.csv`);
    tempCsvPaths.push(tempCsv);
    return { fileName, data, csv: new CsvWriter(tempCsv) };
  });

  const allResults: ResultRow[] = [];
  const allErrors: string[] = [];

  // Run with concurrency limit
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

  // Merge temp CSVs
  CsvWriter.merge(tempCsvPaths, opts.csvOutput);
  console.log(`\nCSV report: ${opts.csvOutput}`);

  return { results: allResults, errors: allErrors };
}

async function runSingleFile(
  fileName: string,
  data: TestFile,
  opts: RunnerOptions,
  csv: CsvWriter,
): Promise<FileResult> {
  const results: ResultRow[] = [];
  const errors: string[] = [];

  console.log(`\n--- ${fileName} ---`);
  const env = new TestEnv({ url: opts.gatewayUrl, gatewayToken: opts.gatewayToken });

  function record(row: ResultRow, error?: string) {
    results.push(row);
    csv.append(row);
    if (error) {errors.push(error);}
  }

  try {
    const loginOk = await tryLogin(env, data, opts);

    if (!loginOk) {
      const errMsg = `Login failed for ${data.email}`;
      for (const tc of data.cases) {
        const label = tc.name ?? tc.message.slice(0, 30);
        record({
          file: fileName, name: label, message: tc.message,
          expected: formatAssert(tc.assert), actual: `ERROR: ${errMsg}`,
          passed: false, duration: "-",
        }, `[${fileName}] "${label}": ${errMsg}`);
      }
      return { results, errors };
    }

    for (const [i, tc] of data.cases.entries()) {
      const label = tc.name ?? tc.message.slice(0, 30);
      let caseFailed = false;

      let reply: Awaited<ReturnType<typeof env.sendAsUser>>;
      try {
        reply = await env.sendAsUser({ agentId: data.agentId, message: tc.message });
      } catch (e) {
        console.log(`  [${i + 1}/${data.cases.length}] FAIL ❌ ${label}`);
        console.log(`    Message: ${tc.message}`);
        console.log(`    Error: ${(e as Error).message}`);
        record({
          file: fileName, name: label, message: tc.message,
          expected: formatAssert(tc.assert), actual: `ERROR: ${(e as Error).message}`,
          passed: false, duration: "-",
        }, `[${fileName}] "${label}": ${(e as Error).message}`);
        if (!opts.continueOnFailure) {break;}
        continue;
      }

      const failures = checkAssertions(reply.text, tc.assert);

      if (failures.length > 0) {
        caseFailed = true;
        console.log(`  [${i + 1}/${data.cases.length}] FAIL ❌ ${label}`);
        console.log(`    Message:  ${tc.message}`);
        console.log(`    Reply:    ${reply.text}`);
        console.log(`    Failures: ${failures.join("; ")}`);
      } else {
        console.log(`  [${i + 1}/${data.cases.length}] PASS ✅ ${label} (${reply.durationMs}ms)`);
        console.log(`    Reply: ${reply.text}`);
      }

      record({
        file: fileName, name: label, message: tc.message,
        expected: formatAssert(tc.assert),
        actual: failures.length > 0 ? failures.join("; ") : reply.text,
        passed: failures.length === 0,
        duration: `${reply.durationMs}ms`,
      }, failures.length > 0 ? `[${fileName}] "${label}": ${failures.join("; ")}` : undefined);

      if (caseFailed && !opts.continueOnFailure) {break;}
    }
  } finally {
    await env.disconnect();
  }

  return { results, errors };
}

async function tryLogin(env: TestEnv, data: TestFile, opts: RunnerOptions): Promise<boolean> {
  try {
    await env.login({ email: data.email, password: data.password });
    return true;
  } catch (loginErr) {
    if (!data.ownerEmail || !data.ownerPassword) {
      console.log(`  Login failed: ${(loginErr as Error).message}`);
      return false;
    }
    console.log(`  User login failed, trying owner invite flow...`);
    const ownerEnv = new TestEnv({ url: opts.gatewayUrl, gatewayToken: opts.gatewayToken });
    try {
      await ownerEnv.login({ email: data.ownerEmail, password: data.ownerPassword });
      await ownerEnv.inviteUser({ email: data.email, password: data.password });
      console.log(`  Invited user: ${data.email}`);
      await env.login({ email: data.email, password: data.password });
      return true;
    } catch (ownerErr) {
      console.log(`  Owner invite failed: ${(ownerErr as Error).message}`);
      return false;
    } finally {
      await ownerEnv.disconnect();
    }
  }
}
