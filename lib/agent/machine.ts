import "server-only";
import { supabaseAdmin } from "../db";
import { logEvent } from "../models";
import { extractRejection } from "./tools/extractRejection";
import { writeQueries } from "./tools/writeQueries";
import { searchPolicy } from "./tools/searchPolicy";
import { assessCase, type CandidatePage } from "./tools/assessCase";
import { chooseRouteTool } from "./tools/chooseRouteTool";
import { draftAppeal, type EvidenceForDraft } from "./tools/draftAppeal";
import { verifyCitationsTool } from "./tools/verifyCitationsTool";
import { redteamReview } from "./tools/redteamReview";
import { dontAppealExplanation } from "./tools/dontAppealExplanation";
import { scheduleFollowupTool } from "./tools/scheduleFollowupTool";
import { matchQuote, stripUnverified, extractCites } from "./verify";
import { simNow } from "./deadlines";
import { looksLikePromptInjection } from "./prompts";
import { exceptionReview } from "./tools/exceptionReview";
import {
  EXCEPTION_ANSWER_KEY,
  EXCEPTION_OPTIONS,
  clauseTextFor,
  findExceptionMarkers,
  firstUnresolvedException,
  isNotSure,
} from "./exceptions";
import type { Check, RejectionFacts, Verdict } from "./schemas";

export const STATES = [
  "INTAKE",
  "EXTRACT",
  "RETRIEVE",
  "ASSESS",
  "AWAITING_USER",
  "DECIDE",
  "DONT_APPEAL",
  "ROUTE",
  "DRAFT",
  "VERIFY",
  "REDTEAM",
  "AWAITING_APPROVAL",
  "APPROVED",
  "ERROR",
] as const;
export type CaseState = (typeof STATES)[number];

export const PAUSE_STATES: CaseState[] = ["AWAITING_USER", "AWAITING_APPROVAL"];
export const TERMINAL_STATES: CaseState[] = ["DONT_APPEAL", "APPROVED", "ERROR"];

const MAX_STEPS = 20;
const MAX_REDRAFTS = 2;

export type CaseRow = {
  id: string;
  state: CaseState;
  insurer: string | null;
  claim_amount_inr: number | null;
  facts: RejectionFacts | null;
  queries: string[] | null;
  candidate_page_ids: string[] | null;
  rubric: Check[] | null;
  missing_facts: Array<{ key: string; question: string; options?: string[] }> | null;
  answers: Record<string, string> | null;
  verdict: Verdict | null;
  route: { step: string; addressee: string; reason: string } | null;
  redraft_count: number;
  redteam_done: boolean;
  dont_appeal_reason: string | null;
  complaint_sent_on: string | null;
  sim_offset_days: number;
  error: string | null;
};

export async function getCase(caseId: string): Promise<CaseRow> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("cases").select("*").eq("id", caseId).single();
  if (error) throw error;
  return data as CaseRow;
}

async function updateCase(caseId: string, patch: Record<string, unknown>) {
  const db = supabaseAdmin();
  const { error } = await db
    .from("cases")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", caseId);
  if (error) throw error;
}

async function setError(caseId: string, message: string) {
  await updateCase(caseId, { state: "ERROR", error: message });
  await logEvent({ caseId, step: "ERROR", summary: message });
}

async function stepCount(caseId: string): Promise<number> {
  const db = supabaseAdmin();
  const { count, error } = await db
    .from("agent_events")
    .select("id", { count: "exact", head: true })
    .eq("case_id", caseId)
    .is("tool", null);
  if (error) throw error;
  return count ?? 0;
}

/** Default per-case token cap, so a fresh deployment is protected even if
 * MAX_TOKENS_PER_CASE is never set (audit F-007). The live eval's heaviest
 * case used about 13k tokens, so this leaves ample headroom. */
export const DEFAULT_MAX_TOKENS_PER_CASE = 60_000;

/** Per-case token cap: MAX_TOKENS_PER_CASE if a positive integer, null
 * (disabled) if explicitly "0", otherwise the default. Read directly rather
 * than via getEnv() so the rest of the env stays optional here. */
export function tokenBudget(): number | null {
  const raw = process.env.MAX_TOKENS_PER_CASE?.trim();
  if (raw === "0") return null;
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_TOKENS_PER_CASE;
}

