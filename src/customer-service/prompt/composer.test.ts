import { describe, expect, it } from "vitest";
import { composeCustomerServicePrompt } from "./composer.js";

describe("composeCustomerServicePrompt", () => {
  it("places platform policy before editable service prompt and runtime context", () => {
    const prompt = composeCustomerServicePrompt({
      servicePrompt: "AI employee persona and KB snippets",
      conversationContext:
        "<customer_service_conversation_context>history</customer_service_conversation_context>",
      businessContext: "business metadata",
    });

    expect(prompt).toContain("<customer_service_platform_policy>");
    expect(prompt).toContain("[confidence:X.XX]");
    expect(prompt).toContain("<customer_service_behavior_and_knowledge>");
    expect(prompt).toContain("AI employee persona and KB snippets");
    expect(prompt).toContain("<customer_service_conversation_context>history");
    expect(prompt).toContain("<customer_service_business_context>");

    expect(prompt.indexOf("<customer_service_platform_policy>")).toBeLessThan(
      prompt.indexOf("<customer_service_behavior_and_knowledge>"),
    );
  });

  it("allows tests to inject a custom platform policy", () => {
    const prompt = composeCustomerServicePrompt({
      platformPolicy: "<custom_policy>custom</custom_policy>",
      servicePrompt: "service",
    });

    expect(prompt).toContain("<custom_policy>custom</custom_policy>");
    expect(prompt).not.toContain("<customer_service_platform_policy>");
  });
});
