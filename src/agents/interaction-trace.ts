/**
 * LLM Interaction Trace - wraps StreamFn to capture every LLM API call's
 * input (system prompt, messages, tools) and output (response, usage, stop reason).
 *
 * Writes to the llm_interaction_traces table asynchronously (fire-and-forget).
 */

import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import { isDbInitialized } from "../db/index.js";
import { createInteractionTrace } from "../db/models/interaction-trace.js";
import { getTenantById } from "../db/models/tenant.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseBooleanValue } from "../utils/boolean.js";

const log = createSubsystemLogger("agent/interaction-trace");

export type InteractionTraceContext = {
  tenantId: string;
  tenantUserId?: string;
  sessionKey?: string;
  agentId?: string;
  channel?: string;
  runId?: string;
  provider?: string;
  modelId?: string;
  userInput?: string;
};

export type InteractionTraceRecorder = {
  /** Wrap a StreamFn to intercept request payloads (messages, system, tools). */
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
  /** Set the system prompt text (call before prompt() so trace can capture it). */
  setSystemPrompt: (text: string) => void;
  /** Record usage/response after prompt() completes. Call once per LLM round. */
  recordRound: (messages: AgentMessage[], error?: unknown) => void;
};

/**
 * Create a trace recorder for one user turn (one prompt() call that may
 * trigger multiple internal LLM rounds via tool-use loops).
 *
 * Returns null if tracing is not applicable (no tenantId or DB not initialized).
 */
/**
 * Check if tracing is globally enabled via ENCLAWS_TRACE_ENABLED env var.
 * Defaults to false — tracing is opt-in since it's primarily a debugging tool.
 */
function isTraceGloballyEnabled(): boolean {
  return parseBooleanValue(process.env.ENCLAWS_TRACE_ENABLED) ?? false;
}

