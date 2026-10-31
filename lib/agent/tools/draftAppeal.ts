import { generate, MODEL_STRONG } from "../../models";
import { DraftOutput, type RejectionFacts, type RedTeam } from "../schemas";
import { DRAFT_APPEAL_SYSTEM } from "../prompts";

export type EvidenceForDraft = { short_id: string; claim: string; quote: string; page_no: number };

export async function draftAppeal(
  caseId: string,
  facts: RejectionFacts,
  route: { step: string; addressee: string },
  evidence: EvidenceForDraft[],
  answers: Record<string, string>,
  rebuttal?: RedTeam | null
): Promise<DraftOutput> {
  const evidenceList = evidence
    .map((e) => `${e.short_id} — ${e.claim} — "${e.quote}" (p. ${e.page_no})`)
    .join("\n");

  const prompt = [
    `Facts:\n${JSON.stringify(facts, null, 2)}`,
    `Route: ${JSON.stringify(route)}`,
    `User answers:\n${JSON.stringify(answers, null, 2)}`,
    `Verified evidence (cite only these ids):\n${evidenceList}`,
    rebuttal ? `Red-team rebuttal to answer:\n${rebuttal.rebuttal}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return generate({
    caseId,
    step: "DRAFT",
    tool: "draft_appeal",
    model: MODEL_STRONG,
    schema: DraftOutput,
    system: DRAFT_APPEAL_SYSTEM,
    prompt,
  });
}
