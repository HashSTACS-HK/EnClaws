/**
 * TestEnv — main entry point for IM simulator tests.
 *
 * Manages tenant lifecycle (register / login), model & agent setup,
 * and simulated chat via Gateway RPC.
 *
 * Usage:
 *   const env = new TestEnv({ url: "ws://127.0.0.1:18789" });
 *
 *   // Full setup
 *   await env.register({ tenantName: "Acme", email: "a@b.com", password: "12345678" });
 *   const model = await env.createModel({ providerType: "deepseek", ... });
 *   await env.createAgent({ agentId: "bot", name: "Bot", modelConfig: [...] });
 *   const reply = await env.sendAsUser({ agentId: "bot", message: "hello" });
 *
 *   // Or connect to existing
 *   await env.login({ email: "a@b.com", password: "12345678" });
 *   const reply = await env.sendAsUser({ agentId: "bot", message: "hello" });
 */

import { randomUUID, createHash } from "node:crypto";
import { RpcClient } from "./rpc-client.js";
import type {
  SimulatorConnectionOptions,
  RegisterOptions,
  RegisterResult,
  LoginOptions,
  LoginResult,
  CreateModelOptions,
  CreateModelResult,
  CreateAgentOptions,
  CreateAgentResult,
  InviteUserOptions,
  InviteUserResult,
  SendMessageOptions,
  SendMessageResult,
  ChatEventPayload,
} from "./types.js";

const DEFAULT_CHAT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 50;

export class TestEnv {
  private connOpts: SimulatorConnectionOptions;
  private client: RpcClient | null = null;
  private jwt: string | null = null;
  private email: string | null = null;

  constructor(opts: SimulatorConnectionOptions) {
    this.connOpts = opts;
  }

  // -----------------------------------------------------------------------
  // Connection helpers
  // -----------------------------------------------------------------------

  /**
   * Ensure a WS connection to the Gateway.
   * If JWT is available, the connection carries tenant context.
   */
  private async ensureClient(): Promise<RpcClient> {
    if (this.client?.connected) {return this.client;}
    this.client?.close();
    this.client = new RpcClient({
      url: this.connOpts.url,
      gatewayToken: this.connOpts.gatewayToken,
      jwt: this.jwt ?? undefined,
    });
    await this.client.connect();
    return this.client;
  }

  /** Reconnect with updated JWT (tenant context changes after login/register). */
  private async reconnectWithJwt(jwt: string) {
    this.jwt = jwt;
    this.client?.close();
    this.client = new RpcClient({
      url: this.connOpts.url,
      gatewayToken: this.connOpts.gatewayToken,
      jwt,
    });
    await this.client.connect();
  }

  // -----------------------------------------------------------------------
  // Auth — register / login
  // -----------------------------------------------------------------------

  /**
   * Register a new tenant with an owner account.
   * After registration the client reconnects with the JWT.
   */
  async register(opts: RegisterOptions): Promise<RegisterResult> {
    const client = await this.ensureClient();
    const hashedPassword = createHash("sha256").update(opts.password).digest("hex");
    const res = await client.request<RegisterResult>("auth.register", {
      tenantName: opts.tenantName,
      email: opts.email,
      password: hashedPassword,
      displayName: opts.displayName,
    });
    this.email = opts.email;
    await this.reconnectWithJwt(res.accessToken);
    return res;
  }

  /**
   * Login to an existing tenant.
   * After login the client reconnects with the JWT.
   */
  async login(opts: LoginOptions): Promise<LoginResult> {
    const client = await this.ensureClient();
    const hashedPassword = createHash("sha256").update(opts.password).digest("hex");
    const res = await client.request<LoginResult>("auth.login", {
      email: opts.email,
      password: hashedPassword,
    });
    this.email = opts.email;
    await this.reconnectWithJwt(res.accessToken);
    return res;
  }

  /**
   * Invite a new user to the current tenant.
   * Requires prior register() or login() as owner/admin.
   */
  async inviteUser(opts: InviteUserOptions): Promise<InviteUserResult> {
    const client = await this.ensureClient();
    return await client.request<InviteUserResult>("tenant.users.invite", {
      email: opts.email,
      password: opts.password,
      role: opts.role ?? "member",
      displayName: opts.displayName,
    });
  }

  // -----------------------------------------------------------------------
  // Setup — model / agent
  // -----------------------------------------------------------------------

  /**
   * Create a model configuration for the current tenant.
   * Requires prior register() or login().
   */
  async createModel(opts: CreateModelOptions): Promise<CreateModelResult> {
    const client = await this.ensureClient();
    return await client.request<CreateModelResult>("tenant.models.create", {
      providerType: opts.providerType,
      providerName: opts.providerName ?? opts.providerType,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      apiProtocol: opts.apiProtocol ?? "openai-completions",
      authMode: opts.authMode ?? "api-key",
      models: opts.models,
    });
  }

  /**
   * Create an agent for the current tenant.
   *
   * If `modelConfig` is omitted and a model was previously created via
   * `createModel()`, the first model definition is auto-wired as default.
   */
  async createAgent(opts: CreateAgentOptions): Promise<CreateAgentResult> {
    const client = await this.ensureClient();
    const { modelConfig } = opts;
    const config: Record<string, unknown> = {};
    if (opts.systemPrompt) {
      config.systemPrompt = opts.systemPrompt;
    }

    const res = await client.request<CreateAgentResult>("tenant.agents.create", {
      agentId: opts.agentId,
      name: opts.name,
      config,
      modelConfig,
    });
    return res;
  }

  // -----------------------------------------------------------------------
  // Chat
  // -----------------------------------------------------------------------

  /**
   * Send a message as a simulated IM user and wait for the agent's reply.
   *
   * The message goes through the full dispatch pipeline:
   *   chat.send → dispatchInboundMessage → Agent → LLM → reply
   *
   * Different `userId` values produce separate conversation sessions.
   */
  async sendAsUser(opts: SendMessageOptions): Promise<SendMessageResult> {
    const client = await this.ensureClient();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    const idempotencyKey = randomUUID();
    const sessionKey = `agent:${opts.agentId}:sim:direct:${this.email}`;

    // Clear stale events
    client.clearEvents();

    const startedAt = Date.now();

    // Send the message (returns immediately with ack)
    await client.request("chat.send", {
      sessionKey,
      message: opts.message,
      idempotencyKey,
    });

    // Poll for the final chat event
    const text = await this.waitForFinalReply(client.events, idempotencyKey, timeoutMs);

    return {
      text,
      runId: idempotencyKey,
      durationMs: Date.now() - startedAt,
    };
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Disconnect from the Gateway. */
  async disconnect() {
    this.client?.close();
    this.client = null;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async waitForFinalReply(
    events: ChatEventPayload[],
    runId: string,
    timeoutMs: number,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = events.find(
        (evt) => evt.runId === runId && evt.state === "final",
      );
      if (match) {
        return extractTextFromMessage(match.message);
      }
      // Check for error state too
      const errorEvt = events.find(
        (evt) => evt.runId === runId && evt.state === "error",
      );
      if (errorEvt) {
        const errText = extractTextFromMessage(errorEvt.message);
        throw new Error(`Agent returned error: ${errText || "unknown error"}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `Timeout (${timeoutMs}ms) waiting for agent reply (runId=${runId})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextFromMessage(
  message?: ChatEventPayload["message"],
): string {
  if (!message?.content || !Array.isArray(message.content)) {return "";}
  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("\n")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
