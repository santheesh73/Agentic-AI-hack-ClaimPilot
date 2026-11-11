import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, DOCUMENTS_BUCKET } from "@/lib/db";
import { getOwnedCase } from "@/lib/ownership";
import { parsePdf, isLikelyImageOnly } from "@/lib/ingest/pdf";
import { normalize } from "@/lib/ingest/normalize";
import {
  DocumentKind,
  PASTED_LETTER_MAX_CHARS,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_PAGES,
  ApiError,
  assertSameOrigin,
  errorResponse,
  notFoundResponse,
} from "@/lib/validation";
import { enforceRequestLimits } from "@/lib/rateLimit";

export const maxDuration = 60;

const PDF_MAGIC_BYTES = "%PDF-";

function hasPdfMagicBytes(buffer: ArrayBuffer): boolean {
  const head = new TextDecoder("latin1").decode(buffer.slice(0, PDF_MAGIC_BYTES.length));
  return head === PDF_MAGIC_BYTES;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const { id } = await params;
    const caseRow = await getOwnedCase(id);
    if (!caseRow) return notFoundResponse();
    // Documents are inputs to INTAKE; once the case has moved on (or finished) they would be silently ignored or rewrite history.
    if (!["INTAKE", "ERROR"].includes(caseRow.state)) {
      throw new ApiError(409, "invalid_state", "Documents can only be added before the case has been processed.");
    }
    await enforceRequestLimits(req, caseRow.owner_id, "upload");

    const form = await req.formData();
    const kindResult = DocumentKind.safeParse(form.get("kind"));
    if (!kindResult.success) {
      throw new ApiError(400, "invalid_kind", "kind must be one of: policy, rejection, discharge, other.");
    }
    const kind = kindResult.data;

    const file = form.get("file") as File | null;
    const pastedText = form.get("text") as string | null;

    if (!file && !pastedText) {
      throw new ApiError(400, "missing_input", "Provide a file or pasted text.");
    }
    if (file && pastedText) {
      throw new ApiError(400, "ambiguous_input", "Provide either a file or pasted text, not both.");
    }
    if (pastedText && pastedText.length > PASTED_LETTER_MAX_CHARS) {
      throw new ApiError(413, "text_too_long", `Pasted text must not exceed ${PASTED_LETTER_MAX_CHARS} characters.`);
    }

    const db = supabaseAdmin();

    let pages: Array<{ page_no: number; text: string; text_norm: string }>;
    let storagePath: string | null = null;
    let filename: string | null = null;

    if (file) {
      if (file.size > UPLOAD_MAX_BYTES) {
        throw new ApiError(413, "file_too_large", `File must not exceed ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`);
      }

      const buffer = await file.arrayBuffer();

      const declaresNonPdf = file.type && file.type !== "application/pdf";
      const namedNonPdf = file.name && !file.name.toLowerCase().endsWith(".pdf");
      if ((declaresNonPdf && namedNonPdf) || !hasPdfMagicBytes(buffer)) {
        throw new ApiError(415, "unsupported_file_type", "Only PDF files are supported.");
      }

      try {
        pages = await parsePdf(buffer);
      } catch {
        throw new ApiError(400, "unreadable_pdf", "Could not read this PDF. It may be corrupted or password-protected.");
      }
      if (pages.length === 0) {
        throw new ApiError(400, "empty_pdf", "This PDF has no pages.");
      }
      if (pages.length > UPLOAD_MAX_PAGES) {
        throw new ApiError(413, "too_many_pages", `PDF must not exceed ${UPLOAD_MAX_PAGES} pages.`);
      }
      if (isLikelyImageOnly(pages)) {
        throw new ApiError(
          422,
          "image_only_pdf",
          "This PDF appears to be image-only (scanned) with no extractable text. ClaimPilot cannot process scanned PDFs."
        );
      }
      filename = file.name;
      // The user's filename is kept only in documents.filename; the storage key is random so it can't be guessed or contain "../".
      storagePath = `${id}/${kind}-${crypto.randomUUID()}.pdf`;
      const { error: uploadError } = await db.storage.from(DOCUMENTS_BUCKET).upload(storagePath, buffer, {
        contentType: "application/pdf",
        upsert: false,
      });
      if (uploadError) throw uploadError;
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
    if (docError) throw docError;

    const pageRows = pages.map((p) => ({
      document_id: doc.id,
      case_id: id,
      page_no: p.page_no,
      text: p.text,
      text_norm: p.text_norm,
    }));
    const { error: pagesError } = await db.from("pages").insert(pageRows);
    if (pagesError) throw pagesError;

    return NextResponse.json({ document_id: doc.id, page_count: pages.length });
  } catch (err) {
    return errorResponse(err);
  }
}
