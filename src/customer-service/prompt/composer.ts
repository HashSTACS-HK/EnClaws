import { CUSTOMER_SERVICE_OUTPUT_POLICY } from "./output-policy.js";

export interface ComposeCustomerServicePromptParams {
  servicePrompt: string;
  conversationContext?: string;
  businessContext?: string;
  platformPolicy?: string;
}

export function composeCustomerServicePrompt(params: ComposeCustomerServicePromptParams): string {
  return [
    params.platformPolicy ?? CUSTOMER_SERVICE_OUTPUT_POLICY,
    wrapSection("customer_service_behavior_and_knowledge", params.servicePrompt),
    params.conversationContext,
    wrapSection("customer_service_business_context", params.businessContext),
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");
}

function wrapSection(tag: string, content: string | undefined): string | undefined {
  const trimmed = content?.trim();
  if (!trimmed) {
    return undefined;
  }
  return `<${tag}>\n${trimmed}\n</${tag}>`;
}
