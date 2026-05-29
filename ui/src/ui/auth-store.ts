/**
 * Browser-side JWT auth store.
 *
 * Manages access tokens, refresh tokens, and user/tenant context
 * for multi-tenant mode. Stored in localStorage with automatic
 * token refresh before expiry.
 */

import { loadSettings } from "./storage.ts";
import { generateUUID } from "./uuid.ts";

const AUTH_KEY = "enclaws.auth.v1";

/**
 * Hash a password with SHA-256 before sending over the wire.
 * Returns a hex-encoded digest so plaintext never leaves the browser.
 *
 * Uses Web Crypto when available (secure contexts: HTTPS or localhost),
 * and falls back to a pure-JS SHA-256 implementation when accessed over
 * plain HTTP from a non-localhost host (LAN IP, dev box, etc.) where
 * `crypto.subtle` is undefined per browser spec.
 */
export async function hashPasswordForTransport(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return sha256Hex(data);
}

/**
 * Pure-JS SHA-256 fallback for non-secure contexts (HTTP + non-localhost)
 * where `crypto.subtle` is unavailable. ~50 lines, no external deps.
 */
function sha256Hex(message: Uint8Array): string {
  // Initial hash values (first 32 bits of fractional parts of square roots
  // of the first 8 primes 2..19)
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  // Round constants (first 32 bits of fractional parts of cube roots of
  // the first 64 primes 2..311)
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const msgLen = message.length;
  const bitLen = msgLen * 8;
  // Pre-processing: append 0x80, pad with zeros, append 64-bit length
  const padLen = (msgLen + 9 + 63) & ~63;
  const padded = new Uint8Array(padLen);
  padded.set(message);
  padded[msgLen] = 0x80;
  // Length in bits as a 64-bit big-endian integer (high 32 bits = 0 for
  // any input < 2^32 bytes, which password fields always are)
  padded[padLen - 4] = (bitLen >>> 24) & 0xff;
  padded[padLen - 3] = (bitLen >>> 16) & 0xff;
  padded[padLen - 2] = (bitLen >>> 8) & 0xff;
  padded[padLen - 1] = bitLen & 0xff;

  const W = new Uint32Array(64);
  for (let chunk = 0; chunk < padLen; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      const j = chunk + i * 4;
      W[i] = (padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [H[0], H[1], H[2], H[3], H[4], H[5], H[6], H[7]];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += H[i].toString(16).padStart(8, "0");
  }
  return hex;
}

function rotr(n: number, b: number): number {
  return ((n >>> b) | (n << (32 - b))) >>> 0;
}

// ── Shared gateway client for token refresh ──────────────────
// Set by app-gateway.ts when the main connection is established.
// Allows refreshAccessToken to reuse the existing WebSocket
// instead of creating a throwaway connection each time.
type RpcClient = { request<T>(method: string, params?: unknown): Promise<T> };
let sharedClient: RpcClient | null = null;

export function setRefreshClient(client: RpcClient | null): void {
  sharedClient = client;
}

/** Minimum interval between refresh attempts (throttle). */
const REFRESH_THROTTLE_MS = 300_000;

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  displayName: string | null;
  tenantId: string;
  /** Phase 1 — set on first login after invite or admin reset. */
  forceChangePassword?: boolean;
}

/** Thrown by login() when the gateway returns RATE_LIMITED. */
export class LoginRateLimitedError extends Error {
  constructor(
    public readonly retryAfterMs: number,
    message: string,
  ) {
    super(message);
    this.name = "LoginRateLimitedError";
  }
}

/** Thrown by login() when the server requires MFA (Phase 3). */
export class LoginMfaRequiredError extends Error {
  constructor(public readonly challengeToken: string) {
    super("MFA required");
    this.name = "LoginMfaRequiredError";
  }
}

/** Thrown by register() when email verification is required (Phase 3). */
export class RegisterPendingVerificationError extends Error {
  constructor(public readonly email: string) {
    super("Email verification required");
    this.name = "RegisterPendingVerificationError";
  }
}

/**
 * Thrown by login / register / requestForgotPassword when the graphic
 * captcha is missing, wrong, or expired. Callers should refresh the
 * captcha widget and prompt the user to re-enter.
 */
export class CaptchaInvalidError extends Error {
  constructor(message: string = "图形验证码错误或已过期") {
    super(message);
    this.name = "CaptchaInvalidError";
  }
}

