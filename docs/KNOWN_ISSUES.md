# Known Issues / Remaining Work

Tracked honestly per the hardening effort's ground rule: never claim something is done that wasn't actually run. Each item below states exactly what's blocking it and the command to run once unblocked.

## Blocked on external input

1. **Real UIIC policy PDF.** `samples/policy.pdf` is still an authored substitute (disclosed in `docs/AI_DISCLOSURE.md`), grounded in real IRDAI standard clauses but not the actual United India Insurance document. With a dedicated environment allowing `www.uiic.co.in`, the request now reaches the site, but UIIC's own bot protection (F5 Volterra) answers 403 to this datacenter IP, and getting around a bot check isn't something to do from here. **Action:** download `https://www.uiic.co.in/web/sites/default/files/Policy-Document/20230913_Policy_Wordings_IHIP.pdf` in a browser, save it as `samples/policy.pdf`, build `samples/CLAUSE_MAP.md` from it, retarget the 12 letters' clause references, then re-run `pnpm eval` ×3 and `pnpm eval:readme`.
2. **Anthropic key.** The dual-provider code path (`LLM_PROVIDER=anthropic`) is implemented and type-checks, but has never been exercised against a real `sk-ant-...` key. **Action:** set `ANTHROPIC_API_KEY` and `LLM_PROVIDER=anthropic` in `.env.local`, then re-run the smoke test and eval suite to get real numbers for that provider.
3. ~~**Supabase reachability from this environment.**~~ — **resolved.** A dedicated personal cloud environment (`Agentic-AI-hack-ClaimPilot`) now allows the Supabase project host, so `pnpm eval` runs directly against the live DB (with `NODE_USE_ENV_PROXY=1`).

## Done since this doc was first written (Phase 3)

~~4. `pnpm test:db`~~, ~~6. Record/replay LLM fixtures + mocked-LLM integration tests~~, ~~7. Exhaustive verdict truth-table test~~ are resolved differently than originally planned:

- Rather than a separate `pnpm test:db` requiring a live Supabase connection this sandbox can't make, the DB layer is exercised via `tests/helpers/fakeSupabase.ts`, an in-memory stand-in for the subset of the Supabase client this codebase uses, combined with a mocked `generate()` (`tests/machine.integration.test.ts`, `tests/routes.*.test.ts`). This runs the real `lib/agent/machine.ts` state machine (INTAKE→AWAITING_APPROVAL) and all 9 API routes offline and deterministically, which is what "record/replay fixtures" was meant to achieve — real literal LLM-response fixtures were not recorded, since no "record" pass against a live key was run.
- `decideVerdict` is tested against all 81 combinations of C1-C4 (the only checks it branches on) and `needsUserInput` against all 6 combinations of C5 × missing-facts-presence (`tests/decision.test.ts`), against an independently-written reference — not a literal 3⁶=729 loop, since C5/C6 don't participate in `decideVerdict` and C1-C4 don't participate in the ask-gate; see that file's comments for the reasoning.
- Property-based tests (`fast-check`) for `matchQuote` run against the real `samples/policy.pdf`, not canned fixtures (`tests/verify.property.test.ts`).

Coverage (`npx vitest run --coverage`, scoped to `lib/agent/**`, `lib/ingest/**`, `app/api/**`): **86.57% statements / 90.22% lines** (310 tests; was 85.03%/89.29% at 220 tests, 82.07%/86.64% at 187), up from 15.14%/15.48% at the start of Phase 3 — both statement and line coverage now meet the 85% target. Branch coverage (67.31%) is the laggard; most of the gap is defensive `?? []`/`?.` fallbacks and the retry/backoff branches in `lib/models.ts` that are hard to hit without either a live flaky API or more elaborate fault-injection in the fake client.

A genuine, previously-undiscovered production bug was caught by this work: `lib/ingest/pdf.ts`'s `parsePdf()` crashed on a real Node `Buffer` (not just in tests — this hit `app/api/cases/sample/route.ts` and would have hit `pnpm eval` too), because `Buffer instanceof Uint8Array` is `true` even though `unpdf` explicitly rejects a real `Buffer`. Fixed; see git log.

## Done since this doc was last updated (Phase 5)

