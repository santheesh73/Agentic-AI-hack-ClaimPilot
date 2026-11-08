import { it } from "vitest";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { parsePdf, isLikelyImageOnly } from "@/lib/ingest/pdf";

const F = "audit/repro/fixtures/";
it("ingest robustness", async () => {
  const out: Record<string, unknown> = {};
  for (const f of ["three_pages.pdf", "image_only.pdf", "corrupt.pdf", "encrypted.pdf", "zero_pages.pdf", "large_250_pages.pdf", "hindi.pdf", "with_javascript.pdf", "decompression_bomb.pdf"]) {
    const buf = fs.readFileSync(F + f);
    const mem0 = process.memoryUsage().rss; const t0 = performance.now();
    try {
      const pages = await parsePdf(buf);
      out[f] = { ok: true, pages: pages.length, ms: Math.round(performance.now() - t0), rss_growth_mb: Math.round((process.memoryUsage().rss - mem0) / 1e6), imageOnly: isLikelyImageOnly(pages), first: pages[0]?.text.slice(0, 70) ?? null, page_nos: pages.slice(0, 3).map((p) => p.page_no) };
    } catch (e) { out[f] = { ok: false, ms: Math.round(performance.now() - t0), error: String((e as Error).message).slice(0, 120) }; }
  }
  // 1-based page numbering vs what a PDF viewer shows (pdftotext -f N -l N)
  const pages = await parsePdf(fs.readFileSync(F + "three_pages.pdf"));
  out.page_numbering = pages.map((p) => ({ page_no: p.page_no, ours: p.text.match(/PAGE MARKER \d/)?.[0], pdftotext: execFileSync("pdftotext", ["-f", String(p.page_no), "-l", String(p.page_no), F + "three_pages.pdf", "-"]).toString().match(/PAGE MARKER \d/)?.[0] }));
  const real = await parsePdf(fs.readFileSync("samples/policy.pdf"));
  out.real_policy = { pages: real.length, chars: real.map((p) => p.text.length) };
  fs.writeFileSync("audit/logs/26-ingest.json", JSON.stringify(out, null, 2));
});