async function tokensUsed(caseId: string): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from("agent_events")
    .select("tokens_in, tokens_out")
    .eq("case_id", caseId);
  if (error) throw error;
  return (data ?? []).reduce((n, e) => n + (e.tokens_in ?? 0) + (e.tokens_out ?? 0), 0);
}

// Longer than the worst-case step with our own retries (3 attempts x 30 s timeout + backoff), so a slow
// step can't outlive its lease and be entered twice. Routes have maxDuration 60, so a killed step releases within the lease.
const STEP_LOCK_LEASE_MS = 90_000;

/** Atomically claims the step lock: succeeds only if no lease is held, or the
 * previous lease has expired. Prevents a double-click or two open tabs from
 * running the same state transition concurrently. */
async function claimStepLock(caseId: string): Promise<boolean> {
  const db = supabaseAdmin();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + STEP_LOCK_LEASE_MS).toISOString();
  const { data, error } = await db
    .from("cases")
    .update({ step_lock_until: leaseUntil })
    .eq("id", caseId)
    .or(`step_lock_until.is.null,step_lock_until.lt.${now.toISOString()}`)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

async function releaseStepLock(caseId: string): Promise<void> {
  const db = supabaseAdmin();
  await db.from("cases").update({ step_lock_until: null }).eq("id", caseId);
}

export class StepLockedError extends Error {
  constructor(public state: CaseState) {
    super("Another /step call is already in progress for this case.");
  }
}

/** Runs exactly one state transition for the case and persists the result.
 * Throws StepLockedError (callers should surface this as 409) if a step is
 * already in progress for this case. */
export async function runStep(caseId: string): Promise<{ state: CaseState; error?: string }> {
  const claimed = await claimStepLock(caseId);
  if (!claimed) {
    const current = await getCase(caseId);
    throw new StepLockedError(current.state);
  }

  try {
    return await runStepLocked(caseId);
  } finally {
    await releaseStepLock(caseId);
  }
}

/** Supabase/PostgREST errors are plain objects, not Error instances, so
 * String(err) would store "[object Object]" on the case. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    const { message, details } = err as { message: string; details?: unknown };
    return typeof details === "string" && details ? `${message} (${details})` : message;
  }
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown error";
    }
  }
  return String(err);
}

async function runStepLocked(caseId: string): Promise<{ state: CaseState; error?: string }> {
  const c = await getCase(caseId);

  const alreadyDone = c.state === "DONT_APPEAL" && c.dont_appeal_reason != null;
  if (PAUSE_STATES.includes(c.state) || c.state === "APPROVED" || c.state === "ERROR" || alreadyDone) {
    return { state: c.state, error: c.error ?? undefined };
  }

  const steps = await stepCount(caseId);
  if (steps >= MAX_STEPS) {
    await setError(caseId, "Step limit reached (20 steps).");
    return { state: "ERROR", error: "Step limit reached" };
  }

  const budget = tokenBudget();
  if (budget != null) {
    const used = await tokensUsed(caseId);
    if (used >= budget) {
      const message = `Token budget exceeded (${used} of ${budget} tokens used for this case).`;
      await setError(caseId, message);
      return { state: "ERROR", error: message };
    }
  }

  try {
    switch (c.state) {
      case "INTAKE":
        return await runIntake(c);
      case "EXTRACT":
        return await runExtract(c);
      case "RETRIEVE":
        return await runRetrieve(c);
      case "ASSESS":
        return await runAssess(c);
      case "DECIDE":
        return await runDecide(c);
      case "DONT_APPEAL":
        return await runDontAppeal(c);
      case "ROUTE":
        return await runRoute(c);
      case "DRAFT":
        return await runDraft(c);
      case "VERIFY":
        return await runVerify(c);
      case "REDTEAM":
        return await runRedteam(c);
      default:
        return { state: c.state };
    }
  } catch (err) {
    const message = errorMessage(err);
    await setError(caseId, message);
    return { state: "ERROR", error: message };
  }
}

async function runIntake(c: CaseRow): Promise<{ state: CaseState }> {
  const db = supabaseAdmin();
  const { data: docs, error } = await db.from("documents").select("id, kind").eq("case_id", c.id);
  if (error) throw error;

  const hasPolicy = (docs ?? []).some((d) => d.kind === "policy");
  const hasRejection = (docs ?? []).some((d) => d.kind === "rejection");

  if (!hasPolicy || !hasRejection) {
    const missing = [!hasPolicy && "a policy document", !hasRejection && "a rejection letter"]
      .filter(Boolean)
      .join(" and ");
    await setError(c.id, `Missing ${missing}. Upload both to continue.`);
    return { state: "ERROR" };
  }

  for (const d of docs!) {
    const { count } = await db
      .from("pages")
      .select("id", { count: "exact", head: true })
      .eq("document_id", d.id);
    if (!count) {
      await setError(
        c.id,
        "One of the uploaded documents has no extractable text. If it is a scanned/image-only PDF, ClaimPilot cannot process it."
      );
      return { state: "ERROR" };
    }
  }

  await updateCase(c.id, { state: "EXTRACT" });
  await logEvent({ caseId: c.id, step: "INTAKE", summary: "Documents verified: policy + rejection present with extractable text." });
  return { state: "EXTRACT" };
}

/** The full text of the case's rejection letter (all pages). */
async function loadRejectionText(caseId: string): Promise<string> {
  const db = supabaseAdmin();
  const { data: rejectionDoc } = await db
    .from("documents")
    .select("id")
    .eq("case_id", caseId)
    .eq("kind", "rejection")
    .limit(1)
    .single();

  const { data: pages } = await db
    .from("pages")
    .select("text")
    .eq("document_id", rejectionDoc!.id)
    .order("page_no");

  return (pages ?? []).map((p) => p.text).join("\n\n");
}