export function createInteractionTraceRecorder(
  ctx: InteractionTraceContext,
  turnId: string,
): InteractionTraceRecorder | null {
  if (!ctx.tenantId || !isDbInitialized()) {
    return null;
  }
  // Global env toggle: ENCLAWS_TRACE_ENABLED (default: false)
  if (!isTraceGloballyEnabled()) {
    return null;
  }

  // Tenant-level toggle: tenants.trace_enabled column (default: false)
  // Checked lazily on first recordRound and cached for the turn lifetime.
  let tenantTraceChecked = false;
  let tenantTraceAllowed = false;

  // System prompt text, set externally via setSystemPrompt() since it's not in StreamFn context.
  let cachedSystemPrompt: string | undefined;

  // Buffer all request payloads across multiple StreamFn calls in a tool-use loop.
  // Each StreamFn invocation pushes one entry; recordRound drains them all.
  const requestPayloads: Array<{
    systemPrompt?: string;
    messages?: unknown[];
    tools?: unknown[];
    requestParams?: Record<string, unknown>;
    startedAt: number;
  }> = [];

  const setSystemPrompt: InteractionTraceRecorder["setSystemPrompt"] = (text) => {
    cachedSystemPrompt = text;
  };

  const wrapStreamFn: InteractionTraceRecorder["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      // Extract request data from the context object that pi-agent-core passes to StreamFn.
      const ctxObj = context as unknown as Record<string, unknown>;
      const messages = ctxObj?.messages as unknown[] | undefined;
      const tools = ctxObj?.tools as unknown[] | undefined;

      // Capture params like temperature, max_tokens from the model/options
      const modelObj = model as unknown as Record<string, unknown>;
      const requestParams: Record<string, unknown> = {};
      if (modelObj?.maxTokens) {requestParams.maxTokens = modelObj.maxTokens;}
      if (modelObj?.contextWindow) {requestParams.contextWindow = modelObj.contextWindow;}
      if (ctxObj?.temperature !== undefined) {requestParams.temperature = ctxObj.temperature;}
      if (ctxObj?.max_tokens !== undefined) {requestParams.max_tokens = ctxObj.max_tokens;}

      requestPayloads.push({
        systemPrompt: cachedSystemPrompt,
        messages: messages ? [...messages] : undefined,
        tools: tools ? [...tools] : undefined,
        requestParams: Object.keys(requestParams).length > 0 ? requestParams : undefined,
        startedAt: Date.now(),
      });

      return streamFn(model, context, {
        ...options,
        onPayload: (payload: unknown) => {
          options?.onPayload?.(payload);
        },
      });
    };
    return wrapped;
  };

  const recordRound: InteractionTraceRecorder["recordRound"] = (finalMessages, error) => {
    if (requestPayloads.length === 0) {
      return;
    }

    // Drain buffer — take ownership and clear immediately
    const payloads = [...requestPayloads];
    requestPayloads.length = 0;

    log.debug(
      `interaction trace: turnId=${turnId} rounds=${payloads.length} finalMessages=${finalMessages.length}`,
    );

    // Async fire-and-forget: check tenant toggle then write all traces
    (async () => {
      // Lazy check tenant-level trace_enabled (query once, cache for turn)
      if (!tenantTraceChecked) {
        tenantTraceChecked = true;
        try {
          const tenant = await getTenantById(ctx.tenantId);
          tenantTraceAllowed = tenant?.traceEnabled ?? false;
        } catch {
          tenantTraceAllowed = false;
        }
      }
      if (!tenantTraceAllowed) {return;}

      for (let i = 0; i < payloads.length; i += 1) {
        const payload = payloads[i];
        const isLastRound = i === payloads.length - 1;

        // --- Extract response for this round ---
        // Key insight: context.messages passed to StreamFn are LLM Message[] (after convertToLlm),
        // but finalMessages (activeSession.messages) are AgentMessage[]. They have different lengths
        // and formats, so we CANNOT index one with the other's length.
        //
        // For intermediate rounds: the NEXT round's context.messages (same LLM format) includes
        // this round's assistant response — it sits right after this round's input messages.
        //
        // For the last round: use finalMessages (AgentMessage[]) — find the last assistant message.
        let response: unknown = null;
        let stopReason: string | undefined;
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;

        if (!isLastRound) {
          // Intermediate round: extract response from next round's LLM context.
          // next.messages = [...this.messages, assistant_response, tool_result, ...]
          const nextMessages = payloads[i + 1].messages;
          const thisLen = payload.messages?.length ?? 0;
          if (nextMessages && thisLen < nextMessages.length) {
            const msg = nextMessages[thisLen] as Record<string, unknown>;
            if (msg?.role === "assistant") {
              response = msg.content ?? null;
              stopReason = msg.stopReason as string | undefined;
              extractUsage(msg, (it, ot, cr, cw) => {
                inputTokens = it;
                outputTokens = ot;
                cacheReadTokens = cr;
                cacheWriteTokens = cw;
              });
            }
          }
        } else {
          // Last round: find last assistant message in finalMessages (AgentMessage[]).
          for (let j = finalMessages.length - 1; j >= 0; j -= 1) {
            const msg = finalMessages[j] as unknown as Record<string, unknown>;
            if (msg?.role === "assistant") {
              response = msg.content ?? null;
              stopReason = msg.stopReason as string | undefined;
              extractUsage(msg, (it, ot, cr, cw) => {
                inputTokens = it;
                outputTokens = ot;
                cacheReadTokens = cr;
                cacheWriteTokens = cw;
              });
              break;
            }
          }
        }

        // Duration: use next round's startedAt for intermediate rounds, Date.now() for last
        const endTime = isLastRound ? Date.now() : payloads[i + 1].startedAt;
        const durationMs = endTime - payload.startedAt;

        await createInteractionTrace({
          tenantId: ctx.tenantId,
          userId: ctx.tenantUserId,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          channel: ctx.channel,
          turnId,
          turnIndex: i,
          userInput: i === 0 ? ctx.userInput : undefined,
          provider: ctx.provider,
          model: ctx.modelId,
          systemPrompt: payload.systemPrompt,
          messages: payload.messages ?? [],
          tools: payload.tools,
          requestParams: payload.requestParams,
          response,
          stopReason,
          errorMessage: isLastRound
            ? error
              ? formatTraceError(error)
              : stopReason === "error"
                ? extractErrorFromResponse(response)
                : undefined
            : undefined,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          durationMs,
        });
      }
    })().catch((err) => {
      log.warn(`Failed to write interaction trace: ${String(err)}`);
    });
  };

  return { wrapStreamFn, setSystemPrompt, recordRound };
}

/** Extract error text from an assistant message response when stopReason is "error". */
export function extractErrorFromResponse(response: unknown): string | undefined {
  if (response == null) {return "LLM request failed (no response)";}
  // response is typically content array: [{type: "text", text: "..."}]
  if (Array.isArray(response)) {
    const texts = response
      .filter((c: Record<string, unknown>) => c?.type === "text" && c?.text)
      .map((c: Record<string, unknown>) => c.text as string);
    if (texts.length > 0) {return texts.join("\n");}
  }
  if (typeof response === "string" && response) {return response;}
  return "LLM request failed";
}

/** Build a non-empty error string for the trace, including HTTP status when available. */
export function formatTraceError(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg) {return msg;}
    // message is empty — use status or toString() as fallback
    const status = (error as { status?: number }).status;
    if (status) {return `${error.name || "Error"}: ${status} status code (no body)`;}
    return error.name || String(error) || "Unknown error";
  }
  return String(error) || "Unknown error";
}


function toInt(val: unknown): number {
  if (typeof val === "number") {return Math.floor(val);}
  if (typeof val === "string") {return parseInt(val, 10) || 0;}
  return 0;
}

/** Extract usage tokens from an assistant message (works for both LLM Message and AgentMessage). */
function extractUsage(
  msg: Record<string, unknown>,
  cb: (inputTokens: number, outputTokens: number, cacheRead: number, cacheWrite: number) => void,
): void {
  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage) {return;}
  cb(
    toInt(usage.input ?? usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens),
    toInt(usage.output ?? usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens),
    toInt(usage.cacheRead ?? usage.cache_read_input_tokens ?? usage.cached_tokens),
    toInt(usage.cacheWrite ?? usage.cache_creation_input_tokens),
  );
}
