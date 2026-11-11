import { NextRequest, NextResponse } from "next/server";
import { getOwnedCase } from "@/lib/ownership";
import { approveCase, InvalidStateError } from "@/lib/agent/machine";
import { ApiError, assertSameOrigin, errorResponse, notFoundResponse } from "@/lib/validation";

export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const { id } = await params;
    const caseRow = await getOwnedCase(id);
    if (!caseRow) return notFoundResponse();
    if (caseRow.state !== "AWAITING_APPROVAL") {
      throw new ApiError(400, "invalid_state", "Case is not awaiting approval.");
    }

    try {
      await approveCase(id);
    } catch (err) {
      // a concurrent approve already claimed the transition
      if (err instanceof InvalidStateError) throw new ApiError(409, "invalid_state", "Case is not awaiting approval.");
      throw err;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