9. **CI workflows** — `.github/workflows/ci.yml` (every push/PR: typecheck via `next typegen && tsc --noEmit`, lint, `pnpm test:coverage` — fully offline, no secrets needed — build, coverage artifact upload) and `.github/workflows/eval.yml` (`workflow_dispatch` only, takes a provider input, needs repo secrets, never runs automatically). Both validated for YAML syntax (`python3 -c "import yaml; yaml.safe_load(...)"`); **not validated by an actual GitHub Actions run**, since that would require pushing to a repo with Actions enabled, which wasn't done from this sandbox.
5. **Rate limiting / abuse guards** — done. `lib/rateLimit.ts` enforces 30 `/step` calls per minute per owner and 10 new cases per hour per owner (both `POST /api/cases` and `POST /api/cases/sample`), via the atomic `bump_rate_limit` upsert-and-compare function in `supabase/migrations/0004_rate_limits.sql`. Over the limit returns 429 `{error:{code:"rate_limited"}}` before any work is done. `MAX_TOKENS_PER_CASE` (optional) caps total tokens summed from `agent_events`; once reached, the next `/step` sets ERROR with a clear message. Migration 0004 was applied to the live project and `bump_rate_limit` checked there directly (limit 2 → true, true, false; test rows deleted). Offline tests: `tests/rateLimit.test.ts`. Windows are fixed (not sliding), so a burst across a window boundary can briefly reach 2× the limit; old `rate_limits` rows are not pruned automatically.
10. **Secret scan over git history** — done with a regex scan, not gitleaks. Downloading the gitleaks binary from GitHub releases was refused in this sandbox. Instead, `git log --all -p` (all 35 commits) was searched for Google API keys (`AIza…`), Anthropic keys (`sk-ant-…`), JWTs (`eyJhbGciOi…`, the format of the Supabase service-role key), `sb_secret_…`, GitHub PATs and PEM private-key headers: **no matches**. The client bundle was also checked: both real secrets are absent from `.next/static` (see `docs/AUDIT.md`). gitleaks itself is still worth running once outside this sandbox (`gitleaks git .`).
11. **`scripts/check-schema.sql`** — done. A read-only query that checks the live DB against everything migrations 0001-0004 create (every column and type, RLS on every table, `search_pages`/`bump_rate_limit`, the three indexes, 5 `regulations` rows); it returns one row per problem. Run against the live project, it returned **no rows** (schema matches). A negative control with a deliberately wrong expected type and a non-existent column returned both, so the check really does detect drift.
14. **`scripts/update-readme-evals.ts`** (`pnpm eval:readme`) — done. Rewrites the README's `EVAL:START/END` block from `evals/results/*.json`: verdict accuracy over every case-run, mean verified-citation % over drafted runs, and per-case results for each run, with median ms and mean tokens. With no result files it exits 1 and leaves the README unchanged (verified). The summary logic is unit-tested (`tests/updateReadmeEvals.test.ts`). It generated the README Results block from the three real runs in item 8.
13. **`engines`/`.nvmrc`** — `package.json` now has `"engines": {"node": ">=22.0.0"}` and `.nvmrc` pins `22`, matching the Node version this whole project was actually built and tested against.

Deployment-readiness checklist, each verified by an actual command, not assumed:

- Clean `pnpm build` from a fresh `.next/` — ✅ (`rm -rf .next && pnpm build`).
- `outputFileTracingIncludes` covers `samples/**` — ✅ (`next.config.ts`, and confirmed present in `route.js.nft.json` in an earlier session).
- `maxDuration` set on every route that calls a model — ✅ (`grep -rl maxDuration app/api/` lists all 9 route files).
- Env validation passes with only the `.env.example` variables filled in as instructed, and fails readably if left blank — ✅, now a real test (`tests/env.test.ts`), not just reasoning about it: two new cases simulate "copied `.env.example`, filled in the required ones" (passes) and "copied `.env.example`, left it all blank" (fails, naming `NEXT_PUBLIC_SUPABASE_URL` in the error).
- `/api/health` works — ✅, tested with a mocked `getEnv`/DB (`tests/routes.misc.test.ts`); not hit over a real deployed URL (no deploy from this sandbox).
- No secrets committed — ✅ (`git ls-files | grep '^\.env'` lists only `.env.example`).
- Migrations folder complete — ✅, 4 files (`0001_init`, `0002_agent_events_provider`, `0003_step_lock`, `0004_rate_limits`), all applied to the live project.
- Node version pinned — ✅ (`engines` + `.nvmrc`, above).

## Previously open, now done (Phase 4 and 6)

