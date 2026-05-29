"use strict";
/**
 * Feishu per-user OAuth token utilities.
 *
 * Token storage is compatible with openclaw-lark's token-store.ts:
 *   - Same directory: %LOCALAPPDATA%\openclaw-feishu-uat\ (Win) or
 *                     ~/.local/share/openclaw-feishu-uat/ (Linux/Mac)
 *   - Same encryption: AES-256-GCM with a local master.key
 *   - Same file naming: {appId}_{userOpenId}.enc
 *   - Same JSON fields: camelCase (accessToken, refreshToken, expiresAt, ...)
 *
 * Pending auth state (Device Flow) is stored separately as plain JSON in
 * feishu-auth/.tokens/{open_id}/pending_auth.json — this is feishu-auth-specific
 * and has no openclaw-lark equivalent.
 *
 * Credential resolution (cascading fallback):
 *   1. Env vars FEISHU_APP_ID + FEISHU_APP_SECRET
 *   2. config.json in skill directory or feishu-auth/
 *   3. openclaw.json in workspace root
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const AUTH_DIR = __dirname;

// ---------------------------------------------------------------------------
// Encrypted token store (compatible with openclaw-lark token-store.ts)
// ---------------------------------------------------------------------------

const KEYCHAIN_SERVICE = "openclaw-feishu-uat";
const MASTER_KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM recommended
const TAG_BYTES = 16; // GCM auth tag
const REFRESH_AHEAD_MS = 5 * 60 * 1000; // 5 minutes

function getUATDir() {
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ||
      path.join(process.env.USERPROFILE || os.homedir(), "AppData", "Local");
    return path.join(localAppData, KEYCHAIN_SERVICE);
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdgData, KEYCHAIN_SERVICE);
}

function safeFileName(appId, userOpenId) {
  const account = `${appId}:${userOpenId}`;
  return account.replace(/[^a-zA-Z0-9._-]/g, "_") + ".enc";
}

function getMasterKeyPath() {
  return path.join(getUATDir(), "master.key");
}

function getOrCreateMasterKey() {
  const dir = getUATDir();
  const keyPath = getMasterKeyPath();

  // Try to read existing key
  if (fs.existsSync(keyPath)) {
    const key = fs.readFileSync(keyPath);
    if (key.length === MASTER_KEY_BYTES) return key;
    // Wrong length — regenerate
    process.stderr.write("[token-utils] master key has unexpected length, regenerating\n");
  }

  // Generate new key
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(MASTER_KEY_BYTES);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch (_) {}
  process.stderr.write("[token-utils] generated new master key\n");
  return key;
}

function encryptToken(plaintext) {
  const key = getOrCreateMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

function decryptToken(data) {
  if (data.length < IV_BYTES + TAG_BYTES) return null;
  try {
    const key = getOrCreateMasterKey();
    const iv = data.subarray(0, IV_BYTES);
    const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const enc = data.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function getTokenFilePath(openId, appId) {
  return path.join(getUATDir(), safeFileName(appId, openId));
}

// ---------------------------------------------------------------------------
// Token read / write (encrypted, openclaw-lark compatible)
// ---------------------------------------------------------------------------

function readToken(openId, appId) {
  const filePath = getTokenFilePath(openId, appId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = fs.readFileSync(filePath);
    const json = decryptToken(data);
    if (!json) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function saveToken(openId, appId, tokenData) {
  // Normalise to camelCase (openclaw-lark compatible)
  const stored = {
    userOpenId: openId,
    appId: appId,
    accessToken: tokenData.accessToken ?? tokenData.access_token,
    refreshToken: tokenData.refreshToken ?? tokenData.refresh_token,
    expiresAt: tokenData.expiresAt ?? tokenData.expires_at,
    refreshExpiresAt: tokenData.refreshExpiresAt ?? tokenData.refresh_expires_at,
    scope: tokenData.scope,
    grantedAt: tokenData.grantedAt ?? tokenData.granted_at ?? Date.now(),
  };
  const dir = getUATDir();
  fs.mkdirSync(dir, { recursive: true });
  const encrypted = encryptToken(JSON.stringify(stored));
  fs.writeFileSync(getTokenFilePath(openId, appId), encrypted);
}

function deleteToken(openId, appId) {
  const filePath = getTokenFilePath(openId, appId);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ---------------------------------------------------------------------------
// Pending auth (Device Flow state) — plain JSON, feishu-auth internal
// ---------------------------------------------------------------------------

function getPendingDir(openId) {
  return path.join(AUTH_DIR, ".tokens", openId);
}

function getPendingPath(openId) {
  return path.join(getPendingDir(openId), "pending_auth.json");
}

function readPending(openId) {
  const p = getPendingPath(openId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function savePending(openId, data) {
  const p = getPendingPath(openId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function deletePending(openId) {
  const p = getPendingPath(openId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ---------------------------------------------------------------------------
// Config (unchanged)
// ---------------------------------------------------------------------------

function getConfig(callerDir) {
  const envAppId = process.env.FEISHU_APP_ID;
  const envAppSecret = process.env.FEISHU_APP_SECRET;
  if (envAppId && envAppSecret) {
    return {
      appId: envAppId,
      appSecret: envAppSecret,
      brand: process.env.FEISHU_BRAND || "feishu",
    };
  }

  const candidates = [];
  if (callerDir && callerDir !== AUTH_DIR) candidates.push(path.join(callerDir, "config.json"));
  candidates.push(path.join(AUTH_DIR, "config.json"));

  for (const cfgPath of candidates) {
    if (fs.existsSync(cfgPath)) {
      let cfg;
      try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      } catch (e) {
        throw new Error(`Failed to parse ${cfgPath}: ${e.message}`);
      }
      if (cfg.appId && cfg.appSecret) return cfg;
    }
  }

  const openclawCfg = tryLoadOpenClawConfig();
  if (openclawCfg) return openclawCfg;

  throw new Error(
    "appId/appSecret not configured. Checked: env FEISHU_APP_ID/FEISHU_APP_SECRET, " +
      path.join(AUTH_DIR, "config.json") +
      ", openclaw.json in workspace root",
  );
}

function tryLoadOpenClawConfig() {
  const candidates = [
    path.join(os.homedir(), ".openclaw", "openclaw.json"),
    path.resolve(AUTH_DIR, "..", "..", "..", "openclaw.json"),
    path.resolve(AUTH_DIR, "..", "..", "openclaw.json"),
  ];
  const cfgPath = candidates.find((p) => fs.existsSync(p));
  if (!cfgPath) return null;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    return null;
  }

  const feishuCfg = raw?.channels?.feishu;
  if (!feishuCfg) return null;

  if (feishuCfg.appId && feishuCfg.appSecret) {
    return { appId: feishuCfg.appId, appSecret: feishuCfg.appSecret, brand: "feishu" };
  }

  const accounts = feishuCfg.accounts;
  if (accounts && typeof accounts === "object") {
    for (const acc of Object.values(accounts)) {
      if (acc && acc.appId && acc.appSecret && acc.enabled !== false) {
        return { appId: acc.appId, appSecret: acc.appSecret, brand: "feishu" };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

async function refreshAccessToken(appId, appSecret, refreshToken) {
  // Use the same OAuth token endpoint as Device Flow (compatible with openclaw-lark)
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: appId,
    client_secret: appSecret,
  });
  const res = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Token refresh non-JSON (HTTP ${res.status}): ${rawText.slice(0, 300)}`);
  }
  // OAuth token endpoint returns fields at top level (not nested in data)
  const error = data.error;
  if (error)
    throw new Error(`Token refresh failed: error=${error} desc=${data.error_description || ""}`);
  if (data.code !== undefined && data.code !== 0)
    throw new Error(`Token refresh failed: code=${data.code} msg=${data.msg}`);
  // Return top-level fields directly (access_token, refresh_token, expires_in, etc.)
  return data;
}

async function tryDeviceCodeExchange(appId, appSecret, deviceCode) {
  try {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: appId,
      client_secret: appSecret,
    });
    const res = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// getValidToken — public API (signature unchanged)
// ---------------------------------------------------------------------------

async function getValidToken(openId, appId, appSecret) {
  const token = readToken(openId, appId);

  if (!token) {
    // No saved token — check pending device auth
    const pending = readPending(openId);
    if (pending && Date.now() < pending.created_at + pending.expires_in * 1000) {
      const json = await tryDeviceCodeExchange(appId, appSecret, pending.device_code);
      if (json && !json.error && json.access_token) {
        const now = Date.now();
        saveToken(openId, appId, {
          accessToken: json.access_token,
          refreshToken: json.refresh_token,
          expiresAt: now + (json.expires_in ?? 7200) * 1000,
          refreshExpiresAt: now + (json.refresh_token_expires_in ?? 604800) * 1000,
          scope: json.scope,
          grantedAt: now,
        });
        deletePending(openId);
        return json.access_token;
      }
    }
    return null;
  }

  const now = Date.now();
  const expiresAt = token.expiresAt ?? token.expires_at;
  const refreshExpiresAt = token.refreshExpiresAt ?? token.refresh_expires_at;
  const refreshToken = token.refreshToken ?? token.refresh_token;
  const accessToken = token.accessToken ?? token.access_token;

  // Access token still valid
  if (now < expiresAt - REFRESH_AHEAD_MS) return accessToken;

  // Try refresh
  if (refreshToken && now < refreshExpiresAt) {
    try {
      const refreshed = await refreshAccessToken(appId, appSecret, refreshToken);
      const newRefreshExpiresAt = refreshed.refresh_token_expires_in
        ? now + refreshed.refresh_token_expires_in * 1000
        : refreshExpiresAt; // preserve original if API doesn't return new value
      saveToken(openId, appId, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? refreshToken,
        expiresAt: now + (refreshed.expires_in ?? 7200) * 1000,
        refreshExpiresAt: newRefreshExpiresAt,
        scope: refreshed.scope ?? token.scope,
        grantedAt: token.grantedAt ?? token.granted_at,
      });
      process.stderr.write(`[token-utils] refreshed token for ${openId}\n`);
      return refreshed.access_token;
    } catch (err) {
      process.stderr.write(`[token-utils] refresh failed for ${openId}: ${err.message}\n`);
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getConfig,
  getTokenFilePath, // replaces getTokenPath
  getPendingPath,
  readToken,
  saveToken,
  readPending,
  savePending,
  deletePending,
  deleteToken,
  getValidToken,
};
