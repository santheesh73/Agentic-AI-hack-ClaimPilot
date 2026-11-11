import { NextRequest, NextResponse } from "next/server";
import { getOwnedCase } from "@/lib/ownership";
import { supabaseAdmin } from "@/lib/db";
import { simNow } from "@/lib/agent/deadlines";
import { logEvent, generate, MODEL_STRONG } from "@/lib/models";
import { DraftOutput } from "@/lib/agent/schemas";
import { verifyCitationsTool } from "@/lib/agent/tools/verifyCitationsTool";
import { stripUnverified } from "@/lib/agent/verify";
import { UNTRUSTED_DOC_PREAMBLE } from "@/lib/agent/prompts";
import { enforceRequestLimits } from "@/lib/rateLimit";
import { ApiError, SimulateBody, parseJsonBody, errorResponse, notFoundResponse } from "@/lib/validation";

export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await handle(req, params);
  } catch (err) {
    return errorResponse(err);
  }
}

async function handle(req: NextRequest, params: Promise<{ id: string }>) {
  const { id } = await params;
  const caseRow = await getOwnedCase(id);
  if (!caseRow) return notFoundResponse();
  await enforceRequestLimits(req, caseRow.owner_id, "simulate");

  const { days } = await parseJsonBody(req, SimulateBody);

  const db = supabaseAdmin();
  const newOffset = caseRow.sim_offset_days + days;
  // Compare-and-set on the offset we read: of two concurrent simulations one wins, the other is told to retry
  // (otherwise both write the same offset and one +N days is silently lost).
  const { data: bumped, error: bumpError } = await db
    .from("cases")
    .update({ sim_offset_days: newOffset })
    .eq("id", id)
    .eq("sim_offset_days", caseRow.sim_offset_days)
    .select("id");
  if (bumpError) throw bumpError;
  if (!bumped || bumped.length === 0) {
    throw new ApiError(409, "simulation_in_progress", "Another simulation just changed this case. Please try again.");
  }

  const now = simNow(newOffset);
  const { data: due } = await db
    .from("followups")
    .select("*")
    .eq("case_id", id)
    .eq("status", "pending")
    .lte("due_on", now);

  let fired = 0;
  for (const fu of due ?? []) {
    // Claim the follow-up before doing any work so two requests can't both fire (and both pay for) the same escalation.
    const { data: claimed } = await db
      .from("followups")
      .update({ status: "fired" })
      .eq("id", fu.id)
      .eq("status", "pending")
      .select("id");
    if (!claimed || claimed.length === 0) continue;
    fired++;
    let outputMd: string | null = null;

    if (fu.action === "ESCALATE_BIMA_BHAROSA") {
      const { data: evidence } = await db.from("evidence").select("*").eq("case_id", id).eq("verified", true);
      const { data: pages } = await db
        .from("pages")
        .select("id, page_no, text_norm")
        .in("id", (evidence ?? []).map((e) => e.page_id));
      const evidenceById = Object.fromEntries((evidence ?? []).map((e) => [e.short_id, e]));
      const pagesById = Object.fromEntries((pages ?? []).map((p) => [p.id, p]));
      const evidenceList = (evidence ?? [])
        .map((e) => `${e.short_id} — ${e.claim} — "${e.quote}"`)
        .join("\n");

      const draft = await generate({
        caseId: id,
        step: "SIMULATE",
        tool: "escalation_draft",
        model: MODEL_STRONG,
        schema: DraftOutput,
        system:
          UNTRUSTED_DOC_PREAMBLE +
          " Write a short escalation complaint to the IRDAI Bima Bharosa Grievance Redressal Cell, noting the insurer's Grievance Redressal Officer did not resolve the complaint within 14 days. Every sentence relying on the policy must end with [cite:E#] citing only the given ids. Do not invent facts.",
        prompt: `Facts: ${JSON.stringify(caseRow.facts)}\n\nEvidence:\n${evidenceList}`,
      });

      // Same verification as the appeal letter: drop sentences citing a
      // failed id and any uncited or unparsed policy claim.
      const results = verifyCitationsTool(draft.body_md, evidenceById, pagesById);
      outputMd = stripUnverified(draft.body_md, results);
    }

    await db.from("followups").update({ output_md: outputMd }).eq("id", fu.id);
    await logEvent({
      caseId: id,
      step: "SIMULATE",
      summary: `Day ${newOffset}: ${fu.action.replace(/_/g, " ").toLowerCase()}${outputMd ? " — drafted escalation" : ""}`,
    });
  }

  return NextResponse.json({ sim_offset_days: newOffset, fired });
}
