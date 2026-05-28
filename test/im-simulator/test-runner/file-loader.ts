import fs from "node:fs";
import path from "node:path";
import type { TestFile } from "./types.js";

export function loadTestFiles(dir: string, prefix = ""): Array<{ fileName: string; data: TestFile }> {
  if (!fs.existsSync(dir)) {return [];}
  const results: Array<{ fileName: string; data: TestFile }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...loadTestFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".json")) {
      const raw = fs.readFileSync(path.join(dir, entry.name), "utf-8");
      results.push({ fileName: rel, data: JSON.parse(raw) as TestFile });
    }
  }
  return results.toSorted((a, b) => a.fileName.localeCompare(b.fileName));
}
