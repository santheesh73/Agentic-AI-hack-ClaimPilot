import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeSupabase, resetFakeIds, type FakeDb } from "./helpers/fakeSupabase";
import { setFakeOwner, fakeGetOwnerId, fakeGetOrCreateOwnerId } from "./helpers/fakeOwnerCookie";

let fakeDb: FakeDb;

vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    supabaseAdmin: () => createFakeSupabase(fakeDb),
    getOwnerId: fakeGetOwnerId,
    getOrCreateOwnerId: fakeGetOrCreateOwnerId,
  };
});

vi.mock("../lib/ingest/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ingest/pdf")>();
  return {
    ...actual,
    parsePdf: vi.fn(async () => mockPages),
    isLikelyImageOnly: vi.fn(() => mockImageOnly),
  };
});

let mockPages: Array<{ page_no: number; text: string; text_norm: string }> = [
  { page_no: 1, text: "Some real policy text here.", text_norm: "some real policy text here." },
];
let mockImageOnly = false;

function pdfBytesWithMagic(): Uint8Array {
  const header = new TextEncoder().encode("%PDF-1.4\n");
  return header;
}

function formDataRequest(fields: Record<string, string | Blob>): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("http://localhost/test", { method: "POST", body: form });
}

beforeEach(() => {
  fakeDb = {
    cases: [{ id: "case-1", owner_id: "owner-1", state: "INTAKE" }],
    documents: [],
    pages: [],
  };
  resetFakeIds();
  setFakeOwner("owner-1");
  mockPages = [{ page_no: 1, text: "Some real policy text here.", text_norm: "some real policy text here." }];
  mockImageOnly = false;
});

describe("POST /api/cases/[id]/documents", () => {
  it("accepts pasted text for a rejection letter", async () => {
    const { POST } = await import("../app/api/cases/[id]/documents/route");
    const req = formDataRequest({ kind: "rejection", text: "Your claim is rejected." });
    const res = await POST(req as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(200);
    expect(fakeDb.documents.length).toBe(1);
    expect(fakeDb.pages.length).toBe(1);
  });

  it("rejects an invalid document kind", async () => {
    const { POST } = await import("../app/api/cases/[id]/documents/route");
    const req = formDataRequest({ kind: "not-a-real-kind", text: "x" });
    const res = await POST(req as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("invalid_kind");
  });

  it("rejects pasted text over the character limit (413)", async () => {
    const { POST } = await import("../app/api/cases/[id]/documents/route");
    const req = formDataRequest({ kind: "rejection", text: "x".repeat(20_001) });
    const res = await POST(req as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error.code).toBe("text_too_long");
  });

  it("rejects a file that isn't a PDF by magic bytes (415)", async () => {
    const { POST } = await import("../app/api/cases/[id]/documents/route");
    const notPdf = new Blob(["this is not a pdf"], { type: "text/plain" });
    const req = formDataRequest({ kind: "policy", file: new File([notPdf], "fake.pdf", { type: "application/pdf" }) });
    const res = await POST(req as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(415);
    const json = await res.json();
    expect(json.error.code).toBe("unsupported_file_type");
  });

  it("rejects an oversized file (413)", async () => {
    const { POST } = await import("../app/api/cases/[id]/documents/route");
    const bigContent = new Uint8Array(15 * 1024 * 1024 + 1);
    const file = new File([bigContent as BlobPart], "big.pdf", { type: "application/pdf" });
    const req = formDataRequest({ kind: "policy", file });
    const res = await POST(req as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error.code).toBe("file_too_large");
  });

  it("rejects an image-only PDF (422)", async () => {
    mockImageOnly = true;
    const { POST } = await import("../app/api/cases/[id]/documents/route");
    const file = new File([pdfBytesWithMagic() as BlobPart], "scanned.pdf", { type: "application/pdf" });
    const req = formDataRequest({ kind: "policy", file });
    const res = await POST(req as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("image_only_pdf");
  });

  it("accepts a valid PDF with extractable text", async () => {
    const { POST } = await import("../app/api/cases/[id]/documents/route");
    const file = new File([pdfBytesWithMagic() as BlobPart], "policy.pdf", { type: "application/pdf" });
    const req = formDataRequest({ kind: "policy", file });
    const res = await POST(req as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.page_count).toBe(1);
  });

  it("returns 404 for a case owned by someone else", async () => {
    fakeDb.cases = [{ id: "case-1", owner_id: "owner-2", state: "INTAKE" }];
    const { POST } = await import("../app/api/cases/[id]/documents/route");
    const req = formDataRequest({ kind: "rejection", text: "x" });
    const res = await POST(req as never, { params: Promise.resolve({ id: "case-1" }) });
    expect(res.status).toBe(404);
  });
});