export interface AuthTenant {
  id: string;
  name: string;
  plan?: string;
}

export interface AuthState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in ms
  user: AuthUser;
  tenant: AuthTenant;
  /** Phase 2: password expiry timestamp (epoch ms). Absent when policy is disabled. */
  pwExp?: number;
}

let currentAuth: AuthState | null = null;

/**
 * Load auth state from localStorage.
 */
export function loadAuth(): AuthState | null {
  if (currentAuth) {
    return currentAuth;
  }
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as AuthState;
    if (!parsed.accessToken || !parsed.refreshToken) {
      return null;
    }
    // Check if expired and no refresh possible
    if (parsed.expiresAt < Date.now() && !parsed.refreshToken) {
      return null;
    }
    currentAuth = parsed;
    // Ensure activity listener is running (covers page reload scenario)
    startActivityListener();
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save auth state to localStorage and memory.
 */
export function saveAuth(auth: AuthState): void {
  currentAuth = auth;
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
  // Prevent activity listener from triggering a refresh immediately after login/refresh
  lastRefreshAttempt = Date.now();
  startActivityListener();
}

/**
 * Clear auth state (logout).
 */
export function clearAuth(): void {
  currentAuth = null;
  localStorage.removeItem(AUTH_KEY);
  stopActivityListener();
}

/**
 * Check if the user is authenticated.
 */
export function isAuthenticated(): boolean {
  const auth = loadAuth();
  return auth !== null && (auth.expiresAt > Date.now() || !!auth.refreshToken);
}

/**
 * Get the current access token, or null if not authenticated.
 */
export function getAccessToken(): string | null {
  const auth = loadAuth();
  if (!auth) {
    return null;
  }
  if (auth.expiresAt > Date.now()) {
    return auth.accessToken;
  }
  return null; // Token expired, needs refresh
}

// ── Activity-based token refresh ──────────────────────────────
let activityListenerActive = false;
let lastRefreshAttempt = 0;
let refreshing = false;

/**
 * Called on user activity. If the token is within the refresh window,
 * trigger a refresh (throttled).
 */
async function onUserActivity(): Promise<void> {
  if (refreshing) {
    return;
  }
  const auth = currentAuth ?? loadAuth();
  if (!auth?.refreshToken) {
    return;
  }

  const now = Date.now();

  // Throttle: don't refresh too frequently
  if (now - lastRefreshAttempt < REFRESH_THROTTLE_MS) {
    return;
  }

  lastRefreshAttempt = now;
  refreshing = true;
  try {
    const result = await refreshAccessToken();
    if (!result && auth?.refreshToken) {
      // Refresh token was rejected (revoked or expired) — force re-login
      clearAuth();
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
  } catch {
    // silent — will retry on next user activity
  } finally {
    refreshing = false;
  }
}

function startActivityListener(): void {
  if (activityListenerActive) {
    return;
  }
  activityListenerActive = true;
  for (const evt of ["click", "keydown", "scroll", "mousemove", "touchstart"]) {
    document.addEventListener(evt, onUserActivity, { passive: true, capture: true });
  }
}

function stopActivityListener(): void {
  if (!activityListenerActive) {
    return;
  }
  activityListenerActive = false;
  for (const evt of ["click", "keydown", "scroll", "mousemove", "touchstart"]) {
    document.removeEventListener(evt, onUserActivity, true);
  }
}

/**
 * Refresh the access token using the refresh token.
 * Reuses the main gateway WebSocket when available; falls back to
 * a temporary connection otherwise (e.g. before the main client starts).
 */
export async function refreshAccessToken(): Promise<AuthState | null> {
  const auth = loadAuth();
  if (!auth?.refreshToken) {
    return null;
  }

  // Fast path: reuse the existing gateway connection
  if (sharedClient) {
    try {
      const p = await sharedClient.request<{
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
      }>("auth.refresh", { refreshToken: auth.refreshToken });

      const newAuth: AuthState = {
        ...auth,
        accessToken: p.accessToken,
        refreshToken: p.refreshToken,
        expiresAt: Date.now() + p.expiresIn * 1000,
      };
      saveAuth(newAuth);
      return newAuth;
    } catch {
      // Main connection may be down — fall through to temporary WS
    }
  }

  // Fallback: temporary WebSocket (used during login/register flows)
  const settings = loadSettings();
  const wsUrl = settings.gatewayUrl;

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let handshakeDone = false;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "req",
          id: generateUUID(),
          method: "connect",
          params: buildConnectParams(),
        }),
      );
    };

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === "res" && !handshakeDone) {
          handshakeDone = true;
          ws.send(
            JSON.stringify({
              type: "req",
              id: generateUUID(),
              method: "auth.refresh",
              params: { refreshToken: auth.refreshToken },
            }),
          );
          return;
        }
        if (frame.type === "res" && handshakeDone) {
          ws.close();
          if (frame.ok && frame.payload) {
            const p = frame.payload as {
              accessToken: string;
              refreshToken: string;
              expiresIn: number;
            };
            const newAuth: AuthState = {
              ...auth,
              accessToken: p.accessToken,
              refreshToken: p.refreshToken,
              expiresAt: Date.now() + p.expiresIn * 1000,
            };
            saveAuth(newAuth);
            resolve(newAuth);
          } else {
            resolve(null);
          }
        }
      } catch {
        resolve(null);
      }
    };

    ws.onerror = () => resolve(null);

    setTimeout(() => {
      ws.close();
      resolve(null);
    }, 10_000);
  });
}

