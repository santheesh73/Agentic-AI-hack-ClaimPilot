import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, DOCUMENTS_BUCKET } from "@/lib/db";
import { getOwnedCase } from "@/lib/ownership";
import { parsePdf, isLikelyImageOnly } from "@/lib/ingest/pdf";
import { normalize } from "@/lib/ingest/normalize";

export const maxDuration = 60;

const ALLOWED_KINDS = ["policy", "rejection", "discharge", "other"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caseRow = await getOwnedCase(id);
  if (!caseRow) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const form = await req.formData();
  const kind = String(form.get("kind") ?? "");
  if (!ALLOWED_KINDS.includes(kind)) {
    return NextResponse.json({ error: "Invalid document kind" }, { status: 400 });
  }

  const file = form.get("file") as File | null;
  const pastedText = form.get("text") as string | null;

  if (!file && !pastedText) {
    return NextResponse.json({ error: "Provide a file or pasted text" }, { status: 400 });
  }

  const db = supabaseAdmin();

  let pages: Array<{ page_no: number; text: string; text_norm: string }>;
  let storagePath: string | null = null;
  let filename: string | null = null;

  if (file) {
    if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "Only PDF files are supported." }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    try {
      pages = await parsePdf(buffer);
    } catch {
      return NextResponse.json(
        { error: "Could not read this PDF. It may be corrupted or password-protected." },
        { status: 400 }
      );
    }
    if (pages.length === 0) {
      return NextResponse.json({ error: "This PDF has no pages." }, { status: 400 });
    }
    if (isLikelyImageOnly(pages)) {
      return NextResponse.json(
        { error: "This PDF appears to be image-only (scanned) with no extractable text. ClaimPilot cannot process scanned PDFs." },
        { status: 400 }
      );
    }
    filename = file.name;
    storagePath = `${id}/${kind}-${Date.now()}-${file.name}`;
    const { error: uploadError } = await db.storage.from(DOCUMENTS_BUCKET).upload(storagePath, buffer, {
      contentType: "application/pdf",
      upsert: false,
    });
    if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });
  } else {
    pages = [{ page_no: 1, text: pastedText!, text_norm: normalize(pastedText!) }];
    filename = "pasted-text.txt";
  }

  const { data: doc, error: docError } = await db
    .from("documents")
    .insert({
      case_id: id,
      kind,
      storage_path: storagePath,
      filename,
      page_count: pages.length,
    })
    .select("id")
    .single();
  if (docError) return NextResponse.json({ error: docError.message }, { status: 500 });

  const pageRows = pages.map((p) => ({
    document_id: doc.id,
    case_id: id,
    page_no: p.page_no,
    text: p.text,
    text_norm: p.text_norm,
  }));
  const { error: pagesError } = await db.from("pages").insert(pageRows);
  if (pagesError) return NextResponse.json({ error: pagesError.message }, { status: 500 });

  return NextResponse.json({ document_id: doc.id, page_count: pages.length });
}
