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
import { matchQuote } from "./verify";
import { looksLikePromptInjection } from "./prompts";
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
  missing_facts: Array<{ key: string; question: string }> | null;
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

/** Runs exactly one state transition for the case and persists the result. */
export async function runStep(caseId: string): Promise<{ state: CaseState; error?: string }> {
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
    const message = err instanceof Error ? err.message : String(err);
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

async function runExtract(c: CaseRow): Promise<{ state: CaseState }> {
  const db = supabaseAdmin();
  const { data: rejectionDoc } = await db
    .from("documents")
    .select("id")
    .eq("case_id", c.id)
    .eq("kind", "rejection")
    .limit(1)
    .single();

  const { data: pages } = await db
    .from("pages")
    .select("text")
    .eq("document_id", rejectionDoc!.id)
    .order("page_no");

  const rejectionText = (pages ?? []).map((p) => p.text).join("\n\n");

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
  const pageById = new Map((pages ?? []).map((p) => [p.id, p]));

  const assessment = await assessCase(c.id, c.facts!, candidatePages, c.answers ?? {});

  const tempToShort = new Map<string, string>();
  assessment.ledger.forEach((l, i) => tempToShort.set(l.temp_id, `E${i + 1}`));

  const evidenceRows = assessment.ledger.map((l) => {
    const short_id = tempToShort.get(l.temp_id)!;
    const page = pageById.get(l.page_id);
    const { ok, score } = page ? matchQuote(l.quote, page.text_norm) : { ok: false, score: 0 };
    return {
      case_id: c.id,
      short_id,
      claim: l.claim,
      page_id: l.page_id,
      quote: l.quote,
      match_score: score,
      verified: ok,
      source: "assess",
    };
  });

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
  const needsUser = (c5?.answer === "unknown" || c5?.answer === "no") && unresolvedMissing.length > 0;

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

async function runDecide(c: CaseRow): Promise<{ state: CaseState }> {
  const verdict = decideVerdict(c.rubric ?? []);
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

function stripFailedSentences(bodyMd: string, failedIds: string[]): string {
  if (!failedIds.length) return bodyMd;
  const sentences = bodyMd.split(/(?<=[.!?])\s+/);
  const failedPattern = new RegExp(`\\[cite:(${failedIds.join("|")})\\]`);
  return sentences.filter((s) => !failedPattern.test(s)).join(" ");
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
      summary: `Verifier: ${results.length}/${results.length} citations matched.`,
    });
    return { state: nextState };
  }

  if (c.redraft_count < MAX_REDRAFTS) {
    await db.from("drafts").update({ verification: results }).eq("id", draft!.id);
    await updateCase(c.id, { state: "DRAFT", redraft_count: c.redraft_count + 1 });
    await logEvent({
      caseId: c.id,
      step: "VERIFY",
      summary: `Verifier: ${results.length - failedIds.length}/${results.length} citations matched; redrafting.`,
    });
    return { state: "DRAFT" };
  }

  const cleaned = stripFailedSentences(draft!.body_md, failedIds);
  const cleanedResults = results.map((r) => (failedIds.includes(r.short_id) ? { ...r, ok: true, score: r.score } : r));
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

/** POST /answer handler support: records answers and resumes at ASSESS. */
export async function recordAnswers(caseId: string, answers: Record<string, string>) {
  const c = await getCase(caseId);
  const merged = { ...(c.answers ?? {}), ...answers };
  await updateCase(caseId, { state: "ASSESS", answers: merged });
  await logEvent({ caseId, step: "AWAITING_USER", summary: "User answered missing-fact questions; resuming assessment." });
}

/** POST /approve handler support. */
export async function approveCase(caseId: string) {
  const c = await getCase(caseId);
  const { simNow } = await import("./deadlines");
  const sentOn = simNow(c.sim_offset_days);
  await updateCase(caseId, { state: "APPROVED", complaint_sent_on: sentOn });
  const db = supabaseAdmin();
  await db
    .from("drafts")
    .update({ approved_at: new Date().toISOString() })
    .eq("case_id", caseId)
    .order("version", { ascending: false })
    .limit(1);
  await scheduleFollowupTool(caseId, sentOn, c.claim_amount_inr);
  await logEvent({ caseId, step: "APPROVED", summary: `Complaint approved and sent on ${sentOn}.` });
}

export { runDontAppeal };
