# Evals

## How the cases were built

Each case in `cases/*.json` pairs a sample rejection letter (`samples/letter_*.txt`) with an expected outcome, grounded in `samples/policy.pdf`'s actual clause text — not invented wording. Currently there are 3 cases (A, B, C); the hardening plan calls for 12 across more rejection categories (pre-existing disease at various waiting-period stages, non-disclosure in both directions, cosmetic vs. reconstructive surgery, a clause the insurer misquotes entirely, a claim amount over the Ombudsman cap, a specified-disease waiting period, a prompt-injection attempt, and a deliberately messy/poorly-formatted letter) — see `docs/KNOWN_ISSUES.md` for exactly what's blocking that expansion (the real UIIC policy PDF and live Supabase access from the current build environment).

A case file:

```json
{
  "name": "case_a_ped_waiting_period_completed",
  "policy": "samples/policy.pdf",
  "letter": "samples/letter_a.txt",
  "answers": { "...": "only present if the case is expected to pause at AWAITING_USER" },
  "expected": "STRONG"
}
```

`expected` is deliberately the final verdict string (or `AWAITING_USER` if that's the terminal state reached without an `answers` block), not a full structured expectation — see the hardening plan's richer `{verdict, final_state, checks, must_cite_pages, route_step, ombudsman_eligible}` shape for what a future expansion should move to once `samples/CLAUSE_MAP.md` exists (recording which real page each clause lives on, so `must_cite_pages` can be asserted against).

## What each metric means (target shape, once the 12-case set exists)

| Metric | Definition | Why it matters |
| --- | --- | --- |
| Verdict accuracy | correct verdicts / runs | The core product claim: is the agent's "appeal or not" call right |
| Rubric check accuracy | correct check answers / (cases × 6) | Catches a verdict that's right for the wrong reason |
| Citation validity | verified citations / all citations in final drafts | Should be 100% by construction — `lib/agent/verify.ts` strips anything that doesn't verify before a draft is shown |
| Uncited policy claims | sentences asserting policy content with no cite | Should be 0 — the draft-appeal prompt and the verifier both guard against this |
| Required-page recall | pages in `must_cite_pages` actually cited / required | Whether retrieval found the clauses that actually matter, not just plausible-looking ones |
| Ask-user precision | ASK fires only on cases designed to need it | A false ASK is a worse user experience than a wrong verdict |
| Stability | same verdict across 3 runs / total cases | LLM non-determinism, quantified rather than assumed |
| Latency / cost | p50/p95 seconds and mean tokens per full run | What this would actually cost and feel like in production |

## How to reproduce

```bash
pnpm eval
```

Needs a real `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY` with `LLM_PROVIDER=anthropic`) and a reachable Supabase project with the migrations in `supabase/migrations/` applied — `evals/run.ts` creates and runs real cases against it. Results print as a table and are also written to `evals/results/<timestamp>-<provider>-<model>.json`.

**Status as of this writing:** 16 cases: `a.json`–`l.json` (development) and `m.json`–`p.json` (held out, written before the code that fixed A/H/L was first run). The latest complete run scored 16/16 (`evals/results/*.json`, summarized in the README by `pnpm eval:readme`). Two further runs were cut off by Gemini's free-tier daily quota (`evals/results/quota-exhausted/`), so stability across 3 runs is not yet measured. Earlier history: `evals/results/pre-fix/` (first run, before 4 bugs were fixed), `no-final-state/` (before final states were recorded), `v1/` (32/36, before the A/H/L fixes). All cases use the authored stand-in `samples/policy.pdf`, not the real UIIC document.

Run it with `NODE_USE_ENV_PROXY=1` if your network goes through an HTTPS proxy: Node's built-in `fetch` ignores `HTTPS_PROXY` otherwise.
