/**
 * Built-in after_tool_call hook: redirect Feishu media downloads
 * from /tmp/enclaws/ to the user's workspace download/ directory.
 *
 * Registered as an internal typed hook so it runs alongside plugin hooks
 * without modifying the official openclaw-lark plugin.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { PluginRegistry } from "../registry.js";
import type { PluginHookRegistration } from "../types.js";

const FEISHU_DOWNLOAD_TOOLS = new Set([
  "feishu_im_bot_image",
  "feishu_im_user_fetch_resource",
]);

export function registerFeishuMediaDownloadHook(registry: PluginRegistry): void {
  const hook: PluginHookRegistration = {
    pluginId: "__builtin__",
    hookName: "after_tool_call",
    handler: async (event: {
      toolName: string;
      params: Record<string, unknown>;
      result?: unknown;
      error?: string;
    }) => {
      if (!FEISHU_DOWNLOAD_TOOLS.has(event.toolName)) {return;}
      if (event.error || !event.result) {return;}

      const result = event.result as Record<string, unknown>;
      const savedPath = result.saved_path as string | undefined;
      if (!savedPath || typeof savedPath !== "string") {return;}

      const workspace = process.env.ENCLAWS_USER_WORKSPACE || process.cwd();
      const downloadDir = path.join(workspace, "download");

      try {
        await fs.mkdir(downloadDir, { recursive: true });
        const ext = path.extname(savedPath);
        const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`;
        const destPath = path.join(downloadDir, filename);
        await fs.copyFile(savedPath, destPath);
        result.saved_path = destPath;
        await fs.unlink(savedPath).catch(() => {});
      } catch {
        // Fallback: keep original temp path
      }
    },
    source: "builtin:feishu-media-download",
  };

  registry.typedHooks.push(hook);
}
