import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parsePdf } from "../lib/ingest/pdf";
import { matchQuote } from "../lib/agent/verify";

type Page = { page_no: number; text: string; text_norm: string };
let pages: Page[];

beforeAll(async () => {
  const buffer = await readFile(path.join(__dirname, "..", "samples", "policy.pdf"));
  // parsePdf() now coerces a Node Buffer to a plain Uint8Array internally
  // (see lib/ingest/pdf.ts) -- this used to require an explicit workaround
  // here before that bug was found and fixed.
  pages = (await parsePdf(buffer)).filter((p) => p.text_norm.length >= 200);
  if (pages.length === 0) throw new Error("samples/policy.pdf produced no usable pages for property testing");
});

/** Trims a raw substring to whole words so edits land on real word boundaries. */
function wordTrim(s: string): string {
  const trimmed = s.trim().replace(/^\S*\s/, "").replace(/\s\S*$/, "");
  return trimmed;
}

function extractSpan(text: string, start: number, len: number): string {
  return wordTrim(text.slice(start, start + len));
}

describe("matchQuote property tests (against the real samples/policy.pdf)", () => {
  it("a random verbatim span from the real policy always matches with score 1", () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), fc.integer({ min: 40, max: 150 }), (pageSeed, offsetSeed, len) => {
        const page = pages[pageSeed % pages.length];
        const text = page.text_norm;
        const maxStart = Math.max(1, text.length - len - 1);
        const start = offsetSeed % maxStart;
        const span = extractSpan(text, start, len);
        fc.pre(span.length >= 20); // word-trimming can shorten it; skip degenerate cases

        const { ok, score } = matchQuote(span, text);
        expect(ok).toBe(true);
        expect(score).toBe(1);
      }),
      { numRuns: 200 }
    );
  });

  it("a 40+ char quote with 1-2 character edits still matches at >= 0.92", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.nat(),
        fc.integer({ min: 40, max: 150 }),
        fc.integer({ min: 1, max: 2 }),
        fc.nat(),
        (pageSeed, offsetSeed, len, editCount, editSeed) => {
          const page = pages[pageSeed % pages.length];
          const text = page.text_norm;
          const maxStart = Math.max(1, text.length - len - 1);
          const start = offsetSeed % maxStart;
          const span = extractSpan(text, start, len);
          // matchQuote requires >=6 words to use fuzzy matching at all (see
          // lib/agent/verify.ts); a 40+ char span of long words can still be
          // short on word count, which would correctly take the exact-match-
          // only path instead -- that's not what this property is testing.
          fc.pre(span.length >= 40 && span.split(" ").length >= 6);

          const chars = span.split("");
          for (let i = 0; i < editCount; i++) {
            const pos = (editSeed + i * 37) % chars.length;
            const original = chars[pos];
            // Replace with a letter guaranteed different from the original.
            const replacement = original === "x" ? "z" : "x";
            chars[pos] = /[a-z0-9]/.test(original) ? replacement : original;
          }
          const edited = chars.join("");
          fc.pre(edited !== span); // only meaningful if an edit actually changed something

          const { score } = matchQuote(edited, text);
          expect(score).toBeGreaterThanOrEqual(0.92);
        }
      ),
      { numRuns: 200 }
    );
  }, 20_000); // the sliding-window Levenshtein search is slow under v8 coverage instrumentation

  it("random text not in the policy does not match", () => {
    const inventedWords = [
      "zorblex", "quintar", "flembic", "trevastic", "glomwit", "snarquel",
      "plindorf", "braxilon", "thrumvex", "clendoza", "fiquorath", "obsidrix",
    ];
    fc.assert(
      fc.property(fc.nat(), fc.array(fc.nat({ max: inventedWords.length - 1 }), { minLength: 8, maxLength: 20 }), (pageSeed, wordIdxs) => {
        const page = pages[pageSeed % pages.length];
        const nonsense = wordIdxs.map((i) => inventedWords[i]).join(" ");

        const { ok } = matchQuote(nonsense, page.text_norm);
        expect(ok).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});
