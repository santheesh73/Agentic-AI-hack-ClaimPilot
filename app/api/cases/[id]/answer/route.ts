import { NextRequest, NextResponse } from "next/server";
import { getOwnedCase } from "@/lib/ownership";
import { recordAnswers } from "@/lib/agent/machine";
import { AnswerBody, parseJsonBody, errorResponse, notFoundResponse } from "@/lib/validation";

export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const caseRow = await getOwnedCase(id);
    if (!caseRow) return notFoundResponse();

    const { answers } = await parseJsonBody(req, AnswerBody);
    await recordAnswers(id, answers);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
