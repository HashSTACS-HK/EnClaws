import type {
  MemoryProgressiveBlock,
  MemoryProgressiveRouteMatch,
  MemoryProgressiveSection,
} from "./types.js";

type Heading = {
  id: string;
  title: string;
  level: number;
  lineNo: number;
  parentId?: string;
  titlePath: string[];
};

export function outlineMarkdown(
  content: string,
  options?: { maxSections?: number; previewChars?: number },
): MemoryProgressiveSection[] {
  return parseMarkdownProgressive(content, options).sections;
}

export function parseMarkdownProgressive(
  content: string,
  options?: {
    maxSections?: number;
    previewChars?: number;
    maxBlockChars?: number;
  },
): { sections: MemoryProgressiveSection[]; blocks: MemoryProgressiveBlock[] } {
  const lines = content.split("\n");
  const headings: Heading[] = [];
  const stack: Heading[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const title = match[2]?.trim();
    if (!title) {
      continue;
    }
    const level = match[1]?.length ?? 1;
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) {
      stack.pop();
    }
    const parent = stack.at(-1);
    const heading: Heading = {
      id: `s${headings.length + 1}`,
      title,
      level,
      lineNo: i + 1,
      ...(parent ? { parentId: parent.id } : {}),
      titlePath: [...(parent?.titlePath ?? []), title],
    };
    headings.push(heading);
    stack.push(heading);
  }

  if (headings.length === 0) {
    const preview = lines
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, options?.previewChars ?? 240);
    const sections: MemoryProgressiveSection[] = preview
      ? [
          {
            id: "s1",
            title: "Document",
            level: 1,
            startLine: 1,
            endLine: Math.max(1, lines.length),
            preview,
            summary: preview,
            keywords: extractKeywords(preview),
            titlePath: ["Document"],
          },
        ]
      : [];
    return {
      sections,
      blocks: sections.length
        ? buildBlocks({
            lines,
            section: sections[0],
            maxBlockChars: options?.maxBlockChars,
          })
        : [],
    };
  }

  const maxSections = Math.max(1, options?.maxSections ?? 80);
  const previewChars = Math.max(40, options?.previewChars ?? 240);
  const sections: MemoryProgressiveSection[] = [];
  for (let i = 0; i < headings.length && sections.length < maxSections; i += 1) {
    const heading = headings[i];
    const next = headings[i + 1];
    if (!heading) {
      continue;
    }
    const startLine = heading.lineNo;
    const endLine = (next?.lineNo ?? lines.length + 1) - 1;
    const bodyPreview = lines
      .slice(startLine, endLine)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .join(" ")
      .slice(0, previewChars);
    const summary = summarizeText(bodyPreview || heading.title, previewChars);
    sections.push({
      id: heading.id,
      title: heading.title,
      level: heading.level,
      startLine,
      endLine: Math.max(startLine, endLine),
      preview: bodyPreview,
      summary,
      keywords: extractKeywords(`${heading.title} ${summary}`),
      titlePath: heading.titlePath,
      ...(heading.parentId ? { parentId: heading.parentId } : {}),
    });
  }
  return {
    sections,
    blocks: sections.flatMap((section) =>
      buildBlocks({ lines, section, maxBlockChars: options?.maxBlockChars }),
    ),
  };
}

export function routeMarkdownProgressive(
  content: string,
  query: string,
  options?: {
    maxResults?: number;
    maxBlocksPerSection?: number;
    previewChars?: number;
    maxBlockChars?: number;
  },
): MemoryProgressiveRouteMatch[] {
  const maxResults = Math.max(1, options?.maxResults ?? 6);
  const maxBlocksPerSection = Math.max(0, options?.maxBlocksPerSection ?? 3);
  const parsed = parseMarkdownProgressive(content, {
    previewChars: options?.previewChars,
    maxBlockChars: options?.maxBlockChars,
  });
  return routeProgressiveIndex(parsed, query, { maxResults, maxBlocksPerSection });
}

export function routeProgressiveIndex(
  parsed: {
    sections: MemoryProgressiveSection[];
    blocks: MemoryProgressiveBlock[];
  },
  query: string,
  options?: {
    maxResults?: number;
    maxBlocksPerSection?: number;
  },
): MemoryProgressiveRouteMatch[] {
  const maxResults = Math.max(1, options?.maxResults ?? 6);
  const maxBlocksPerSection = Math.max(0, options?.maxBlocksPerSection ?? 3);
  const queryTerms = extractQueryTerms(query);
  if (queryTerms.length === 0) {
    return [];
  }
  const scored = parsed.sections
    .map((section) => {
      const sectionText = `${section.title} ${section.summary} ${section.keywords.join(" ")}`;
      const sectionScore = scoreText(
        sectionText,
        queryTerms,
        {
          title: section.title,
          keywords: section.keywords,
        },
      );
      const blocks = parsed.blocks
        .filter((block) => block.sectionId === section.id)
        .map((block) => ({
          block,
          text: `${block.preview} ${block.keywords.join(" ")}`,
          score: scoreText(`${block.preview} ${block.keywords.join(" ")}`, queryTerms, {
            keywords: block.keywords,
          }),
        }))
        .filter((entry) => entry.score > 0)
        .toSorted((a, b) => b.score - a.score)
        .slice(0, maxBlocksPerSection);
      const blockScore = blocks.reduce((sum, entry) => sum + entry.score, 0);
      const matchedTerms = collectMatchedTerms(
        `${sectionText} ${blocks.map((entry) => entry.text).join(" ")}`,
        queryTerms,
      );
      return {
        section,
        blocks: blocks.map((entry) => entry.block),
        score: sectionScore + blockScore,
        matchedTerms,
      };
    })
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return scored.map((entry) => ({
    section: entry.section,
    blocks: entry.blocks,
    score: entry.score,
    matchedTerms: entry.matchedTerms,
    why: formatRouteReason(entry.matchedTerms, entry.section),
    recommendedRead: buildRecommendedRead(entry.section, entry.blocks),
  }));
}

