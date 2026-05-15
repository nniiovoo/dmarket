import { AnthropicProvider } from "./anthropic";
import { DeepSeekProvider } from "./deepseek";
import { OpenAIProvider } from "./openai";
import { LLMProviderConfigError, type LLMProvider, type ProviderName } from "./types";

export {
  addUsage,
  emptyUsage,
  LLMConfigError,
  LLMProviderConfigError
} from "./types";
export type {
  LLMCallOptions,
  LLMProvider,
  LLMToolCall,
  LLMToolResponse,
  LLMUsage,
  ProviderName,
  TokenUsage
} from "./types";

// Provider factory. The auto-detect order is cost-ascending so a dev
// who has multiple keys in their .env gets the cheapest one by
// default; explicit LLM_PROVIDER=<name> overrides the auto-detect.

const ENV_KEY_BY_PROVIDER: Record<ProviderName, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY"
};

const AUTO_DETECT_ORDER: ProviderName[] = ["deepseek", "openai", "anthropic"];

function buildProvider(name: ProviderName): LLMProvider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    case "deepseek":
      return new DeepSeekProvider();
  }
}

export function getLLMProvider(): LLMProvider {
  const explicit = process.env.LLM_PROVIDER?.trim();
  if (explicit && explicit !== "auto") {
    if (!(explicit in ENV_KEY_BY_PROVIDER)) {
      throw new LLMProviderConfigError(
        `Unknown LLM_PROVIDER "${explicit}". Set one of: anthropic, openai, deepseek (or unset for auto-detect).`
      );
    }
    return buildProvider(explicit as ProviderName);
  }

  for (const name of AUTO_DETECT_ORDER) {
    const envKey = ENV_KEY_BY_PROVIDER[name];
    const value = process.env[envKey];
    if (value && value.trim() !== "") {
      return buildProvider(name);
    }
  }

  throw new LLMProviderConfigError(
    "No LLM API key configured. Set DEEPSEEK_API_KEY (cheapest), OPENAI_API_KEY, or ANTHROPIC_API_KEY in .env.local."
  );
}

// Test-only seam: allow tests to inject a fake provider without env juggling.
let injectedProviderForTesting: LLMProvider | null = null;

export function __setLLMProviderForTesting(provider: LLMProvider | null): void {
  injectedProviderForTesting = provider;
}

export function resolveLLMProvider(): LLMProvider {
  if (injectedProviderForTesting !== null) return injectedProviderForTesting;
  return getLLMProvider();
}
