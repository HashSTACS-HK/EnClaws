import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

export const KNOWLEDGE_TEXT_EXTENSIONS = new Set([".md", ".txt", ".csv"]);
export const KNOWLEDGE_BINARY_EXTENSIONS = new Set([".docx", ".xlsx", ".pdf"]);
export const KNOWLEDGE_FILE_EXTENSIONS = new Set([
  ...KNOWLEDGE_TEXT_EXTENSIONS,
  ...KNOWLEDGE_BINARY_EXTENSIONS,
]);

export type KnowledgeDocumentBlock = {
  id: string;
  type: "paragraph" | "table" | "sheet" | "page";
  text?: string;
  markdown?: string;
  page?: number;
  sheet?: string;
  rowNumber?: number;
  metadata?: Record<string, unknown>;
};

export type KnowledgeDocument = {
  id: string;
  sourcePath: string;
  mimeType: string;
  title?: string;
  pages?: number;
  sheets?: string[];
  blocks: KnowledgeDocumentBlock[];
};

export type KnowledgeTextProjection = {
  text: string;
  document: KnowledgeDocument;
};

export function isKnowledgeFilePath(filePath: string): boolean {
  return KNOWLEDGE_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isEditableKnowledgeTextFile(filePath: string): boolean {
  return KNOWLEDGE_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function normalizeKnowledgeFileName(name: string): string {
  return name.trim().replace(/\\/g, "/");
}

export async function extractKnowledgeText(absPath: string): Promise<KnowledgeTextProjection> {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".md" || ext === ".txt" || ext === ".csv") {
    const text = await fs.readFile(absPath, "utf-8");
    return {
      text,
      document: {
        id: path.basename(absPath),
        sourcePath: absPath,
        mimeType: ext === ".md" ? "text/markdown" : ext === ".csv" ? "text/csv" : "text/plain",
        blocks: [{ id: "text", type: ext === ".csv" ? "table" : "paragraph", text }],
      },
    };
  }
  if (ext === ".docx") {
    return extractDocxText(absPath);
  }
  if (ext === ".xlsx") {
    return extractXlsxText(absPath);
  }
  if (ext === ".pdf") {
    return extractPdfText(absPath);
  }
  return {
    text: "",
    document: {
      id: path.basename(absPath),
      sourcePath: absPath,
      mimeType: "application/octet-stream",
      blocks: [],
    },
  };
}

async function extractDocxText(absPath: string): Promise<KnowledgeTextProjection> {
  const zip = await JSZip.loadAsync(await fs.readFile(absPath));
  const xml = await zip.file("word/document.xml")?.async("string");
  const headingStyles = await readDocxHeadingStyles(zip);
  const blocks: KnowledgeDocumentBlock[] = [];
  if (!xml) {
    return emptyProjection(
      absPath,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  }
  const body = xml.match(/<w:body[\s\S]*?<\/w:body>/)?.[0] ?? xml;
  const markdownParts: string[] = [];
  let paragraphIndex = 0;
  let tableIndex = 0;
  for (const node of body.match(/<w:p\b[\s\S]*?<\/w:p>|<w:tbl\b[\s\S]*?<\/w:tbl>/g) ?? []) {
    if (node.startsWith("<w:tbl")) {
      const rows = parseDocxTableRows(node);
      if (rows.length === 0) {
        continue;
      }
      tableIndex += 1;
      const markdown = [
        `### Table ${tableIndex}`,
        ...rows.map((row) => `| ${row.join(" | ")} |`),
      ].join("\n");
      blocks.push({
        id: `table${tableIndex}`,
        type: "table",
        markdown,
        text: rows.map((row) => row.join(" | ")).join("\n"),
      });
      markdownParts.push(markdown);
      continue;
    }
    const text = extractWordText(node).trim();
    if (!text) {
      continue;
    }
    paragraphIndex += 1;
    const headingLevel = resolveDocxHeadingLevel(node, headingStyles);
    const markdown = headingLevel ? `${"#".repeat(headingLevel)} ${text}` : text;
    blocks.push({
      id: `p${paragraphIndex}`,
      type: "paragraph",
      text,
      markdown,
      ...(headingLevel ? { metadata: { headingLevel } } : {}),
    });
    markdownParts.push(markdown);
  }
  return {
    text: markdownParts.join("\n\n"),
    document: {
      id: path.basename(absPath),
      sourcePath: absPath,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      blocks,
    },
  };
}

async function extractXlsxText(absPath: string): Promise<KnowledgeTextProjection> {
  const zip = await JSZip.loadAsync(await fs.readFile(absPath));
  const sharedStrings = await readSharedStrings(zip);
  const workbookRels = await readWorkbookRels(zip);
  const workbook = await zip.file("xl/workbook.xml")?.async("string");
  const sheets = parseWorkbookSheets(workbook ?? "", workbookRels);
  const blocks: KnowledgeDocumentBlock[] = [];
  const markdownParts: string[] = [];

  for (const sheet of sheets) {
    const sheetXml = await zip.file(sheet.path)?.async("string");
    if (!sheetXml) {
      continue;
    }
    const rows = parseSheetRows(sheetXml, sharedStrings);
    blocks.push({
      id: `sheet:${sheet.name}`,
      type: "sheet",
      sheet: sheet.name,
      text: `${sheet.name}: ${rows.length} rows`,
    });
    markdownParts.push(`## Sheet: ${sheet.name}`);
    const headerByColumn = buildHeaderMap(rows[0]?.cells ?? []);
    for (const row of rows) {
      const line = row.cells
        .filter((cell) => cell.value.trim())
        .map((cell) => {
          const header = headerByColumn.get(cell.column);
          return header ? `${header}(${cell.ref})=${cell.value}` : `${cell.ref}=${cell.value}`;
        })
        .join(" | ");
      if (!line.trim()) {
        continue;
      }
      blocks.push({
        id: `sheet:${sheet.name}:r${row.rowNumber}`,
        type: "table",
        sheet: sheet.name,
        rowNumber: row.rowNumber,
        text: line,
        markdown: line,
      });
      markdownParts.push(`- R${row.rowNumber}: ${line}`);
    }
  }

  return {
    text: markdownParts.join("\n"),
    document: {
      id: path.basename(absPath),
      sourcePath: absPath,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sheets: sheets.map((sheet) => sheet.name),
      blocks,
    },
  };
}

async function extractPdfText(absPath: string): Promise<KnowledgeTextProjection> {
  const data = new Uint8Array(await fs.readFile(absPath));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data, disableWorker: true });
  const pdf = await loadingTask.promise;
  const blocks: KnowledgeDocumentBlock[] = [];
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? String(item.str) : ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      continue;
    }
    blocks.push({ id: `page:${pageNumber}`, type: "page", page: pageNumber, text });
    pages.push(`## Page ${pageNumber}\n\n${text}`);
  }
  return {
    text: pages.join("\n\n"),
    document: {
      id: path.basename(absPath),
      sourcePath: absPath,
      mimeType: "application/pdf",
      pages: pdf.numPages,
      blocks,
    },
  };
}

