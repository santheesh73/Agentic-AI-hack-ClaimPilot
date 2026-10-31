import { NextRequest, NextResponse } from "next/server";
import { getOwnedCase } from "@/lib/ownership";
import { recordAnswers } from "@/lib/agent/machine";

export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caseRow = await getOwnedCase(id);
  if (!caseRow) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { answers } = await req.json();
  if (!answers || typeof answers !== "object") {
    return NextResponse.json({ error: "answers object required" }, { status: 400 });
  }

  await recordAnswers(id, answers);
  return NextResponse.json({ ok: true });
}