function buildConnectParams() {
  const settings = loadSettings();
  const gatewayToken = settings.token || undefined;
  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "webchat",
      version: "dev",
      platform: navigator.platform ?? "web",
      mode: "webchat",
      instanceId: generateUUID(),
    },
    role: "operator",
    scopes: [],
    caps: [],
    auth: gatewayToken ? { token: gatewayToken } : undefined,
  };
}

/**
 * Login with email and password. Returns auth state on success.
 */
export async function login(params: {
  gatewayUrl: string;
  email: string;
  password: string;
  captchaId: string;
  captchaAnswer: string;
}): Promise<AuthState> {
  const hashedPassword = await hashPasswordForTransport(params.password);
  return new Promise((resolve, reject) => {
    const wsUrl = params.gatewayUrl;
    const ws = new WebSocket(wsUrl);
    let handshakeDone = false;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "req",
          id: generateUUID(),
          method: "connect",
          params: buildConnectParams(),
        }),
      );
    };

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === "res" && !handshakeDone) {
          handshakeDone = true;
          ws.send(
            JSON.stringify({
              type: "req",
              id: generateUUID(),
              method: "auth.login",
              params: {
                email: params.email,
                password: hashedPassword,
                captchaId: params.captchaId,
                captchaAnswer: params.captchaAnswer,
              },
            }),
          );
          return;
        }
        if (frame.type === "res" && handshakeDone) {
          ws.close();
          if (frame.ok && frame.payload) {
            const p = frame.payload;
            // Phase 3: MFA required — server returns challengeToken instead of JWT
            if (p.mfaRequired && p.mfaChallengeToken) {
              reject(new LoginMfaRequiredError(p.mfaChallengeToken));
              return;
            }
            const auth: AuthState = {
              accessToken: p.accessToken,
              refreshToken: p.refreshToken,
              expiresAt: Date.now() + p.expiresIn * 1000,
              user: {
                id: p.user.id,
                email: p.user.email,
                role: p.user.role,
                displayName: p.user.displayName,
                tenantId: p.user.tenantId,
                forceChangePassword: Boolean(p.user.forceChangePassword),
              },
              tenant: {
                id: p.user.tenantId,
                name: "",
              },
              pwExp: typeof p.pwExp === "number" ? p.pwExp : undefined,
            };
            saveAuth(auth);
            resolve(auth);
          } else {
            const code = frame.error?.code;
            const msg = frame.error?.message ?? "Login failed";
            if (code === "RATE_LIMITED") {
              const wait = Number(frame.error?.retryAfterMs ?? 0);
              reject(new LoginRateLimitedError(wait, msg));
            } else if (code === "CAPTCHA_INVALID" || code === "CAPTCHA_REQUIRED") {
              reject(new CaptchaInvalidError(msg));
            } else {
              reject(new Error(msg));
            }
          }
        }
      } catch (err) {
        reject(err);
      }
    };

    ws.onerror = () => {
      reject(new Error("Connection failed"));
    };

    setTimeout(() => {
      ws.close();
      reject(new Error("Login timeout"));
    }, 15_000);
  });
}

// ===========================================================================
// Phase 1 — public RPC wrapper for unauthenticated flows
// (forgot password, reset, capabilities, view temp password)
// ===========================================================================

