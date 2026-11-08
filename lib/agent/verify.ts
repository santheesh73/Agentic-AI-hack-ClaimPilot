import { distance as levenshtein } from "fastest-levenshtein";
import { normalize } from "../ingest/normalize";

export { normalize };

export type MatchResult = { ok: boolean; score: number };

const OK_THRESHOLD = 0.92;
const SHORT_QUOTE_WORDS = 6;

/**
 * Checks whether `quote` appears in `pageNorm` (already normalize()'d).
 * Exact substring is score 1. Otherwise a sliding token window scored by
 * normalized Levenshtein similarity. Quotes under 6 words require an exact
 * substring match (fuzzy matching on very short strings is unreliable).
 */
export function matchQuote(quote: string, pageNorm: string): MatchResult {
  const qNorm = normalize(quote);
  if (qNorm.length === 0) return { ok: false, score: 0 };

  if (pageNorm.includes(qNorm)) return { ok: true, score: 1 };

  const qWords = qNorm.split(" ");
  if (qWords.length < SHORT_QUOTE_WORDS) return { ok: false, score: 0 };

  const pageWords = pageNorm.split(" ");
  const qLen = qWords.length;
  const minLen = Math.max(1, Math.floor(qLen * 0.85));
  const maxLen = Math.ceil(qLen * 1.15);

  let best = 0;
  for (let winLen = minLen; winLen <= maxLen; winLen++) {
    for (let start = 0; start + winLen <= pageWords.length; start++) {
      const winStr = pageWords.slice(start, start + winLen).join(" ");
      const maxStrLen = Math.max(qNorm.length, winStr.length);
      if (maxStrLen === 0) continue;
      const dist = levenshtein(qNorm, winStr);
      const score = 1 - dist / maxStrLen;
      if (score > best) best = score;
      if (best >= 1) break;
    }
    if (best >= 1) break;
  }

  return { ok: best >= OK_THRESHOLD, score: best };
}

export type EvidenceRow = { short_id: string; quote: string; page_id: string; verified: boolean };
export type PageRow = { id: string; text_norm: string };

// Tolerant of model formatting drift: optional space after the colon, and a
// comma-separated list of ids in one marker (e.g. "[cite: E1, E2]"), which
// models produce despite being told to write one id per marker with no space.
// Exported so every consumer (verifier, UI rendering, redraft cleanup) parses
// citation markers identically instead of re-deriving a slightly different regex.
export const CITE_RE = /\[cite:\s*([A-Za-z0-9_]+(?:\s*,\s*[A-Za-z0-9_]+)*)\]/g;

function splitCiteIds(idList: string): string[] {
  return idList
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function extractCites(bodyMd: string): string[] {
  const ids = new Set<string>();
  for (const m of bodyMd.matchAll(CITE_RE)) {
    for (const id of splitCiteIds(m[1])) ids.add(id);
  }
  return [...ids];
}

/** Drops every sentence that cites at least one of the given failed ids. */
export function stripSentencesCiting(bodyMd: string, failedIds: string[]): string {
  if (!failedIds.length) return bodyMd;
  const failedSet = new Set(failedIds);
  const sentences = bodyMd.split(/(?<=[.!?])\s+/);
  return sentences.filter((s) => !extractCites(s).some((id) => failedSet.has(id))).join(" ");
}

/** Replaces every [cite:...] marker (single or comma-list) with `render(ids)`. */
export function replaceCites(bodyMd: string, render: (ids: string[]) => string): string {
  return bodyMd.replace(CITE_RE, (_match, idList: string) => render(splitCiteIds(idList)));
}

/**
 * Verifies every [cite:E#] in a draft: the id must be known, its evidence
 * already verified, and its quote must still match its source page.
 */
export function verifyDraft(
  bodyMd: string,
  evidenceById: Record<string, EvidenceRow>,
  pagesById: Record<string, PageRow>
): Array<{ short_id: string; ok: boolean; score: number }> {
  const cites = extractCites(bodyMd);
  return cites.map((short_id) => {
    const ev = evidenceById[short_id];
    if (!ev || !ev.verified) return { short_id, ok: false, score: 0 };
    const page = pagesById[ev.page_id];
    if (!page) return { short_id, ok: false, score: 0 };
    const { ok, score } = matchQuote(ev.quote, page.text_norm);
    return { short_id, ok, score };
  });
}
