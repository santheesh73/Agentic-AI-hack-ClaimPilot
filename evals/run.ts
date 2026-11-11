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

export function infraErrorOf(message: string | null | undefined): string | undefined {
  if (!message) return undefined;
  if (/exceeded your current quota|RESOURCE_EXHAUSTED|rate.?limit|\b429\b/i.test(message)) return "quota";
  if (/\b(500|502|503|504)\b|overloaded|UNAVAILABLE|high demand|try again later|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message)) return "provider_unavailable";
  return undefined;
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

  const { data: finalCase } = await db.from("cases").select("verdict, state, error").eq("id", caseId).single();
  // Score the final draft only; earlier versions were redrafted precisely
  // because their citations failed.
  const { data: drafts } = await db
    .from("drafts")
    .select("verification")
    .eq("case_id", caseId)
    .order("version", { ascending: false })
    .limit(1);
  const { data: events } = await db.from("agent_events").select("tokens_in, tokens_out, summary").eq("case_id", caseId);

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
    // The verdict can be right while the case still ends in ERROR (e.g. no
    // quote verified, so no letter); recorded so that isn't counted as success.
    finalState: finalCase?.state ?? "UNKNOWN",
    // Whether the exception-clause safeguard paused this case to ask the user (the cost of "ask, don't assume").
    askedException: (events ?? []).some((e) => String(e.summary ?? "").startsWith("Exception clause found")),
    // Quota / rate-limit / provider outages say nothing about ClaimPilot's
    // judgment; recorded separately so they're excluded from accuracy.
    infraError: infraErrorOf(finalCase?.error),
    verifiedPct,
    steps,
    ms: Date.now() - start,
    tokens: totalTokens,
  };
}

async function main() {
  const casesDir = path.resolve(__dirname, "cases");
  let files = fs.readdirSync(casesDir).filter((f) => f.endsWith(".json"));
  // EVAL_CASES=l,m runs only cases whose file name (without .json) is listed.
  // Such a partial run is written to evals/results/partial/ so that
  // `pnpm eval:readme` (which reads evals/results/*.json) never mixes it in.
  const only = (process.env.EVAL_CASES ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (only.length) files = files.filter((f) => only.includes(f.replace(/\.json$/, "").toLowerCase()));
  if (!files.length) throw new Error(`EVAL_CASES=${process.env.EVAL_CASES} matched no case files in evals/cases/`);
  const results = [];
  for (const file of files) {
    const evalCase: EvalCase = JSON.parse(fs.readFileSync(path.join(casesDir, file), "utf-8"));
    try {
      results.push(await runCase(evalCase));
    } catch (err) {
      results.push({ case: evalCase.name, expected: evalCase.expected, got: `ERROR: ${(err as Error).message}`, finalState: "ERROR", askedException: false, infraError: infraErrorOf((err as Error).message), verifiedPct: 0, steps: 0, ms: 0, tokens: 0 });
    }
  }

  console.log("\ncase | expected | got | final state | citations verified % | steps | total ms | tokens");
  console.log("-----|----------|-----|-------------|----------------------|-------|----------|-------");
  for (const r of results) {
    console.log(`${r.case} | ${r.expected} | ${r.got} | ${r.finalState} | ${r.verifiedPct}% | ${r.steps} | ${r.ms} | ${r.tokens}`);
  }

  const resultsDir = path.resolve(__dirname, "results", only.length ? "partial" : "");
  fs.mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const provider = process.env.LLM_PROVIDER ?? "google";
  const model = process.env.MODEL_STRONG ?? "(default)";
  const outPath = path.join(resultsDir, `${timestamp}-${provider}-${model}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify({ ranAt: new Date().toISOString(), provider, model_fast: process.env.MODEL_FAST, model_strong: model, results }, null, 2)
  );
  console.log(`\nWrote ${outPath}`);
}

if (process.argv[1]?.endsWith("run.ts")) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
