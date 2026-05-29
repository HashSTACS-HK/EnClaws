/**
 * Detect whether the deployment can send transactional email, and actually
 * send the password-reset message via nodemailer when SMTP is configured.
 *
 * Used by:
 *   - auth.capabilities → tells the frontend to show "enter your email"
 *     vs "contact platform admin" on the forgot-password page.
 *   - auth.forgotPassword → routes between path A (email) and the
 *     no-op-with-message branch.
 *
 * Environment variables:
 *   ENCLAWS_SMTP_HOST         — hostname (required to enable)
 *   ENCLAWS_SMTP_PORT         — port (default 587)
 *   ENCLAWS_SMTP_USER         — username for SMTP AUTH (optional)
 *   ENCLAWS_SMTP_PASS         — password for SMTP AUTH (optional)
 *   ENCLAWS_SMTP_FROM         — From: header (required to enable)
 *   ENCLAWS_SMTP_SECURE       — "true" forces TLS; port 465 auto-implies
 *   ENCLAWS_SMTP_FROM_NAME    — optional display name prefixed to FROM
 *   ENCLAWS_PUBLIC_BASE_URL   — base URL used to build clickable links
 */

import nodemailer, { type Transporter } from "nodemailer";

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  fromName?: string;
  secure: boolean;
}

export function loadSmtpConfig(): SmtpConfig | null {
  const host = process.env.ENCLAWS_SMTP_HOST?.trim();
  const from = process.env.ENCLAWS_SMTP_FROM?.trim();
  if (!host || !from) {
    return null;
  }
  const portRaw = process.env.ENCLAWS_SMTP_PORT?.trim();
  const port = portRaw ? Number(portRaw) : 587;
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }
  return {
    host,
    port,
    user: process.env.ENCLAWS_SMTP_USER?.trim() || undefined,
    pass: process.env.ENCLAWS_SMTP_PASS || undefined,
    from,
    fromName: process.env.ENCLAWS_SMTP_FROM_NAME?.trim() || undefined,
    secure: process.env.ENCLAWS_SMTP_SECURE === "true" || port === 465,
  };
}

export function hasEmailCapability(): boolean {
  return loadSmtpConfig() !== null;
}

/**
 * Boot-time sanity check: if the operator configured SMTP but forgot to set
 * `ENCLAWS_PUBLIC_BASE_URL`, the reset-link emails will contain relative
 * URLs (`/#/auth/reset-password?...`) that recipients can't click from a
 * mail client.  Warn loudly but don't fail startup — the flow will still
 * work from the web UI's forgot-password form.
 */
export function warnOnMissingPublicBaseUrl(): void {
  if (!hasEmailCapability()) {
    return;
  }
  const base = process.env.ENCLAWS_PUBLIC_BASE_URL?.trim();
  if (base) {
    return;
  }
  console.warn(
    "[auth] ENCLAWS_SMTP_HOST is set but ENCLAWS_PUBLIC_BASE_URL is not — " +
      "password-reset emails will contain relative URLs that won't be clickable " +
      "from mail clients. Set ENCLAWS_PUBLIC_BASE_URL to your public gateway URL " +
      "(e.g. https://console.example.com) to fix this.",
  );
}

// ---------------------------------------------------------------------------
// Transport cache
// ---------------------------------------------------------------------------

interface CachedTransport {
  cfg: SmtpConfig;
  transporter: Transporter;
}

let cachedTransport: CachedTransport | null = null;

function sameConfig(a: SmtpConfig, b: SmtpConfig): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.user === b.user &&
    a.pass === b.pass &&
    a.from === b.from &&
    a.fromName === b.fromName &&
    a.secure === b.secure
  );
}

function getTransport(cfg: SmtpConfig): Transporter {
  if (cachedTransport && sameConfig(cachedTransport.cfg, cfg)) {
    return cachedTransport.transporter;
  }
  if (cachedTransport) {
    try {
      cachedTransport.transporter.close();
    } catch {
      /* ignore */
    }
  }
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
    // Reasonable defaults for transactional mail:
    //  - 10s connect timeout so we don't hang auth.forgotPassword forever
    //  - pool enabled so repeated requests reuse the TCP connection
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
  });
  cachedTransport = { cfg, transporter };
  return transporter;
}

