import "server-only";
import { supabaseAdmin } from "./db";
import { ApiError } from "./validation";

export const RATE_LIMITS = {
  step: { limit: 30, windowMs: 60_000 },
  newCase: { limit: 10, windowMs: 60 * 60_000 },
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

/** Start of the fixed window containing `now`, so every request in the same
 * window increments the same row. */
export function windowStart(now: Date, windowMs: number): string {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs).toISOString();
}

/** Atomically counts this request against the owner's bucket and throws a
 * 429 ApiError if it's over the limit (see supabase/migrations/0004). */
export async function enforceRateLimit(ownerId: string, bucket: RateLimitBucket, now = new Date()): Promise<void> {
  const { limit, windowMs } = RATE_LIMITS[bucket];
  const { data, error } = await supabaseAdmin().rpc("bump_rate_limit", {
    p_owner: ownerId,
    p_bucket: bucket,
    p_window_start: windowStart(now, windowMs),
    p_limit: limit,
  });
  if (error) throw error;
  if (data === false) {
    throw new ApiError(429, "rate_limited", `Too many requests: limit is ${limit} per ${windowMs / 60_000} minute(s).`);
  }
}
