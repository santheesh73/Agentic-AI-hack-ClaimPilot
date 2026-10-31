import { NextRequest, NextResponse } from "next/server";
import { getOwnedCase } from "@/lib/ownership";
import { runStep } from "@/lib/agent/machine";
import { supabaseAdmin } from "@/lib/db";

export const maxDuration = 60;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caseRow = await getOwnedCase(id);
  if (!caseRow) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const db = supabaseAdmin();
  const { data: before } = await db
    .from("agent_events")
    .select("id")
    .eq("case_id", id)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastIdBefore = before?.id ?? 0;

  const result = await runStep(id);

  const { data: newEvents } = await db
    .from("agent_events")
    .select("*")
    .eq("case_id", id)
    .gt("id", lastIdBefore)
    .order("id", { ascending: true });

  return NextResponse.json({ state: result.state, error: result.error ?? null, events: newEvents ?? [] });
}