function emptyProjection(absPath: string, mimeType: string): KnowledgeTextProjection {
  return {
    text: "",
    document: {
      id: path.basename(absPath),
      sourcePath: absPath,
      mimeType,
      blocks: [],
    },
  };
}

function extractWordText(xml: string): string {
  const matches = xml.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) ?? [];
  return matches.map((entry) => decodeXml(entry.replace(/<[^>]+>/g, ""))).join("");
}

async function readDocxHeadingStyles(zip: JSZip): Promise<Map<string, number>> {
  const stylesXml = await zip.file("word/styles.xml")?.async("string");
  const headings = new Map<string, number>();
  for (let level = 1; level <= 6; level += 1) {
    headings.set(`heading${level}`, level);
    headings.set(`Heading${level}`, level);
  }
  if (!stylesXml) {
    return headings;
  }
  for (const style of stylesXml.match(/<w:style\b[\s\S]*?<\/w:style>/g) ?? []) {
    const styleId = readXmlAttr(style, "w:styleId");
    const name = readXmlAttr(style, "w:val") ?? "";
    const match = /heading\s*([1-6])|标题\s*([1-6])/i.exec(`${styleId ?? ""} ${name}`);
    const level = Number(match?.[1] ?? match?.[2]);
    if (styleId && level >= 1 && level <= 6) {
      headings.set(styleId, level);
    }
  }
  return headings;
}

