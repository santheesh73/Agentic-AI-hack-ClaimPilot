import "server-only";
import { z } from "zod";

const envSchema = z
  .object({
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    LLM_PROVIDER: z.enum(["anthropic", "google"]).default("google"),
    GEMINI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    MODEL_FAST: z.string().optional(),
    MODEL_STRONG: z.string().optional(),
    MAX_TOKENS_PER_CASE: z.coerce.number().int().positive().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.LLM_PROVIDER === "google" && !val.GEMINI_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["GEMINI_API_KEY"], message: "required when LLM_PROVIDER=google" });
    }
    if (val.LLM_PROVIDER === "anthropic" && !val.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "required when LLM_PROVIDER=anthropic" });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Validates and returns process.env against envSchema, throwing a single
 * readable error listing every problem at once rather than failing on
 * whichever var happens to be read first. Call this once per process (e.g.
 * at the top of a route handler, or in a test) -- it's cheap to call
 * repeatedly since the result is cached after the first successful parse.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Missing or invalid environment variables:\n${lines.join("\n")}\n\nSee .env.example.`);
  }
  cached = result.data;
  return cached;
}

/** Test-only: clears the cached env so a test can re-validate with a
 * different process.env. Not used by application code. */
export function _resetEnvCacheForTests() {
  cached = null;
}