function buildRecommendedRead(
  section: MemoryProgressiveSection,
  blocks: MemoryProgressiveBlock[],
): { from: number; lines: number } {
  const firstBlock = blocks[0];
  const startLine = firstBlock?.startLine ?? section.startLine;
  const endLine = firstBlock?.endLine ?? Math.min(section.endLine, startLine + 79);
  return {
    from: Math.max(1, startLine),
    lines: Math.max(1, Math.min(120, endLine - startLine + 1)),
  };
}

function formatRouteReason(terms: string[], section: MemoryProgressiveSection): string {
  const title = section.titlePath.join(" > ") || section.title;
  if (terms.length === 0) {
    return `Matched section: ${title}`;
  }
  return `Matched section: ${title}; terms: ${terms.slice(0, 8).join(", ")}`;
}

function buildBlocks(params: {
  lines: string[];
  section: MemoryProgressiveSection;
  maxBlockChars?: number;
}): MemoryProgressiveBlock[] {
  const maxBlockChars = Math.max(200, params.maxBlockChars ?? 1600);
  const blocks: MemoryProgressiveBlock[] = [];
  let current: Array<{ line: string; lineNo: number }> = [];

  const flush = () => {
    const text = current.map((entry) => entry.line).join("\n").trim();
    if (!text) {
      current = [];
      return;
    }
    const first = current[0];
    const last = current.at(-1);
    if (!first || !last) {
      current = [];
      return;
    }
    const preview = summarizeText(text, 360);
    blocks.push({
      id: `${params.section.id}:b${blocks.length + 1}`,
      sectionId: params.section.id,
      titlePath: params.section.titlePath,
      startLine: first.lineNo,
      endLine: last.lineNo,
      preview,
      keywords: extractKeywords(`${params.section.title} ${preview}`),
    });
    current = [];
  };

  const bodyStart = params.section.title === "Document" ? params.section.startLine : params.section.startLine + 1;
  for (let i = bodyStart; i <= params.section.endLine; i += 1) {
    const line = params.lines[i - 1] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (trimmed.startsWith("#")) {
      continue;
    }
    const currentChars = current.reduce((sum, entry) => sum + entry.line.length + 1, 0);
    if (current.length > 0 && currentChars + line.length > maxBlockChars) {
      flush();
    }
    current.push({ line, lineNo: i });
  }
  flush();
  return blocks;
}

function summarizeText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(0, maxChars).trimEnd();
}

function extractQueryTerms(text: string): string[] {
  return extractKeywords(text, { includeShortAscii: true, maxKeywords: 24 });
}

function extractKeywords(
  text: string,
  options?: { includeShortAscii?: boolean; maxKeywords?: number },
): string[] {
  const maxKeywords = Math.max(1, options?.maxKeywords ?? 16);
  const normalized = text.toLowerCase();
  const terms = new Map<string, number>();
  const matches = normalized.match(/[\p{Script=Han}]+|[a-z0-9][a-z0-9_-]*/gu) ?? [];
  for (const raw of matches) {
    const token = raw.trim();
    if (!token || STOP_WORDS.has(token)) {
      continue;
    }
    if (/^[a-z0-9_-]+$/.test(token)) {
      if (!options?.includeShortAscii && token.length < 3) {
        continue;
      }
      terms.set(token, (terms.get(token) ?? 0) + 1);
      continue;
    }
    if (token.length <= 4) {
      terms.set(token, (terms.get(token) ?? 0) + 2);
      continue;
    }
    for (let i = 0; i < token.length - 1; i += 1) {
      const gram = token.slice(i, i + 2);
      terms.set(gram, (terms.get(gram) ?? 0) + 1);
    }
  }
  return Array.from(terms.entries())
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxKeywords)
    .map(([term]) => term);
}

function scoreText(
  text: string,
  terms: string[],
  options?: { title?: string; keywords?: string[] },
): number {
  const haystack = text.toLowerCase();
  const title = options?.title?.toLowerCase() ?? "";
  const keywords = new Set(options?.keywords ?? []);
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) {
      score += 5;
    }
    if (keywords.has(term)) {
      score += 4;
    }
    if (haystack.includes(term)) {
      score += 1;
    }
  }
  return score;
}

function collectMatchedTerms(text: string, terms: string[]): string[] {
  const haystack = text.toLowerCase();
  const matched: string[] = [];
  for (const term of terms) {
    if (haystack.includes(term) && !matched.includes(term)) {
      matched.push(term);
    }
  }
  return matched;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "about",
  "what",
  "when",
  "where",
  "how",
  "why",
  "了",
  "的",
  "是",
  "在",
  "和",
  "与",
  "或",
  "及",
  "一个",
  "这个",
  "那个",
]);
