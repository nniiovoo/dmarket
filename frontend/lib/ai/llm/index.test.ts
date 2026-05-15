import { test } from "node:test";
import assert from "node:assert";

import { getLLMProvider, LLMProviderConfigError } from "./index";

// Pre-flight: snapshot the env vars we will be mutating so each test can
// restore them. node:test does not provide per-test setup/teardown, so
// we wrap each test in a small helper that does it manually.

const ENV_KEYS = ["LLM_PROVIDER", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

function withEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => void): void {
  const prior: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prior[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

test("LLM_PROVIDER=deepseek picks DeepSeekProvider", () => {
  withEnv(
    {
      LLM_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "sk-deepseek-test",
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined
    },
    () => {
      const p = getLLMProvider();
      assert.strictEqual(p.name, "deepseek");
      assert.strictEqual(p.model, "deepseek-chat");
    }
  );
});

test("LLM_PROVIDER=openai picks OpenAIProvider", () => {
  withEnv(
    {
      LLM_PROVIDER: "openai",
      DEEPSEEK_API_KEY: undefined,
      OPENAI_API_KEY: "sk-openai-test",
      ANTHROPIC_API_KEY: undefined
    },
    () => {
      const p = getLLMProvider();
      assert.strictEqual(p.name, "openai");
      assert.strictEqual(p.model, "gpt-4o-mini");
    }
  );
});

test("LLM_PROVIDER=anthropic picks AnthropicProvider", () => {
  withEnv(
    {
      LLM_PROVIDER: "anthropic",
      DEEPSEEK_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: "sk-ant-test"
    },
    () => {
      const p = getLLMProvider();
      assert.strictEqual(p.name, "anthropic");
      assert.strictEqual(p.model, "claude-sonnet-4-6");
    }
  );
});

test("LLM_PROVIDER=auto + only OPENAI_API_KEY → OpenAIProvider", () => {
  withEnv(
    {
      LLM_PROVIDER: "auto",
      DEEPSEEK_API_KEY: undefined,
      OPENAI_API_KEY: "sk-openai-test",
      ANTHROPIC_API_KEY: undefined
    },
    () => {
      const p = getLLMProvider();
      assert.strictEqual(p.name, "openai");
    }
  );
});

test("auto-detect prefers DeepSeek when multiple keys are present", () => {
  withEnv(
    {
      LLM_PROVIDER: undefined,
      DEEPSEEK_API_KEY: "sk-deepseek",
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-ant"
    },
    () => {
      const p = getLLMProvider();
      assert.strictEqual(p.name, "deepseek");
    }
  );
});

test("auto-detect falls back to Anthropic when only ANTHROPIC_API_KEY is set", () => {
  withEnv(
    {
      LLM_PROVIDER: undefined,
      DEEPSEEK_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: "sk-ant"
    },
    () => {
      const p = getLLMProvider();
      assert.strictEqual(p.name, "anthropic");
    }
  );
});

test("no provider key set → LLMProviderConfigError", () => {
  withEnv(
    {
      LLM_PROVIDER: undefined,
      DEEPSEEK_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined
    },
    () => {
      assert.throws(() => getLLMProvider(), (err) => err instanceof LLMProviderConfigError);
    }
  );
});

test("unknown LLM_PROVIDER throws LLMProviderConfigError", () => {
  withEnv({ LLM_PROVIDER: "gemini", DEEPSEEK_API_KEY: "sk-deepseek" }, () => {
    assert.throws(() => getLLMProvider(), (err) => err instanceof LLMProviderConfigError);
  });
});

test("empty-string API key is treated as unset", () => {
  withEnv(
    {
      LLM_PROVIDER: undefined,
      DEEPSEEK_API_KEY: "   ",
      OPENAI_API_KEY: "sk-openai"
    },
    () => {
      const p = getLLMProvider();
      assert.strictEqual(p.name, "openai");
    }
  );
});
