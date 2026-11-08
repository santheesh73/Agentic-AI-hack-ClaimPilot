import { NextRequest, NextResponse } from "next/server";
import { getOwnedCase } from "@/lib/ownership";
import { supabaseAdmin } from "@/lib/db";
import { simNow } from "@/lib/agent/deadlines";
import { logEvent, generate, MODEL_STRONG } from "@/lib/models";
import { DraftOutput } from "@/lib/agent/schemas";
import { verifyCitationsTool } from "@/lib/agent/tools/verifyCitationsTool";
import { stripSentencesCiting } from "@/lib/agent/verify";
import { SimulateBody, parseJsonBody, errorResponse, notFoundResponse } from "@/lib/validation";

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

  const { days } = await parseJsonBody(req, SimulateBody);

  const db = supabaseAdmin();
  const newOffset = caseRow.sim_offset_days + days;
  await db.from("cases").update({ sim_offset_days: newOffset }).eq("id", id);

  const now = simNow(newOffset);
  const { data: due } = await db
    .from("followups")
    .select("*")
    .eq("case_id", id)
    .eq("status", "pending")
    .lte("due_on", now);

  for (const fu of due ?? []) {
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
          "Write a short escalation complaint to the IRDAI Bima Bharosa Grievance Redressal Cell, noting the insurer's Grievance Redressal Officer did not resolve the complaint within 14 days. Every sentence relying on the policy must end with [cite:E#] citing only the given ids. Do not invent facts.",
        prompt: `Facts: ${JSON.stringify(caseRow.facts)}\n\nEvidence:\n${evidenceList}`,
      });

      const results = verifyCitationsTool(draft.body_md, evidenceById, pagesById);
      const failedIds = results.filter((r) => !r.ok).map((r) => r.short_id);
      outputMd = stripSentencesCiting(draft.body_md, failedIds);
    }

    await db.from("followups").update({ status: "fired", output_md: outputMd }).eq("id", fu.id);
    await logEvent({
      caseId: id,
      step: "SIMULATE",
      summary: `Day ${newOffset}: ${fu.action.replace(/_/g, " ").toLowerCase()}${outputMd ? " — drafted escalation" : ""}`,
    });
  }

  return NextResponse.json({ sim_offset_days: newOffset, fired: due?.length ?? 0 });
}
