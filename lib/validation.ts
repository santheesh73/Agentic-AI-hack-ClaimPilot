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
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: { code: "internal_error", message } }, { status: 500 });
}

/** Parses the request body as JSON and validates it against `schema`,
 * throwing a 400 ApiError with the first Zod issue on failure. */
export async function parseJsonBody<T extends ZodTypeAny>(req: NextRequest, schema: T): Promise<z.infer<T>> {
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

export const AnswerBody = z.object({
  answers: z.record(z.string().min(1), z.string().max(2000)),
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