8. **Eval set** — done, with one gap. **16 cases**: 12 for development (A–L) and 4 held out (M–P), run with `pnpm eval` against live Gemini and Supabase.
   - **v1 runs** (`evals/results/v1/`, 3 runs, 12 cases): 32/36 correct. They failed on A (a verbatim quote labelled with the wrong page, so no letter), H (the system never asked about prior cover, so portability couldn't apply) and L (retrieval missed the cited clause; an override was applied without checking its own conditions).
   - **Fixes, all at the root cause:** `locateQuote()` re-attributes a quote only when it matches another retrieved page; `clauseRefs()` always retrieves pages containing the cited clause id; the rubric now has general rules on override conditions and on asking about prior cover. Each code fix has a regression test.
   - **Latest complete run:** 16/16, including all held-out cases.
   - **Gap:** runs 2 and 3 hit Gemini's free-tier quota (500 requests/day). Run 2 got 9/9 correct before that; run 3 got no responses. Both are kept in `evals/results/quota-exhausted/`, and stability across 3 runs is **not yet measured**. **Action:** after the quota resets (or with a paid key), run `NODE_USE_ENV_PROXY=1 pnpm eval` 3 times, then `pnpm eval:readme`.
   The first live run also found 4 real bugs, all fixed with regression tests: (a) re-assessment after the user answered a question re-inserted evidence ids and violated the `evidence` unique key, so **every case that asked the user a question ended in ERROR**; (b) PostgREST errors were stored as `"[object Object]"`; (c) a case with no verified evidence drafted a letter citing nothing, which passed verification vacuously; (d) citations stripped after max redrafts were recorded as `ok: true`. Plus `pnpm eval` crashed on `server-only` outside Next.js, and the rubric's C4 definition was ambiguous.
12. ~~`docs/RESUME.md`, `evals/README.md`, the full README rewrite~~ — **done (Phase 6)**, with two honest gaps: (a) ~~the README eval block was hand-written~~, now generated by `pnpm eval:readme` (item 8); (b) no demo GIF/video/screenshots, since this environment can't reach a running deployment. Both mermaid diagrams were render-validated with `@mermaid-js/mermaid-cli` against the pre-installed Chromium (no syntax errors, all expected node labels present in the output SVG). `docs/RESUME.md` deliberately omits an accuracy-percentage bullet, since no real verdict-accuracy number exists yet.

## Real bugs found and fixed this session (for context, not "remaining")

See `git log` on `hardening` for full detail: the `.update().order().limit()` PostgREST no-op bug in `approveCase`, the printable letter and simulate-route citation-stripping regexes that had drifted from the centralized fixed version, the stuck-forever `AskUserDialog` on a thrown `onSubmit`, missing Vercel file-tracing for `samples/`, a real `@ai-sdk/anthropic`/`@ai-sdk/google` dependency type conflict, the previously-unvalidated/inconsistent API error contract across all 8 routes, the lack of any step-level concurrency guard, and (Phase 3) `parsePdf()` crashing on a real Node `Buffer`.

## Independent audit (audit/AUDIT_REPORT.md on branch `claude/trusting-feynman-m7ekcj`)

**Fixed (all Critical and High findings), each with regression tests:**
- F-001 quote verifier accepted meaning-inverted quotes → numbers and polarity words must now match exactly.
- F-002 uncited/unparsed policy claims passed verification → fail-closed parser plus an uncited-policy-claim check (a keyword heuristic, documented as such in the README); simulate escalation drafts use the same check.
- F-003 Ombudsman last date ignored the insurer's reply → labelled as the no-reply deadline; `ombudsmanLastDate()` handles a known reply date.
- F-004 stripping kept the failed claim and deleted the next sentence → markers attach to the preceding sentence; structure preserved.
- F-005 ask-user gate ignored the verdict → asks only when the answer can change the outcome.
- F-006 `/answer` revived terminal cases → 409 unless AWAITING_USER, atomic transition.
- F-007 cookie-only rate limits → per-IP limits, limits on uploads/answers/simulate, global daily LLM budget, default per-case token cap.
- F-008 contradictory Ombudsman labels above ₹50 lakh → only "not available" is shown.
- F-009 README claims corrected.

**Still open (Medium/Low):** see the report's batches B and C — notably layered SDK retries (F-010), lease expiry (F-011), approve/simulate races (F-012), injection scanning of policy pages (F-013), security headers (F-014), IST dates (F-015), verifier performance on long pages (F-016), Indic-script PDFs (F-017), accessibility and mobile layout (F-022, F-023).

**Not re-measured:** the eval results in the README predate these fixes; re-run `pnpm eval` ×3.
