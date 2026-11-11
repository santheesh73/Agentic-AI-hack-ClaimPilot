import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, DOCUMENTS_BUCKET } from "@/lib/db";
import { getOwnedCase } from "@/lib/ownership";
import { deadlinesForUi } from "@/lib/agent/deadlines";
import { assertSameOrigin, errorResponse, notFoundResponse } from "@/lib/validation";

export const maxDuration = 60;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await getCase(params);
  } catch (err) {
    return errorResponse(err);
  }
}

async function getCase(params: Promise<{ id: string }>) {
  const { id } = await params;
  const caseRow = await getOwnedCase(id);
  if (!caseRow) return notFoundResponse();

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

  const pageIds = [...new Set((evidence ?? []).map((e) => e.page_id))];
  const { data: evidencePages } = pageIds.length
    ? await db.from("pages").select("id, page_no").in("id", pageIds)
    : { data: [] as Array<{ id: string; page_no: number }> };
  const pageNoById = new Map((evidencePages ?? []).map((p) => [p.id, p.page_no]));
  const evidenceWithPageNo = (evidence ?? []).map((e) => ({ ...e, page_no: pageNoById.get(e.page_id) ?? null }));

  return NextResponse.json({
    case: caseRow,
    events: events ?? [],
    evidence: evidenceWithPageNo,
    drafts: drafts ?? [],
    followups: followups ?? [],
    documents: documents ?? [],
    deadlines,
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const { id } = await params;
    const caseRow = await getOwnedCase(id);
    if (!caseRow) return notFoundResponse();

    const db = supabaseAdmin();

    const { data: documents } = await db.from("documents").select("storage_path").eq("case_id", id);
    const storagePaths = (documents ?? []).map((d) => d.storage_path).filter((p): p is string => p != null);
    if (storagePaths.length) {
      // Best-effort: an orphaned storage object is a minor leak, not worth
      // failing the delete over if Storage is briefly unavailable.
      await db.storage.from(DOCUMENTS_BUCKET).remove(storagePaths);
    }

    const { error } = await db.from("cases").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
