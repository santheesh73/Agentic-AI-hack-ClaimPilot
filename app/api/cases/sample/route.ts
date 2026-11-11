import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { supabaseAdmin, getOrCreateOwnerId } from "@/lib/db";
import { parsePdf } from "@/lib/ingest/pdf";
import { normalize } from "@/lib/ingest/normalize";
import { SampleBody, parseJsonBody, errorResponse, ApiError } from "@/lib/validation";
import { enforceRequestLimits } from "@/lib/rateLimit";

export const maxDuration = 60;

const SAMPLES: Record<string, { title: string; insurer: string; claim_amount_inr: number; letter: string }> = {
  a: {
    title: "Sample Case A — PED waiting period already expired",
    insurer: "United General Health Insurance Co. Ltd.",
    claim_amount_inr: 185000,
    letter: "letter_a.txt",
  },
  b: {
    title: "Sample Case B — Non-disclosure, diagnosis date unknown",
    insurer: "United General Health Insurance Co. Ltd.",
    claim_amount_inr: 92500,
    letter: "letter_b.txt",
  },
  c: {
    title: "Sample Case C — Cosmetic surgery, explicit exclusion",
    insurer: "United General Health Insurance Co. Ltd.",
    claim_amount_inr: 110000,
    letter: "letter_c.txt",
  },
};

export async function POST(req: NextRequest) {
  try {
    const { sample } = await parseJsonBody(req, SampleBody);
    const config = SAMPLES[sample];

    const samplesDir = path.join(process.cwd(), "samples");
    let policyBuffer: Buffer;
    let letterText: string;
    try {
      [policyBuffer, letterText] = await Promise.all([
        readFile(path.join(samplesDir, "policy.pdf")),
        readFile(path.join(samplesDir, config.letter), "utf-8"),
      ]);
    } catch {
      throw new ApiError(500, "samples_unavailable", "Sample files are not available on this deployment.");
    }

    const ownerId = await getOrCreateOwnerId();
    await enforceRequestLimits(req, ownerId, "newCase");
    const db = supabaseAdmin();

    const { data: caseRow, error: caseError } = await db
      .from("cases")
      .insert({ owner_id: ownerId, title: config.title, insurer: config.insurer, claim_amount_inr: config.claim_amount_inr, state: "INTAKE" })
      .select("id")
      .single();
    if (caseError) throw caseError;
    const caseId = caseRow.id as string;

    const policyPages = await parsePdf(policyBuffer);
    const { data: policyDoc, error: policyDocError } = await db
      .from("documents")
      .insert({ case_id: caseId, kind: "policy", filename: "policy.pdf", page_count: policyPages.length })
      .select("id")
      .single();
    if (policyDocError) throw policyDocError;

    const { error: policyPagesError } = await db.from("pages").insert(
      policyPages.map((p) => ({ document_id: policyDoc.id, case_id: caseId, page_no: p.page_no, text: p.text, text_norm: p.text_norm }))
    );
    if (policyPagesError) throw policyPagesError;

    const { data: rejectionDoc, error: rejectionDocError } = await db
      .from("documents")
      .insert({ case_id: caseId, kind: "rejection", filename: config.letter, page_count: 1 })
      .select("id")
      .single();
    if (rejectionDocError) throw rejectionDocError;

    const { error: rejectionPageError } = await db.from("pages").insert([
      { document_id: rejectionDoc.id, case_id: caseId, page_no: 1, text: letterText, text_norm: normalize(letterText) },
    ]);
    if (rejectionPageError) throw rejectionPageError;

    return NextResponse.json({ id: caseId });
  } catch (err) {
    return errorResponse(err);
  }
}