function resolveDocxHeadingLevel(
  paragraphXml: string,
  headingStyles: Map<string, number>,
): number | undefined {
  const pPr = paragraphXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
  const styleMatch = pPr.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/);
  const styleId = styleMatch?.[1] ? decodeXml(styleMatch[1]) : undefined;
  if (!styleId) {
    return undefined;
  }
  return headingStyles.get(styleId);
}

function parseDocxTableRows(tableXml: string): string[][] {
  const rows: string[][] = [];
  for (const rowXml of tableXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []) {
    const row: string[] = [];
    for (const cellXml of rowXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []) {
      row.push(extractWordText(cellXml).replace(/\s+/g, " ").trim());
    }
    if (row.some((cell) => cell.trim())) {
      rows.push(row);
    }
  }
  return rows;
}

async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (!xml) {
    return [];
  }
  const items = xml.match(/<si[\s\S]*?<\/si>/g) ?? [];
  return items.map((item) =>
    decodeXml(
      (item.match(/<t[^>]*>[\s\S]*?<\/t>/g) ?? [])
        .map((text) => text.replace(/<[^>]+>/g, ""))
        .join(""),
    ),
  );
}

async function readWorkbookRels(zip: JSZip): Promise<Map<string, string>> {
  const xml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  const result = new Map<string, string>();
  if (!xml) {
    return result;
  }
  for (const rel of xml.match(/<Relationship\b[^>]*\/>/g) ?? []) {
    const id = readXmlAttr(rel, "Id");
    const target = readXmlAttr(rel, "Target");
    if (id && target) {
      result.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }
  }
  return result;
}

function parseWorkbookSheets(
  workbookXml: string,
  rels: Map<string, string>,
): Array<{ name: string; path: string }> {
  const sheets: Array<{ name: string; path: string }> = [];
  for (const sheet of workbookXml.match(/<sheet\b[^>]*\/>/g) ?? []) {
    const name = readXmlAttr(sheet, "name") ?? "Sheet";
    const relId = readXmlAttr(sheet, "r:id");
    const target = relId ? rels.get(relId) : undefined;
    if (target) {
      sheets.push({ name, path: target });
    }
  }
  return sheets;
}

function parseSheetRows(
  sheetXml: string,
  sharedStrings: string[],
): Array<{ rowNumber: number; cells: Array<{ ref: string; column: string; value: string }> }> {
  const rows: Array<{
    rowNumber: number;
    cells: Array<{ ref: string; column: string; value: string }>;
  }> = [];
  for (const rowXml of sheetXml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
    const rowNumber = Number(readXmlAttr(rowXml, "r")) || rows.length + 1;
    const cells: Array<{ ref: string; column: string; value: string }> = [];
    for (const cellXml of rowXml.match(/<c\b[\s\S]*?<\/c>/g) ?? []) {
      const type = readXmlAttr(cellXml, "t");
      const ref = readXmlAttr(cellXml, "r") ?? `R${rowNumber}C${cells.length + 1}`;
      const column = parseCellColumn(ref) ?? String(cells.length + 1);
      const value = (cellXml.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "").trim();
      let resolved = "";
      if (type === "s") {
        resolved = sharedStrings[Number(value)] ?? "";
      } else if (type === "inlineStr") {
        resolved = decodeXml((cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "").trim());
      } else {
        resolved = decodeXml(value);
      }
      cells.push({ ref, column, value: resolved });
    }
    rows.push({ rowNumber, cells });
  }
  return rows;
}

function buildHeaderMap(cells: Array<{ column: string; value: string }>): Map<string, string> {
  const headers = new Map<string, string>();
  for (const cell of cells) {
    const value = cell.value.trim();
    if (value) {
      headers.set(cell.column, value);
    }
  }
  return headers;
}

function parseCellColumn(ref: string): string | undefined {
  return /^[A-Z]+/i.exec(ref)?.[0]?.toUpperCase();
}

function readXmlAttr(xml: string, attr: string): string | undefined {
  const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`${escaped}="([^"]*)"`));
  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
