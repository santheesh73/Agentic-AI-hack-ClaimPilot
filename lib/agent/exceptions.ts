import { matchQuote, normalize } from "./verify";

/**
 * "Ask, don't assume" on exception clauses.
 *
 * Before a case can end as DONT_APPEAL, the clause text behind the verdict is
 * checked in code for an exception marker. If one is there and nothing
 * explicitly establishes whether the exception applies, the case asks the user
 * (one question, yes / no / not sure) instead of assuming it doesn't. This
 * exists because a model reading "joint replacement ... (unless due to
 * accident)" next to a letter that never mentions a cause sometimes concludes
 * "no accident" and tells the user not to appeal (eval case O).
 */

/** Phrases that introduce an exception to a rule. Matched case-insensitively on word boundaries. */
export const EXCEPTION_MARKERS = [
  "unless",
  "except",
  "other than",
  "provided that",
  "save where",
  "shall not apply",
  "shall not, however, apply", // the stand-in policy's wording in Excl02
  "excluding cases",
] as const;

const MARKER_RE = new RegExp(
  `(?<![\\w-])(?:${EXCEPTION_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|")})(?![\\w-])`,
  "gi"
);

/** The exception markers present in `text` (lowercased, deduplicated, in order of appearance). */
export function findExceptionMarkers(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(MARKER_RE)) found.add(m[0].toLowerCase().replace(/\s+/g, " "));
  return [...found];
}

export function hasExceptionMarker(text: string): boolean {
  return findExceptionMarkers(text).length > 0;
}

/** The answers-record key under which the exception question's answer is stored. Its presence means "already asked". */
export const EXCEPTION_ANSWER_KEY = "exception_applies";
export const EXCEPTION_OPTIONS = ["Yes", "No", "Not sure"] as const;

/** "Not sure" must never end as WEAK (don't-appeal). */
export function isNotSure(answer: string | undefined): boolean {
  return /^\s*not sure\.?\s*$/i.test(answer ?? "");
}

// A new clause starts at "Excl03 —", "4.2 ", "6.3.1 " or "Section 8:" at the start of a line.
const CLAUSE_START_RE = /^\s*(?:Excl\s?\d+\s*[—–-]|\d+(?:\.\d+)+\.?\s+\S|Section\s+\d+\s*[:.])/i;

/** Splits raw page text into clause-sized segments (the first may be a continuation from the previous page). */
export function splitClauses(pageText: string): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  for (const line of pageText.split("\n")) {
    if (CLAUSE_START_RE.test(line) && current.length) {
      segments.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) segments.push(current.join("\n"));
  return segments;
}

/**
 * The text of the whole clause that contains `quote`, so an exception stated
 * elsewhere in the same clause ("... (unless due to accident)") is seen even
 * when the model quoted only part of it. A clause that runs onto the next
 * page is continued from `nextPageText`. Falls back to the quote itself.
 */
export function clauseTextFor(pageText: string, quote: string, nextPageText?: string): string {
  const segments = splitClauses(pageText);
  const q = normalize(quote);
  let index = segments.findIndex((s) => normalize(s).includes(q));
  if (index === -1) {
    let best = { score: 0, i: -1 };
    segments.forEach((s, i) => {
      const m = matchQuote(quote, normalize(s));
      if (m.ok && m.score > best.score) best = { score: m.score, i };
    });
    index = best.i;
  }
  if (index === -1) return quote;
  let text = segments[index];
  if (index === segments.length - 1 && nextPageText) {
    // the clause may continue on the next page, up to that page's first new clause
    const continuation = splitClauses(nextPageText)[0] ?? "";
    if (!CLAUSE_START_RE.test(continuation.split("\n")[0] ?? "")) text += "\n" + continuation;
  }
  return text;
}

export type ExceptionReviewItem = {
  condition: string;
  relevant: boolean;
  status: "applies" | "does_not_apply" | "not_established";
  basis_quote: string | null;
};

/**
 * The first relevant exception that is NOT established. An exception is
 * established only if the review says it applies or doesn't AND supplies a
 * basis quote that is verifiably present (exact or >= 0.92 fuzzy, same
 * numbers/polarity) in the rejection letter or the user's answers. A model
 * saying "the facts do not indicate an accident" without such a quote does
 * not count.
 */
export function firstUnresolvedException(
  exceptions: ExceptionReviewItem[],
  sources: string[]
): ExceptionReviewItem | null {
  const normalizedSources = sources.map((s) => normalize(s));
  for (const e of exceptions) {
    if (!e.relevant) continue;
    const quote = e.basis_quote?.trim();
    const established =
      e.status !== "not_established" && !!quote && normalizedSources.some((s) => matchQuote(quote, s).ok);
    if (!established) return e;
  }
  return null;
}