async function runExtract(c: CaseRow): Promise<{ state: CaseState }> {
  const rejectionText = await loadRejectionText(c.id);

  if (looksLikePromptInjection(rejectionText)) {
    await logEvent({ caseId: c.id, step: "EXTRACT", summary: "Ignored instructions found inside a document" });
  }

  const facts = await extractRejection(c.id, rejectionText);
  await updateCase(c.id, { state: "RETRIEVE", facts });
  await logEvent({
    caseId: c.id,
    step: "EXTRACT",
    summary: `Extracted rejection: ${facts.clause_cited ?? facts.reason_category}, ₹${facts.claim_amount_inr ?? "?"}`,
  });
  return { state: "RETRIEVE" };
}

/** Patterns for the clause identifiers named in an insurer's citation, e.g.
 * "Section 6 (Disclosure), Clause 6.2" -> /6.2/ and /Section 6/;
 * "Excl01 (Pre-Existing Diseases)" -> /Excl01/ (also matches "Excl1"). */
export function clauseRefs(clauseCited: string): RegExp[] {
  const refs: RegExp[] = [];
  for (const m of clauseCited.matchAll(/\bExcl\s*0*(\d{1,2})\b/gi)) {
    refs.push(new RegExp(`\\bExcl\\s*0*${m[1]}\\b`, "i"));
  }
  for (const m of clauseCited.matchAll(/(?<![\d.])(\d{1,2}\.\d{1,2})(?![\d.])/g)) {
    refs.push(new RegExp(`(?<![\\d.])${m[1].replace(".", "\\.")}(?![\\d])`));
  }
  for (const m of clauseCited.matchAll(/\bSection\s+(\d{1,2})\b/gi)) {
    refs.push(new RegExp(`\\bSection\\s+${m[1]}\\b(?!\\.)`, "i"));
  }
  return refs;
}

async function runRetrieve(c: CaseRow): Promise<{ state: CaseState }> {
  const db = supabaseAdmin();
  const facts = c.facts!;
  const queries = await writeQueries(c.id, facts);

  const byId = new Map<string, { id: string; page_no: number; rank: number }>();
  for (const q of queries) {
    const results = await searchPolicy(c.id, q, 6);
    for (const r of results) {
      const existing = byId.get(r.id);
      if (!existing || r.rank > existing.rank) {
        byId.set(r.id, { id: r.id, page_no: r.page_no, rank: r.rank });
      }
    }
  }

  const { data: policyDocs } = await db.from("documents").select("id").eq("case_id", c.id).eq("kind", "policy");
  const policyDocIds = (policyDocs ?? []).map((d) => d.id);
  const { data: allPolicyPages } = await db
    .from("pages")
    .select("id, page_no, text, document_id")
    .in("document_id", policyDocIds.length ? policyDocIds : ["00000000-0000-0000-0000-000000000000"]);

  // Full-text search can miss a clause cited by number ("Clause 6.2",
  // "Excl01"), since websearch_to_tsquery tokenizes those poorly. Always
  // include pages that literally contain the cited clause id, ranked first.
  const refs = clauseRefs(facts.clause_cited ?? "");
  for (const p of allPolicyPages ?? []) {
    if (refs.some((re) => re.test(p.text as string))) {
      byId.set(p.id, { id: p.id, page_no: p.page_no, rank: Number.MAX_SAFE_INTEGER });
    }
  }

  let extrasAdded = 0;
  for (const p of allPolicyPages ?? []) {
    if (extrasAdded >= 4) break;
    if (byId.has(p.id)) continue;
    const head = (p.text as string).slice(0, 300);
    if (/definitions?/i.test(head) || /exclusions?/i.test(head)) {
      byId.set(p.id, { id: p.id, page_no: p.page_no, rank: 0 });
      extrasAdded++;
    }
  }

  const candidatePageIds = [...byId.values()]
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 14)
    .map((p) => p.id);

  await updateCase(c.id, { state: "ASSESS", queries, candidate_page_ids: candidatePageIds });
  await logEvent({
    caseId: c.id,
    step: "RETRIEVE",
    summary: `Searched policy with ${queries.length} queries → ${candidatePageIds.length} pages`,
  });
  return { state: "ASSESS" };
}

