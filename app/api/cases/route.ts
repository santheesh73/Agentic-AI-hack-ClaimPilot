import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db";
import { getOrCreateOwnerId } from "@/lib/db";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { title, insurer, claim_amount_inr } = body ?? {};

  const ownerId = await getOrCreateOwnerId();
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("cases")
    .insert({
      owner_id: ownerId,
      title: title ?? null,
      insurer: insurer ?? null,
      claim_amount_inr: claim_amount_inr ?? null,
      state: "INTAKE",
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id });
}
