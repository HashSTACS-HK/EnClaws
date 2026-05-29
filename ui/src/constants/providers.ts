/**
 * Shared model provider definitions.
 *
 * Used by onboarding wizard and tenant-models management page.
 */

export interface ProviderDef {
  value: string;
  label: string;
  defaultBaseUrl: string;
  defaultProtocol: string;
  placeholder?: string;
}

export const PROVIDER_TYPES: readonly ProviderDef[] = [
  {
    value: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultProtocol: "openai-completions",
    placeholder: "sk-...",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultProtocol: "anthropic-messages",
    placeholder: "sk-ant-...",
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultProtocol: "openai-completions",
    placeholder: "sk-...",
  },
  {
    value: "qwen",
    label: "Qwen (通义千问)",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultProtocol: "openai-completions",
    placeholder: "sk-...",
  },
  {
    value: "zhipu",
    label: "ZAI (智谱)",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultProtocol: "openai-completions",
    placeholder: "...",
  },
  {
    value: "moonshot",
    label: "Moonshot (月之暗面)",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    defaultProtocol: "openai-completions",
    placeholder: "sk-...",
  },
  {
    value: "minimax",
    label: "MiniMax",
    defaultBaseUrl: "https://api.minimax.chat/v1",
    defaultProtocol: "openai-completions",
    placeholder: "...",
  },
  {
    value: "siliconflow",
    label: "SiliconFlow (硅基流动)",
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    defaultProtocol: "openai-completions",
    placeholder: "sk-...",
  },
  {
    value: "google",
    label: "Google Gemini",
    defaultBaseUrl: "",
    defaultProtocol: "google-generative-ai",
    placeholder: "...",
  },
  {
    value: "bedrock",
    label: "AWS Bedrock",
    defaultBaseUrl: "",
    defaultProtocol: "bedrock-converse-stream",
    placeholder: "...",
  },
  {
    value: "ollama",
    label: "Ollama",
    defaultBaseUrl: "http://localhost:11434",
    defaultProtocol: "ollama",
    placeholder: "...",
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultProtocol: "openai-completions",
    placeholder: "sk-or-...",
  },
  {
    value: "custom",
    label: "Custom",
    defaultBaseUrl: "",
    defaultProtocol: "openai-completions",
    placeholder: "...",
  },
] as const;

export const API_PROTOCOLS = [
  { value: "openai-completions", label: "OpenAI Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
  { value: "bedrock-converse-stream", label: "AWS Bedrock" },
  { value: "ollama", label: "Ollama" },
] as const;
