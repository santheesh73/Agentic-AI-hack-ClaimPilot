import { NextRequest, NextResponse } from "next/server";
import { getOwnedCase } from "@/lib/ownership";
import { recordAnswers, InvalidStateError } from "@/lib/agent/machine";
import { enforceRequestLimits } from "@/lib/rateLimit";
import { AnswerBody, ApiError, parseJsonBody, errorResponse, notFoundResponse } from "@/lib/validation";

export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const caseRow = await getOwnedCase(id);
    if (!caseRow) return notFoundResponse();
    if (caseRow.state !== "AWAITING_USER") {
      throw new ApiError(409, "invalid_state", "This case is not waiting for answers.");
    }
    await enforceRequestLimits(req, caseRow.owner_id, "answer");

    const { answers } = await parseJsonBody(req, AnswerBody);
    try {
      await recordAnswers(id, answers);
    } catch (err) {
      if (err instanceof InvalidStateError) throw new ApiError(409, "invalid_state", "This case is not waiting for answers.");
      throw err;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