/** Verifies a ledger quote against the page the model attributed it to and,
 * if it doesn't match there, against the other retrieved pages. Models
 * sometimes copy a quote correctly but label it with a neighbouring page;
 * the quote is still re-checked against real policy text, so this only
 * fixes the page reference, never accepts text that isn't in the policy. */
export function locateQuote(
  quote: string,
  statedPageId: string,
  pages: Array<{ id: string; text_norm: string }>
): { page_id: string; ok: boolean; score: number } {
  const stated = pages.find((p) => p.id === statedPageId);
  const first = stated ? matchQuote(quote, stated.text_norm) : { ok: false, score: 0 };
  if (first.ok) return { page_id: statedPageId, ...first };
  let best: { page_id: string; ok: boolean; score: number } | null = null;
  for (const p of pages) {
    if (p.id === statedPageId) continue;
    const m = matchQuote(quote, p.text_norm);
    if (m.ok && (!best || m.score > best.score)) best = { page_id: p.id, ...m };
  }
  return best ?? { page_id: statedPageId, ...first };
}

async function runAssess(c: CaseRow): Promise<{ state: CaseState }> {
  const db = supabaseAdmin();
  const { data: pages } = await db
    .from("pages")
    .select("id, page_no, text, text_norm")
    .in("id", c.candidate_page_ids ?? []);

  const candidatePages: CandidatePage[] = (pages ?? []).map((p) => ({
    id: p.id,
    page_no: p.page_no,
    text: p.text,
  }));
  const rejectionText = await loadRejectionText(c.id);
  const assessment = await assessCase(c.id, c.facts!, candidatePages, answersWithQuestions(c), rejectionText);

  const tempToShort = new Map<string, string>();
  assessment.ledger.forEach((l, i) => tempToShort.set(l.temp_id, `E${i + 1}`));

  const evidenceRows = assessment.ledger.map((l) => {
    const short_id = tempToShort.get(l.temp_id)!;
    const { page_id, ok, score } = locateQuote(l.quote, l.page_id, pages ?? []);
    return {
      case_id: c.id,
      short_id,
      claim: l.claim,
      page_id,
      quote: l.quote,
      match_score: score,
      verified: ok,
      source: "assess",
    };
  });

  // A re-assessment (after the user answers missing facts) replaces the
  // previous ledger. Without this, re-inserting E1.. violates the
  // unique (case_id, short_id) constraint and the case lands in ERROR.
  const { error: clearError } = await db.from("evidence").delete().eq("case_id", c.id).eq("source", "assess");
  if (clearError) throw clearError;

  if (evidenceRows.length) {
    const { error } = await db.from("evidence").insert(evidenceRows);
    if (error) throw error;
  }

  const rubric: Check[] = assessment.checks.map((check) => ({
    ...check,
    evidence_refs: check.evidence_refs.map((ref) => tempToShort.get(ref) ?? ref),
  }));

  const verifiedCount = evidenceRows.filter((e) => e.verified).length;

  const c5 = rubric.find((r) => r.id === "C5_FACTS_KNOWN");
  const answers = c.answers ?? {};
  const unresolvedMissing = (assessment.missing_facts ?? []).filter((mf) => !(mf.key in answers));
  // The question is only worth the user's time if the answer could change
  // the outcome: decide the provisional verdict first (audit F-005).
  const needsUser = needsUserInput(decideVerdict(rubric), c5?.answer, unresolvedMissing.length > 0);

  const nextState: CaseState = needsUser ? "AWAITING_USER" : "DECIDE";

  await updateCase(c.id, {
    state: nextState,
    rubric,
    missing_facts: assessment.missing_facts,
  });

  const yes = rubric.filter((r) => r.answer === "yes").length;
  const no = rubric.filter((r) => r.answer === "no").length;
  const unknown = rubric.filter((r) => r.answer === "unknown").length;
  await logEvent({
    caseId: c.id,
    step: "ASSESS",
    summary: `Rubric: ${yes} yes, ${no} no, ${unknown} unknown. Evidence: ${verifiedCount}/${evidenceRows.length} verified.`,
  });

  return { state: nextState };
}

