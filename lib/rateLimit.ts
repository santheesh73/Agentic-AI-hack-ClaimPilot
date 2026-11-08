import "server-only";
import { supabaseAdmin } from "./db";
import { ApiError } from "./validation";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Fixed-window limits. Each request is counted against the owner cookie AND
 * the client IP, because the owner cookie is minted for any cookieless
 * request -- limiting on it alone is bypassed by simply dropping the cookie
 * (audit F-007). Actions that spend model tokens also count against one
 * global daily budget, so no single client can exhaust the shared API quota.
 */
export const RATE_LIMITS = {
  step: { limit: 30, windowMs: MINUTE },
  newCase: { limit: 10, windowMs: HOUR },
  upload: { limit: 30, windowMs: HOUR },
  answer: { limit: 30, windowMs: HOUR },
  simulate: { limit: 30, windowMs: HOUR },
  "ip:step": { limit: 60, windowMs: MINUTE },
  "ip:newCase": { limit: 20, windowMs: HOUR },
  "ip:upload": { limit: 60, windowMs: HOUR },
  "ip:answer": { limit: 60, windowMs: HOUR },
  "ip:simulate": { limit: 60, windowMs: HOUR },
  "global:llm": { limit: 0, windowMs: DAY }, // limit resolved at runtime, see globalDailyLimit()
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMITS;
export type Action = "step" | "newCase" | "upload" | "answer" | "simulate";

const LLM_ACTIONS: ReadonlySet<Action> = new Set(["step", "simulate"]);
export const DEFAULT_GLOBAL_DAILY_LLM_CALLS = 1500;

/** GLOBAL_DAILY_LLM_CALLS if set to a positive integer, otherwise the default. */
export function globalDailyLimit(): number {
  const n = Number(process.env.GLOBAL_DAILY_LLM_CALLS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_GLOBAL_DAILY_LLM_CALLS;
}

/** Start of the fixed window containing `now`, so every request in the same
 * window increments the same row. */
export function windowStart(now: Date, windowMs: number): string {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs).toISOString();
}

/** Best-effort client IP. On Vercel the platform sets x-forwarded-for, whose
 * first entry is the client; behind another proxy, configure it to do the same. */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Atomically counts this request against `key`'s bucket and throws a 429
 * ApiError if it's over the limit (see supabase/migrations/0004). */
export async function enforceRateLimit(key: string, bucket: RateLimitBucket, now = new Date()): Promise<void> {
  const { windowMs } = RATE_LIMITS[bucket];
  const limit = bucket === "global:llm" ? globalDailyLimit() : RATE_LIMITS[bucket].limit;
  const { data, error } = await supabaseAdmin().rpc("bump_rate_limit", {
    p_owner: key,
    p_bucket: bucket,
    p_window_start: windowStart(now, windowMs),
    p_limit: limit,
  });
  if (error) throw error;
  if (data === false) {
    const message =
      bucket === "global:llm"
        ? "ClaimPilot has reached its daily usage limit. Please try again tomorrow."
        : `Too many requests: limit is ${limit} per ${windowMs / MINUTE} minute(s).`;
    throw new ApiError(429, "rate_limited", message);
  }
}

/** Applies every limit that governs `action` for this request: per owner, per IP, and (for model-spending actions) the global daily budget. */
export async function enforceRequestLimits(req: Request, ownerId: string, action: Action, now = new Date()): Promise<void> {
  await enforceRateLimit(ownerId, action, now);
  await enforceRateLimit(`ip:${clientIp(req)}`, `ip:${action}`, now);
  if (LLM_ACTIONS.has(action)) await enforceRateLimit("global", "global:llm", now);
}
