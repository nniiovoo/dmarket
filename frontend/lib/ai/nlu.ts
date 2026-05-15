import { z } from "zod";

import type Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources";

import { computeCostUsd, getLLMClient, LLM_MODEL, type TokenUsage } from "./llm";
import { SYSTEM_PROMPT } from "./prompts";

import type { SearchProductsInput, SearchSortBy } from "@/lib/search/products";

// JSON schema for the `extract_query` tool. Hand-authored rather than
// generated from a Zod schema because we want fine control over what the
// model sees (descriptions matter for tool-use quality), and zod-to-json
// would be a new dep for one usage. Stays in lock-step with
// extractQuerySchema below.
// `MessageCreateParamsNonStreaming["tools"]` is `(ToolUnion | ToolBash20250124 | ...)[]`.
// We narrow to the single in-house tool shape via the SDK's tool type and
// let TS check both the schema fields and tool name in lockstep.
type AnthropicTool = NonNullable<MessageCreateParamsNonStreaming["tools"]>[number];

const EXTRACT_QUERY_TOOL: AnthropicTool = {
  name: "extract_query",
  description:
    "Extract structured search parameters from a user's free-text shopping query for the ChainUs product search service.",
  input_schema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description: "Primary product descriptor (brand, model, feature keywords). Strip qualifiers that have their own fields."
      },
      priceMaxWei: {
        type: "string",
        pattern: "^[0-9]+$",
        description: "Upper price bound in wei (or token base units). Omit if user did not state one or you cannot determine the currency."
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
  }
};

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

export interface NLUResult {
  parsed: SearchProductsInput;
  confidence: Confidence;
  explanation: string;
  usage: TokenUsage;
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
    super(`NLU output failed schema validation: ${issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
    this.issues = issues;
    this.raw = raw;
  }
}

// Public seam for tests — pass in a stub `messages.create` to avoid
// hitting the network. Production callers use parseUserQuery(query).
export async function parseUserQueryWithClient(
  client: Pick<Anthropic, "messages">,
  query: string
): Promise<NLUResult> {
  const response = await client.messages.create({
    model: LLM_MODEL,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" }
      }
    ],
    tools: [EXTRACT_QUERY_TOOL],
    tool_choice: { type: "tool", name: "extract_query" },
    messages: [{ role: "user", content: query }]
  });

  // Find the tool_use content block; tool_choice forces one, but we
  // still defend against a malformed response.
  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new NLUParseError("Anthropic response did not include a tool_use block", response);
  }
  if (toolUse.name !== EXTRACT_QUERY_TOOL.name) {
    throw new NLUParseError(`Unexpected tool name ${toolUse.name}`, response);
  }

  const parsedResult = extractQuerySchema.safeParse(toolUse.input);
  if (!parsedResult.success) {
    throw new NLUSchemaError(parsedResult.error.issues, toolUse.input);
  }
  const data = parsedResult.data;

  const usage = response.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  const inputTokens = usage.input_tokens ?? 0;
  const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const tokenUsage: TokenUsage = {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: computeCostUsd(inputTokens, cachedInputTokens, outputTokens)
  };

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
    usage: tokenUsage
  };
}

export function parseUserQuery(query: string): Promise<NLUResult> {
  return parseUserQueryWithClient(getLLMClient(), query);
}

// Exported for tests + recommend.ts diagnostics.
export const __extractQueryToolName = EXTRACT_QUERY_TOOL.name;
