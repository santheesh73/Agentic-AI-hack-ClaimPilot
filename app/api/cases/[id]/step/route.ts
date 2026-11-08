import { NextRequest, NextResponse } from "next/server";
import { getOwnedCase } from "@/lib/ownership";
import { runStep, StepLockedError } from "@/lib/agent/machine";
import { supabaseAdmin } from "@/lib/db";
import { notFoundResponse, errorResponse } from "@/lib/validation";
import { enforceRateLimit } from "@/lib/rateLimit";

export const maxDuration = 60;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const caseRow = await getOwnedCase(id);
    if (!caseRow) return notFoundResponse();
    await enforceRateLimit(caseRow.owner_id, "step");

    const db = supabaseAdmin();
    const { data: before } = await db
      .from("agent_events")
      .select("id")
      .eq("case_id", id)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastIdBefore = before?.id ?? 0;

    let result;
    try {
      result = await runStep(id);
    } catch (err) {
      if (err instanceof StepLockedError) {
        return NextResponse.json(
          { error: { code: "step_in_progress", message: err.message }, state: err.state },
          { status: 409 }
        );
      }
      throw err;
    }

    const { data: newEvents } = await db
      .from("agent_events")
      .select("*")
      .eq("case_id", id)
      .gt("id", lastIdBefore)
      .order("id", { ascending: true });

    return NextResponse.json({ state: result.state, error: result.error ?? null, events: newEvents ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}
