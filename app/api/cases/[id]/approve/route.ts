import { NextRequest, NextResponse } from "next/server";
import { getOwnedCase } from "@/lib/ownership";
import { approveCase } from "@/lib/agent/machine";

export const maxDuration = 60;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caseRow = await getOwnedCase(id);
  if (!caseRow) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (caseRow.state !== "AWAITING_APPROVAL") {
    return NextResponse.json({ error: "Case is not awaiting approval" }, { status: 400 });
  }

  await approveCase(id);
  return NextResponse.json({ ok: true });
}
