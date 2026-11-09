import { generate, MODEL_STRONG, type CachedTextPart } from "../../models";
import { Assessment, type RejectionFacts } from "../schemas";
import { ASSESS_CASE_SYSTEM, wrapDocument } from "../prompts";

/** The letter is context, not evidence: it carries no page_id, so the model has
 * nothing to cite, and it is marked non-citable. (Giving it a page_id made the
 * model cite it in the ledger, which failed the schema's policy-page-uuid rule.) */
export function wrapRejectionLetter(text: string): string {
  return `<document kind="rejection" citable="false">\n${text}\n</document>`;
}

export type CandidatePage = { id: string; page_no: number; text: string };

export async function assessCase(
  caseId: string,
  facts: RejectionFacts,
  candidatePages: CandidatePage[],
  answers: Record<string, string>,
  rejectionText: string
): Promise<Assessment> {
  const policyContext = candidatePages
    .map((p) => wrapDocument("policy", p.id, p.page_no, p.text))
    .join("\n\n");

  const parts: CachedTextPart[] = [
    { type: "text", text: policyContext, cache: true },
    {
      type: "text",
      // The extracted facts are a short summary; the letter itself holds what
      // the insurer says it found (dates, records, form answers), which the
      // assessment must be able to read.
      text: `Rejection letter (what the insurer states):\n${wrapRejectionLetter(rejectionText)}\n\nRejection facts:\n${JSON.stringify(facts, null, 2)}\n\nUser-provided answers:\n${JSON.stringify(
        answers,
        null,
        2
      )}`,
    },
  ];

  return generate({
    caseId,
    step: "ASSESS",
    tool: "assess_case",
    model: MODEL_STRONG,
    schema: Assessment,
    system: ASSESS_CASE_SYSTEM,
    prompt: parts,
  });
}
