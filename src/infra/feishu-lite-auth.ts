/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu "lightweight auth" driver — implemented in core, with zero plugin dependencies.
 *
 * Flow (invoked by `auth-gate.ts::coreAuthGate`):
 *   1. Use the OAuth Device Authorization Grant (RFC 8628) to request the
 *      minimal `offline_access` scope, obtaining a device code + verification URL.
 *   2. DM the user an interactive card containing the verification URL
 *      **via receive_id_type='open_id'** — Feishu routes this into the
 *      bot↔user p2p chat automatically. If the user is a stranger the
 *      request is blocked with 230013 and the driver returns
 *      delivered=false, letting the gate clear the cooldown and retry.
 *   3. Poll the token endpoint asynchronously until the user approves, denies,
 *      or the code expires.
 *   4. Once we have a UAT, call `/open-apis/authen/v1/user_info` to fetch
 *      the user's name. That endpoint requires no extra business scope — a
 *      valid UAT is enough to return name / en_name.
 *   5. Call the gate-provided `onComplete(name)` — the gate persists the name
 *      to DB and replays the queued inbound message.
 *
 * Differences vs. the plugin path
 * (`extensions/openclaw-lark/src/tools/oauth.ts::executeAuthorize`):
 *   - Purely fetch-based; does not depend on the Lark SDK (keeps core
 *     decoupled from plugins).
 *   - **Does not store the token** — once the name has been persisted the
 *     token is discarded (good enough, refresh scenarios are very rare).
 *   - Does not reuse the plugin's cardkit (we lose some card-update
 *     animations but keep zero plugin dependencies).
 *   - Does not run an owner check (any user can authorize themselves, which
 *     is exactly what happens here).
 *
 * Registration: this module calls `registerAuthDriver(feishuLiteAuthDriver)`
 * at the top level. `auth-gate-bootstrap.ts` just has to `import` this file
 * at boot and the driver self-registers.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { AuthGateDriver } from "./auth-gate.js";
import { registerAuthDriver } from "./auth-gate.js";
import { extractFeishuCredentials, getTenantAccessToken } from "./feishu-user-resolve.js";

const log = createSubsystemLogger("feishu-lite-auth");

const LITE_SCOPE = "offline_access";

// ---------------------------------------------------------------------------
// Lark/Feishu OAuth endpoints (defaults to the Chinese Feishu hosts; international Lark TODO).
// ---------------------------------------------------------------------------

const DEVICE_AUTH_URL = "https://accounts.feishu.cn/oauth/v1/device_authorization";
const TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
const IM_MESSAGE_CREATE_URL =
  "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id";

// ---------------------------------------------------------------------------
// Step 1: device authorization request
// ---------------------------------------------------------------------------

interface DeviceAuthResponse {
  deviceCode: string;
  verificationUriComplete: string;
  expiresIn: number; // seconds
  interval: number; // seconds
}

