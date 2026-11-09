import { distance as levenshtein } from "fastest-levenshtein";
import { normalize } from "../ingest/normalize";

export { normalize };

export type MatchResult = { ok: boolean; score: number };

const OK_THRESHOLD = 0.92;
const SHORT_QUOTE_WORDS = 6;

/**
 * Words whose presence or absence flips a clause's legal meaning. A fuzzy
 * match may tolerate typos and PDF-extraction noise, but never a change to
 * one of these or to a number: "shall be excluded" vs "shall not be
 * excluded" is ~2% of the characters and 100% of the meaning.
 */
const POLARITY_WORDS = new Set([
  "not", "no", "nor", "never", "none", "without", "except", "unless", "only", "all", "any",
  "exclude", "excludes", "excluded", "excluding", "exclusion",
  "include", "includes", "included", "including", "inclusion",
  "cover", "covers", "covered", "covering",
  "before", "after", "prior", "within", "beyond", "more", "less", "maximum", "minimum",
  "shall", "may", "must",
]);

/** The meaning-bearing tokens of a normalized string: every number and every polarity word, in order. */
export function meaningSignature(norm: string): string {
  const tokens = norm.match(/\d+(?:[.,]\d+)*|[a-z]+/g) ?? [];
  return tokens.filter((t) => /^\d/.test(t) || POLARITY_WORDS.has(t)).join(" ");
}

/**
 * Checks whether `quote` appears in `pageNorm` (already normalize()'d).
 * An exact normalized substring scores 1. Otherwise a sliding token window
 * finds the closest passage by normalized Levenshtein similarity; it counts
 * as verified only if it is >= 0.92 similar AND has exactly the same numbers
 * and polarity words as the quote (see POLARITY_WORDS). Quotes under 6 words
 * require an exact substring match.
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
  let bestWindow = "";
  for (let winLen = minLen; winLen <= maxLen; winLen++) {
    for (let start = 0; start + winLen <= pageWords.length; start++) {
      const winStr = pageWords.slice(start, start + winLen).join(" ");
      const maxStrLen = Math.max(qNorm.length, winStr.length);
      if (maxStrLen === 0) continue;
      const dist = levenshtein(qNorm, winStr);
      const score = 1 - dist / maxStrLen;
      if (score > best) {
        best = score;
        bestWindow = winStr;
      }
      if (best >= 1) break;
    }
    if (best >= 1) break;
  }

  const sameMeaning = meaningSignature(qNorm) === meaningSignature(bestWindow);
  return { ok: best >= OK_THRESHOLD && sameMeaning, score: best };
}

export type EvidenceRow = { short_id: string; quote: string; page_id: string; verified: boolean };
export type PageRow = { id: string; text_norm: string };

// Citation markers, tolerant of the formats models actually produce:
// [cite:E1], [cite: E1, E2], [CITE:e1], [cite:E1; E2], [cite:E1 E2],
// [cite:E1-E3], (cite:E1). Exported so every consumer (verifier, UI
// rendering, redraft cleanup) parses markers identically.
export const CITE_RE = /[[(]\s*cite\s*:\s*([^\])]*?)\s*[\])]/gi;

/** Splits a marker's id list into normalized ids ("E1"), expanding ranges. Unrecognized tokens are kept verbatim so they fail verification. */
function splitCiteIds(idList: string): string[] {
  const out: string[] = [];
  for (const raw of idList.split(/\s*(?:,|;|\band\b|\s)\s*/i).filter(Boolean)) {
    const range = raw.match(/^E?(\d+)\s*[-–]\s*E?(\d+)$/i);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (b >= a && b - a <= 20) for (let n = a; n <= b; n++) out.push(`E${n}`);
      else out.push(raw);
      continue;
    }
    out.push(/^E\d+$/i.test(raw) ? raw.toUpperCase() : raw);
  }
  return out;
}

export function extractCites(bodyMd: string): string[] {
  const ids = new Set<string>();
  for (const m of bodyMd.matchAll(CITE_RE)) {
    for (const id of splitCiteIds(m[1])) ids.add(id);
  }
  return [...ids];
}

/** Replaces every recognized citation marker with `render(ids)`. */
export function replaceCites(bodyMd: string, render: (ids: string[]) => string): string {
  return bodyMd.replace(CITE_RE, (_match, idList: string) => render(splitCiteIds(idList)));
}

// --- Sentence handling ---------------------------------------------------

// Abbreviations whose trailing "." does not end a sentence.
const ABBREVIATIONS = new Set(["sec", "no", "nos", "rs", "cl", "excl", "e.g", "i.e", "dr", "mr", "mrs", "ms", "vs", "etc", "st", "viz", "approx", "dt", "ref", "art", "para", "pg", "p"]);
const CITE_SRC = String.raw`[[(]\s*cite\s*:[^\])]*[\])]`;
// A sentence ends at . ! or ?, optionally followed by closing quotes/brackets
// and by citation markers -- markers right after the full stop belong to the
// sentence BEFORE them, which is how models usually place them.
const BOUNDARY_RE = new RegExp(String.raw`[.!?]["'”’)\]]*((?:\s*${CITE_SRC})*)(?=\s|$)`, "gi");

