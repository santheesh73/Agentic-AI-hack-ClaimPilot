import fs from "node:fs";
import path from "node:path";
import { supabaseAdmin } from "../lib/db";
import { parsePdf } from "../lib/ingest/pdf";
import { normalize } from "../lib/ingest/normalize";
import { runStep } from "../lib/agent/machine";

type EvalCase = {
  name: string;
  policy: string;
  letter: string;
  answers?: Record<string, string>;
  expected: "STRONG" | "ARGUABLE" | "WEAK" | "AWAITING_USER";
};

const PAUSE_OR_TERMINAL = new Set(["AWAITING_USER", "AWAITING_APPROVAL", "DONT_APPEAL", "APPROVED", "ERROR"]);
const MAX_LOOP_STEPS = 25;

async function createCaseHeadless(evalCase: EvalCase) {
  const db = supabaseAdmin();
  const ownerId = "eval-" + evalCase.name;

  const { data: caseRow, error } = await db
    .from("cases")
    .insert({ owner_id: ownerId, title: evalCase.name, state: "INTAKE" })
    .select("id")
    .single();
  if (error) throw error;
  const caseId = caseRow.id as string;

  const policyPath = path.resolve(__dirname, "..", evalCase.policy);
  const policyBuffer = fs.readFileSync(policyPath);
  const policyPages = await parsePdf(policyBuffer);

  const { data: policyDoc } = await db
    .from("documents")
    .insert({ case_id: caseId, kind: "policy", filename: path.basename(policyPath), page_count: policyPages.length })
    .select("id")
    .single();
  await db.from("pages").insert(
    policyPages.map((p) => ({ document_id: policyDoc!.id, case_id: caseId, page_no: p.page_no, text: p.text, text_norm: p.text_norm }))
  );

  const letterPath = path.resolve(__dirname, "..", evalCase.letter);
  const letterText = fs.readFileSync(letterPath, "utf-8");
  const { data: rejectionDoc } = await db
    .from("documents")
    .insert({ case_id: caseId, kind: "rejection", filename: path.basename(letterPath), page_count: 1 })
    .select("id")
    .single();
  await db.from("pages").insert([
    { document_id: rejectionDoc!.id, case_id: caseId, page_no: 1, text: letterText, text_norm: normalize(letterText) },
  ]);

  return caseId;
}

async function runCase(evalCase: EvalCase) {
  const start = Date.now();
  const caseId = await createCaseHeadless(evalCase);
  const db = supabaseAdmin();

  let steps = 0;
  let state = "INTAKE";
  for (let i = 0; i < MAX_LOOP_STEPS; i++) {
    const result = await runStep(caseId);
    state = result.state;
    steps++;
    if (PAUSE_OR_TERMINAL.has(state)) break;
  }

  if (state === "AWAITING_USER" && evalCase.answers) {
    const { recordAnswers } = await import("../lib/agent/machine");
    const { data: pausedCase } = await db.from("cases").select("missing_facts").eq("id", caseId).single();
    const missingFacts = (pausedCase?.missing_facts ?? []) as Array<{ key: string }>;
    // The model names missing-fact keys dynamically, so apply the eval's single
    // canned answer to whichever key(s) it actually asked for.
    const fallbackAnswer = Object.values(evalCase.answers)[0];
    const answers = Object.fromEntries(missingFacts.map((mf) => [mf.key, fallbackAnswer]));
    await recordAnswers(caseId, answers);
    for (let i = 0; i < MAX_LOOP_STEPS; i++) {
      const result = await runStep(caseId);
      state = result.state;
      steps++;
      if (PAUSE_OR_TERMINAL.has(state)) break;
    }
  }

  const { data: finalCase } = await db.from("cases").select("verdict, state").eq("id", caseId).single();
  const { data: drafts } = await db.from("drafts").select("verification").eq("case_id", caseId);
  const { data: events } = await db.from("agent_events").select("tokens_in, tokens_out").eq("case_id", caseId);

  const allVerifications = (drafts ?? []).flatMap((d) => d.verification ?? []);
  const verifiedPct = allVerifications.length
    ? Math.round((100 * allVerifications.filter((v: { ok: boolean }) => v.ok).length) / allVerifications.length)
    : 0;
  const totalTokens = (events ?? []).reduce((n, e) => n + (e.tokens_in ?? 0) + (e.tokens_out ?? 0), 0);

  const got = finalCase?.state === "AWAITING_USER" ? "AWAITING_USER" : finalCase?.verdict ?? finalCase?.state;

  return {
    case: evalCase.name,
    expected: evalCase.expected,
    got,
    verifiedPct,
    steps,
    ms: Date.now() - start,
    tokens: totalTokens,
  };
}

async function main() {
  const casesDir = path.resolve(__dirname, "cases");
  const files = fs.readdirSync(casesDir).filter((f) => f.endsWith(".json"));
  const results = [];
  for (const file of files) {
    const evalCase: EvalCase = JSON.parse(fs.readFileSync(path.join(casesDir, file), "utf-8"));
    try {
      results.push(await runCase(evalCase));
    } catch (err) {
      results.push({ case: evalCase.name, expected: evalCase.expected, got: `ERROR: ${(err as Error).message}`, verifiedPct: 0, steps: 0, ms: 0, tokens: 0 });
    }
  }

  console.log("\ncase | expected | got | citations verified % | steps | total ms | tokens");
  console.log("-----|----------|-----|----------------------|-------|----------|-------");
  for (const r of results) {
    console.log(`${r.case} | ${r.expected} | ${r.got} | ${r.verifiedPct}% | ${r.steps} | ${r.ms} | ${r.tokens}`);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
