import { generate, MODEL_FAST } from "../../models";
import { RouteReason, type RejectionFacts } from "../schemas";
import { ROUTE_REASON_SYSTEM } from "../prompts";
import { chooseRoute as chooseRoutePure, deadlinesForUi } from "../deadlines";

export async function chooseRouteTool(caseId: string, facts: RejectionFacts) {
  const route = chooseRoutePure(facts.insurer);
  const { reason } = await generate({
    caseId,
    step: "ROUTE",
    tool: "choose_route",
    model: MODEL_FAST,
    schema: RouteReason,
    system: ROUTE_REASON_SYSTEM,
    prompt: JSON.stringify(facts, null, 2),
  });
  const deadlines = deadlinesForUi(null, facts.claim_amount_inr);
  return { ...route, reason, deadlines };
}
