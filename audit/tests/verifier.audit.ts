// Independent fuzzing of lib/agent/verify.ts matchQuote() against the real
// text of samples/policy.pdf. Seeded PRNG so results are reproducible.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { parsePdf } from "@/lib/ingest/pdf";
import { matchQuote } from "@/lib/agent/verify";

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
const R = rng(20261108);
const pick = <T,>(a: T[]) => a[Math.floor(R() * a.length)];

describe("verifier on real policy text", async () => {
  const pages = await parsePdf(fs.readFileSync("samples/policy.pdf"));
  const report: Record<string, unknown> = { pages: pages.length };

  it("200 random verbatim spans (raw extracted text, 6-40 words) all match", () => {
    let ok = 0; const fails: string[] = [];
    for (let i = 0; i < 200; i++) {
      const p = pick(pages); const words = p.text.split(/\s+/).filter(Boolean);
      const len = 6 + Math.floor(R() * 35); const start = Math.floor(R() * Math.max(1, words.length - len));
      const q = words.slice(start, start + len).join(" ");
      if (matchQuote(q, p.text_norm).ok) ok++; else fails.push(q);
    }
    report.verbatim = { ok, of: 200, fails: fails.slice(0, 5) };
    expect.soft(ok).toBe(200);
  });

  it("200 spans of >=40 chars with 1-3 random character edits: match rate", () => {
    let ok = 0;
    for (let i = 0; i < 200; i++) {
      let q = "";
      while (q.length < 40) {
        const p = pick(pages); const words = p.text.split(/\s+/).filter(Boolean);
        const len = 8 + Math.floor(R() * 30); const s = Math.floor(R() * Math.max(1, words.length - len));
        q = words.slice(s, s + len).join(" ");
      }
      const chars = q.split(""); const edits = 1 + Math.floor(R() * 3);
      for (let e = 0; e < edits; e++) {
        const pos = Math.floor(R() * chars.length); const op = Math.floor(R() * 3); const ch = "abcdefghijklmnopqrstuvwxyz"[Math.floor(R() * 26)];
        if (op === 0) chars[pos] = ch; else if (op === 1) chars.splice(pos, 0, ch); else chars.splice(pos, 1);
      }
      const p = pages.find((pg) => true)!; void p;
      if (pages.some((pg) => matchQuote(chars.join(""), pg.text_norm).ok)) ok++;
    }
    report.edited_1to3 = { ok, of: 200, rate: ok / 200 };
  });

  it("200 fabricated policy-like sentences: false-match rate", () => {
    const subj = ["Expenses related to", "Claims arising from", "Treatment of", "Costs incurred for", "Any hospitalisation for"];
    const obj = ["dental implants", "infertility treatment", "obesity surgery", "psychiatric illness", "organ donor expenses", "ayurvedic treatment", "maternity benefits", "vision correction", "HIV/AIDS", "external congenital anomalies"];
    const verb = ["shall be excluded", "shall be covered", "are payable", "shall not be admissible", "are covered up to the sum insured"];
    const tail = ["after 36 months of continuous coverage.", "during the first policy year.", "subject to prior approval by the insurer.", "unless certified by a medical practitioner.", "provided the policy has been renewed without a break."];
    let falseMatch = 0; const hits: string[] = [];
    for (let i = 0; i < 200; i++) {
      const s = `${pick(subj)} ${pick(obj)} ${pick(verb)} ${pick(tail)}`;
      if (pages.some((pg) => matchQuote(s, pg.text_norm).ok)) { falseMatch++; hits.push(s); }
    }
    report.fabricated = { falseMatch, of: 200, hits: hits.slice(0, 5) };
    expect.soft(falseMatch).toBe(0);
  });

  it("semantic tampering of real clauses (negation, numbers, include/exclude)", () => {
    const clauses = [
      "Expenses related to the treatment of a pre-existing disease (PED) and its direct complications shall be excluded until the expiry of 48 months of continuous coverage after the date of inception of the first policy with the insurer.",
      "Expenses related to the treatment of the following listed conditions, surgeries or treatments shall be excluded until the expiry of 24 months of continuous coverage after the date of inception of the first policy with the insurer",
      "a condition first diagnosed, or for which medical advice was first sought, on or after the effective date of the policy does not constitute non-disclosure under this Section",
      "Cosmetic surgery undertaken for aesthetic purposes, including but not limited to rhinoplasty not necessitated by injury, is excluded in all circumstances under this policy.",
    ];
    const tamper: Array<[string, (s: string) => string]> = [
      ["insert 'not' (shall be -> shall not be)", (s) => s.replace("shall be", "shall not be")],
      ["delete negation (does not constitute -> does constitute)", (s) => s.replace("does not constitute", "does constitute")],
      ["number change 48 -> 24 months", (s) => s.replace("48 months", "24 months")],
      ["number change 24 -> 12 months", (s) => s.replace("24 months", "12 months")],
      ["excluded -> included", (s) => s.replace("excluded", "included")],
      ["is excluded -> is not excluded", (s) => s.replace("is excluded", "is not excluded")],
    ];
    const results: Array<Record<string, unknown>> = [];
    for (const c of clauses) {
      const orig = pages.map((pg) => matchQuote(c, pg.text_norm)).sort((a, b) => b.score - a.score)[0];
      for (const [name, f] of tamper) {
        const t = f(c); if (t === c) continue;
        const best = pages.map((pg) => matchQuote(t, pg.text_norm)).sort((a, b) => b.score - a.score)[0];
        results.push({ clause: c.slice(0, 50) + "...", original_ok: orig.ok, tamper: name, tampered_ok: best.ok, score: +best.score.toFixed(3) });
      }
    }
    report.semantic_tampering = { accepted: results.filter((r) => r.tampered_ok).length, of: results.length, results };
  });

  it("edge cases", () => {
    const p = pages[0].text_norm;
    const longQ = pages.map((pg) => pg.text).join(" ") + " extra words beyond the page";
    report.edges = {
      empty: matchQuote("", p), whitespace_only: matchQuote("   \n ", p),
      longer_than_page: matchQuote(longQ, p),
      regex_specials: matchQuote("(.*)[a-z]+$^ shall be excluded \\d{2} until", p),
      unicode_curly_and_ligature: matchQuote("“Pre-Existing Disease” means any condition, ailment, injury or disease that is/are diagnosed by a physician", pages[0].text_norm),
      nfkc_fullwidth: matchQuote("ＰＲＥ-ＥＸＩＳＴＩＮＧ DISEASE means any condition, ailment, injury or disease", pages[0].text_norm),
      hyphen_linebreak_quote: matchQuote("including but not limited to para-jumping, rock climbing, mountaineering, rafting, motor racing", pages.find((pg) => pg.text.includes("para"))!.text_norm),
      short_exact: matchQuote("Section 6", pages[2].text_norm),
      short_fuzzy_typo: matchQuote("Sectoin 6 Disclosure", pages[2].text_norm),
    };
  });

  it("performance: worst case (non-matching 60-word quote) on the largest page", () => {
    const largest = [...pages].sort((a, b) => b.text_norm.length - a.text_norm.length)[0];
    const q = Array.from({ length: 60 }, (_, i) => `zz${i}word`).join(" ");
    const t0 = performance.now(); for (let i = 0; i < 5; i++) matchQuote(q, largest.text_norm); const ms = (performance.now() - t0) / 5;
    // and a synthetic 50k-char page (a dense real policy page can be this big)
    const big = (largest.text_norm + " ").repeat(Math.ceil(50_000 / largest.text_norm.length)).slice(0, 50_000);
    const t1 = performance.now(); matchQuote(q, big); const msBig = performance.now() - t1;
    report.perf = { largest_page_chars: largest.text_norm.length, ms_per_call: +ms.toFixed(1), synthetic_50k_chars_ms: +msBig.toFixed(1) };
    fs.writeFileSync("audit/logs/21-verifier.json", JSON.stringify(report, null, 2));
  });
});
