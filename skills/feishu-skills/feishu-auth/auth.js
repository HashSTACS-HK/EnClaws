"use strict";
/**
 * feishu-auth: OAuth Device Flow for Feishu per-user authorization.
 *
 * Modes:
 *   --auth-and-poll  Combined: init → send auth link to user via IM → poll until authorized
 *   --init           Request device authorization → output URL, then exit
 *   --complete       Single attempt to exchange device_code for token
 *   --complete --poll Block and poll until user authorizes or expires
 *   --revoke         Clear local token
 *   --status         Check current auth state
 *
 * All output is single-line JSON.
 */

const path = require("path");
const {
  getConfig,
  readToken,
  saveToken,
  readPending,
  savePending,
  deletePending,
  deleteToken,
  getValidToken,
} = require(path.join(__dirname, "./token-utils.js"));
const { sendCard, updateCard, getTenantAccessToken } = require(
  path.join(__dirname, "./send-card.js"),
);

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  const result = {
    mode: null,
    openId: null,
    poll: false,
    chatId: null,
    timeout: null,
    extraScopes: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--auth-and-poll":
        result.mode = "auth-and-poll";
        break;
      case "--init":
        result.mode = "init";
        break;
      case "--complete":
        result.mode = "complete";
        break;
      case "--revoke":
        result.mode = "revoke";
        break;
      case "--status":
        result.mode = "status";
        break;
      case "--poll":
        result.poll = true;
        break;
      case "--open-id":
        result.openId = argv[++i];
        break;
      case "--chat-id":
        result.chatId = argv[++i];
        break;
      case "--timeout":
        result.timeout = parseInt(argv[++i], 10);
        break;
      case "--scope":
        result.extraScopes = argv[++i];
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
// Feishu API helpers
// ---------------------------------------------------------------------------

function basicAuth(appId, appSecret) {
  return "Basic " + Buffer.from(`${appId}:${appSecret}`).toString("base64");
}

/** Minimal base scopes — always requested regardless of --scope argument. */
const BASE_SCOPES = [
  "offline_access",
  "contact:user.base:readonly",
  "contact:contact.base:readonly",
];

/**
 * Merge base scopes + extra scopes from --scope arg + existing token scopes.
 * Deduplicates and returns a single space-separated string.
 */
function buildMergedScopes(extraScopesStr, existingTokenScope) {
  const set = new Set(BASE_SCOPES);
  if (existingTokenScope) {
    for (const s of existingTokenScope.split(/\s+/)) if (s) set.add(s);
  }
  if (extraScopesStr) {
    for (const s of extraScopesStr.split(/[\s,]+/)) if (s) set.add(s);
  }
  // If no extra scopes requested at all (first-time auth without --scope),
  // include a sensible default set for docs/drive/wiki so basic skills work.
  if (!extraScopesStr && !existingTokenScope) {
    for (const s of [
      "docs:doc",
      "docx:document",
      "docx:document:create",
      "docx:document:readonly",
      "drive:drive",
      "drive:file:download",
      "docs:document.media:download",
      "wiki:wiki:readonly",
      "wiki:node:read",
      "space:document:retrieve",
    ])
      set.add(s);
  }
  return [...set].join(" ");
}

// getTenantAccessToken, sendFeishuMessage, updateFeishuMessage, buildAuthCard,
// buildSuccessCard — all moved to send-card.js

async function tryUpdateCardToGreen(openId) {
  const pending = readPending(openId);
  if (!pending?.message_id) return;
  const messageId = pending.message_id;
  // Remove message_id from pending (keep rest of pending data intact)
  const { message_id: _removed, ...rest } = pending;
  if (Object.keys(rest).length > 0) savePending(openId, rest);
  else deletePending(openId);
  try {
    const result = await updateCard({
      messageId,
      title: "✅ 授权成功",
      body: "飞书账号授权已完成，正在继续处理您的请求。",
      color: "green",
    });
    process.stderr.write(`[auth] card updated to green: ${JSON.stringify(result)}\n`);
  } catch (err) {
    process.stderr.write(`[auth] card update failed (non-fatal): ${err.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Step 1: init
// ---------------------------------------------------------------------------

async function init(openId, cfg, scopeStr) {
  const mergedScope = scopeStr || buildMergedScopes(null, null);
  const body = new URLSearchParams({ client_id: cfg.appId, scope: mergedScope });
  const res = await fetch("https://accounts.feishu.cn/oauth/v1/device_authorization", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(cfg.appId, cfg.appSecret),
    },
    body: body.toString(),
  });
  const rawText = await res.text();
  let json;
  try {
    json = JSON.parse(rawText);
  } catch (e) {
    die({
      status: "error",
      message: `API returned non-JSON (HTTP ${res.status}): ${rawText.slice(0, 300)}`,
    });
  }

  if (!res.ok || json.error) {
    die({
      status: "error",
      message: `Device authorization failed: ${json.error_description ?? json.error ?? rawText}`,
    });
  }

  const pending = {
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: json.verification_uri ?? json.verification_uri_complete,
    expires_in: json.expires_in ?? 240,
    interval: json.interval ?? 5,
    created_at: Date.now(),
  };
  savePending(openId, pending);

  out({
    status: "awaiting",
    expires_in: pending.expires_in,
    message:
      "授权已初始化，请使用 --auth-and-poll 模式发送授权卡片给用户。不要将授权链接直接展示给用户。",
  });

  return pending;
}

// ---------------------------------------------------------------------------
// Token exchange (single attempt)
// ---------------------------------------------------------------------------

async function tryExchange(deviceCode, cfg) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
  });
  const res = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const rawText = await res.text();
  try {
    return JSON.parse(rawText);
  } catch (e) {
    return {
      error: "parse_error",
      error_description: `Non-JSON (HTTP ${res.status}): ${rawText.slice(0, 300)}`,
    };
  }
}

function saveAuthorizedToken(openId, cfg, data) {
  const now = Date.now();
  const tokenData = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + (data.expires_in ?? 7200) * 1000,
    refreshExpiresAt:
      now + (data.refresh_token_expires_in ?? data.refresh_expires_in ?? 604800) * 1000,
    scope: data.scope,
    grantedAt: now,
  };
  saveToken(openId, cfg.appId, tokenData);
  return tokenData;
}

// ---------------------------------------------------------------------------
// Poll loop (shared by --complete --poll and --auth-and-poll)
// ---------------------------------------------------------------------------

/**
 * Wraps pollUntilAuthorized in an internal retry loop.
 * Continues polling across multiple rounds until authorized or device_code expires.
 * Never returns polling_timeout to the caller (agent).
 */
async function pollLoop(openId, cfg, pending, roundMs, messageId) {
  while (true) {
    const result = await pollUntilAuthorized(openId, cfg, pending, roundMs, messageId);
    if (result.status !== "polling_timeout") return result;
    // device_code still valid — re-read pending only to check expiry
    const currentPending = readPending(openId);
    if (
      !currentPending ||
      currentPending.created_at + currentPending.expires_in * 1000 <= Date.now()
    ) {
      return { status: "expired", message: "授权码已过期" };
    }
    process.stderr.write("[auth] polling_timeout, device_code still valid — continuing poll\n");
    // Only update pending if device_code matches — avoid picking up a concurrent process's device_code
    if (currentPending.device_code === pending.device_code) {
      pending = currentPending;
    }
  }
}

async function pollUntilAuthorized(openId, cfg, pending, timeoutMs, messageId) {
  const deviceDeadline = pending.created_at + pending.expires_in * 1000;
  const pollDeadline = timeoutMs ? Date.now() + timeoutMs : deviceDeadline;
  const deadline = Math.min(deviceDeadline, pollDeadline);
  const intervalMs = Math.min(pending.interval ?? 5, 3) * 1000;

  while (Date.now() < deadline) {
    const json = await tryExchange(pending.device_code, cfg);
    const error = json.error;
    process.stderr.write(`[poll] exchange response: ${JSON.stringify(json).slice(0, 500)}\n`);

    if (!error && json.access_token) {
      const tokenData = saveAuthorizedToken(openId, cfg, json);
      await tryUpdateCardToGreen(openId);
      deletePending(openId);
      return {
        status: "authorized",
        scope: tokenData.scope,
        expires_in: json.expires_in,
        message: "授权成功！",
      };
    }

    if (error === "authorization_pending") {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      process.stderr.write(`[poll] waiting... ${Math.floor(remaining / 1000)}s left\n`);
      await sleep(Math.min(intervalMs, remaining));
      continue;
    }

    if (error === "slow_down") {
      process.stderr.write("[poll] slow_down, backing off...\n");
      await sleep(intervalMs * 2);
      continue;
    }

    if (error === "access_denied") {
      deletePending(openId);
      return { status: "denied", message: "用户拒绝了授权请求" };
    }

    if (error === "expired_token") {
      deletePending(openId);
      return { status: "expired", message: "授权码已过期" };
    }

    deletePending(openId);
    return {
      status: "error",
      message: `Token exchange failed: ${json.error_description ?? error ?? JSON.stringify(json)}`,
    };
  }

  // device_code still valid → caller will retry; do NOT delete pending
  if (Date.now() < deviceDeadline) {
    return { status: "polling_timeout" };
  }

  deletePending(openId);
  return { status: "expired", message: "授权码已过期" };
}

// ---------------------------------------------------------------------------
// Combined: auth-and-poll (single command for AI)
// Sends auth link to user via IM, then polls until authorized.
// ---------------------------------------------------------------------------

async function authAndPoll(openId, chatId, cfg, timeoutMs, extraScopesStr) {
  // Resolve chatId with fallback: CLI arg → env var → null (private message)
  const resolvedChatId = chatId || process.env.ENCLAWS_CHAT_ID || null;

  // Check if already authorized AND has all requested scopes
  const existingToken = await getValidToken(openId, cfg.appId, cfg.appSecret);
  if (existingToken) {
    // If --scope was provided, check if current token already covers all requested scopes
    if (extraScopesStr) {
      const tokenObj = readToken(openId, cfg.appId);
      const currentScopes = new Set((tokenObj?.scope || "").split(/\s+/).filter(Boolean));
      const requested = extraScopesStr.split(/[\s,]+/).filter(Boolean);
      const missing = requested.filter((s) => !currentScopes.has(s));
      if (missing.length > 0) {
        process.stderr.write(
          `[auth-and-poll] token missing scopes: ${missing.join(", ")} — re-authorizing\n`,
        );
        // Fall through to re-authorize with merged scopes.
        // Do NOT delete the old token here — keep it usable until the new
        // authorization succeeds and saveToken overwrites the file.
      } else {
        out({ status: "authorized", message: "用户已授权，且权限充足" });
        return;
      }
    } else {
      out({ status: "authorized", message: "用户已授权，无需重新授权" });
      return;
    }
  }

  // Build merged scope string: base + extra + existing token scopes (for upgrade)
  const tokenObj = readToken(openId, cfg.appId);
  const mergedScope = buildMergedScopes(extraScopesStr, tokenObj?.scope);

  // Check if there's a pending auth from a previous (possibly killed) run
  const existingPending = readPending(openId);
  if (
    existingPending &&
    existingPending.created_at + existingPending.expires_in * 1000 > Date.now()
  ) {
    process.stderr.write("[auth-and-poll] found existing pending auth, trying exchange first...\n");
    const json = await tryExchange(existingPending.device_code, cfg);
    if (!json.error && json.access_token) {
      saveAuthorizedToken(openId, cfg, json);
      await tryUpdateCardToGreen(openId);
      deletePending(openId);
      out({ status: "authorized", message: "授权成功！" });
      return;
    }
    process.stderr.write(
      `[auth-and-poll] existing pending not yet authorized (${json.error}), will re-use it\n`,
    );
    if (json.error === "authorization_pending" || json.error === "slow_down") {
      // Re-use existing pending — send card if not already sent, then poll
      if (!existingPending.message_id) {
        const cardResult = await sendCard({
          openId,
          chatId: resolvedChatId,
          title: "🔐 飞书授权",
          body: "**需要完成飞书授权才能继续操作**\n\n授权完成后将自动继续处理您的请求。",
          buttonText: "点击这里完成飞书授权",
          buttonUrl: existingPending.verification_uri,
          color: "blue",
        });
        if (cardResult.success && cardResult.message_id) {
          savePending(openId, { ...existingPending, message_id: cardResult.message_id });
          process.stderr.write(
            `[auth-and-poll] auth card sent for existing pending, message_id=${cardResult.message_id}\n`,
          );
        }
      }
      const result = await pollLoop(
        openId,
        cfg,
        existingPending,
        timeoutMs,
        existingPending.message_id,
      );
      out(result);
      if (result.status !== "authorized") process.exit(1);
      return;
    }
    // Other errors (expired, denied, etc.) — fall through to create new auth
  }

  // Init: get device code and auth URL with merged scopes
  const pending = await initSilent(openId, cfg, mergedScope);

  // Send auth card via public send-card module (3-level fallback built in)
  const cardResult = await sendCard({
    openId,
    chatId: resolvedChatId,
    title: "🔐 飞书授权",
    body: "**需要完成飞书授权才能继续操作**\n\n授权完成后将自动继续处理您的请求。",
    buttonText: "点击这里完成飞书授权",
    buttonUrl: pending.verification_uri,
    color: "blue",
  });
  if (cardResult.success && cardResult.message_id) {
    const currentPending = readPending(openId) || {};
    savePending(openId, { ...currentPending, message_id: cardResult.message_id });
    process.stderr.write(`[auth-and-poll] auth card sent, message_id=${cardResult.message_id}\n`);
  } else if (!cardResult.success) {
    out({
      status: "awaiting",
      url: pending.verification_uri,
      reply: cardResult.reply,
      message: "无法通过 IM 发送授权消息，请将 reply 内容直接展示给用户",
    });
    return;
  }

  // Internal poll loop — never returns polling_timeout to agent
  const result = await pollLoop(openId, cfg, pending, timeoutMs, cardResult.message_id);
  out(result);
  if (result.status !== "authorized") process.exit(1);
}

/**
 * Like init() but returns pending data without outputting JSON.
 */
async function initSilent(openId, cfg, scopeStr) {
  // Race-condition guard: if another process just created a pending (<10s ago), re-use it
  // to avoid sending two auth cards with different device codes simultaneously.
  const existingRecent = readPending(openId);
  if (
    existingRecent &&
    existingRecent.device_code &&
    Date.now() - existingRecent.created_at < 10000
  ) {
    process.stderr.write(
      "[auth] recent pending exists (<10s), re-using to prevent duplicate auth card\n",
    );
    return existingRecent;
  }

  const mergedScope = scopeStr || buildMergedScopes(null, null);
  const body = new URLSearchParams({ client_id: cfg.appId, scope: mergedScope });
  const res = await fetch("https://accounts.feishu.cn/oauth/v1/device_authorization", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(cfg.appId, cfg.appSecret),
    },
    body: body.toString(),
  });
  const rawText = await res.text();
  let json;
  try {
    json = JSON.parse(rawText);
  } catch (e) {
    die({
      status: "error",
      message: `API returned non-JSON (HTTP ${res.status}): ${rawText.slice(0, 300)}`,
    });
  }

  if (!res.ok || json.error) {
    die({
      status: "error",
      message: `Device authorization failed: ${json.error_description ?? json.error ?? rawText}`,
    });
  }

  const pending = {
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: json.verification_uri ?? json.verification_uri_complete,
    expires_in: json.expires_in ?? 240,
    interval: json.interval ?? 5,
    created_at: Date.now(),
  };
  savePending(openId, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// Step 2: complete (single attempt or polling)
// ---------------------------------------------------------------------------

async function complete(openId, cfg, poll) {
  let pending = readPending(openId);

  if (!pending || pending.created_at + pending.expires_in * 1000 <= Date.now()) {
    if (pending) deletePending(openId);
    await init(openId, cfg);
    pending = readPending(openId);
    if (!pending) {
      die({ status: "error", message: "授权初始化失败" });
    }
  }

  if (!poll) {
    const json = await tryExchange(pending.device_code, cfg);
    if (!json.error && json.access_token) {
      const tokenData = saveAuthorizedToken(openId, cfg, json);
      deletePending(openId);
      out({ status: "authorized", scope: tokenData.scope, message: "授权成功！" });
    } else {
      out({ status: "pending", message: "用户尚未完成授权" });
    }
    return;
  }

  const result = await pollUntilAuthorized(openId, cfg, pending);
  out(result);
  if (result.status !== "authorized") {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

async function revoke(openId, cfg) {
  deleteToken(openId, cfg.appId);
  deletePending(openId);
  out({ status: "revoked", message: "授权已清除" });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function status(openId, cfg) {
  const token = readToken(openId, cfg.appId);
  const pending = readPending(openId);
  const now = Date.now();

  if (!token && !pending) {
    out({ status: "unauthorized", message: "用户未授权" });
    return;
  }

  if (token) {
    const expiresAt = token.expiresAt ?? token.expires_at;
    const refreshExpiresAt = token.refreshExpiresAt ?? token.refresh_expires_at;
    const refreshToken = token.refreshToken ?? token.refresh_token;
    if (now < expiresAt - 5 * 60 * 1000) {
      out({ status: "valid", expires_at: expiresAt, scope: token.scope });
    } else if (refreshToken && now < refreshExpiresAt) {
      out({ status: "needs_refresh", message: "access_token 已过期但 refresh_token 有效" });
    } else {
      out({ status: "expired", message: "授权已完全过期，需重新授权" });
    }
    return;
  }

  if (pending) {
    const elapsed = now - pending.created_at;
    if (elapsed < pending.expires_in * 1000) {
      out({
        status: "awaiting",
        url: pending.verification_uri,
        remaining_seconds: Math.floor((pending.expires_in * 1000 - elapsed) / 1000),
      });
    } else {
      deletePending(openId);
      out({ status: "unauthorized", message: "授权链接已过期" });
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  if (!args.openId) {
    die({ status: "error", message: "--open-id 参数必填" });
  }
  if (!args.mode) {
    die({
      status: "error",
      message: "请指定模式：--auth-and-poll | --init | --complete [--poll] | --revoke | --status",
    });
  }

  let cfg;
  try {
    cfg = getConfig(__dirname);
  } catch (err) {
    die({ status: "error", message: err.message });
  }

  try {
    switch (args.mode) {
      case "auth-and-poll":
        await authAndPoll(
          args.openId,
          args.chatId,
          cfg,
          (args.timeout ?? 60) * 1000,
          args.extraScopes,
        );
        break;
      case "init":
        await init(
          args.openId,
          cfg,
          args.extraScopes ? buildMergedScopes(args.extraScopes, null) : undefined,
        );
        break;
      case "complete":
        await complete(args.openId, cfg, args.poll);
        break;
      case "revoke":
        await revoke(args.openId, cfg);
        break;
      case "status":
        await status(args.openId, cfg);
        break;
    }
  } catch (err) {
    die({ status: "error", message: err.message });
  }
}

main();
