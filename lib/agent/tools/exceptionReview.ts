import { generate, MODEL_STRONG } from "../../models";
import { ExceptionReview, type RejectionFacts } from "../schemas";
import { EXCEPTION_REVIEW_SYSTEM } from "../prompts";

/**
 * Asked only after the code has found an exception marker in the clause text
 * behind a provisional WEAK verdict (see lib/agent/exceptions.ts). The model
 * reports what is and isn't established; the code decides whether to ask,
 * and verifies every basis quote against the letter and the user's answers.
 */
export async function exceptionReview(
  caseId: string,
  clauseTexts: string[],
  rejectionText: string,
  answersWithQuestions: Record<string, string>,
  facts: RejectionFacts
): Promise<ExceptionReview> {
  const prompt = [
    ...clauseTexts.map((t) => `<document kind="policy_clause">\n${t}\n</document>`),
    `<document kind="rejection" citable="false">\n${rejectionText}\n</document>`,
    `Claim facts:\n${JSON.stringify({ diagnosis: facts.diagnosis, reason_summary: facts.reason_summary, clause_cited: facts.clause_cited }, null, 2)}`,
    `User's answers (question — answer):\n${JSON.stringify(answersWithQuestions, null, 2)}`,
  ].join("\n\n");
  return generate({
    caseId,
    step: "DECIDE",
    tool: "exception_review",
    model: MODEL_STRONG,
    schema: ExceptionReview,
    system: EXCEPTION_REVIEW_SYSTEM,
    prompt,
  });
}
