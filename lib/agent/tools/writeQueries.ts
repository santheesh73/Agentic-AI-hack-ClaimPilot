import { generate, MODEL_FAST } from "../../models";
import { Queries, type RejectionFacts } from "../schemas";
import { WRITE_QUERIES_SYSTEM } from "../prompts";

export async function writeQueries(caseId: string, facts: RejectionFacts): Promise<string[]> {
  const result = await generate({
    caseId,
    step: "RETRIEVE",
    tool: "write_queries",
    model: MODEL_FAST,
    schema: Queries,
    system: WRITE_QUERIES_SYSTEM,
    prompt: JSON.stringify(facts, null, 2),
  });
  return result.queries;
}
