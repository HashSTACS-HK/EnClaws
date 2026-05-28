import type { TestCaseAssert } from "./types.js";

export function formatAssert(a?: TestCaseAssert): string {
  if (!a) {return "";}
  const parts: string[] = [];
  if (a.contains) {parts.push(`contains:"${a.contains}"`);}
  if (a.notContains) {parts.push(`!contains:"${a.notContains}"`);}
  if (a.matches) {parts.push(`matches:/${a.matches}/`);}
  if (a.minLength != null) {parts.push(`min:${a.minLength}`);}
  if (a.maxLength != null) {parts.push(`max:${a.maxLength}`);}
  return parts.join(", ");
}

export function checkAssertions(text: string, assert?: TestCaseAssert): string[] {
  const failures: string[] = [];
  if (!text) {
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
  }
  return failures;
}