/** Test helper: drop the cached transport so the next send rebuilds it. */
export function _resetSmtpTransportCache(): void {
  if (cachedTransport) {
    try {
      cachedTransport.transporter.close();
    } catch {
      /* ignore */
    }
    cachedTransport = null;
  }
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPasswordResetEmail(opts: {
  to: string;
  resetUrl: string;
  expiresInMinutes: number;
}): { subject: string; text: string; html: string } {
  const safeUrl = escapeHtml(opts.resetUrl);
  const ttl = opts.expiresInMinutes;
  const subject = "EnClaws 密码重置请求";
  const text = [
    "您好，",
    "",
    "我们收到了对您 EnClaws 账户的密码重置请求。",
    "请点击下方链接设置新密码：",
    "",
    opts.resetUrl,
    "",
    `该链接将在 ${ttl} 分钟后失效。`,
    "如果您没有请求重置密码，请忽略此邮件 —— 您的账户不会有任何变化。",
    "",
    "—— EnClaws 安全团队",
  ].join("\r\n");

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#222;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f6f6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden;">
          <tr><td style="padding:28px 32px 16px;">
            <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#111;">密码重置请求</h2>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#444;">
              我们收到了对您 EnClaws 账户的密码重置请求。
              点击下方按钮设置新密码：
            </p>
            <p style="text-align:center;margin:24px 0;">
              <a href="${safeUrl}" style="display:inline-block;padding:12px 28px;background:#3b82f6;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;">
                设置新密码
              </a>
            </p>
            <p style="margin:0 0 12px;font-size:13px;color:#666;line-height:1.6;">
              如果按钮无法点击，请将以下链接复制到浏览器：
            </p>
            <p style="margin:0 0 16px;font-size:12px;color:#3b82f6;word-break:break-all;">
              <a href="${safeUrl}" style="color:#3b82f6;text-decoration:none;">${safeUrl}</a>
            </p>
            <p style="margin:16px 0 0;font-size:12px;color:#888;line-height:1.6;">
              此链接将在 <strong>${ttl} 分钟</strong>后失效。<br>
              如果您没有请求重置密码，请忽略此邮件 —— 您的账户不会有任何变化。
            </p>
          </td></tr>
          <tr><td style="padding:16px 32px;background:#fafafa;border-top:1px solid #eee;font-size:11px;color:#999;">
            —— EnClaws 安全团队
          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a password reset email. Returns true on successful handoff to the
 * SMTP server (250 OK), false on failure.
 *
 * Errors are logged but never thrown — the caller treats a false return as
 * "could not deliver" and falls through to the normal "we've sent a reset
 * link" UI anyway, to avoid user-enumeration via timing/error leaks.
 */
export async function sendPasswordResetEmail(opts: {
  to: string;
  resetUrl: string;
  expiresInMinutes: number;
}): Promise<boolean> {
  const cfg = loadSmtpConfig();
  if (!cfg) {
    return false;
  }

  const { subject, text, html } = buildPasswordResetEmail(opts);
  const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.from}>` : cfg.from;

  try {
    const transport = getTransport(cfg);
    const info = await transport.sendMail({
      from,
      to: opts.to,
      subject,
      text,
      html,
    });
    console.log(
      `[smtp] sent password-reset email to=${opts.to} messageId=${info.messageId ?? "?"}`,
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[smtp] failed to send password-reset email to=${opts.to}: ${message}`);
    return false;
  }
}

/**
 * Send an email verification link.  Same transport + error semantics as
 * sendPasswordResetEmail.
 */
export async function sendVerifyEmail(opts: {
  to: string;
  verifyUrl: string;
  expiresInHours: number;
}): Promise<boolean> {
  const cfg = loadSmtpConfig();
  if (!cfg) {
    return false;
  }

  const safeUrl = escapeHtml(opts.verifyUrl);
  const ttl = opts.expiresInHours;
  const subject = "EnClaws — verify your email address";
  const text = [
    "Welcome to EnClaws!",
    "",
    "Please verify your email address by visiting the link below:",
    "",
    opts.verifyUrl,
    "",
    `This link expires in ${ttl} hours.`,
    "If you did not create this account, you can safely ignore this email.",
    "",
    "— EnClaws",
  ].join("\r\n");

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#222;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f6f6;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background:#fff;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:28px 32px 16px;">
          <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#111;">Verify your email</h2>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#444;">
            Click the button below to verify your email address and activate your EnClaws account.
          </p>
          <p style="text-align:center;margin:24px 0;">
            <a href="${safeUrl}" style="display:inline-block;padding:12px 28px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;">
              Verify email
            </a>
          </p>
          <p style="margin:0 0 12px;font-size:13px;color:#666;line-height:1.6;">
            If the button doesn't work, copy this link into your browser:
          </p>
          <p style="margin:0 0 16px;font-size:12px;color:#3b82f6;word-break:break-all;">
            <a href="${safeUrl}" style="color:#3b82f6;text-decoration:none;">${safeUrl}</a>
          </p>
          <p style="margin:16px 0 0;font-size:12px;color:#888;line-height:1.6;">
            This link expires in <strong>${ttl} hours</strong>.<br>
            If you didn't create this account, please ignore this email.
          </p>
        </td></tr>
        <tr><td style="padding:16px 32px;background:#fafafa;border-top:1px solid #eee;font-size:11px;color:#999;">
          — EnClaws
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.from}>` : cfg.from;
  try {
    const transport = getTransport(cfg);
    const info = await transport.sendMail({ from, to: opts.to, subject, text, html });
    console.log(`[smtp] sent verify email to=${opts.to} messageId=${info.messageId ?? "?"}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[smtp] failed to send verify email to=${opts.to}: ${message}`);
    return false;
  }
}