interface PublicRpcResult<T> {
  ok: boolean;
  payload?: T;
  errorMessage?: string;
  errorCode?: string;
}

/**
 * Open a temporary WebSocket, perform connect handshake, then issue a single
 * RPC.  Used by forgot-password / reset-password / view-temp flows that run
 * before login, and as a fallback for authenticated flows (force-change-password)
 * where the main shared gateway client isn't yet established.
 *
 * When `jwtToken` is provided, it is placed in `auth.token` of the connect
 * params — the gateway's early tenant-context resolver detects the "." in
 * a JWT and attaches the tenant context to the connection, so subsequent
 * calls on this socket carry authenticated state.
 */
export function callPublicRpc<T = unknown>(
  gatewayUrl: string,
  method: string,
  params: Record<string, unknown>,
  jwtToken?: string,
): Promise<PublicRpcResult<T>> {
  return new Promise((resolve) => {
    const ws = new WebSocket(gatewayUrl);
    let handshakeDone = false;
    let settled = false;
    const finish = (r: PublicRpcResult<T>) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    ws.onopen = () => {
      const connectParams = buildConnectParams();
      if (jwtToken) {
        connectParams.auth = { ...connectParams.auth, token: jwtToken };
      }
      ws.send(
        JSON.stringify({
          type: "req",
          id: generateUUID(),
          method: "connect",
          params: connectParams,
        }),
      );
    };

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === "res" && !handshakeDone) {
          handshakeDone = true;
          ws.send(
            JSON.stringify({
              type: "req",
              id: generateUUID(),
              method,
              params,
            }),
          );
          return;
        }
        if (frame.type === "res" && handshakeDone) {
          if (frame.ok) {
            finish({ ok: true, payload: frame.payload as T });
          } else {
            finish({
              ok: false,
              errorCode: frame.error?.code,
              errorMessage: frame.error?.message ?? "request failed",
            });
          }
        }
      } catch (err) {
        finish({ ok: false, errorMessage: String(err) });
      }
    };

    ws.onerror = () => finish({ ok: false, errorMessage: "Connection failed" });

    setTimeout(() => finish({ ok: false, errorMessage: "Request timeout" }), 15_000);
  });
}

/**
 * Authenticated RPC wrapper used by self-service password change.
 * Reuses the shared gateway connection when available; otherwise opens
 * a temporary WebSocket and performs an authenticated connect handshake
 * with the current access token.
 *
 * The fallback path matters for the force-change-password flow: those
 * users are logged in (fcp=true) but the main app shell skipped
 * state.connect() because it immediately routed to the overlay, so
 * sharedClient is null.
 */
export async function callAuthRpc<T = unknown>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  if (sharedClient) {
    return sharedClient.request<T>(method, params);
  }
  // Fallback: open a temporary WebSocket carrying the current JWT.
  const auth = loadAuth();
  if (!auth?.accessToken) {
    throw new Error("auth: not authenticated");
  }
  const settings = loadSettings();
  const gatewayUrl = settings.gatewayUrl;
  const result = await callPublicRpc<T>(gatewayUrl, method, params, auth.accessToken);
  if (!result.ok) {
    const err = new Error(result.errorMessage ?? `${method} failed`);
    (err as Error & { code?: string }).code = result.errorCode;
    throw err;
  }
  return result.payload as T;
}

// ---- Phase 1 helper wrappers ----

export async function getAuthCapabilities(gatewayUrl: string): Promise<{ email: boolean }> {
  const r = await callPublicRpc<{ email: boolean }>(gatewayUrl, "auth.capabilities", {});
  if (!r.ok) {
    throw new Error(r.errorMessage ?? "capabilities failed");
  }
  return r.payload ?? { email: false };
}

export async function requestForgotPassword(
  gatewayUrl: string,
  email: string,
  captcha: { id: string; answer: string },
): Promise<{ ok: boolean; email: boolean }> {
  const r = await callPublicRpc<{ ok: boolean; email: boolean }>(
    gatewayUrl,
    "auth.forgotPassword",
    { email, captchaId: captcha.id, captchaAnswer: captcha.answer },
  );
  if (!r.ok) {
    if (r.errorCode === "CAPTCHA_INVALID" || r.errorCode === "CAPTCHA_REQUIRED") {
      throw new CaptchaInvalidError(r.errorMessage);
    }
    throw new Error(r.errorMessage ?? "forgotPassword failed");
  }
  return r.payload ?? { ok: false, email: false };
}

