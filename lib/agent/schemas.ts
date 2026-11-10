import { z } from "zod";

export const RejectionFacts = z.object({
  insurer: z.string().nullable(),
  policy_no: z.string().nullable(),
  claim_no: z.string().nullable(),
  patient_name: z.string().nullable(),
  claim_amount_inr: z.number().nullable(),
  rejection_date: z.string().nullable(),
  admission_date: z.string().nullable(),
  policy_start_date: z.string().nullable(),
  diagnosis: z.string().nullable(),
  reason_summary: z.string(),
  clause_cited: z.string().nullable(),
  reason_category: z.enum([
    "pre_existing",
    "non_disclosure",
    "waiting_period",
    "exclusion",
    "documentation",
    "not_medically_necessary",
    "other",
  ]),
});
export type RejectionFacts = z.infer<typeof RejectionFacts>;

export const Queries = z.object({
  queries: z.array(z.string()).min(3).max(6),
});
export type Queries = z.infer<typeof Queries>;

export const CheckId = z.enum([
  "C1_CLAUSE_EXISTS",
  "C2_CONDITIONS_HOLD",
  "C3_OVERRIDING_CLAUSE",
  "C4_EXPLICIT_EXCLUSION",
  "C5_FACTS_KNOWN",
  "C6_DOCS_PRESENT",
]);
export type CheckId = z.infer<typeof CheckId>;

export const Check = z.object({
  id: CheckId,
  answer: z.enum(["yes", "no", "unknown"]),
  rationale: z.string(),
  evidence_refs: z.array(z.string()),
});
export type Check = z.infer<typeof Check>;

export const Assessment = z.object({
  checks: z.array(Check).length(6),
  ledger: z.array(
    z.object({
      temp_id: z.string(),
      claim: z.string(),
      page_id: z.string().uuid(),
      quote: z.string(),
    })
  ),
  missing_facts: z.array(z.object({ key: z.string(), question: z.string() })),
});
export type Assessment = z.infer<typeof Assessment>;

export const Verdict = z.enum(["STRONG", "ARGUABLE", "WEAK"]);
export type Verdict = z.infer<typeof Verdict>;

export const DraftOutput = z.object({
  subject: z.string(),
  body_md: z.string(),
});
export type DraftOutput = z.infer<typeof DraftOutput>;

export const RedTeam = z.object({
  rebuttal: z.string(),
  attacked: z.array(z.string()),
  supporting: z.array(z.object({ page_id: z.string().uuid(), quote: z.string() })),
  severity: z.enum(["low", "medium", "high"]),
});
export type RedTeam = z.infer<typeof RedTeam>;

export const RouteReason = z.object({
  reason: z.string(),
});
export type RouteReason = z.infer<typeof RouteReason>;

export const PlainExplanation = z.object({
  explanation: z.string(),
});
export type PlainExplanation = z.infer<typeof PlainExplanation>;

export const ExceptionReview = z.object({
  exceptions: z.array(
    z.object({
      /** The circumstance in which the exclusion does NOT apply, in plain language. */
      condition: z.string(),
      /** Does this exception concern the treatment/claim at hand (not some other item in the same clause)? */
      relevant: z.boolean(),
      status: z.enum(["applies", "does_not_apply", "not_established"]),
      /** Verbatim from the rejection letter or the user's answers; required unless status is not_established. */
      basis_quote: z.string().nullable(),
    })
  ),
  /** One plain yes/no question about the single most important unresolved exception, or null if none. */
  question: z.string().nullable(),
});
export type ExceptionReview = z.infer<typeof ExceptionReview>;
