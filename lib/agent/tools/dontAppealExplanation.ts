import { generate, MODEL_FAST } from "../../models";
import { PlainExplanation, type Check } from "../schemas";
import { DONT_APPEAL_SYSTEM } from "../prompts";

export async function dontAppealExplanation(caseId: string, checks: Check[]): Promise<string> {
  const { explanation } = await generate({
    caseId,
    step: "DONT_APPEAL",
    tool: "dont_appeal_explanation",
    model: MODEL_FAST,
    schema: PlainExplanation,
    system: DONT_APPEAL_SYSTEM,
    prompt: JSON.stringify(checks, null, 2),
  });
  return explanation;
}
