import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db";
import { getOwnedCase } from "@/lib/ownership";
import { deadlinesForUi } from "@/lib/agent/deadlines";

export const maxDuration = 60;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caseRow = await getOwnedCase(id);
  if (!caseRow) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const db = supabaseAdmin();
  const [{ data: events }, { data: evidence }, { data: drafts }, { data: followups }, { data: documents }] =
    await Promise.all([
      db.from("agent_events").select("*").eq("case_id", id).order("id", { ascending: true }),
      db.from("evidence").select("*").eq("case_id", id).order("short_id"),
      db.from("drafts").select("*").eq("case_id", id).order("version", { ascending: true }),
      db.from("followups").select("*").eq("case_id", id).order("due_on", { ascending: true }),
      db.from("documents").select("id, kind, filename, page_count").eq("case_id", id),
    ]);

  const deadlines = deadlinesForUi(caseRow.complaint_sent_on, caseRow.claim_amount_inr);

  return NextResponse.json({
    case: caseRow,
    events: events ?? [],
    evidence: evidence ?? [],
    drafts: drafts ?? [],
    followups: followups ?? [],
    documents: documents ?? [],
    deadlines,
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caseRow = await getOwnedCase(id);
  if (!caseRow) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const db = supabaseAdmin();
  const { error } = await db.from("cases").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
