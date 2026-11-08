import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, getOrCreateOwnerId } from "@/lib/db";
import { CreateCaseBody, parseJsonBody, errorResponse } from "@/lib/validation";
import { enforceRateLimit } from "@/lib/rateLimit";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await parseJsonBody(req, CreateCaseBody);

    const ownerId = await getOrCreateOwnerId();
    await enforceRateLimit(ownerId, "newCase");
    const db = supabaseAdmin();
    const { data, error } = await db
      .from("cases")
      .insert({
        owner_id: ownerId,
        title: body.title ?? null,
        insurer: body.insurer ?? null,
        claim_amount_inr: body.claim_amount_inr ?? null,
        state: "INTAKE",
      })
      .select("id")
      .single();

    if (error) return NextResponse.json({ error: { code: "db_error", message: error.message } }, { status: 500 });
    return NextResponse.json({ id: data.id });
  } catch (err) {
    return errorResponse(err);
  }
}
