import { supabaseAdmin } from "../../db";
import { scheduleFollowups } from "../deadlines";

export async function scheduleFollowupTool(
  caseId: string,
  sentOn: string,
  claimAmountInr: number | null
) {
  const db = supabaseAdmin();
  const followups = scheduleFollowups(sentOn, claimAmountInr);
  const rows = followups.map((f) => ({
    case_id: caseId,
    due_on: f.due_on,
    action: f.action,
  }));
  const { error } = await db.from("followups").insert(rows);
  if (error) throw error;
  return followups;
}
