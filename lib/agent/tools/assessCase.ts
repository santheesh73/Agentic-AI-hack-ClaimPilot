import { generate, MODEL_STRONG, type CachedTextPart } from "../../models";
import { Assessment, type RejectionFacts } from "../schemas";
import { ASSESS_CASE_SYSTEM, wrapDocument } from "../prompts";

export type CandidatePage = { id: string; page_no: number; text: string };

export async function assessCase(
  caseId: string,
  facts: RejectionFacts,
  candidatePages: CandidatePage[],
  answers: Record<string, string>
): Promise<Assessment> {
  const policyContext = candidatePages
    .map((p) => wrapDocument("policy", p.id, p.page_no, p.text))
    .join("\n\n");

  const parts: CachedTextPart[] = [
    { type: "text", text: policyContext, cache: true },
    {
      type: "text",
      text: `Rejection facts:\n${JSON.stringify(facts, null, 2)}\n\nUser-provided answers:\n${JSON.stringify(
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
