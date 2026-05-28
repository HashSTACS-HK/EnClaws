import fs from "node:fs";
import path from "node:path";
import type { TestFile } from "../types.js";

export function loadTestFiles(dirOrFile: string, prefix = ""): Array<{ fileName: string; data: TestFile }> {
  if (!fs.existsSync(dirOrFile)) {return [];}
  // Support passing a single .json file directly
  if (!prefix && fs.statSync(dirOrFile).isFile() && dirOrFile.endsWith(".json")) {
    const raw = fs.readFileSync(dirOrFile, "utf-8");
    return [{ fileName: path.basename(dirOrFile), data: JSON.parse(raw) as TestFile }];
  }
  const results: Array<{ fileName: string; data: TestFile }> = [];
  for (const entry of fs.readdirSync(dirOrFile, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...loadTestFiles(path.join(dirOrFile, entry.name), rel));
    } else if (entry.name.endsWith(".json")) {
      const raw = fs.readFileSync(path.join(dirOrFile, entry.name), "utf-8");
      results.push({ fileName: rel, data: JSON.parse(raw) as TestFile });
    }
  }
  return results.toSorted((a, b) => a.fileName.localeCompare(b.fileName));
}
