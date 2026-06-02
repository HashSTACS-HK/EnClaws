const SUPPORTED_KNOWLEDGE_EXTENSIONS = [".md", ".txt", ".csv", ".docx", ".xlsx", ".pdf"];
const WINDOWS_RESERVED_CHARS = /[<>:"|?*\u0000-\u001f]/g;

function sanitizePathPart(part: string): string | null {
  const sanitized = part.replace(WINDOWS_RESERVED_CHARS, "").trim();
  if (!sanitized || sanitized === "." || sanitized === ".." || sanitized.startsWith(".")) {
    return null;
  }
  return sanitized;
}

export function normalizeAgentKnowledgeFileName(raw: string): string | null {
  const clean = raw.trim().replace(/\\/g, "/");
  if (!clean) {
    return null;
  }
  const withoutPrefix = clean.startsWith("memory/") ? clean.slice("memory/".length) : clean;
  const parts = withoutPrefix.split("/");
  const safeParts: string[] = [];
  for (const part of parts) {
    const safePart = sanitizePathPart(part);
    if (!safePart) {
      return null;
    }
    safeParts.push(safePart);
  }
  const safeName = safeParts.join("/");
  const lower = safeName.toLowerCase();
  const hasSupportedExt = SUPPORTED_KNOWLEDGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  return `memory/${hasSupportedExt ? safeName : `${safeName}.md`}`;
}
