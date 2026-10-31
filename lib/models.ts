import "server-only";
import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { z } from "zod";
import { supabaseAdmin } from "./db";

export const PROMPT_VERSION = "v1";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const MODEL_FAST = process.env.MODEL_FAST ?? "claude-haiku-5-5";
export const MODEL_STRONG = process.env.MODEL_STRONG ?? "claude-sonnet-5-5";

const TIMEOUT_MS = 30_000;

export type CachedTextPart = { type: "text"; text: string; cache?: boolean };

type GenerateArgs<T extends z.ZodTypeAny> = {
  caseId: string;
  step: string;
  tool: string;
  model: string;
  schema: T;
  system: string;
  /** Plain string, or parts where any with cache:true get ephemeral prompt caching. */
  prompt: string | CachedTextPart[];
  temperature?: number;
};

/**
 * The single entry point for every model call in the agent. Applies a
 * timeout, Zod validation with one retry, and logs tokens/ms/model to
 * agent_events.
 */
export async function generate<T extends z.ZodTypeAny>(
  args: GenerateArgs<T>
): Promise<z.infer<T>> {
  const { caseId, step, tool, model, schema, system, prompt, temperature = 0 } = args;

  const messages =
    typeof prompt === "string"
      ? prompt
      : [
          {
            role: "user" as const,
            content: prompt.map((p) => ({
              type: "text" as const,
              text: p.text,
              ...(p.cache
                ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
                : {}),
            })),
          },
        ];

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = Date.now();
    try {
      const result = await generateObject({
        model: anthropic(model),
        schema,
        system,
        ...(typeof messages === "string" ? { prompt: messages } : { messages }),
        temperature,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      });

      await logEvent({
        caseId,
        step,
        tool,
        model,
        summary: undefined,
        input: { system, prompt: typeof prompt === "string" ? prompt : "[cached parts]" },
        output: result.object,
        tokens_in: result.usage?.inputTokens,
        tokens_out: result.usage?.outputTokens,
        ms: Date.now() - start,
      });

      return result.object as z.infer<T>;
    } catch (err) {
      lastError = err;
      await logEvent({
        caseId,
        step,
        tool,
        model,
        summary: `Model call failed (attempt ${attempt + 1}): ${(err as Error).message}`,
        input: { system },
        output: null,
        ms: Date.now() - start,
      });
    }
  }
  throw lastError;
}

export async function logEvent(args: {
  caseId: string;
  step: string;
  tool?: string | null;
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
    model: args.model ?? null,
    summary: args.summary ?? null,
    input: args.input ?? null,
    output: args.output ?? null,
    tokens_in: args.tokens_in ?? null,
    tokens_out: args.tokens_out ?? null,
    ms: args.ms ?? null,
  });
}