/** Fetch a fresh captcha challenge from the gateway. */
export async function requestCaptchaChallenge(
  gatewayUrl: string,
): Promise<{ id: string; svg: string; expiresAt: number }> {
  const r = await callPublicRpc<{ id: string; svg: string; expiresAt: number }>(
    gatewayUrl,
    "captcha.challenge",
    {},
  );
  if (!r.ok || !r.payload) {
    throw new Error(r.errorMessage ?? "captcha challenge failed");
  }
  return r.payload;
}

export async function verifyForgotPassword(
  gatewayUrl: string,
  token: string,
  newPassword: string,
): Promise<void> {
  const hashedNew = await hashPasswordForTransport(newPassword);
  const r = await callPublicRpc(gatewayUrl, "auth.forgotPassword.verify", {
    token,
    newPassword: hashedNew,
  });
  if (!r.ok) {
    throw new Error(r.errorMessage ?? "reset failed");
  }
}

export async function viewTempPassword(
  gatewayUrl: string,
  token: string,
): Promise<{ tempPassword: string }> {
  const r = await callPublicRpc<{ tempPassword: string }>(gatewayUrl, "auth.viewTempPassword", {
    token,
  });
  if (!r.ok) {
    throw new Error(r.errorMessage ?? "view failed");
  }
  if (!r.payload) {
    throw new Error("empty response");
  }
  return r.payload;
}

export async function changePasswordAuthed(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const hashedCurrent = await hashPasswordForTransport(currentPassword);
  const hashedNew = await hashPasswordForTransport(newPassword);
  await callAuthRpc("auth.changePassword", {
    currentPassword: hashedCurrent,
    newPassword: hashedNew,
  });
  // After a successful change, the server has revoked all refresh tokens.
  // Clear local auth so the user is forced through a fresh login.
  clearAuth();
}

export async function adminResetPassword(
  userId: string,
): Promise<{ viewToken: string; viewUrl: string; expiresAt: string }> {
  return callAuthRpc("auth.adminResetPassword", { userId });
}

/**
 * Register a new tenant and owner account.
 */
export async function register(params: {
  gatewayUrl: string;
  tenantName: string;
  email: string;
  password: string;
  displayName?: string;
  captchaId: string;
  captchaAnswer: string;
}): Promise<AuthState> {
  const hashedPassword = await hashPasswordForTransport(params.password);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(params.gatewayUrl);
    let handshakeDone = false;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "req",
          id: generateUUID(),
          method: "connect",
          params: buildConnectParams(),
        }),
      );
    };

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === "res" && !handshakeDone) {
          handshakeDone = true;
          ws.send(
            JSON.stringify({
              type: "req",
              id: generateUUID(),
              method: "auth.register",
              params: {
                tenantName: params.tenantName,
                email: params.email,
                password: hashedPassword,
                displayName: params.displayName,
                captchaId: params.captchaId,
                captchaAnswer: params.captchaAnswer,
              },
            }),
          );
          return;
        }
        if (frame.type === "res" && handshakeDone) {
          ws.close();
          if (frame.ok && frame.payload) {
            const p = frame.payload;
            // Phase 3: email verification required — no tokens issued
            if (p.pendingVerification) {
              reject(new RegisterPendingVerificationError(p.user?.email ?? params.email));
              return;
            }
            const auth: AuthState = {
              accessToken: p.accessToken,
              refreshToken: p.refreshToken,
              expiresAt: Date.now() + p.expiresIn * 1000,
              user: {
                id: p.user.id,
                email: p.user.email,
                role: p.user.role,
                displayName: p.user.displayName,
                tenantId: p.tenant.id,
              },
              tenant: {
                id: p.tenant.id,
                name: p.tenant.name,
              },
            };
            saveAuth(auth);
            resolve(auth);
          } else {
            const code = frame.error?.code;
            const msg = frame.error?.message ?? "Registration failed";
            if (code === "CAPTCHA_INVALID" || code === "CAPTCHA_REQUIRED") {
              reject(new CaptchaInvalidError(msg));
            } else {
              reject(new Error(msg));
            }
          }
        }
      } catch (err) {
        reject(err);
      }
    };

    ws.onerror = () => {
      reject(new Error("Connection failed"));
    };

    setTimeout(() => {
      ws.close();
      reject(new Error("Registration timeout"));
    }, 15_000);
  });
}
