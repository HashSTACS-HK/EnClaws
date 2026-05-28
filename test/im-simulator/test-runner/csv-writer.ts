import fs from "node:fs";
import path from "node:path";
import type { ResultRow } from "./types.js";

const CSV_HEADER = "File Name,Case Name,Message Input,Expected Output,Actual Output,Result,Duration";
const BOM = "\uFEFF";

function escapeCsv(s: string): string {
  const clean = s.replace(/\r?\n/g, " ").trim();
  if (clean.includes(",") || clean.includes('"')) {
    return `"${clean.replace(/"/g, '""')}"`;
  }
  return clean;
}

function rowToCsvLine(r: ResultRow): string {
  return [
    escapeCsv(r.file),
    escapeCsv(r.name),
    escapeCsv(r.message),
    escapeCsv(r.expected),
    escapeCsv(r.actual),
    r.passed ? "PASS" : "FAIL",
    r.duration,
  ].join(",");
}

export class CsvWriter {
  private filePath: string;
  private initialized = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  append(row: ResultRow): void {
    if (!this.initialized) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, BOM + CSV_HEADER + "\n", "utf-8");
      this.initialized = true;
    }
    fs.appendFileSync(this.filePath, rowToCsvLine(row) + "\n", "utf-8");
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * Merge multiple CSV files into one final CSV.
   * Each source file should have been written by a CsvWriter (with BOM + header).
   * The merged file has one header row followed by all data rows.
   */
  static merge(sources: string[], output: string): void {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const lines: string[] = [BOM + CSV_HEADER];
    for (const src of sources) {
      if (!fs.existsSync(src)) {continue;}
      const content = fs.readFileSync(src, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.replace(/^\uFEFF/, "").trim();
        if (!trimmed || trimmed === CSV_HEADER) {continue;}
        lines.push(trimmed);
      }
      fs.rmSync(src, { force: true });
    }
    fs.writeFileSync(output, lines.join("\n") + "\n", "utf-8");
  }
}
