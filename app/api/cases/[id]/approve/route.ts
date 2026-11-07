import { NextRequest, NextResponse } from "next/server";
import { getOwnedCase } from "@/lib/ownership";
import { approveCase } from "@/lib/agent/machine";
import { ApiError, errorResponse, notFoundResponse } from "@/lib/validation";

export const maxDuration = 60;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const caseRow = await getOwnedCase(id);
    if (!caseRow) return notFoundResponse();
    if (caseRow.state !== "AWAITING_APPROVAL") {
      throw new ApiError(400, "invalid_state", "Case is not awaiting approval.");
    }

    await approveCase(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