/**
 * Whether the case should pause for AWAITING_USER rather than proceed to
 * DECIDE. Only when there are unanswered missing-fact questions AND an answer
 * could still change the outcome:
 *  - provisional verdict ARGUABLE: always ask (the design's rule);
 *  - provisional verdict WEAK and C5 != yes: ask, because a wrong "don't
 *    appeal" costs the user a valid claim, while asking costs one question;
 *  - provisional verdict STRONG: never ask -- the appeal goes ahead anyway.
 */
export function needsUserInput(
  provisionalVerdict: Verdict,
  c5Answer: Check["answer"] | undefined,
  hasUnresolvedMissingFacts: boolean
): boolean {
  if (!hasUnresolvedMissingFacts) return false;
  if (provisionalVerdict === "ARGUABLE") return true;
  if (provisionalVerdict === "WEAK") return c5Answer !== "yes";
  return false;
}

export function decideVerdict(rubric: Check[]): Verdict {
  const get = (id: Check["id"]) => rubric.find((r) => r.id === id);
  const c1 = get("C1_CLAUSE_EXISTS");
  const c2 = get("C2_CONDITIONS_HOLD");
  const c3 = get("C3_OVERRIDING_CLAUSE");
  const c4 = get("C4_EXPLICIT_EXCLUSION");

  // The cited clause genuinely exists, its conditions hold, and nothing overrides it
  // -- the rejection is correctly applied -- or some other clause explicitly excludes it.
  if ((c1?.answer === "yes" && c2?.answer === "yes" && c3?.answer === "no") || c4?.answer === "yes") {
    return "WEAK";
  }
  if (c1?.answer === "no" || c2?.answer === "no" || c3?.answer === "yes") return "STRONG";
  return "ARGUABLE";
}

/** The user's answers, each prefixed with the question it answers, so the model reads "Was it an accident? — Yes", not a bare key. */
export function answersWithQuestions(c: Pick<CaseRow, "answers" | "missing_facts">): Record<string, string> {
  const questions = new Map((c.missing_facts ?? []).map((mf) => [mf.key, mf.question]));
  return Object.fromEntries(
    Object.entries(c.answers ?? {}).map(([key, value]) => [key, questions.has(key) ? `${questions.get(key)} — ${value}` : value])
  );
}

/**
 * Before a case can end as DONT_APPEAL: if the clause text behind the WEAK
 * verdict contains an exception marker and nothing explicitly establishes
 * whether the exception applies, returns the one question to ask instead.
 * Returns null when the case can proceed (no exception clause, or every
 * relevant exception is established by a verifiable quote from the letter or
 * the user's answers). See lib/agent/exceptions.ts.
 */
