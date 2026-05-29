/**
 * Tenant memory tool — allows the LLM to save/delete enterprise-level memories.
 *
 * Writes directly to tenants/{tid}/MEMORY.md on disk.
 * The file is loaded into the LLM context via loadTenantBootstrapFiles().
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveTenantDir } from "../../config/sessions/tenant-paths.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const MEMORY_FILENAME = "MEMORY.md";
const MAX_MEMORY_SIZE = 8192; // 8KB limit

const MEMORY_ACTIONS = ["save", "delete", "list"] as const;

const TenantMemorySchema = Type.Object({
  action: stringEnum(MEMORY_ACTIONS),
  /** Memory entry to save (for "save" action). One entry per call. */
  entry: Type.Optional(Type.String()),
  /** Keyword or line content to match for deletion (for "delete" action). */
  keyword: Type.Optional(Type.String()),
});

type TenantMemoryToolOptions = {
  tenantId?: string;
};

async function readMemoryFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function writeMemoryFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

export function createTenantMemoryTool(options: TenantMemoryToolOptions): AnyAgentTool | null {
  if (!options.tenantId) {
    return null;
  }
  const tenantId = options.tenantId;

  return {
    label: "Enterprise Memory",
    name: "tenant_memory",
    description:
      "Manage enterprise long-term memory (MEMORY.md). Proactively save important enterprise-level context " +
      "when it appears in conversation: business rules, processes, technical stack, architecture decisions, " +
      "partner/vendor info, team conventions, or anything the user explicitly asks you to remember. " +
      "Do NOT save: one-off debugging info, personal preferences, or information already saved. " +
      "Actions: 'save' appends a new entry, 'delete' removes entries matching a keyword, 'list' shows all entries. " +
      "Keep entries concise and factual.",
    parameters: TenantMemorySchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", {
        required: true,
      }) as (typeof MEMORY_ACTIONS)[number];
      const tenantDir = resolveTenantDir(tenantId);
      const memoryPath = path.join(tenantDir, MEMORY_FILENAME);

      if (action === "list") {
        const content = await readMemoryFile(memoryPath);
        const entries = content
          .split("\n")
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2).trim());
        return jsonResult({ entries, count: entries.length });
      }

      if (action === "save") {
        const entry = readStringParam(params, "entry", { required: true });
        if (!entry?.trim()) {
          return jsonResult({ error: "entry is required for save action" });
        }
        const content = await readMemoryFile(memoryPath);
        const line = `- ${entry.trim()}`;

        // Check if entry already exists
        if (content.includes(line)) {
          return jsonResult({ status: "exists", message: "This memory entry already exists" });
        }

        // Build new content
        let header = "";
        let body = content;
        if (!content.trim()) {
          header = "# Enterprise Memory\n\n";
          body = "";
        }
        const newContent = header + body.trimEnd() + "\n" + line + "\n";

        // Size check
        if (newContent.length > MAX_MEMORY_SIZE) {
          return jsonResult({
            error:
              "Memory file would exceed size limit (8KB). Consider removing outdated entries first.",
          });
        }

        await writeMemoryFile(memoryPath, newContent);
        return jsonResult({ status: "saved", entry: entry.trim() });
      }

      if (action === "delete") {
        const keyword = readStringParam(params, "keyword", { required: true });
        if (!keyword?.trim()) {
          return jsonResult({ error: "keyword is required for delete action" });
        }
        const content = await readMemoryFile(memoryPath);
        if (!content.trim()) {
          return jsonResult({ status: "empty", message: "No memory entries to delete" });
        }
        const lines = content.split("\n");
        const kw = keyword.trim().toLowerCase();
        const remaining = lines.filter(
          (line) => !(line.startsWith("- ") && line.toLowerCase().includes(kw)),
        );
        const removed = lines.length - remaining.length;
        if (removed === 0) {
          return jsonResult({
            status: "not_found",
            message: `No entries matching "${keyword}" found`,
          });
        }
        await writeMemoryFile(memoryPath, remaining.join("\n"));
        return jsonResult({ status: "deleted", removed, keyword: keyword.trim() });
      }

      return jsonResult({ error: `Unknown action: ${action}` });
    },
  };
}
