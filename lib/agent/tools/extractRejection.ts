import { generate, MODEL_FAST } from "../../models";
import { RejectionFacts } from "../schemas";
import { EXTRACT_REJECTION_SYSTEM, wrapDocument } from "../prompts";

export async function extractRejection(
  caseId: string,
  rejectionText: string
): Promise<RejectionFacts> {
  const prompt = wrapDocument("rejection", "rejection-0", 1, rejectionText);
  return generate({
    caseId,
    step: "EXTRACT",
    tool: "extract_rejection",
    model: MODEL_FAST,
    schema: RejectionFacts,
    system: EXTRACT_REJECTION_SYSTEM,
    prompt,
  });
}