/** Splits one line of text into sentences, keeping each citation marker with the sentence it follows. */
export function splitSentences(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of line.matchAll(BOUNDARY_RE)) {
    const end = m.index! + m[0].length;
    const before = line.slice(start, m.index!);
    const lastWord = (before.match(/([A-Za-z.]+)$/)?.[1] ?? "").toLowerCase();
    // "Sec. 6.3", "Rs. 1,000", "e.g. this": not a boundary.
    if (m[0].startsWith(".") && !m[1] && (ABBREVIATIONS.has(lastWord) || /^[a-z]$/.test(lastWord))) continue;
    out.push(line.slice(start, end).trim());
    start = end;
  }
  const rest = line.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** Applies `keep` to every sentence while preserving paragraphs, list items and headings. */
function filterSentences(bodyMd: string, keep: (sentence: string) => boolean): string {
  return bodyMd
    .split(/\n{2,}/)
    .map((para) =>
      para
        .split("\n")
        .map((line) => {
          const prefix = line.match(/^(\s*(?:[-*+]|\d+\.|#{1,6})\s+)/)?.[1] ?? "";
          const kept = splitSentences(line.slice(prefix.length)).filter(keep);
          return kept.length ? prefix + kept.join(" ") : "";
        })
        .filter((l) => l.trim() !== "")
        .join("\n")
    )
    .filter((p) => p.trim() !== "")
    .join("\n\n");
}

/** Drops every sentence that cites at least one of the given failed ids. */
export function stripSentencesCiting(bodyMd: string, failedIds: string[]): string {
  if (!failedIds.length) return bodyMd;
  const failed = new Set(failedIds);
  return filterSentences(bodyMd, (s) => !extractCites(s).some((id) => failed.has(id)));
}

// --- Fail-closed checks for text the citation parser can't vouch for -----

// A "cite"-like token left after every recognized marker is removed means
// the model used a marker format we don't parse; it must not pass silently.
const LEFTOVER_CITE_RE = /\bcite\b|\[E\d+\]/i;

// Heuristic for a sentence that asserts what the POLICY says. It flags only
// explicit attributions to the policy text. Bare topic words such as
// "portability", "continuous coverage" or "waiting period" are NOT enough:
// they appear constantly in the insured's own facts ("I ported to this
// policy ...") and flagging those strips true statements from the letter
// (seen in the live eval: cases H, K and M).
// A sentence needs a citation when it ASSERTS WHAT THE POLICY SAYS: an
// explicit reference to the policy text (a clause/section/exclusion id, or
// "the policy") together with a verb that states its content. Merely naming
// a clause ("the invocation of Clause Excl01 is incorrect"), quoting a policy
// number ("under Policy No. UGHI/..."), or recounting the insured's own
// facts is not a claim about the policy's content.
const POLICY_REF_RE = new RegExp(
  [
    String.raw`\b(?:clause|section|sec\.|excl\s?\d+)\s*\d*(?:\.\d+)?`,
    String.raw`\b(?:as per|under|per|according to|in terms of|pursuant to)\s+the\s+(?:policy|policy wording|policy terms|terms of the policy)\b`,
    String.raw`\bthe\s+(?:policy|policy wording|policy terms|insurance contract)\b`,
  ].join("|"),
  "i"
);
const CONTENT_VERB_RE = new RegExp(
  [
    String.raw`\b(?:provides?|states?|says?|covers?|excludes?|defines?|requires?|stipulates?|specifies|guarantees?|allows?|waives?|entitles?|obliges?|mandates?|permits?|prohibits?|promises?|ensures?)\b`,
    String.raw`\b(?:does|do)\s+not\s+(?:cover|apply|constitute|exclude)\b`,
    String.raw`\b(?:is|are|stands?|stand)\s+(?:not\s+)?(?:covered|excluded|payable|included|admissible|waived|credited|entitled)\b`,
    String.raw`\b(?:shall|must)\b`,
  ].join("|"),
  "i"
);
// Verbs that assert a benefit for the insured. These override the
// rejection-restatement exemption below.
const STRONG_ASSERTION_RE = /\b(?:guarantees?|entitles?|waives?|obliges?|mandates?|promises?|ensures?|payable|credited|entitled)\b/i;
// The model's typical unsupported conclusion about the policy's terms applied
// to the facts. Exempt when it is the insured's own account or an attachment.
const APPLIED_CONCLUSION_RE = new RegExp(
  [
    String.raw`\b(?:waiting period|exclusion)\b[^.!?]*\b(?:has|have)\s+(?:expired|ceased|lapsed|elapsed|been completed)\b`,
    String.raw`\b(?:waiting period|exclusion)\b[^.!?]*\b(?:does not|do not|no longer)\s+appl(?:y|ies)\b`,
  ].join("|"),
  "i"
);
// Recounting what the insurer said or did.
const RESTATES_REJECTION_RE = new RegExp(
  [
    String.raw`\b(?:was|were|been|stands?)\s+(?:\w+\s+)?(?:rejected|repudiated|denied|communicated)\b`,
    String.raw`\brejected\s+(?:under|on|by|based|vide|citing)\b`,
    String.raw`\b(?:rejection|repudiation|denial)\s+(?:of|was|dated|letter)\b`,
    String.raw`\b(?:appeal|contest|challenge|dispute)\w*\s+(?:against\s+)?(?:the\s+|this\s+|our\s+|my\s+)?(?:rejection|decision|repudiation)\b`,
    String.raw`\byour\s+(?:esteemed\s+)?(?:letter|decision|office)\b`,
  ].join("|"),
  "i"
);
const OWN_FACTS_OR_ATTACHMENT_RE = new RegExp(
  [
    String.raw`\b(?:documents?|copy|copies|enclosed|enclosure|attached|attachment|annexure|certificate|report|summary)\b`,
    String.raw`^\s*(?:i|my|we|our)\b`,
  ].join("|"),
  "i"
);

function isUncitedPolicyClaim(sentence: string): boolean {
  const assertsPolicyContent = POLICY_REF_RE.test(sentence) && CONTENT_VERB_RE.test(sentence);
  if (assertsPolicyContent) {
    // Recounting the rejection is exempt unless it also asserts a benefit.
    return !RESTATES_REJECTION_RE.test(sentence) || STRONG_ASSERTION_RE.test(sentence);
  }
  return APPLIED_CONCLUSION_RE.test(sentence) && !OWN_FACTS_OR_ATTACHMENT_RE.test(sentence) && !RESTATES_REJECTION_RE.test(sentence);
}

export type UnverifiableSentence = { reason: "unparsed_citation" | "uncited_policy_claim"; sentence: string };

/** Sentences that cannot be verified: an unrecognized citation format, or a policy claim with no citation. */
export function findUnverifiableSentences(bodyMd: string): UnverifiableSentence[] {
  const found: UnverifiableSentence[] = [];
  for (const line of bodyMd.split("\n")) {
    if (/^\s*#/.test(line)) continue; // headings/subject lines
    const text = line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
    for (const sentence of splitSentences(text)) {
      const withoutMarkers = sentence.replace(CITE_RE, "");
      if (LEFTOVER_CITE_RE.test(withoutMarkers)) {
        found.push({ reason: "unparsed_citation", sentence });
      } else if (extractCites(sentence).length === 0 && isUncitedPolicyClaim(sentence)) {
        found.push({ reason: "uncited_policy_claim", sentence });
      }
    }
  }
  return found;
}

/** Drops the given sentences (exact match after trimming), preserving structure. */
export function stripSentences(bodyMd: string, sentences: string[]): string {
  if (!sentences.length) return bodyMd;
  const drop = new Set(sentences.map((s) => s.trim()));
  return filterSentences(bodyMd, (s) => !drop.has(s.trim()));
}

export type VerificationResult = { short_id: string; ok: boolean; score: number; reason?: string; stripped?: boolean };

/**
 * Verifies a draft: every recognized [cite:E#] must be known, already
 * verified, and still match its source page; and no sentence may use an
 * unrecognized citation format or make a policy claim without a citation
 * (those are reported as short_id "UNCITED", ok: false).
 */
export function verifyDraft(
  bodyMd: string,
  evidenceById: Record<string, EvidenceRow>,
  pagesById: Record<string, PageRow>
): VerificationResult[] {
  const cites = extractCites(bodyMd);
  const results: VerificationResult[] = cites.map((short_id) => {
    const ev = evidenceById[short_id];
    if (!ev || !ev.verified) return { short_id, ok: false, score: 0 };
    const page = pagesById[ev.page_id];
    if (!page) return { short_id, ok: false, score: 0 };
    const { ok, score } = matchQuote(ev.quote, page.text_norm);
    return { short_id, ok, score };
  });
  for (const u of findUnverifiableSentences(bodyMd)) {
    results.push({ short_id: "UNCITED", ok: false, score: 0, reason: `${u.reason}: ${u.sentence.slice(0, 160)}` });
  }
  return results;
}

/**
 * Removes everything verification could not vouch for: sentences citing a
 * failed id, and unparsed/uncited policy sentences. Used after the redraft
 * budget is spent, and by the escalation drafts in the simulate route.
 */
export function stripUnverified(bodyMd: string, results: VerificationResult[]): string {
  const failedIds = results.filter((r) => !r.ok && r.short_id !== "UNCITED").map((r) => r.short_id);
  const afterIds = stripSentencesCiting(bodyMd, failedIds);
  return stripSentences(afterIds, findUnverifiableSentences(afterIds).map((u) => u.sentence));
}
