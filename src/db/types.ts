/**
 * Database types for multi-tenant system.
 */

// ============================================================
// Tenant
// ============================================================

export type TenantPlan = "free" | "pro" | "enterprise";
export type TenantStatus = "active" | "suspended" | "deleted";

export interface TenantQuotas {
  maxUsers: number;
  maxAgents: number;
  maxChannels: number;
  maxTokensPerMonth: number;
  maxCronJobs: number;
}

export interface TenantSettings {
  defaultModel?: string;
  allowedModels?: string[];
  sandboxEnabled?: boolean;
  [key: string]: unknown;
}

export interface Tenant {
  id: string;
  name: string;
  plan: TenantPlan;
  status: TenantStatus;
  settings: TenantSettings;
  quotas: TenantQuotas;
  traceEnabled: boolean;
  identityPrompt: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTenantInput {
  name: string;
  plan?: TenantPlan;
  settings?: TenantSettings;
  quotas?: Partial<TenantQuotas>;
}

// ============================================================
// User
// ============================================================

export type UserRole = "platform-admin" | "owner" | "admin" | "member" | "viewer";
export type UserStatus = "active" | "invited" | "suspended" | "deleted";

export interface UserSettings {
  defaultAgent?: string;
  locale?: string;
  theme?: "light" | "dark" | "auto";
  [key: string]: unknown;
}

export interface User {
  id: string;
  tenantId: string;
  channelId: string | null;
  openIds: string[];
  unionId: string | null;
  email: string | null;
  passwordHash: string | null;
  displayName: string | null;
  role: UserRole;
  status: UserStatus;
  avatarUrl: string | null;
  lastLoginAt: Date | null;
  settings: UserSettings;
  /** When 1, user must change password on next login (set on invite/admin-reset). */
  forceChangePassword: boolean;
  /** Timestamp of the last password change; used by Phase 2 expiry policy. */
  passwordChangedAt: Date | null;
  /** Phase 3: encrypted TOTP secret (AES-256-GCM, same key as temp-password payload). */
  mfaSecret: string | null;
  /** Phase 3: whether MFA is enabled for this user. */
  mfaEnabled: boolean;
  /** Phase 3: JSON array of SHA-256 hashed backup codes. */
  mfaBackupCodes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** User object without sensitive secrets, safe to return from API. */
export type SafeUser = Omit<User, "passwordHash" | "mfaSecret" | "mfaBackupCodes">;

export interface CreateUserInput {
  tenantId: string;
  channelId?: string;
  email?: string;
  password?: string;
  displayName?: string;
  role?: UserRole;
}

export interface UpdateUserInput {
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  settings?: UserSettings;
  avatarUrl?: string;
}

// ============================================================
// JWT Payload
// ============================================================

export interface JwtPayload {
  sub: string; // user ID
  tid: string; // tenant ID
  email: string | null;
  role: UserRole;
  /** Force-change-password flag — when true, the client must redirect to change-password. */
  fcp?: boolean;
  /** Phase 2: password expiry timestamp (epoch ms). Absent when policy is disabled. */
  pwExp?: number;
}

export interface JwtTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
}

// ============================================================
// Tenant API Key
// ============================================================

export interface TenantApiKey {
  id: string;
  tenantId: string;
  provider: string;
  label: string | null;
  keyEncrypted: string;
  isActive: boolean;
  usageCount: number;
  lastUsedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// Tenant Model Config (租户级模型配置)
// ============================================================

export type ModelApiProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "bedrock-converse-stream"
  | "ollama"
  | "deepseek-web"
  | "qwen-web";

export type ModelAuthMode = "api-key" | "oauth" | "token" | "none";

export interface TenantModelDefinition {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  alias?: string;
  streaming?: boolean;
  compat?: Record<string, unknown>;
}

export type ModelVisibility = "private" | "shared";

export interface TenantModel {
  id: string;
  tenantId: string;
  providerType: string;
  providerName: string;
  baseUrl: string | null;
  apiProtocol: ModelApiProtocol;
  authMode: ModelAuthMode;
  apiKeyEncrypted: string | null;
  extraHeaders: Record<string, string>;
  extraConfig: Record<string, unknown>;
  models: TenantModelDefinition[];
  visibility: ModelVisibility;
  isActive: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// Tenant Agent Config
// ============================================================

export interface ModelConfigEntry {
  providerId: string; // tenant_models.id
  modelId: string; // tenant_models.models[].id
  isDefault: boolean; // true = primary, false = fallback (ordered by array index)
}

export interface TenantAgent {
  id: string;
  tenantId: string;
  agentId: string;
  name: string | null;
  config: Record<string, unknown>;
  modelConfig: ModelConfigEntry[];
  tools: { deny: string[] };
  skills: string[] | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// Tenant Channel Config
// ============================================================

export type ChannelPolicy = "open" | "allowlist" | "disabled";

export interface TenantChannelConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  domain: string;
  connectionMode: string;
  requireMention: boolean;
  dmPolicy: string;
  groupPolicy: string;
  allowFrom: string[];
  groupAllowFrom: string[];
  replyMode: Record<string, string>;
  uat: Record<string, unknown>;
  streaming: boolean;
  [key: string]: unknown;
}

export interface TenantChannel {
  id: string;
  tenantId: string;
  channelType: string;
  channelName: string | null;
  channelPolicy: ChannelPolicy;
  config: TenantChannelConfig;
  isActive: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// Tenant Channel App
// ============================================================

export interface TenantChannelApp {
  id: string;
  channelId: string;
  tenantId: string;
  appId: string;
  appSecret: string;
  botName: string;
  groupPolicy: ChannelPolicy;
  agentId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// Tenant Session
// ============================================================

export interface TenantSession {
  id: string;
  tenantId: string;
  sessionKey: string;
  agentId: string | null;
  userId: string | null;
  channel: string | null;
  chatType: string | null;
  metadata: Record<string, unknown>;
  status: "active" | "archived" | "deleted";
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// Audit Log
// ============================================================

export interface AuditLog {
  id: string;
  tenantId: string;
  userId: string | null;
  action: string;
  resource: string | null;
  detail: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

// ============================================================
// Usage Record
// ============================================================

export interface UsageRecord {
  id: string;
  tenantId: string;
  userId: string | null;
  agentId: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sessionKey: string | null;
  recordedAt: Date;
}

// ============================================================
// LLM Interaction Trace
// ============================================================

export interface LlmInteractionTrace {
  id: string;
  tenantId: string;
  userId: string | null;
  sessionKey: string | null;
  agentId: string | null;
  channel: string | null;
  turnId: string;
  turnIndex: number;
  userInput: string | null;
  provider: string | null;
  model: string | null;
  systemPrompt: string | null;
  messages: unknown[];
  tools: unknown[] | null;
  requestParams: Record<string, unknown> | null;
  response: unknown | null;
  stopReason: string | null;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number | null;
  createdAt: Date;
}

// ============================================================
// System Config (single-row tables)
// ============================================================

export interface SysGatewayConfigRow {
  id: number;
  port: number;
  mode: string | null;
  bind: string | null;
  customBindHost: string | null;
  tailscale: Record<string, unknown>;
  remote: Record<string, unknown>;
  reload: Record<string, unknown>;
  tls: Record<string, unknown>;
  http: Record<string, unknown>;
  nodes: Record<string, unknown>;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  auth: Record<string, unknown>;
  tools: Record<string, unknown>;
  channelHealthCheckMinutes: number | null;
  multiTenant: Record<string, unknown>;
  updatedAt: Date;
}

export interface SysLoggingConfigRow {
  id: number;
  level: string | null;
  file: string | null;
  maxFileBytes: number | null;
  consoleLevel: string | null;
  consoleStyle: string | null;
  redactSensitive: string | null;
  redactPatterns: string[];
  updatedAt: Date;
}

export interface SysPluginsConfigRow {
  id: number;
  enabled: boolean;
  allow: string[];
  deny: string[];
  load: Record<string, unknown>;
  slots: Record<string, unknown>;
  entries: Record<string, unknown>;
  installs: Record<string, unknown>;
  updatedAt: Date;
}

export interface SysToolsConfigRow {
  id: number;
  allowDangerousToolsOverride: boolean;
  profile: string | null;
  allow: string[];
  alsoAllow: string[];
  deny: string[];
  byProvider: Record<string, unknown>;
  web: Record<string, unknown>;
  media: Record<string, unknown>;
  links: Record<string, unknown>;
  message: Record<string, unknown>;
  agentToAgent: Record<string, unknown>;
  sessions: Record<string, unknown>;
  elevated: Record<string, unknown>;
  exec: Record<string, unknown>;
  fs: Record<string, unknown>;
  loopDetection: Record<string, unknown>;
  subagents: Record<string, unknown>;
  sandbox: Record<string, unknown>;
  updatedAt: Date;
}

// ============================================================
// CS API Object (upper-app credentials, Agenora S2)
// ============================================================

export type MessageSource = "agenora-ai" | "upper-app-relay";

export interface CsApiObject {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  agentId: string;
  appId: string;
  appSecretHash: string;
  rotatingFromHash?: string;
  rotatingUntil?: Date;
  endpointUrl: string;
  isActive: boolean;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// RBAC Permission Definitions
// ============================================================

export const PERMISSIONS = {
  // Platform management
  "platform.overview": ["platform-admin"],
  "platform.tenants": ["platform-admin"],
  "platform.models.list": ["platform-admin"],
  "platform.models.create": ["platform-admin"],
  "platform.models.update": ["platform-admin"],
  "platform.models.delete": ["platform-admin"],

  // Tenant management
  "tenant.read": ["owner", "admin"],
  "tenant.update": ["owner", "admin"],
  "tenant.delete": ["owner"],
  "tenant.billing": ["owner"],

  // User management
  "user.list": ["owner", "admin"],
  "user.invite": ["owner", "admin"],
  "user.update": ["owner", "admin"],
  "user.remove": ["owner", "admin"],
  "user.role.change": ["owner"],

  // Agent management
  "agent.list": ["owner", "admin", "member", "viewer"],
  "agent.create": ["owner", "admin", "member"],
  "agent.update": ["owner", "admin", "member"],
  "agent.delete": ["owner", "admin", "member"],
  "agent.use": ["owner", "admin", "member"],

  // Channel management
  "channel.list": ["owner", "admin", "member", "viewer"],
  "channel.create": ["owner", "admin"],
  "channel.update": ["owner", "admin"],
  "channel.delete": ["owner", "admin"],

  // Model management
  "model.list": ["owner", "admin", "member", "viewer"],
  "model.create": ["owner", "admin"],
  "model.update": ["owner", "admin"],
  "model.delete": ["owner", "admin"],

  // Session / Chat
  "session.list": ["owner", "admin", "member"],
  "session.own": ["owner", "admin", "member"],
  "session.all": ["owner", "admin"],
  "session.delete": ["owner", "admin"],

  // API Key management
  "apikey.list": ["owner", "admin"],
  "apikey.create": ["owner", "admin"],
  "apikey.delete": ["owner", "admin"],

  // Skill management
  "skill.list": ["owner", "admin", "member", "viewer"],
  "skill.use": ["owner", "admin", "member"],
  "skill.update": ["owner", "admin"],
  "skill.install": ["owner", "admin"],
  "skill.create": ["owner", "admin"],
  "skill.delete": ["owner", "admin"],

  // Config
  "config.read": ["owner", "admin", "member"],
  "config.write": ["owner", "admin"],

  // Audit
  "audit.read": ["owner", "admin"],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof PERMISSIONS;
