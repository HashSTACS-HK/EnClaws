/**
 * Layer 1: Script-level test runner.
 *
 * Executes skill scripts directly (e.g. `node create-doc.js --open-id ...`)
 * and asserts on the JSON output, exit code, and stdout/stderr content.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ScriptTestFile, ScriptTestCase, ScriptResultRow } from "../types.js";
import { formatScriptAssert, checkScriptAssertions } from "./asserter.js";
import { CsvWriter } from "./csv-writer.js";

export type ScriptRunnerOptions = {
  dataDir: string;
  csvOutput: string;
  continueOnFailure: boolean;
  /** Timeout per command in ms (default: 30000) */
  commandTimeoutMs?: number;
};

type ExecResult = { stdout: string; stderr: string; exitCode: number };

function execCommand(
  cmd: string,
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const parts = parseCommand(cmd);
    const [bin, ...args] = parts;

    execFile(
      bin,
      args,
      {
        cwd,
        env: { ...process.env, ...env },
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        shell: true,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          exitCode: error?.code != null ? (typeof error.code === "number" ? error.code : 1) : 0,
        });
      },
    );
  });
}

/** Simple command parser that respects quotes */
function parseCommand(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (const ch of cmd) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        parts.push(current);
      }
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

export function loadScriptTestFiles(
  dir: string,
  prefix = "",
): Array<{ fileName: string; data: ScriptTestFile }> {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const results: Array<{ fileName: string; data: ScriptTestFile }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...loadScriptTestFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".json")) {
      const raw = fs.readFileSync(path.join(dir, entry.name), "utf-8");
      results.push({ fileName: rel, data: JSON.parse(raw) as ScriptTestFile });
    }
  }
  return results.toSorted((a, b) => a.fileName.localeCompare(b.fileName));
}

export async function runScriptTestFiles(
  opts: ScriptRunnerOptions,
): Promise<{ results: ScriptResultRow[]; errors: string[] }> {
  const testFiles = loadScriptTestFiles(opts.dataDir);
  if (testFiles.length === 0) {
    console.log(`No script test JSON files found in: ${opts.dataDir}`);
    return { results: [], errors: [] };
  }

  const csv = new CsvWriter(opts.csvOutput);
  const allResults: ScriptResultRow[] = [];
  const allErrors: string[] = [];

  for (const { fileName, data } of testFiles) {
    const { results, errors } = await runSingleScriptFile(fileName, data, opts, csv);
    allResults.push(...results);
    allErrors.push(...errors);
  }

  console.log(`\nCSV report: ${csv.path}`);
  return { results: allResults, errors: allErrors };
}

async function runSingleScriptFile(
  fileName: string,
  data: ScriptTestFile,
  opts: ScriptRunnerOptions,
  csv: CsvWriter,
): Promise<{ results: ScriptResultRow[]; errors: string[] }> {
  const results: ScriptResultRow[] = [];
  const errors: string[] = [];
  const timeoutMs = opts.commandTimeoutMs ?? 30_000;
  const env = data.env ?? {};
  const vars = data.vars ?? {};
  const cwd = data.skillsDir;

  console.log(`\n--- [Layer1] ${fileName} ---`);

  if (!fs.existsSync(cwd)) {
    const errMsg = `skillsDir not found: ${cwd}`;
    console.log(`  ERROR: ${errMsg}`);
    for (const tc of data.cases) {
      const row: ScriptResultRow = {
        file: fileName,
        name: tc.name,
        message: tc.command,
        expected: formatScriptAssert(tc.assert),
        actual: "",
        failures: `ERROR: ${errMsg}`,
        passed: false,
        duration: "-",
      };
      results.push(row);
      csv.append(row);
      errors.push(`[${fileName}] "${tc.name}": ${errMsg}`);
    }
    return { results, errors };
  }

  for (const [i, tc] of data.cases.entries()) {
    const command = applyTemplate(tc.command, vars);
    const startedAt = Date.now();

    const exec = await execCommand(command, env, cwd, timeoutMs);
    const durationMs = Date.now() - startedAt;

    const failures = checkScriptAssertions(exec.stdout, exec.stderr, exec.exitCode, tc.assert);

    const passed = failures.length === 0;
    const row: ScriptResultRow = {
      file: fileName,
      name: tc.name,
      message: command,
      expected: formatScriptAssert(tc.assert),
      actual: exec.stdout.trim().slice(0, 500),
      failures: passed ? "" : failures.join("; "),
      passed,
      duration: `${durationMs}ms`,
      exitCode: exec.exitCode,
      stdout: exec.stdout,
      stderr: exec.stderr,
    };

    results.push(row);
    csv.append(row);

    if (passed) {
      console.log(`  [${i + 1}/${data.cases.length}] PASS \u2705 ${tc.name} (${durationMs}ms)`);
    } else {
      console.log(`  [${i + 1}/${data.cases.length}] FAIL \u274C ${tc.name}`);
      console.log(`    Command:  ${command}`);
      console.log(`    Failures: ${failures.join("; ")}`);
      if (exec.stderr) {
        console.log(`    Stderr:   ${exec.stderr.slice(0, 200)}`);
      }
      errors.push(`[${fileName}] "${tc.name}": ${failures.join("; ")}`);
      if (!opts.continueOnFailure) {
        break;
      }
    }

    // Run cleanup command if provided
    if (tc.cleanup) {
      try {
        // Build result vars from stdout JSON for template substitution
        const resultVars: Record<string, string> = { ...vars };
        try {
          const lines = exec.stdout.trim().split("\n").filter(Boolean);
          const json = JSON.parse(lines[lines.length - 1]);
          for (const [k, v] of Object.entries(json)) {
            if (typeof v === "string" || typeof v === "number") {
              resultVars[`result.${k}`] = String(v);
            }
          }
        } catch {
          /* stdout not JSON, skip result vars */
        }

        const cleanupCmd = applyTemplate(tc.cleanup, resultVars);
        console.log(`    Cleanup: ${cleanupCmd}`);
        await execCommand(cleanupCmd, env, cwd, timeoutMs);
      } catch (e) {
        console.log(`    Cleanup failed: ${(e as Error).message}`);
      }
    }
  }

  return { results, errors };
}
