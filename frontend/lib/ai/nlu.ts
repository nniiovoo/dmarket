import { z } from "zod";

import { resolveLLMProvider } from "./llm";
import type { LLMProvider, LLMToolResponse } from "./llm";
import { SYSTEM_PROMPT } from "./prompts";

import type { SearchProductsInput, SearchSortBy } from "@/lib/search/products";

// NLU stage — single Claude/OpenAI/DeepSeek tool call that parses a
// free-text shopping query into structured search input. Phase I.5
// moved the LLM transport out of this file into lib/ai/llm/* so the
// same NLU code runs on whichever provider is configured.
//
// The tool's JSON Schema is hand-authored (descriptions matter for
// tool-use quality across providers; auto-generated schemas tend to
// drop them) and stays in lock-step with extractQuerySchema below.

const EXTRACT_QUERY_TOOL_NAME = "extract_query";
const EXTRACT_QUERY_TOOL_DESCRIPTION =
  "Extract structured search parameters from a user's free-text shopping query for the ChainUs product search service.";

const EXTRACT_QUERY_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    q: {
      type: "string",
      description:
        "Primary product descriptor (brand, model, feature keywords). Strip qualifiers that have their own fields."
    },
    priceMaxWei: {
      type: "string",
      pattern: "^[0-9]+$",
      description:
        "Upper price bound in wei (or token base units). Omit if user did not state one or you cannot determine the currency."
    },
    priceMinWei: {
      type: "string",
      pattern: "^[0-9]+$",
      description: "Lower price bound. Omit unless user explicitly stated one."
    },
    chainId: {
      type: "integer",
      enum: [421614, 11155111, 80002],
      description: "EVM chain id. Only set if the user named a chain explicitly."
    },
    sortBy: {
      type: "string",
      enum: ["relevance", "price_asc", "price_desc", "recent"],
      description: "Sort order. relevance is the default for keyword queries; recent for empty queries."
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "Result count cap (default 10)."
    },
    offset: {
      type: "integer",
      minimum: 0,
      description: "Pagination offset (default 0)."
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "How sure you are that the structured query matches the user's intent."
    },
    explanation: {
      type: "string",
      description: "One or two sentences for the user explaining what you assumed."
    }
  },
  required: ["q", "sortBy", "limit", "offset", "confidence", "explanation"],
  additionalProperties: false
} as const;

const extractQuerySchema = z.object({
  q: z.string().max(200),
  priceMaxWei: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  priceMinWei: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  chainId: z.number().int().optional(),
  sortBy: z.enum(["relevance", "price_asc", "price_desc", "recent"]),
  limit: z.number().int().min(1).max(20),
  offset: z.number().int().min(0),
  confidence: z.enum(["high", "medium", "low"]),
  explanation: z.string().max(1000)
});

export type Confidence = "high" | "medium" | "low";

// Surfaced usage shape. Mirrors LLMUsage but with provider/model tagged
// on so the /api/ai/recommend response can identify what served the
// query without changing the route's top-level body shape.
export interface NLUUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  providerName: string;
  model: string;
}

export interface NLUResult {
  parsed: SearchProductsInput;
  confidence: Confidence;
  explanation: string;
  usage: NLUUsage;
}

export class NLUParseError extends Error {
  readonly raw: unknown;
  constructor(message: string, raw: unknown) {
    super(message);
    this.raw = raw;
  }
}

export class NLUSchemaError extends Error {
  readonly raw: unknown;
  readonly issues: z.ZodIssue[];
  constructor(issues: z.ZodIssue[], raw: unknown) {
    super(
      `NLU output failed schema validation: ${issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`
    );
    this.issues = issues;
    this.raw = raw;
  }
}

// Public seam for tests — pass in a stub LLMProvider whose
// `callWithTool` returns whatever the test wants.
export async function parseUserQueryWithProvider(
  provider: LLMProvider,
  query: string
): Promise<NLUResult> {
  let response: LLMToolResponse<unknown>;
  try {
    response = await provider.callWithTool({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: query,
      toolName: EXTRACT_QUERY_TOOL_NAME,
      toolDescription: EXTRACT_QUERY_TOOL_DESCRIPTION,
      toolInputSchema: EXTRACT_QUERY_TOOL_INPUT_SCHEMA,
      maxTokens: 1024,
      cacheable: true
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("did not include a tool_use")) {
      throw new NLUParseError(err.message, err);
    }
    throw err;
  }

  if (response.toolCall.toolName !== EXTRACT_QUERY_TOOL_NAME) {
    throw new NLUParseError(`Unexpected tool name ${response.toolCall.toolName}`, response);
  }

  const parsedResult = extractQuerySchema.safeParse(response.toolCall.input);
  if (!parsedResult.success) {
    throw new NLUSchemaError(parsedResult.error.issues, response.toolCall.input);
  }
  const data = parsedResult.data;

  const parsed: SearchProductsInput = {
    q: data.q,
    sortBy: data.sortBy as SearchSortBy,
    limit: data.limit,
    offset: data.offset,
    ...(data.priceMaxWei !== undefined ? { priceMaxWei: BigInt(data.priceMaxWei) } : {}),
    ...(data.priceMinWei !== undefined ? { priceMinWei: BigInt(data.priceMinWei) } : {}),
    ...(data.chainId !== undefined ? { chainId: data.chainId } : {})
  };

  return {
    parsed,
    confidence: data.confidence,
    explanation: data.explanation,
    usage: {
      inputTokens: response.usage.inputTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.usage.costUsd,
      providerName: response.providerName,
      model: response.model
    }
  };
}

export function parseUserQuery(query: string): Promise<NLUResult> {
  return parseUserQueryWithProvider(resolveLLMProvider(), query);
}

// Exported for tests + recommend.ts diagnostics.
export const __extractQueryToolName = EXTRACT_QUERY_TOOL_NAME;