async function requestDeviceAuthorization(
  appId: string,
  appSecret: string,
): Promise<DeviceAuthResponse | null> {
  try {
    const basicAuth = Buffer.from(`${appId}:${appSecret}`).toString("base64");
    const body = new URLSearchParams();
    body.set("client_id", appId);
    body.set("scope", LITE_SCOPE);

    const res = await fetch(DEVICE_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: body.toString(),
    });

    const text = await res.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      log.warn(
        `device authorization response not JSON: status=${res.status} body=${text.slice(0, 200)}`,
      );
      return null;
    }

    if (!res.ok || data.error) {
      log.warn(`device authorization failed: ${data.error_description ?? data.error ?? "unknown"}`);
      return null;
    }

    return {
      deviceCode: data.device_code as string,
      verificationUriComplete:
        (data.verification_uri_complete as string) ?? (data.verification_uri as string),
      expiresIn: (data.expires_in as number) ?? 240,
      interval: (data.interval as number) ?? 5,
    };
  } catch (err) {
    log.warn(`requestDeviceAuthorization fetch failed: ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 2: poll token endpoint
// ---------------------------------------------------------------------------

interface PolledToken {
  accessToken: string;
  expiresIn: number;
  scope: string;
}

async function pollDeviceToken(
  appId: string,
  appSecret: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<PolledToken | null> {
  const deadline = Date.now() + expiresIn * 1000;
  let currentInterval = Math.max(1, interval);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, currentInterval * 1000));

    try {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: appId,
          client_secret: appSecret,
        }).toString(),
      });
      const data = (await res.json()) as Record<string, unknown>;

      if (!data.error && data.access_token) {
        return {
          accessToken: data.access_token as string,
          expiresIn: (data.expires_in as number) ?? 7200,
          scope: (data.scope as string) ?? "",
        };
      }

      const error = data.error as string | undefined;
      if (error === "authorization_pending") {
        continue;
      }
      if (error === "slow_down") {
        currentInterval = Math.min(currentInterval + 5, 60);
        continue;
      }
      if (error === "access_denied" || error === "expired_token" || error === "invalid_grant") {
        log.info(`device flow ended: ${error}`);
        return null;
      }
      log.warn(`unexpected token poll error: ${error ?? JSON.stringify(data).slice(0, 200)}`);
      return null;
    } catch (err) {
      log.warn(`token poll fetch failed: ${String(err)}`);
      // Transient network hiccup — try again next iteration.
    }
  }
  log.info(`device flow timed out after ${expiresIn}s`);
  return null;
}

// ---------------------------------------------------------------------------
// Step 3: fetch user_info to get the display name
// ---------------------------------------------------------------------------

async function fetchUserName(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USER_INFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as {
      code?: number;
      data?: { name?: string; en_name?: string };
    };
    if (data.code !== 0) {
      log.warn(`/authen/v1/user_info returned code=${data.code}`);
      return null;
    }
    return data.data?.name || data.data?.en_name || null;
  } catch (err) {
    log.warn(`fetchUserName failed: ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 4: build interactive auth card and send via DM
// ---------------------------------------------------------------------------

function buildLiteAuthCard(verificationUrl: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "请授权以继续" },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "我需要获取你的基本资料（如昵称、头像）。授权范围最小，可随时撤销。",
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "前往授权" },
            type: "primary",
            multi_url: {
              url: verificationUrl,
              pc_url: verificationUrl,
              android_url: verificationUrl,
              ios_url: verificationUrl,
            },
          },
        ],
      },
    ],
  };
}

async function sendInteractiveDm(
  tenantToken: string,
  receiverOpenId: string,
  card: Record<string, unknown>,
): Promise<{ ok: boolean; reason?: string; messageId?: string }> {
  try {
    const res = await fetch(IM_MESSAGE_CREATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tenantToken}`,
      },
      body: JSON.stringify({
        receive_id: receiverOpenId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    });
    const data = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: { message_id?: string };
    };
    if (data.code !== 0) {
      return { ok: false, reason: `feishu code=${data.code} msg=${data.msg ?? ""}` };
    }
    return { ok: true, messageId: data.data?.message_id };
  } catch (err) {
    return { ok: false, reason: `fetch failed: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Step 5: build the success card and patch the original DM card in place.
// ---------------------------------------------------------------------------

/**
 * Builds the "auth complete" card used to replace the original DM card after
 * a successful authorization. Button-less by design — we do not want users
 * clicking the OAuth link again once it has already been consumed.
 */
function buildLiteAuthSuccessCard(name: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "✅ 授权完成" },
      template: "green",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `你好 **${name}**，已成功获取你的基本资料～现在可以正常对话了。`,
        },
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "如需撤销授权，可随时告诉我。",
          },
        ],
      },
    ],
  };
}

/**
 * Replace an already-sent interactive card in place using
 * `PATCH /open-apis/im/v1/messages/{message_id}`. Feishu expects the PATCH
 * body as `{ content: "<json string>" }` where content is the new card
 * serialized as a JSON string.
 */
