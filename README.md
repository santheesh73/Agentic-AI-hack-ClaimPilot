# ClaimPilot

An agent that takes a rejected Indian health insurance claim and returns:

1. An honest verdict on whether to appeal: **Strong**, **Arguable**, or **Weak**.
2. An appeal letter in which every policy claim is cited to an exact page and quote, **verified in code**.
3. The correct escalation route with real deadlines (insurer GRO → IRDAI Bima Bharosa → Insurance Ombudsman), with follow-ups over time.

Built for the Product Space Agentic AI Hackathon (Unstop).

> Draft for your review, not legal advice. ClaimPilot does not file anything on your behalf and does not OCR scanned PDFs.

## Problem

Health insurance claim rejections in India are opaque and hard to contest. Policyholders rarely know whether the insurer's cited clause is even correct, whether it's been overridden by another clause (waiting period expiry, portability credit), or what the actual escalation path and deadlines are (GRO → IRDAI Bima Bharosa → Insurance Ombudsman). Most people give up.

## Solution

ClaimPilot ingests the policy PDF and the rejection letter, retrieves the relevant policy pages, and runs a six-check rubric (does the cited clause exist? do its conditions hold? is there an overriding clause? is there an explicit exclusion? are the facts known? are the documents present?) to produce a verdict in code — not just a model's say-so. If the claim is worth appealing, it drafts a letter where every factual sentence carries a `[cite:E#]` marker, and a **code-level verifier** (Levenshtein-based fuzzy quote matching, not an LLM) checks every citation against the actual policy text before the letter is shown. A red-team pass finds the insurer's best counter-argument before you send anything.

## Architecture

```
PDF (policy + rejection)
        |
        v
  ingest/pdf.ts --(unpdf)--> pages (per-page text + normalized text)
        |
        v
  Postgres full-text search (search_pages RPC)
        |
        v
  Agent state machine (lib/agent/machine.ts)
  INTAKE -> EXTRACT -> RETRIEVE -> ASSESS -> [AWAITING_USER] -> DECIDE
     -> DONT_APPEAL (terminal)
     -> ROUTE -> DRAFT -> VERIFY -> REDTEAM -> AWAITING_APPROVAL -> APPROVED
     -> ERROR (any state, on failure)
        |
        v
  verify.ts: normalize() + matchQuote() + verifyDraft()
  (pure, unit-tested citation verifier -- the trust mechanism)
        |
        v
  deadlines.ts: pure calendar-month-aware deadline engine
```

Every model call goes through a single helper (`lib/models.ts`) that applies a 30s timeout, Zod validation with one retry, and logs tokens/ms/model to `agent_events` — which is also the live trace shown in the UI.

## Stack

Next.js 15 (App Router, TypeScript) + Tailwind + shadcn/ui, Supabase (Postgres + Storage, no vector DB), Google Gemini via the Vercel AI SDK (`generateObject` + Zod), `unpdf` for PDF text extraction, `fastest-levenshtein` for fuzzy citation matching.

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in GEMINI_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
```

Apply `supabase/migrations/0001_init.sql` to your Supabase project (via the SQL editor or the Supabase CLI), and create a private Storage bucket named `documents`.

```bash
pnpm dev      # run locally
pnpm test     # vitest: verify.ts + deadlines.ts
pnpm eval     # run the 3 synthetic cases end-to-end, prints a results table
pnpm build    # production build
```

## Evals

`evals/cases/{a,b,c}.json` cover: Case A (PED exclusion cited, but the 48-month waiting period had already run out — expected STRONG), Case B (non-disclosure claim where the rejection letter omits the diagnosis date — expected AWAITING_USER, then STRONG once answered), Case C (cosmetic surgery, an exclusion that genuinely applies — expected WEAK).

**Confirmed against the live database and live Gemini calls** (via `scripts/prove-local.mjs`, since this environment's network policy blocks `pnpm eval`'s direct connection to Supabase -- see that script's header comment):

- `search_pages` correctly surfaces the relevant clauses (Excl01 pre-existing-disease exclusion, Excl08 cosmetic-surgery exclusion) for the sample policy, ranked at the top.
- All three cases reach their expected verdict and terminal/pause state:

| Case | Verdict | State | Citations verified |
| --- | --- | --- | --- |
| A -- PED cited, waiting period already expired | STRONG | AWAITING_APPROVAL | 2/2 |
| B -- non-disclosure, diagnosis date initially unknown | STRONG (after answering) | AWAITING_APPROVAL | 1/1 |
| C -- cosmetic surgery, exclusion genuinely applies | WEAK | DONT_APPEAL | n/a (not drafted) |

Getting here required fixing three real bugs found only by running the pipeline end-to-end against a real document and a real model, not caught by code review or the unit tests alone -- see the git log for `decideVerdict`'s missing WEAK case, the `AWAITING_USER` trigger only matching "unknown" and not "no", and the citation parser rejecting a model's slightly-off-spec `[cite: E1, E2]` formatting. Reproduce with `node --env-file=.env.local scripts/prove-local.mjs` once `samples/policy.pdf` and a working `GEMINI_API_KEY`/`MODEL_FAST`/`MODEL_STRONG` are set.

## What's AI-generated vs. human-directed

See `docs/AI_DISCLOSURE.md` — including a disclosure that the sample policy document is an authored stand-in grounded in IRDAI's real standard clauses, not the originally-intended real insurer PDF.

## Known gaps before this is submission-ready

- `pnpm eval` itself (as opposed to the equivalent `scripts/prove-local.mjs` run above) has not been exercised, since this build environment cannot reach Supabase directly -- run it in an environment that can, to confirm the same results through the real DB-backed path.
- The deployed Vercel URL has not been manually verified end-to-end in a browser (same network restriction).
- No demo video yet.

## Demo video

<!-- TODO: add link once recorded -->
