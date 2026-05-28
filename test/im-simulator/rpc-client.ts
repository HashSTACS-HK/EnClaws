/**
 * Lightweight WS RPC client for the Gateway.
 *
 * Uses raw WebSocket instead of the full GatewayClient to keep things simple
 * and support JWT auth directly. Handles the connect challenge/handshake.
 */

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../../src/infra/device-identity.js";
import { rawDataToString } from "../../src/infra/ws.js";
import { buildDeviceAuthPayloadV3 } from "../../src/gateway/device-auth.js";
import { PROTOCOL_VERSION } from "../../src/gateway/protocol/index.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../src/utils/message-channel.js";
import type { ChatEventPayload } from "./types.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

export type RpcClientOptions = {
  url: string;
  /** Gateway shared token */
  gatewayToken?: string;
  /** JWT access token (for tenant-scoped operations) */
  jwt?: string;
  /** Connection timeout in ms (default: 10_000) */
  connectTimeoutMs?: number;
};

/**
 * A thin WS client that speaks the Gateway RPC protocol.
 *
 * Usage:
 *   const client = new RpcClient({ url: "ws://127.0.0.1:18789", gatewayToken: "tok" });
 *   await client.connect();
 *   const res = await client.request("auth.login", { email, password });
 *   client.close();
 */
export class RpcClient {
  private ws: WebSocket | null = null;
  private opts: RpcClientOptions;
  private pending = new Map<string, Pending>();
  private _events: ChatEventPayload[] = [];
  private _connected = false;

  constructor(opts: RpcClientOptions) {
    this.opts = opts;
  }

  /** Collected chat events (delta + final). */
  get events(): ChatEventPayload[] {
    return this._events;
  }

  get connected(): boolean {
    return this._connected;
  }

  // -----------------------------------------------------------------------
  // Connect
  // -----------------------------------------------------------------------

  async connect(): Promise<void> {
    const timeoutMs = this.opts.connectTimeoutMs ?? 10_000;

    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) {return;}
        settled = true;
        clearTimeout(timer);
        if (err) {reject(err);}
        else {
          this._connected = true;
          resolve();
        }
      };

      const timer = setTimeout(
        () => finish(new Error("RpcClient connect timeout")),
        timeoutMs,
      );

      const ws = new WebSocket(this.opts.url, {
        maxPayload: 25 * 1024 * 1024,
      });
      this.ws = ws;

      ws.once("error", (err) => finish(err));
      ws.once("close", (code, reason) =>
        finish(new Error(`closed during connect (${code}): ${rawDataToString(reason)}`)),
      );

      ws.on("message", (raw) => {
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(rawDataToString(raw)) as Record<string, unknown>;
        } catch {
          return;
        }

        // 1) Connect challenge → reply with connect params
        if (obj.type === "event" && obj.event === "connect.challenge") {
          const nonce = (obj.payload as { nonce?: string } | null)?.nonce;
          if (typeof nonce === "string" && nonce.trim()) {
            this.sendConnectParams(nonce.trim());
          }
          return;
        }

        // 2) Hello-ok → connected
        //    Gateway wraps it as { type:"res", id:"connect", ok:true, payload:{ type:"hello-ok", ... } }
        if (
          obj.type === "hello-ok" ||
          (obj.type === "res" && obj.id === "connect" && obj.ok)
        ) {
          finish();
          return;
        }

        // 2b) Connect rejected
        if (obj.type === "res" && obj.id === "connect" && !obj.ok) {
          const errObj = obj.error as { message?: string } | undefined;
          finish(new Error(errObj?.message ?? `connect rejected: ${JSON.stringify(obj.error)}`));
          return;
        }

        // 3) RPC response
        if (obj.type === "res") {
          const id = obj.id as string;
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            if (obj.ok) {
              p.resolve(obj.payload ?? obj);
            } else {
              const errObj = obj.error as { message?: string } | undefined;
              p.reject(new Error(errObj?.message ?? `RPC error: ${JSON.stringify(obj.error)}`));
            }
          }
          return;
        }

        // 4) Chat events
        if (obj.type === "event" && obj.event === "chat") {
          this._events.push(obj.payload as ChatEventPayload);
          return;
        }
      });
    });
  }

  // -----------------------------------------------------------------------
  // RPC
  // -----------------------------------------------------------------------

  async request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("RpcClient not connected");
    }
    const id = randomUUID();
    const frame = { type: "req", id, method, params };
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  // -----------------------------------------------------------------------
  // Close
  // -----------------------------------------------------------------------

  close() {
    this._connected = false;
    if (this.ws) {
      try {
        this.ws.close(1000, "test client closing");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    // Reject all pending
    for (const [, p] of this.pending) {
      p.reject(new Error("client closed"));
    }
    this.pending.clear();
  }

  /** Clear collected chat events. */
  clearEvents() {
    this._events.length = 0;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private sendConnectParams(nonce: string) {
    const identity = loadOrCreateDeviceIdentity();
    const signedAtMs = Date.now();
    const platform = process.platform;
    const role = "operator";
    const scopes = ["operator.admin", "operator.read", "operator.write"];

    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
      role,
      scopes,
      signedAtMs,
      token: this.opts.gatewayToken ?? null,
      nonce,
      platform,
    });
    const signature = signDevicePayload(identity.privateKeyPem, payload);

    const auth: Record<string, unknown> = {};
    if (this.opts.gatewayToken) {
      auth.token = this.opts.gatewayToken;
    }
    if (this.opts.jwt) {
      // JWT can be passed as auth.jwt or as auth.token (if it contains dots).
      // Use the dedicated field when available.
      auth.jwt = this.opts.jwt;
    }

    const connectFrame = {
      type: "req",
      id: "connect",
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: GATEWAY_CLIENT_NAMES.TEST,
          displayName: "im-simulator",
          version: "dev",
          platform,
          mode: GATEWAY_CLIENT_MODES.TEST,
        },
        caps: [],
        auth: Object.keys(auth).length > 0 ? auth : undefined,
        role,
        scopes,
        device: {
          id: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
          signature,
          signedAt: signedAtMs,
          nonce,
        },
      },
    };
    this.ws?.send(JSON.stringify(connectFrame));
  }
}