async function patchInteractiveCard(
  tenantToken: string,
  messageId: string,
  newCard: Record<string, unknown>,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tenantToken}`,
      },
      body: JSON.stringify({
        content: JSON.stringify(newCard),
      }),
    });
    const data = (await res.json()) as { code?: number; msg?: string };
    if (data.code !== 0) {
      return { ok: false, reason: `feishu code=${data.code} msg=${data.msg ?? ""}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `fetch failed: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Driver implementation
// ---------------------------------------------------------------------------

export const feishuLiteAuthDriver: AuthGateDriver = {
  provider: "feishu",

  async triggerAuth(params) {
    const { ctx, cfg, onComplete } = params;
    const senderId = ctx.SenderId;
    if (!senderId) {
      return { delivered: false, reason: "no-sender-id" };
    }

    // 1. Look up the appId / appSecret for this account.
    const accountId = (ctx as Record<string, unknown>).AccountId as string | undefined;
    const creds = extractFeishuCredentials(
      cfg as unknown as Record<string, unknown>,
      "feishu",
      accountId,
    );
    if (!creds) {
      return { delivered: false, reason: "no-credentials" };
    }

    // 2. Fetch a tenant access token (used to send the IM card).
    const tenantToken = await getTenantAccessToken(creds.appId, creds.appSecret);
    if (!tenantToken) {
      return { delivered: false, reason: "tenant-token-failed" };
    }

    // 3. Request device authorization.
    const deviceAuth = await requestDeviceAuthorization(creds.appId, creds.appSecret);
    if (!deviceAuth) {
      return { delivered: false, reason: "device-auth-failed" };
    }

    // 4. Build the card and DM it to the user.
    const card = buildLiteAuthCard(deviceAuth.verificationUriComplete);
    const sendResult = await sendInteractiveDm(tenantToken, senderId, card);
    if (!sendResult.ok) {
      log.warn(`DM send failed for ${senderId}: ${sendResult.reason}`);
      return { delivered: false, reason: sendResult.reason };
    }
    // Remember the message_id so we can PATCH this card into the success card later.
    const originalCardMessageId = sendResult.messageId;
    log.info(
      `lite-auth DM delivered to ${senderId} (message_id=${originalCardMessageId ?? "unknown"}), polling device flow in background`,
    );

    // 5. Poll for the token in the background; once we have the name, invoke
    //    onComplete (the gate persists to DB + replays the queued message).
    setImmediate(async () => {
      const token = await pollDeviceToken(
        creds.appId,
        creds.appSecret,
        deviceAuth.deviceCode,
        deviceAuth.interval,
        deviceAuth.expiresIn,
      );
      if (!token) {
        return;
      }
      const name = await fetchUserName(token.accessToken);
      if (!name) {
        log.warn(`got UAT for ${senderId} but /authen/v1/user_info returned no name`);
        return;
      }
      log.info(`lite-auth complete: ${senderId} → "${name}"`);

      // 5a. PATCH the original DM card into the success card so the "go authorize"
      //     button does not linger once authorization is done. We refresh the tenant
      //     token first — the one from step 2 may have expired (the user may have
      //     taken a long time to click).
      if (originalCardMessageId) {
        try {
          const freshTenantToken = await getTenantAccessToken(creds.appId, creds.appSecret);
          if (freshTenantToken) {
            const successCard = buildLiteAuthSuccessCard(name);
            const patchResult = await patchInteractiveCard(
              freshTenantToken,
              originalCardMessageId,
              successCard,
            );
            if (patchResult.ok) {
              log.info(`lite-auth card patched to "授权完成" for ${senderId}`);
            } else {
              log.warn(`failed to patch lite-auth card for ${senderId}: ${patchResult.reason}`);
            }
          }
        } catch (err) {
          log.warn(`patch lite-auth card threw for ${senderId}: ${String(err)}`);
        }
      }

      // 5b. Fire the gate's onComplete (writes the name to DB + replays the stashed message).
      try {
        await onComplete(name);
      } catch (err) {
        log.error(`onComplete callback threw for ${senderId}: ${String(err)}`);
      }
    });

    return { delivered: true };
  },
};

// Self-register at module load time.
registerAuthDriver(feishuLiteAuthDriver);