async function findUnresolvedExceptionQuestion(c: CaseRow): Promise<string | null> {
  const db = supabaseAdmin();
  const rubric = c.rubric ?? [];
  const answerOf = (id: Check["id"]) => rubric.find((r) => r.id === id);
  // The checks that drove the WEAK verdict: C4 if an explicit exclusion applies, else the cited clause (C1-C3).
  const drivers = answerOf("C4_EXPLICIT_EXCLUSION")?.answer === "yes"
    ? [answerOf("C4_EXPLICIT_EXCLUSION")!]
    : (["C1_CLAUSE_EXISTS", "C2_CONDITIONS_HOLD", "C3_OVERRIDING_CLAUSE"] as const).map(answerOf).filter((x): x is Check => !!x);
  const refs = new Set(drivers.flatMap((d) => d.evidence_refs));

  const { evidence } = await loadEvidenceAndPages(c.id);
  const verified = evidence.filter((e) => e.verified);
  const behind = verified.filter((e) => refs.has(e.short_id));
  const evidenceBehind = behind.length ? behind : verified; // no refs recorded: be conservative, look at all

  const pageIds = [...new Set(evidenceBehind.map((e) => e.page_id))];
  if (!pageIds.length) return null;
  const { data: pages } = await db.from("pages").select("id, document_id, page_no, text").in("id", pageIds);
  const clauseTexts = new Set<string>();
  for (const e of evidenceBehind) {
    const page = (pages ?? []).find((p) => p.id === e.page_id);
    if (!page) continue;
    const { data: next } = await db
      .from("pages")
      .select("text")
      .eq("document_id", page.document_id)
      .eq("page_no", page.page_no + 1)
      .maybeSingle();
    const text = clauseTextFor(page.text as string, e.quote, (next?.text as string | undefined) ?? undefined);
    if (findExceptionMarkers(text).length) clauseTexts.add(text);
  }
  if (!clauseTexts.size) return null; // no exception clause: straight to the verdict, no extra question

  const letter = await loadRejectionText(c.id);
  const answers = answersWithQuestions(c);
  const review = await exceptionReview(c.id, [...clauseTexts], letter, answers, c.facts!);
  const unresolved = firstUnresolvedException(review.exceptions, [letter, ...Object.values(c.answers ?? {})]);
  if (!unresolved) return null;
  return review.question?.trim() || `Does this apply to your claim: ${unresolved.condition}?`;
}

async function runDecide(c: CaseRow): Promise<{ state: CaseState }> {
  let verdict = decideVerdict(c.rubric ?? []);
  if (verdict === "WEAK") {
    const answered = c.answers?.[EXCEPTION_ANSWER_KEY];
    if (isNotSure(answered)) {
      verdict = "ARGUABLE"; // the user can't rule the exception out: never tell them not to appeal
    } else if (answered === undefined) {
      const question = await findUnresolvedExceptionQuestion(c);
      if (question) {
        await updateCase(c.id, {
          state: "AWAITING_USER",
          verdict: null,
          missing_facts: [{ key: EXCEPTION_ANSWER_KEY, question, options: [...EXCEPTION_OPTIONS] }],
        });
        await logEvent({ caseId: c.id, step: "DECIDE", summary: `Exception clause found — asking instead of assuming: ${question}` });
        return { state: "AWAITING_USER" };
      }
    }
  }
  const nextState: CaseState = verdict === "WEAK" ? "DONT_APPEAL" : "ROUTE";
  await updateCase(c.id, { state: nextState, verdict });
  await logEvent({ caseId: c.id, step: "DECIDE", summary: `Verdict: ${verdict}` });
  return { state: nextState };
}

async function runDontAppeal(c: CaseRow): Promise<{ state: CaseState }> {
  const reason = await dontAppealExplanation(c.id, c.rubric ?? []);
  await updateCase(c.id, { dont_appeal_reason: reason });
  await logEvent({ caseId: c.id, step: "DONT_APPEAL", summary: "Explained why appealing is not advisable." });
  return { state: "DONT_APPEAL" };
}

async function runRoute(c: CaseRow): Promise<{ state: CaseState }> {
  const { deadlines, ...route } = await chooseRouteTool(c.id, c.facts!);
  await updateCase(c.id, { state: "DRAFT", route, deadlines });
  await logEvent({ caseId: c.id, step: "ROUTE", summary: `Route: ${route.step} — ${route.reason}` });
  return { state: "DRAFT" };
}

async function loadEvidenceAndPages(caseId: string) {
  const db = supabaseAdmin();
  const { data: evidence } = await db.from("evidence").select("*").eq("case_id", caseId);
  const pageIds = [...new Set((evidence ?? []).map((e) => e.page_id))];
  const { data: pages } = await db
    .from("pages")
    .select("id, page_no, text_norm")
    .in("id", pageIds.length ? pageIds : ["00000000-0000-0000-0000-000000000000"]);
  return { evidence: evidence ?? [], pages: pages ?? [] };
}

