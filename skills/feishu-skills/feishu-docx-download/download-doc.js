"use strict";
/**
 * Download a file attachment from Feishu Drive or Wiki.
 *
 * Usage:
 *   node ./download-doc.js --open-id "ou_xxx" --url "https://xxx.feishu.cn/wiki/TOKEN"
 *   node ./download-doc.js --open-id "ou_xxx" --url "https://xxx.feishu.cn/file/TOKEN"
 *   node ./download-doc.js --open-id "ou_xxx" --file-token "FILE_TOKEN" --type "docx"
 *
 * Options:
 *   --open-id      Feishu open_id of the requesting user (required)
 *   --url          Feishu Wiki or Drive file URL (auto-detected)
 *   --file-token   Drive file token (skip URL lookup)
 *   --type         File extension hint (docx/pdf/pptx/xlsx/...), auto-detected from title if omitted
 *   --output-dir   Download directory (default: user workspace under EnClaws, ./downloads otherwise)
 *   --output       Output filename override
 */

const fs = require("fs");
const path = require("path");
const { getConfig, getValidToken } = require(path.join(__dirname, "../feishu-auth/token-utils.js"));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null;
}

const openId = getArg("--open-id");
const inputUrl = getArg("--url");
const fileToken = getArg("--file-token");
const fileType = getArg("--type");
const outputName = getArg("--output");

// Default output dir:
//   EnClaws: ENCLAWS_USER_WORKSPACE env var + /download
//   OpenClaw / other: ./download  (relative to cwd, which is the workspace root)
function resolveDefaultOutputDir() {
  const envWorkspace = process.env.ENCLAWS_USER_WORKSPACE;
  if (envWorkspace) {
    return path.join(envWorkspace, "download");
  }
  return path.join(process.cwd(), "download");
}
const outputDir = getArg("--output-dir") || resolveDefaultOutputDir();

if (!openId) {
  console.log(JSON.stringify({ error: "missing_arg", message: "--open-id is required" }));
  process.exit(1);
}
if (!inputUrl && !fileToken) {
  console.log(
    JSON.stringify({ error: "missing_arg", message: "--url or --file-token is required" }),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Classify URL and extract token */
function parseFeishuUrl(url) {
  const wikiMatch = url.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikiMatch) return { type: "wiki", token: wikiMatch[1] };
  const fileMatch = url.match(/\/file\/([A-Za-z0-9]+)/);
  if (fileMatch) return { type: "file", token: fileMatch[1] };
  return null;
}

/** Format bytes for display */
function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Load credentials
  let cfg;
  try {
    cfg = getConfig(__dirname);
  } catch (e) {
    console.log(JSON.stringify({ error: "config_error", message: e.message }));
    process.exit(1);
  }

  // Get valid OAuth token
  const accessToken = await getValidToken(openId, cfg.appId, cfg.appSecret);
  if (!accessToken) {
    console.log(JSON.stringify({ error: "auth_required" }));
    process.exit(0);
  }

  const headers = { Authorization: `Bearer ${accessToken}` };

  let resolvedToken = fileToken;
  let resolvedType = fileType;
  let resolvedName = outputName;

  // -------------------------------------------------------------------------
  // Step 1: Resolve URL → file_token
  // -------------------------------------------------------------------------
  if (inputUrl) {
    const parsed = parseFeishuUrl(inputUrl);
    if (!parsed) {
      console.log(
        JSON.stringify({
          error: "invalid_url",
          message: "Cannot parse token from URL: " + inputUrl,
        }),
      );
      process.exit(1);
    }

    if (parsed.type === "wiki") {
      // Wiki URL → get_node to resolve obj_token
      const nodeRes = await fetch(
        `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${parsed.token}`,
        { headers },
      );
      let nodeData;
      try {
        nodeData = await nodeRes.json();
      } catch {
        console.log(JSON.stringify({ error: "wiki_api_parse_error", status: nodeRes.status }));
        process.exit(1);
      }
      if (nodeData.code !== 0) {
        console.log(
          JSON.stringify({ error: "wiki_api_error", code: nodeData.code, message: nodeData.msg }),
        );
        process.exit(1);
      }
      const node = nodeData.data?.node;
      if (!node) {
        console.log(JSON.stringify({ error: "wiki_node_not_found" }));
        process.exit(1);
      }
      if (node.obj_type !== "file") {
        console.log(
          JSON.stringify({
            error: "not_a_file_attachment",
            obj_type: node.obj_type,
            message: `This Wiki node is an online document (type: ${node.obj_type}), not a file attachment. Use feishu-fetch-doc to read it.`,
          }),
        );
        process.exit(1);
      }
      resolvedToken = node.obj_token;
      if (!resolvedType && node.title && node.title.includes(".")) {
        resolvedType = node.title.split(".").pop().toLowerCase();
      }
      if (!resolvedName) resolvedName = node.title || `feishu_${resolvedToken}`;
    } else if (parsed.type === "file") {
      // Drive /file/ URL → use token directly, query metadata for name/type
      resolvedToken = parsed.token;
      const metaRes = await fetch("https://open.feishu.cn/open-apis/drive/v1/metas/batch_query", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ request_docs: [{ doc_token: parsed.token, doc_type: "file" }] }),
      });
      let metaData;
      try {
        metaData = await metaRes.json();
      } catch {
        metaData = null;
      }
      const meta = metaData?.data?.metas?.[0];
      if (meta) {
        const title = meta.title || "";
        if (!resolvedType && title.includes(".")) {
          resolvedType = title.split(".").pop().toLowerCase();
        }
        if (!resolvedName) resolvedName = title || `feishu_${resolvedToken}`;
      }
    }
  }

  // Ensure filename has extension
  if (resolvedType && resolvedName && !resolvedName.endsWith("." + resolvedType)) {
    resolvedName = `${resolvedName}.${resolvedType}`;
  }
  if (!resolvedName) {
    resolvedName = `feishu_${resolvedToken}${resolvedType ? "." + resolvedType : ""}`;
  }

  // -------------------------------------------------------------------------
  // Step 2: Download file from Drive
  // -------------------------------------------------------------------------
  const dlRes = await fetch(
    `https://open.feishu.cn/open-apis/drive/v1/files/${resolvedToken}/download`,
    { headers },
  );

  // Check if Feishu returned a JSON error instead of binary
  const contentType = dlRes.headers.get("content-type") || "";
  if (!dlRes.ok || contentType.includes("application/json")) {
    let errBody;
    try {
      errBody = await dlRes.json();
    } catch {
      errBody = await dlRes.text();
    }
    console.log(
      JSON.stringify({
        error: "download_error",
        status: dlRes.status,
        detail: typeof errBody === "object" ? errBody : String(errBody).slice(0, 300),
      }),
    );
    process.exit(1);
  }

  // Write binary to disk
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, resolvedName);
  const buffer = Buffer.from(await dlRes.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);

  const size = fs.statSync(outputPath).size;

  console.log(
    JSON.stringify({
      success: true,
      file_path: outputPath,
      file_name: resolvedName,
      file_type: resolvedType || "unknown",
      size_bytes: size,
      next_step: `node ./extract.js "${outputPath}"`,
      reply: `文件已下载：${resolvedName}（${formatSize(size)}），保存至：${outputPath}。请执行 node ./extract.js "${outputPath}" 提取文本。`,
    }),
  );
}

main().catch((e) => {
  console.log(JSON.stringify({ error: "unexpected_error", message: e.message }));
  process.exit(1);
});
