import "server-only";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z, type ZodTypeAny } from "zod";

/** A uniform {error:{code,message}} API error, per docs/AUDIT.md's error contract. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function notFoundResponse(): NextResponse {
  return NextResponse.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  // Never echo internals (hostnames, SQL, provider messages) to the client: log them server-side
  // and hand the client a generic message plus an id to quote.
  const requestId = crypto.randomUUID();
  console.error(`[api] unhandled error ${requestId}`, err);
  return NextResponse.json(
    { error: { code: "internal_error", message: "Something went wrong on our side. Please try again.", request_id: requestId } },
    { status: 500 }
  );
}

/** Rejects a browser request whose Origin is another site. The owner cookie is SameSite=Lax; this is a second layer for state-changing routes. Requests with no Origin header (same-origin GETs, non-browser clients) pass. */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, "cross_origin", "Cross-origin requests are not allowed.");
  }
  if (originHost !== host) throw new ApiError(403, "cross_origin", "Cross-origin requests are not allowed.");
}

/** Parses the request body as JSON and validates it against `schema`,
 * throwing a 400 ApiError with the first Zod issue on failure. */
export async function parseJsonBody<T extends ZodTypeAny>(req: NextRequest, schema: T): Promise<z.infer<T>> {
  assertSameOrigin(req);
  if (!/application\/json/i.test(req.headers.get("content-type") ?? "")) {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ApiError(400, "invalid_body", `${issue.path.join(".") || "body"}: ${issue.message}`);
  }
  return result.data;
}

// --- Per-route request schemas ---

export const CreateCaseBody = z.object({
  title: z.string().max(200).nullable().optional(),
  insurer: z.string().max(200).nullable().optional(),
  claim_amount_inr: z
    .number()
    .positive()
    .max(100_000_000, "claim_amount_inr must not exceed 10 crore")
    .nullable()
    .optional(),
});

// Answers are fed into every later prompt, so they are small and few: at most 10, short keys, 1000 chars each.
export const ANSWER_MAX_ENTRIES = 10;
export const ANSWER_MAX_CHARS = 1000;
export const AnswerBody = z.object({
  answers: z
    .record(z.string().regex(/^[A-Za-z0-9_]{1,64}$/, "answer keys must be 1-64 letters, digits or underscores"), z.string().min(1).max(ANSWER_MAX_CHARS))
    .refine((o) => Object.keys(o).length >= 1 && Object.keys(o).length <= ANSWER_MAX_ENTRIES, {
      message: `provide between 1 and ${ANSWER_MAX_ENTRIES} answers`,
    }),
});

export const SimulateBody = z.object({
  days: z.number().int().positive().max(3650, "days must not exceed 10 years"),
});

export const SampleBody = z.object({
  sample: z.enum(["a", "b", "c"]),
});

export const PASTED_LETTER_MAX_CHARS = 20_000;
export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
export const UPLOAD_MAX_PAGES = 200;

export const DocumentKind = z.enum(["policy", "rejection", "discharge", "other"]);