async function runDraft(c: CaseRow): Promise<{ state: CaseState }> {
  const db = supabaseAdmin();
  const { evidence, pages } = await loadEvidenceAndPages(c.id);
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const verifiedEvidence = evidence.filter((e) => e.verified);

  // Every policy claim in the letter must carry a verified citation. With no
  // verified evidence at all, any letter would either cite nothing (passing
  // verification vacuously) or assert policy content uncited, so stop here.
  if (verifiedEvidence.length === 0) {
    const message =
      "No policy text could be verified for this case, so no appeal letter was drafted. Check that the right policy document was uploaded.";
    await setError(c.id, message);
    return { state: "ERROR" };
  }

  const evidenceForDraft: EvidenceForDraft[] = verifiedEvidence.map((e) => ({
    short_id: e.short_id,
    claim: e.claim,
    quote: e.quote,
    page_no: pageById.get(e.page_id)?.page_no ?? 0,
  }));

  const { data: latestDraft } = await db
    .from("drafts")
    .select("*")
    .eq("case_id", c.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const rebuttal = latestDraft?.redteam ?? null;

  const output = await draftAppeal(c.id, c.facts!, c.route!, evidenceForDraft, c.answers ?? {}, rebuttal);

  const version = (latestDraft?.version ?? 0) + 1;
  const { error } = await db.from("drafts").insert({
    case_id: c.id,
    version,
    route_step: c.route!.step,
    body_md: `# ${output.subject}\n\n${output.body_md}`,
  });
  if (error) throw error;

  await updateCase(c.id, { state: "VERIFY" });
  await logEvent({ caseId: c.id, step: "DRAFT", summary: `Drafted appeal letter v${version} (${evidenceForDraft.length} citable facts).` });
  return { state: "VERIFY" };
}

async function runVerify(c: CaseRow): Promise<{ state: CaseState }> {
  const db = supabaseAdmin();
  const { data: draft } = await db
    .from("drafts")
    .select("*")
    .eq("case_id", c.id)
    .order("version", { ascending: false })
    .limit(1)
    .single();

  const { evidence, pages } = await loadEvidenceAndPages(c.id);
  const evidenceById = Object.fromEntries(evidence.map((e) => [e.short_id, e]));
  const pagesById = Object.fromEntries(pages.map((p) => [p.id, p]));

  const results = verifyCitationsTool(draft!.body_md, evidenceById, pagesById);
  const allOk = results.every((r) => r.ok);
  const failedIds = results.filter((r) => !r.ok).map((r) => r.short_id);

  if (allOk) {
    await db
      .from("drafts")
      .update({ verification: results, verified_at: new Date().toISOString() })
      .eq("id", draft!.id);
    const nextState: CaseState = c.redteam_done ? "AWAITING_APPROVAL" : "REDTEAM";
    await updateCase(c.id, { state: nextState });
    await logEvent({
      caseId: c.id,
      step: "VERIFY",
      summary: `Verifier: ${results.length}/${results.length} checks passed.`,
    });
    return { state: nextState };
  }

  if (c.redraft_count < MAX_REDRAFTS) {
    await db.from("drafts").update({ verification: results }).eq("id", draft!.id);
    await updateCase(c.id, { state: "DRAFT", redraft_count: c.redraft_count + 1 });
    await logEvent({
      caseId: c.id,
      step: "VERIFY",
      summary: `Verifier: ${results.length - failedIds.length}/${results.length} checks passed; redrafting.`,
    });
    return { state: "DRAFT" };
  }

  // Redraft budget spent: remove everything verification could not vouch
  // for -- sentences citing a failed id, and sentences with an unparsed
  // citation format or an uncited policy claim (short_id "UNCITED").
  const cleaned = stripUnverified(draft!.body_md, results);
  // If nothing verifiable survives, there is no letter to approve: an empty
  // or uncited "appeal" must not reach AWAITING_APPROVAL.
  if (extractCites(cleaned).length === 0) {
    await db.from("drafts").update({ verification: results.map((r) => (r.ok ? r : { ...r, stripped: true })) }).eq("id", draft!.id);
    const message =
      "Could not produce an appeal letter whose policy statements could all be verified against the policy text, even after redrafting.";
    await setError(c.id, message);
    return { state: "ERROR" };
  }
  // Stripped citations stay recorded as failed (not silently flipped to ok),
  // so "citations verified" counts reflect what the model actually produced.
  const cleanedResults = results.map((r) => (r.ok ? r : { ...r, stripped: true }));
  await db
    .from("drafts")
    .update({ body_md: cleaned, verification: cleanedResults, verified_at: new Date().toISOString() })
    .eq("id", draft!.id);
  const nextState: CaseState = c.redteam_done ? "AWAITING_APPROVAL" : "REDTEAM";
  await updateCase(c.id, { state: nextState });
  await logEvent({
    caseId: c.id,
    step: "VERIFY",
    summary: `Verifier: stripped ${failedIds.length} unverifiable sentence(s) after ${MAX_REDRAFTS} redrafts.`,
  });
  return { state: nextState };
}

async function runRedteam(c: CaseRow): Promise<{ state: CaseState }> {
  const db = supabaseAdmin();
  const { data: draft } = await db
    .from("drafts")
    .select("*")
    .eq("case_id", c.id)
    .order("version", { ascending: false })
    .limit(1)
    .single();

  const { evidence, pages } = await loadEvidenceAndPages(c.id);
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const evidenceList = evidence
    .filter((e) => e.verified)
    .map((e) => `${e.short_id} — ${e.claim} — "${e.quote}"`)
    .join("\n");

  const { data: candidatePagesRaw } = await db
    .from("pages")
    .select("id, page_no, text")
    .in("id", c.candidate_page_ids ?? []);
  const candidatePages = (candidatePagesRaw ?? []).map((p) => ({ id: p.id, page_no: p.page_no, text: p.text }));

  const redteam = await redteamReview(c.id, draft!.body_md, evidenceList, candidatePages);

  const filteredSupporting = redteam.supporting.filter((s) => {
    const page = pageById.get(s.page_id);
    if (!page) return false;
    return matchQuote(s.quote, page.text_norm).ok;
  });
  const cleanedRedteam = { ...redteam, supporting: filteredSupporting };

  await db.from("drafts").update({ redteam: cleanedRedteam }).eq("id", draft!.id);
  await updateCase(c.id, { redteam_done: true });

  const needsRedraft = redteam.severity === "medium" || redteam.severity === "high";
  const nextState: CaseState = needsRedraft ? "DRAFT" : "AWAITING_APPROVAL";
  await updateCase(c.id, { state: nextState });
  await logEvent({
    caseId: c.id,
    step: "REDTEAM",
    summary: `Red-team severity: ${redteam.severity}.${needsRedraft ? " Redrafting to address it." : ""}`,
  });
  return { state: nextState };
}

export class InvalidStateError extends Error {
  constructor(public state: CaseState, public expected: CaseState = "AWAITING_USER") {
    super(`Case is in state ${state}, not ${expected}.`);
  }
}

/**
 * POST /answer handler support: records answers and resumes at ASSESS.
 * Only valid while the case is AWAITING_USER. The transition is a
 * conditional update, so a terminal case (APPROVED, DONT_APPEAL, ERROR) or a
 * case that hasn't been assessed yet can never be pushed back into ASSESS.
 */
export async function recordAnswers(caseId: string, answers: Record<string, string>) {
  const c = await getCase(caseId);
  if (c.state !== "AWAITING_USER") throw new InvalidStateError(c.state);
  const merged = { ...(c.answers ?? {}), ...answers };
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("cases")
    .update({ state: "ASSESS", answers: merged, updated_at: new Date().toISOString() })
    .eq("id", caseId)
    .eq("state", "AWAITING_USER")
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new InvalidStateError((await getCase(caseId)).state);
  await logEvent({ caseId, step: "AWAITING_USER", summary: "User answered missing-fact questions; resuming assessment." });
}

/** POST /approve handler support. */
export async function approveCase(caseId: string) {
  const c = await getCase(caseId);
  const sentOn = simNow(c.sim_offset_days);
  const db = supabaseAdmin();
  // Claim the transition atomically: of two concurrent approvals only one wins, so follow-ups are scheduled once.
  const { data: claimed, error: claimError } = await db
    .from("cases")
    .update({ state: "APPROVED", complaint_sent_on: sentOn, updated_at: new Date().toISOString() })
    .eq("id", caseId)
    .eq("state", "AWAITING_APPROVAL")
    .select("id");
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) throw new InvalidStateError((await getCase(caseId)).state, "AWAITING_APPROVAL");
  const { data: latestDraft } = await db
    .from("drafts")
    .select("id")
    .eq("case_id", caseId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestDraft) {
    await db.from("drafts").update({ approved_at: new Date().toISOString() }).eq("id", latestDraft.id);
  }
  await scheduleFollowupTool(caseId, sentOn, c.claim_amount_inr);
  await logEvent({ caseId, step: "APPROVED", summary: `Complaint approved and sent on ${sentOn}.` });
}

export { runDontAppeal };
