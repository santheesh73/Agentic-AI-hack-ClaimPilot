import { generate, MODEL_STRONG, type CachedTextPart } from "../../models";
import { RedTeam } from "../schemas";
import { REDTEAM_SYSTEM, wrapDocument } from "../prompts";
import type { CandidatePage } from "./assessCase";

export async function redteamReview(
  caseId: string,
  draftBodyMd: string,
  evidenceList: string,
  candidatePages: CandidatePage[]
): Promise<RedTeam> {
  const policyContext = candidatePages
    .map((p) => wrapDocument("policy", p.id, p.page_no, p.text))
    .join("\n\n");

  const parts: CachedTextPart[] = [
    { type: "text", text: policyContext, cache: true },
    {
      type: "text",
      text: `Draft appeal letter:\n${draftBodyMd}\n\nEvidence cited:\n${evidenceList}`,
    },
  ];

  return generate({
    caseId,
    step: "REDTEAM",
    tool: "redteam_review",
    model: MODEL_STRONG,
    schema: RedTeam,
    system: REDTEAM_SYSTEM,
    prompt: parts,
  });
}
