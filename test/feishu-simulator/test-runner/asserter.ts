import type { TestCaseAssert, ScriptAssert } from "../types.js";
import type { FeishuReplyMeta } from "../feishu-client.js";

export function formatAssert(a?: TestCaseAssert): string {
  if (!a) {return "";}
  const parts: string[] = [];
  if (a.contains) {parts.push(`contains:"${a.contains}"`);}
  if (a.notContains) {parts.push(`!contains:"${a.notContains}"`);}
  if (a.matches) {parts.push(`matches:/${a.matches}/`);}
  if (a.minLength != null) {parts.push(`min:${a.minLength}`);}
  if (a.maxLength != null) {parts.push(`max:${a.maxLength}`);}
  if (a.msgType) {parts.push(`msgType:${a.msgType}`);}
  if (a.hasFile) {parts.push("hasFile");}
  if (a.hasImage) {parts.push("hasImage");}
  if (a.fileNameMatches) {parts.push(`fileName:/${a.fileNameMatches}/`);}
  if (a.containsAny) {parts.push(`containsAny:[${a.containsAny.map((s) => `"${s}"`).join(",")}]`);}
  if (a.containsAll) {parts.push(`containsAll:[${a.containsAll.map((s) => `"${s}"`).join(",")}]`);}
  if (a.expectNoReply) {parts.push("expectNoReply");}
  return parts.join(", ");
}

export function checkAssertions(text: string, assert?: TestCaseAssert, meta?: FeishuReplyMeta): string[] {
  const failures: string[] = [];

  // Negative assertion: expect the bot to NOT reply
  if (assert?.expectNoReply) {
    if (text || meta?.fileKey || meta?.imageKey) {
      failures.push(`expected no reply but got: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);
    }
    return failures;
  }

  if (!text && !meta?.fileKey && !meta?.imageKey) {
    failures.push("reply is empty");
  }
  if (assert) {
    if (assert.contains && !text.includes(assert.contains)) {
      failures.push(`expected to contain "${assert.contains}"`);
    }
    if (assert.notContains && text.includes(assert.notContains)) {
      failures.push(`expected NOT to contain "${assert.notContains}"`);
    }
    if (assert.matches && !new RegExp(assert.matches).test(text)) {
      failures.push(`expected to match /${assert.matches}/`);
    }
    if (assert.minLength != null && text.length < assert.minLength) {
      failures.push(`length ${text.length} < minLength ${assert.minLength}`);
    }
    if (assert.maxLength != null && text.length > assert.maxLength) {
      failures.push(`length ${text.length} > maxLength ${assert.maxLength}`);
    }
    if (assert.msgType && meta?.msgType !== assert.msgType) {
      failures.push(`expected msgType "${assert.msgType}" but got "${meta?.msgType ?? "unknown"}"`);
    }
    if (assert.hasFile && !meta?.fileKey) {
      failures.push("expected reply to contain a file");
    }
    if (assert.hasImage && !meta?.imageKey) {
      failures.push("expected reply to contain an image");
    }
    if (assert.fileNameMatches && !new RegExp(assert.fileNameMatches).test(meta?.fileName ?? "")) {
      failures.push(`expected fileName to match /${assert.fileNameMatches}/ but got "${meta?.fileName ?? ""}"`);
    }
    if (assert.containsAny && assert.containsAny.length > 0) {
      const found = assert.containsAny.some((s) => text.includes(s));
      if (!found) {
        failures.push(`expected to contain any of [${assert.containsAny.map((s) => `"${s}"`).join(", ")}]`);
      }
    }
    if (assert.containsAll) {
      for (const s of assert.containsAll) {
        if (!text.includes(s)) {
          failures.push(`expected to contain "${s}" (containsAll)`);
        }
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Layer 1: Script output assertions
// ---------------------------------------------------------------------------

export function formatScriptAssert(a?: ScriptAssert): string {
  if (!a) {return "";}
  const parts: string[] = [];
  if (a.exitCode != null) {parts.push(`exitCode:${a.exitCode}`);}
  if (a.stdoutContains) {parts.push(`stdout~"${a.stdoutContains}"`);}
  if (a.stdoutNotContains) {parts.push(`stdout!~"${a.stdoutNotContains}"`);}
  if (a.stderrContains) {parts.push(`stderr~"${a.stderrContains}"`);}
  if (a.jsonPath) {
    for (const [p, rule] of Object.entries(a.jsonPath)) {
      if (rule.equals != null) {parts.push(`$.${p}==${JSON.stringify(rule.equals)}`);}
      if (rule.contains) {parts.push(`$.${p}~"${rule.contains}"`);}
      if (rule.matches) {parts.push(`$.${p}~/${rule.matches}/`);}
      if (rule.notContains) {parts.push(`$.${p}!~"${rule.notContains}"`);}
      if (rule.exists) {parts.push(`$.${p} exists`);}
    }
  }
  return parts.join(", ");
}

export function checkScriptAssertions(
  stdout: string,
  stderr: string,
  exitCode: number,
  assert?: ScriptAssert,
): string[] {
  const failures: string[] = [];
  const expectedExitCode = assert?.exitCode ?? 0;

  if (exitCode !== expectedExitCode) {
    failures.push(`exitCode ${exitCode} !== expected ${expectedExitCode}`);
  }

  if (!assert) {return failures;}

  if (assert.stdoutContains && !stdout.includes(assert.stdoutContains)) {
    failures.push(`stdout does not contain "${assert.stdoutContains}"`);
  }
  if (assert.stdoutNotContains && stdout.includes(assert.stdoutNotContains)) {
    failures.push(`stdout should NOT contain "${assert.stdoutNotContains}"`);
  }
  if (assert.stderrContains && !stderr.includes(assert.stderrContains)) {
    failures.push(`stderr does not contain "${assert.stderrContains}"`);
  }

  if (assert.jsonPath) {
    let json: Record<string, unknown> | null = null;
    try {
      // Parse the last non-empty line as JSON (skill scripts output single-line JSON)
      const lines = stdout.trim().split("\n").filter(Boolean);
      json = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    } catch {
      failures.push("stdout is not valid JSON");
      return failures;
    }

    for (const [dotPath, rule] of Object.entries(assert.jsonPath)) {
      const value = resolveDotPath(json, dotPath);

      if (rule.exists && value === undefined) {
        failures.push(`$.${dotPath} does not exist`);
        continue;
      }
      if (rule.equals !== undefined && value !== rule.equals) {
        failures.push(`$.${dotPath}: ${JSON.stringify(value)} !== ${JSON.stringify(rule.equals)}`);
      }
      if (rule.contains && (typeof value !== "string" || !value.includes(rule.contains))) {
        failures.push(`$.${dotPath}: expected to contain "${rule.contains}", got ${JSON.stringify(value)}`);
      }
      if (rule.matches && (typeof value !== "string" || !new RegExp(rule.matches).test(value))) {
        failures.push(`$.${dotPath}: expected to match /${rule.matches}/, got ${JSON.stringify(value)}`);
      }
      if (rule.notContains && typeof value === "string" && value.includes(rule.notContains)) {
        failures.push(`$.${dotPath}: should NOT contain "${rule.notContains}"`);
      }
    }
  }

  return failures;
}

function resolveDotPath(obj: Record<string, unknown> | null, dotPath: string): unknown {
  if (!obj) {return undefined;}
  const parts = dotPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") {return undefined;}
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
