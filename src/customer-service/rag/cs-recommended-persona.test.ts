/**
 * Tests for CS recommended persona defaults and builder.
 *
 * 推荐人设默认值及 builder 函数测试——验证 3 个 MD 常量内容正确、
 * {companyName} 占位符替换正确（identity 含企业名、不含原始占位符；
 * soul/agents 不含占位符，替换后内容完整）。
 */

import { describe, expect, it } from "vitest";
import {
  RECOMMENDED_IDENTITY_MD,
  RECOMMENDED_SOUL_MD,
  RECOMMENDED_AGENTS_MD,
  buildRecommendedPersona,
} from "./cs-recommended-persona.js";

describe("RECOMMENDED_IDENTITY_MD", () => {
  it("contains the {companyName} placeholder", () => {
    expect(RECOMMENDED_IDENTITY_MD).toContain("{companyName}");
  });

  it("contains required role section content", () => {
    expect(RECOMMENDED_IDENTITY_MD).toContain("AI 客服助手");
    expect(RECOMMENDED_IDENTITY_MD).toContain("产品知识库");
  });

  it("contains style/tone section", () => {
    expect(RECOMMENDED_IDENTITY_MD).toContain("专业、友好、简洁");
    expect(RECOMMENDED_IDENTITY_MD).toContain("200 字以内");
  });
});

describe("RECOMMENDED_SOUL_MD", () => {
  it("contains core constraint heading", () => {
    expect(RECOMMENDED_SOUL_MD).toContain("严格基于知识库作答");
  });

  it("contains self-check rule", () => {
    expect(RECOMMENDED_SOUL_MD).toContain("发出回复前自检");
  });

  it("contains forbidden behaviors section", () => {
    expect(RECOMMENDED_SOUL_MD).toContain("禁止行为");
  });

  it("does not contain a {companyName} placeholder", () => {
    expect(RECOMMENDED_SOUL_MD).not.toContain("{companyName}");
  });
});

describe("RECOMMENDED_AGENTS_MD", () => {
  it("contains behavior rules", () => {
    expect(RECOMMENDED_AGENTS_MD).toContain("行为规则");
  });

  it("contains knowledge-base-first rule", () => {
    expect(RECOMMENDED_AGENTS_MD).toContain("优先基于知识库回答");
  });

  it("contains escalation rule", () => {
    expect(RECOMMENDED_AGENTS_MD).toContain("通知负责人");
  });

  it("does not contain a {companyName} placeholder", () => {
    expect(RECOMMENDED_AGENTS_MD).not.toContain("{companyName}");
  });
});

describe("buildRecommendedPersona", () => {
  const COMPANY = "测试企业";

  it("returns an object with identity, soul, and agents keys", () => {
    const result = buildRecommendedPersona(COMPANY);
    expect(result).toHaveProperty("identity");
    expect(result).toHaveProperty("soul");
    expect(result).toHaveProperty("agents");
  });

  it("substitutes company name into identity", () => {
    const { identity } = buildRecommendedPersona(COMPANY);
    expect(identity).toContain(COMPANY);
  });

  it("removes {companyName} placeholder from identity after substitution", () => {
    const { identity } = buildRecommendedPersona(COMPANY);
    expect(identity).not.toContain("{companyName}");
  });

  it("soul content is preserved correctly after (harmless) replacement", () => {
    const { soul } = buildRecommendedPersona(COMPANY);
    expect(soul).toContain("严格基于知识库作答");
    expect(soul).not.toContain("{companyName}");
  });

  it("agents content is preserved correctly after (harmless) replacement", () => {
    const { agents } = buildRecommendedPersona(COMPANY);
    expect(agents).toContain("行为规则");
    expect(agents).not.toContain("{companyName}");
  });

  it("works correctly for a different company name", () => {
    const { identity } = buildRecommendedPersona("Acme Corp");
    expect(identity).toContain("Acme Corp");
    expect(identity).not.toContain("{companyName}");
  });

  it("handles edge case: empty company name string", () => {
    const { identity } = buildRecommendedPersona("");
    // Placeholder removed (replaced with empty string), no literal "{companyName}" remains
    expect(identity).not.toContain("{companyName}");
  });
});
