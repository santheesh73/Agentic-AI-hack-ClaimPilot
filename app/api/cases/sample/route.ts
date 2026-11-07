import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { supabaseAdmin, getOrCreateOwnerId } from "@/lib/db";
import { parsePdf } from "@/lib/ingest/pdf";
import { normalize } from "@/lib/ingest/normalize";

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
  const { sample } = await req.json().catch(() => ({ sample: null }));
  const config = typeof sample === "string" ? SAMPLES[sample] : undefined;
  if (!config) {
    return NextResponse.json({ error: "Unknown sample case. Expected one of: a, b, c." }, { status: 400 });
  }

  const samplesDir = path.join(process.cwd(), "samples");
  let policyBuffer: Buffer;
  let letterText: string;
  try {
    [policyBuffer, letterText] = await Promise.all([
      readFile(path.join(samplesDir, "policy.pdf")),
      readFile(path.join(samplesDir, config.letter), "utf-8"),
    ]);
  } catch {
    return NextResponse.json({ error: "Sample files are not available on this deployment." }, { status: 500 });
  }

  const ownerId = await getOrCreateOwnerId();
  const db = supabaseAdmin();

  const { data: caseRow, error: caseError } = await db
    .from("cases")
    .insert({ owner_id: ownerId, title: config.title, insurer: config.insurer, claim_amount_inr: config.claim_amount_inr, state: "INTAKE" })
    .select("id")
    .single();
  if (caseError) return NextResponse.json({ error: caseError.message }, { status: 500 });
  const caseId = caseRow.id as string;

  const policyPages = await parsePdf(policyBuffer);
  const { data: policyDoc, error: policyDocError } = await db
    .from("documents")
    .insert({ case_id: caseId, kind: "policy", filename: "policy.pdf", page_count: policyPages.length })
    .select("id")
    .single();
  if (policyDocError) return NextResponse.json({ error: policyDocError.message }, { status: 500 });

  const { error: policyPagesError } = await db.from("pages").insert(
    policyPages.map((p) => ({ document_id: policyDoc.id, case_id: caseId, page_no: p.page_no, text: p.text, text_norm: p.text_norm }))
  );
  if (policyPagesError) return NextResponse.json({ error: policyPagesError.message }, { status: 500 });

  const { data: rejectionDoc, error: rejectionDocError } = await db
    .from("documents")
    .insert({ case_id: caseId, kind: "rejection", filename: config.letter, page_count: 1 })
    .select("id")
    .single();
  if (rejectionDocError) return NextResponse.json({ error: rejectionDocError.message }, { status: 500 });

  const { error: rejectionPageError } = await db.from("pages").insert([
    { document_id: rejectionDoc.id, case_id: caseId, page_no: 1, text: letterText, text_norm: normalize(letterText) },
  ]);
  if (rejectionPageError) return NextResponse.json({ error: rejectionPageError.message }, { status: 500 });

  return NextResponse.json({ id: caseId });
}
