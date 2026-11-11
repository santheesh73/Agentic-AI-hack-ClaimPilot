import "server-only";
import { generateObject, type LanguageModel } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { z } from "zod";
import { supabaseAdmin } from "./db";

export const PROMPT_VERSION = "v1";

export type LlmProvider = "anthropic" | "google";

/**
 * Configurable via LLM_PROVIDER=anthropic|google. Defaults to "google"
 * because that is the provider with a working key in this deployment; the
 * Anthropic path is fully implemented and switches on with LLM_PROVIDER=anthropic
 * plus ANTHROPIC_API_KEY, but has not been live-tested here for lack of a key.
 */
export const LLM_PROVIDER: LlmProvider = process.env.LLM_PROVIDER === "anthropic" ? "anthropic" : "google";

const DEFAULT_MODELS: Record<LlmProvider, { fast: string; strong: string }> = {
  anthropic: { fast: "claude-haiku-5-5", strong: "claude-sonnet-5-5" },
  // Both default to the same model: this deployment's Gemini key has quota
  // only for flash-tier models (gemini-2.5-pro/gemini-3.1-pro-preview both
  // 404 or have zero free-tier quota for this key -- see docs/ARCHITECTURE.md).
  google: { fast: "gemini-3.5-flash-lite", strong: "gemini-3.5-flash-lite" },
};

export const MODEL_FAST = process.env.MODEL_FAST ?? DEFAULT_MODELS[LLM_PROVIDER].fast;
export const MODEL_STRONG = process.env.MODEL_STRONG ?? DEFAULT_MODELS[LLM_PROVIDER].strong;

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function resolveModel(modelId: string): LanguageModel {
  return LLM_PROVIDER === "anthropic" ? anthropic(modelId) : google(modelId);
}

const TIMEOUT_MS = 30_000;

/** A chunk of prompt text. `cache` requests Anthropic ephemeral prompt
 * caching when LLM_PROVIDER=anthropic; it is a no-op under Google, whose
 * context-caching API differs and isn't wired up (see docs/ARCHITECTURE.md). */
export type CachedTextPart = { type: "text"; text: string; cache?: boolean };

type GenerateArgs<T extends z.ZodTypeAny> = {
  caseId: string;
  step: string;
  tool: string;
  model: string;
  schema: T;
  system: string;
  prompt: string | CachedTextPart[];
  temperature?: number;
};

/**
 * The single entry point for every model call in the agent, for both
 * supported providers. Applies a timeout, Zod validation with one retry on
 * schema failure, exponential backoff on 429/5xx (up to 2 retries), and logs
 * {provider, model, tokens, ms, ok} to agent_events.
 */
export async function generate<T extends z.ZodTypeAny>(
  args: GenerateArgs<T>
): Promise<z.infer<T>> {
  const { caseId, step, tool, model, schema, system, prompt, temperature = 0 } = args;

  const useAnthropicCaching = LLM_PROVIDER === "anthropic" && typeof prompt !== "string";
  const promptText = typeof prompt === "string" ? prompt : prompt.map((p) => p.text).join("\n\n");

  const messages = useAnthropicCaching
    ? [
        {
          role: "user" as const,
          content: (prompt as CachedTextPart[]).map((p) => ({
            type: "text" as const,
            text: p.text,
            ...(p.cache
              ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } } }
              : {}),
          })),
        },
      ]
    : undefined;

  const MAX_ATTEMPTS = 3; // 1 initial + up to 2 retries on 429/5xx; schema failures get exactly 1 retry total
  let schemaRetryUsed = false;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const start = Date.now();
    try {
      const result = messages
        ? await generateObject({
            model: resolveModel(model),
            schema,
            system,
            messages,
            temperature,
            abortSignal: AbortSignal.timeout(TIMEOUT_MS),
            maxRetries: 0, // retries are ours (below); the SDK's own would multiply them (6 calls per 429)
          })
        : await generateObject({
            model: resolveModel(model),
            schema,
            system,
            prompt: promptText,
            temperature,
            abortSignal: AbortSignal.timeout(TIMEOUT_MS),
            maxRetries: 0, // retries are ours (below); the SDK's own would multiply them (6 calls per 429)
          });

      await logEvent({
        caseId,
        step,
        tool,
        provider: LLM_PROVIDER,
        model,
        summary: undefined,
        input: { prompt_version: PROMPT_VERSION, system, prompt: typeof prompt === "string" ? prompt : "[parts]" },
        output: result.object,
        tokens_in: result.usage?.inputTokens,
        tokens_out: result.usage?.outputTokens,
        ms: Date.now() - start,
      });

      return result.object as z.infer<T>;
    } catch (err) {
      lastError = err;
      const status = extractHttpStatus(err);
      const isRetryableStatus = status === 429 || (status != null && status >= 500);
      // Only a response that arrived but didn't parse (no HTTP error status) earns the one schema retry; a 401/400 is not retried.
      const isSchemaFailure = status === undefined && !schemaRetryUsed;

      await logEvent({
        caseId,
        step,
        tool,
        provider: LLM_PROVIDER,
        model,
        summary: `Model call failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}, status=${status ?? "n/a"}): ${(err as Error).message}`,
        input: { prompt_version: PROMPT_VERSION, system },
        output: null,
        ms: Date.now() - start,
      });

      if (isSchemaFailure) {
        schemaRetryUsed = true;
        continue;
      }
      if (isRetryableStatus && attempt < MAX_ATTEMPTS - 1) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

function extractHttpStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "statusCode" in err) {
    const code = (err as { statusCode?: unknown }).statusCode;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function logEvent(args: {
  caseId: string;
  step: string;
  tool?: string | null;
  provider?: LlmProvider | null;
  model?: string | null;
  summary?: string | null;
  input?: unknown;
  output?: unknown;
  tokens_in?: number | null;
  tokens_out?: number | null;
  ms?: number | null;
}) {
  const db = supabaseAdmin();
  await db.from("agent_events").insert({
    case_id: args.caseId,
    step: args.step,
    tool: args.tool ?? null,
    provider: args.provider ?? null,
    model: args.model ?? null,
    summary: args.summary ?? null,
    input: args.input ?? null,
    output: args.output ?? null,
    tokens_in: args.tokens_in ?? null,
    tokens_out: args.tokens_out ?? null,
    ms: args.ms ?? null,
  });
}
