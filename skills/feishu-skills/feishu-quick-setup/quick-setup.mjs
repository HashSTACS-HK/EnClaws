/**
 * feishu-quick-setup: One-click Feishu bot creation via QR code scan.
 *
 * Uses Feishu App Registration API (Device Flow) to let users create a
 * Feishu bot by scanning a QR code, then writes credentials to openclaw.json.
 *
 * Modes:
 *   --status         Check if Feishu is already configured in openclaw.json
 *   --begin          Start registration (init + begin), return QR code URL
 *   --poll           Poll for registration result (appId, appSecret)
 *   --save           Write appId/appSecret to openclaw.json
 *   --full           Full flow: begin → terminal QR → poll → save (blocking)
 *
 * All output is single-line JSON.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Feishu registration API base URLs
// ---------------------------------------------------------------------------

const FEISHU_BASE = "https://accounts.feishu.cn";
const LARK_BASE = "https://accounts.larksuite.com";

function resolveBaseUrl(domain) {
  return domain === "lark" ? LARK_BASE : FEISHU_BASE;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  const result = {
    mode: null,
    domain: "feishu",
    deviceCode: null,
    appId: null,
    appSecret: null,
    timeout: 300,
    wait: false,
    configPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--status":
        result.mode = "status";
        break;
      case "--begin":
        result.mode = "begin";
        break;
      case "--poll":
        result.mode = "poll";
        break;
      case "--save":
        result.mode = "save";
        break;
      case "--full":
        result.mode = "full";
        break;
      case "--wait":
        result.wait = true;
        break;
      case "--domain":
        result.domain = argv[++i];
        break;
      case "--device-code":
        result.deviceCode = argv[++i];
        break;
      case "--app-id":
        result.appId = argv[++i];
        break;
      case "--app-secret":
        result.appSecret = argv[++i];
        break;
      case "--timeout":
        result.timeout = parseInt(argv[++i], 10);
        break;
      case "--config":
        result.configPath = argv[++i];
        break;
    }
  }
  return result;
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function die(obj) {
  out(obj);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Pending state file (auto-save deviceCode to avoid long CLI args)
// ---------------------------------------------------------------------------

import { fileURLToPath as _furl } from "node:url";
const __filename_mjs = _furl(import.meta.url);
const __dirname_mjs = path.dirname(__filename_mjs);
const PENDING_FILE = path.join(__dirname_mjs, ".pending.json");

function savePendingState(data) {
  fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2), "utf8");
}

function readPendingState() {
  if (!fs.existsSync(PENDING_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
  } catch {
    return null;
  }
}

function clearPendingState() {
  if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE);
}

// ---------------------------------------------------------------------------
// OpenClaw config helpers
// ---------------------------------------------------------------------------

function getOpenClawConfigPath(override) {
  if (override) return override;
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

function readOpenClawConfig(configPath) {
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function getFeishuStatus(configPath) {
  const cfg = readOpenClawConfig(configPath);
  if (!cfg) {
    return { configured: false, reason: "openclaw.json not found", configPath };
  }
  const feishu = cfg.channels?.feishu;
  if (!feishu || !feishu.appId || !feishu.appSecret) {
    return { configured: false, reason: "channels.feishu.appId/appSecret not set", configPath };
  }
  return {
    configured: true,
    appId: feishu.appId,
    domain: feishu.domain || "feishu",
    enabled: feishu.enabled !== false,
    configPath,
  };
}

// ---------------------------------------------------------------------------
// Feishu Registration API
// ---------------------------------------------------------------------------

async function postRegistration(baseUrl, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
  try {
    const res = await fetch(`${baseUrl}/oauth/v1/app/registration`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function registrationBegin(domain) {
  const baseUrl = resolveBaseUrl(domain);

  // Step 1: init — check supported auth methods
  const initRes = await postRegistration(baseUrl, new URLSearchParams({ action: "init" }));
  const methods = initRes.supported_auth_methods;
  if (!Array.isArray(methods) || !methods.includes("client_secret")) {
    return {
      error: true,
      message: "Current environment does not support client_secret auth method",
    };
  }

  // Step 2: begin — get device_code + verification URL
  const beginRes = await postRegistration(
    baseUrl,
    new URLSearchParams({
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    }),
  );

  const deviceCode = beginRes.device_code;
  const verificationUrl = beginRes.verification_uri_complete;
  const interval = beginRes.interval ?? 5;
  const expireIn = beginRes.expire_in ?? 600;

  if (!deviceCode || !verificationUrl) {
    return {
      error: true,
      message: "Failed to begin registration",
      detail: JSON.stringify(beginRes),
    };
  }

  return {
    error: false,
    deviceCode,
    verificationUrl,
    interval,
    expireIn,
    domain,
  };
}

async function registrationPoll(deviceCode, domain) {
  let effectiveDomain = domain;
  let baseUrl = resolveBaseUrl(domain);

  const pollRes = await postRegistration(
    baseUrl,
    new URLSearchParams({ action: "poll", device_code: deviceCode }),
  );

  // Check if domain needs switching (lark tenant)
  const userInfo = pollRes.user_info;
  if (userInfo?.tenant_brand === "lark" && domain !== "lark") {
    effectiveDomain = "lark";
    baseUrl = resolveBaseUrl("lark");
    const retryRes = await postRegistration(
      baseUrl,
      new URLSearchParams({ action: "poll", device_code: deviceCode }),
    );
    Object.assign(pollRes, retryRes);
  }

  const clientId = pollRes.client_id;
  const clientSecret = pollRes.client_secret;

  if (clientId && clientSecret) {
    const openId = userInfo?.open_id;
    return {
      status: "completed",
      appId: clientId,
      appSecret: clientSecret,
      openId,
      domain: effectiveDomain,
    };
  }

  const error = pollRes.error;
  if (!error || error === "authorization_pending") {
    return { status: "pending" };
  }
  if (error === "slow_down") {
    return { status: "pending", slowDown: true };
  }

  // expired_token, access_denied, or other errors
  return {
    status: "error",
    error,
    errorDescription: pollRes.error_description,
  };
}

// ---------------------------------------------------------------------------
// Config writer
// ---------------------------------------------------------------------------

function saveFeishuConfig(configPath, appId, appSecret, domain) {
  let cfg = readOpenClawConfig(configPath);
  const isNew = !cfg;
  cfg = cfg || {};

  // Backup existing config
  if (!isNew) {
    const backupPath = configPath + ".bak";
    fs.copyFileSync(configPath, backupPath);
  }

  // Ensure structure
  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels.feishu) cfg.channels.feishu = {};

  // Write feishu credentials
  cfg.channels.feishu.appId = appId;
  cfg.channels.feishu.appSecret = appSecret;
  cfg.channels.feishu.domain = domain || "feishu";
  cfg.channels.feishu.enabled = true;

  // Set default policies if not already set
  if (!cfg.channels.feishu.dmPolicy) cfg.channels.feishu.dmPolicy = "pairing";
  if (!cfg.channels.feishu.groupPolicy) cfg.channels.feishu.groupPolicy = "allowlist";

  // Ensure parent directory exists
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");

  return {
    success: true,
    configPath,
    appId,
    isNew,
    backup: isNew ? null : configPath + ".bak",
    permissionUrl: `https://open.feishu.cn/app/${appId}/auth`,
    message: [
      `飞书 Bot 创建成功！`,
      ``,
      `App ID: ${appId}`,
      `配置已自动保存并生效。`,
      `基础权限（消息收发等）已默认开启。`,
      ``,
      `现在可以在飞书中搜索并给 Bot 发消息，即可开始使用！`,
      ``,
      `如需查看或管理应用权限：`,
      `https://open.feishu.cn/app/${appId}/auth`,
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Full flow: begin → show URL → poll → save
// ---------------------------------------------------------------------------

async function fullFlow(args) {
  const configPath = getOpenClawConfigPath(args.configPath);

  // Check existing config
  const status = getFeishuStatus(configPath);
  if (status.configured) {
    return {
      status: "already_configured",
      appId: status.appId,
      domain: status.domain,
      configPath,
      message: "Feishu is already configured. Use --save with new credentials to overwrite.",
    };
  }

  // Begin registration
  process.stderr.write("[quick-setup] Starting Feishu bot registration...\n");
  const beginResult = await registrationBegin(args.domain);
  if (beginResult.error) {
    return { status: "error", message: beginResult.message, detail: beginResult.detail };
  }

  // Output verification URL for the agent to display
  process.stderr.write(`\n[quick-setup] Verification URL: ${beginResult.verificationUrl}\n`);
  process.stderr.write(
    `[quick-setup] Waiting for user to scan and confirm (timeout: ${args.timeout}s)...\n\n`,
  );

  // Poll until authorized or timeout
  const startTime = Date.now();
  const timeoutMs = args.timeout * 1000;
  let interval = Math.max(beginResult.interval, 3) * 1000;

  while (Date.now() - startTime < timeoutMs) {
    await sleep(interval);

    try {
      const result = await registrationPoll(beginResult.deviceCode, args.domain);

      if (result.status === "completed") {
        // Save to config
        const saveResult = saveFeishuConfig(
          configPath,
          result.appId,
          result.appSecret,
          result.domain,
        );
        return {
          status: "completed",
          appId: result.appId,
          openId: result.openId,
          domain: result.domain,
          configPath: saveResult.configPath,
          backup: saveResult.backup,
          isNew: saveResult.isNew,
        };
      }

      if (result.status === "error") {
        return { status: "error", error: result.error, errorDescription: result.errorDescription };
      }

      if (result.slowDown) {
        interval = Math.min(interval + 5000, 60000);
      }
    } catch (err) {
      // Transient error, keep polling
      process.stderr.write(`[quick-setup] Poll error (retrying): ${err.message}\n`);
    }
  }

  return { status: "timeout", message: `Registration timed out after ${args.timeout}s` };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  if (!args.mode) {
    die({
      error: true,
      message: "No mode specified. Use --status, --begin, --poll, --save, or --full",
    });
  }

  try {
    switch (args.mode) {
      case "status": {
        const configPath = getOpenClawConfigPath(args.configPath);
        out(getFeishuStatus(configPath));
        break;
      }

      case "begin": {
        const result = await registrationBegin(args.domain);
        if (!result.error) {
          savePendingState({
            deviceCode: result.deviceCode,
            domain: result.domain,
            verificationUrl: result.verificationUrl,
            createdAt: Date.now(),
          });
        }
        out(result);
        break;
      }

      case "poll": {
        let deviceCode = args.deviceCode;
        let domain = args.domain;
        if (!deviceCode) {
          const pending = readPendingState();
          if (!pending || !pending.deviceCode) {
            die({ error: true, message: "No pending registration found. Run --begin first." });
          }
          deviceCode = pending.deviceCode;
          domain = pending.domain || domain;
        }

        if (args.wait) {
          const timeoutMs = args.timeout * 1000;
          const startTime = Date.now();
          let interval = 5000;
          while (Date.now() - startTime < timeoutMs) {
            const r = await registrationPoll(deviceCode, domain);
            if (r.status === "completed") {
              clearPendingState();
              out(r);
              process.exit(0);
            }
            if (r.status === "error") {
              out(r);
              process.exit(1);
            }
            if (r.slowDown) interval = Math.min(interval + 5000, 60000);
            await sleep(interval);
          }
          die({ status: "timeout", message: `Poll timed out after ${args.timeout}s` });
        } else {
          const result = await registrationPoll(deviceCode, domain);
          if (result.status === "completed") {
            clearPendingState();
          }
          out(result);
        }
        break;
      }

      case "save": {
        if (!args.appId || !args.appSecret) {
          die({ error: true, message: "--app-id and --app-secret are required for --save" });
        }
        const configPath = getOpenClawConfigPath(args.configPath);
        const result = saveFeishuConfig(configPath, args.appId, args.appSecret, args.domain);
        out(result);
        break;
      }

      case "full": {
        const result = await fullFlow(args);
        out(result);
        break;
      }

      default:
        die({ error: true, message: `Unknown mode: ${args.mode}` });
    }
  } catch (err) {
    die({ error: true, message: err.message });
  }
}

main();
