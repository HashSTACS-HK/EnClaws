/**
 * User memory tool — allows the LLM to save/delete personal user-level memories.
 *
 * Writes directly to tenants/{tid}/users/{uid}/USER.md on disk.
 * The file is loaded into the LLM context via loadTenantBootstrapFiles().
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveTenantUserDir } from "../../config/sessions/tenant-paths.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const USER_MEMORY_FILENAME = "USER.md";
const MAX_USER_MEMORY_SIZE = 4096; // 4KB limit

const USER_MEMORY_ACTIONS = ["save", "delete", "list"] as const;

const UserMemorySchema = Type.Object({
  action: stringEnum(USER_MEMORY_ACTIONS),
  /** Memory entry to save (for "save" action). One entry per call. */
  entry: Type.Optional(Type.String()),
  /** Keyword or line content to match for deletion (for "delete" action). */
  keyword: Type.Optional(Type.String()),
});

type UserMemoryToolOptions = {
  tenantId?: string;
  userId?: string;
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

export function createUserMemoryTool(options: UserMemoryToolOptions): AnyAgentTool | null {
  if (!options.tenantId || !options.userId) {
    return null;
  }
  const tenantId = options.tenantId;
  const userId = options.userId;

  return {
    label: "User Memory",
    name: "user_memory",
    description:
      "Manage personal user-level memory (USER.md). Use this to save information the user shares about themselves: " +
      "their name, role, preferences, personal background, contact info, or anything they explicitly ask you to remember about them. " +
      "Do NOT use this for enterprise/business information — use tenant_memory for that instead. " +
      "Do NOT save: ephemeral task details, one-off debugging info, or information already saved. " +
      "Actions: 'save' appends a new entry, 'delete' removes entries matching a keyword, 'list' shows all entries. " +
      "Keep entries concise and factual.",
    parameters: UserMemorySchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", {
        required: true,
      }) as (typeof USER_MEMORY_ACTIONS)[number];
      const userDir = resolveTenantUserDir(tenantId, userId);
      const memoryPath = path.join(userDir, USER_MEMORY_FILENAME);

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

        if (content.includes(line)) {
          return jsonResult({ status: "exists", message: "This memory entry already exists" });
        }

        let header = "";
        let body = content;
        if (!content.trim()) {
          header = "# User Profile\n\n";
          body = "";
        }
        const newContent = header + body.trimEnd() + "\n" + line + "\n";

        if (newContent.length > MAX_USER_MEMORY_SIZE) {
          return jsonResult({
            error:
              "User memory file would exceed size limit (4KB). Consider removing outdated entries first.",
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
