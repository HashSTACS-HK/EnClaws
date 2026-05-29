/**
 * Layer 3: LLM-as-Judge module.
 *
 * Uses an LLM to evaluate the quality of bot replies against human-defined criteria.
 */

import type { LlmJudgeConfig, LlmJudgeAssert } from "../types.js";

export type JudgeCriterionResult = {
  criterion: string;
  passed: boolean;
  reason: string;
};

export type JudgeResult = {
  criteriaResults: JudgeCriterionResult[];
  score: number;
  passed: boolean;
};

/**
 * Evaluate a bot reply against a list of criteria using an LLM.
 */
export async function evaluateReply(
  config: LlmJudgeConfig,
  userMessage: string,
  botReply: string,
  judgeAssert: LlmJudgeAssert,
): Promise<JudgeResult> {
  const threshold = judgeAssert.passThreshold ?? 0.75;

  const prompt = buildJudgePrompt(userMessage, botReply, judgeAssert.criteria);

  const response = await callLlm(config, prompt);

  const criteriaResults = parseJudgeResponse(response, judgeAssert.criteria);

  const passedCount = criteriaResults.filter((c) => c.passed).length;
  const score = criteriaResults.length > 0 ? passedCount / criteriaResults.length : 0;
  const passed = score >= threshold;

  return { criteriaResults, score, passed };
}

function buildJudgePrompt(userMessage: string, botReply: string, criteria: string[]): string {
  const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

  return `You are a strict QA judge evaluating a chatbot's reply quality.

## User Message
${userMessage}

## Bot Reply
${botReply}

## Evaluation Criteria
${criteriaList}

## Instructions
Evaluate EACH criterion independently. For each one, determine if the bot reply satisfies it.

Respond in JSON format ONLY, no other text:
{
  "results": [
    {"criterion": 1, "passed": true, "reason": "brief explanation"},
    {"criterion": 2, "passed": false, "reason": "brief explanation"}
  ]
}`;
}

async function callLlm(config: LlmJudgeConfig, prompt: string): Promise<string> {
  if (config.provider === "anthropic") {
    return callAnthropic(config, prompt);
  }
  if (config.provider === "openai") {
    return callOpenAI(config, prompt);
  }
  throw new Error(`Unsupported LLM provider: ${config.provider}`);
}

async function callAnthropic(config: LlmJudgeConfig, prompt: string): Promise<string> {
  const baseUrl = config.baseUrl ?? "https://api.anthropic.com";
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as Record<string, any>;
  return data.content?.[0]?.text ?? "";
}

async function callOpenAI(config: LlmJudgeConfig, prompt: string): Promise<string> {
  const baseUrl = config.baseUrl ?? "https://api.openai.com";
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as Record<string, any>;
  return data.choices?.[0]?.message?.content ?? "";
}

function parseJudgeResponse(response: string, criteria: string[]): JudgeCriterionResult[] {
  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.log(`  [LLM Judge] Failed to parse response: ${response.slice(0, 200)}`);
    return criteria.map((c) => ({
      criterion: c,
      passed: false,
      reason: "Failed to parse LLM response",
    }));
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      results: Array<{ criterion: number; passed: boolean; reason: string }>;
    };

    return criteria.map((c, i) => {
      const r = parsed.results?.find((r) => r.criterion === i + 1);
      return {
        criterion: c,
        passed: r?.passed ?? false,
        reason: r?.reason ?? "No evaluation returned",
      };
    });
  } catch {
    console.log(`  [LLM Judge] JSON parse error: ${jsonMatch[0].slice(0, 200)}`);
    return criteria.map((c) => ({
      criterion: c,
      passed: false,
      reason: "JSON parse error in LLM response",
    }));
  }
}
