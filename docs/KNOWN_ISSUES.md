# Known Issues / Remaining Work

Tracked honestly per the hardening effort's ground rule: never claim something is done that wasn't actually run. Each item below states exactly what's blocking it and the command to run once unblocked.

## Blocked on external input

1. **Real UIIC policy PDF.** `samples/policy.pdf` is still an authored substitute (disclosed in `docs/AI_DISCLOSURE.md`), grounded in real IRDAI standard clauses but not the actual United India Insurance document. This sandbox's network policy blocks `uiic.co.in` outright. **Action:** place the real PDF at `samples/policy.pdf`, then re-run `node --env-file=.env.local scripts/prove-local.mjs` to re-verify the three existing cases still produce the expected verdicts against the real text (page numbers for Excl01/Excl08 will likely differ), and expand to the 12-case eval set (`evals/cases/*.json`) once `samples/CLAUSE_MAP.md` is built from the real document.
2. **Anthropic key.** The dual-provider code path (`LLM_PROVIDER=anthropic`) is implemented and type-checks, but has never been exercised against a real `sk-ant-...` key. **Action:** set `ANTHROPIC_API_KEY` and `LLM_PROVIDER=anthropic` in `.env.local`, then re-run the smoke test and eval suite to get real numbers for that provider.
3. **Supabase reachability from this environment.** This sandbox cannot reach `supabase.co` directly (confirmed repeatedly); all live-DB work here went through the Supabase MCP tool (`apply_migration`), which has SQL-execution parity but not full client-library parity. **Action:** run `pnpm test:db` (once written, see below) and `pnpm eval` from an environment that can reach Supabase directly — your own machine, or a differently-configured cloud environment.

## Done since this doc was first written (Phase 3)

~~4. `pnpm test:db`~~, ~~6. Record/replay LLM fixtures + mocked-LLM integration tests~~, ~~7. Exhaustive verdict truth-table test~~ are resolved differently than originally planned:

- Rather than a separate `pnpm test:db` requiring a live Supabase connection this sandbox can't make, the DB layer is exercised via `tests/helpers/fakeSupabase.ts`, an in-memory stand-in for the subset of the Supabase client this codebase uses, combined with a mocked `generate()` (`tests/machine.integration.test.ts`, `tests/routes.*.test.ts`). This runs the real `lib/agent/machine.ts` state machine (INTAKE→AWAITING_APPROVAL) and all 9 API routes offline and deterministically, which is what "record/replay fixtures" was meant to achieve — real literal LLM-response fixtures were not recorded, since no "record" pass against a live key was run.
- `decideVerdict` is tested against all 81 combinations of C1-C4 (the only checks it branches on) and `needsUserInput` against all 6 combinations of C5 × missing-facts-presence (`tests/decision.test.ts`), against an independently-written reference — not a literal 3⁶=729 loop, since C5/C6 don't participate in `decideVerdict` and C1-C4 don't participate in the ask-gate; see that file's comments for the reasoning.
- Property-based tests (`fast-check`) for `matchQuote` run against the real `samples/policy.pdf`, not canned fixtures (`tests/verify.property.test.ts`).

Coverage (`npx vitest run --coverage`, scoped to `lib/agent/**`, `lib/ingest/**`, `app/api/**`): **82.07% statements / 86.64% lines**, up from 15.14%/15.48% at the start of Phase 3 — at or above the 85% target depending on which figure is read. Branch coverage (57.67%) is the laggard; most of the gap is defensive `?? []`/`?.` fallbacks and the retry/backoff branches in `lib/models.ts` that are hard to hit without either a live flaky API or more elaborate fault-injection in the fake client.

A genuine, previously-undiscovered production bug was caught by this work: `lib/ingest/pdf.ts`'s `parsePdf()` crashed on a real Node `Buffer` (not just in tests — this hit `app/api/cases/sample/route.ts` and would have hit `pnpm eval` too), because `Buffer instanceof Uint8Array` is `true` even though `unpdf` explicitly rejects a real `Buffer`. Fixed; see git log.

## Done since this doc was last updated (Phase 5)

9. **CI workflows** — `.github/workflows/ci.yml` (every push/PR: typecheck via `next typegen && tsc --noEmit`, lint, `pnpm test:coverage` — fully offline, no secrets needed — build, coverage artifact upload) and `.github/workflows/eval.yml` (`workflow_dispatch` only, takes a provider input, needs repo secrets, never runs automatically). Both validated for YAML syntax (`python3 -c "import yaml; yaml.safe_load(...)"`); **not validated by an actual GitHub Actions run**, since that would require pushing to a repo with Actions enabled, which wasn't done from this sandbox.
5. **Rate limiting / abuse guards** — done. `lib/rateLimit.ts` enforces 30 `/step` calls per minute per owner and 10 new cases per hour per owner (both `POST /api/cases` and `POST /api/cases/sample`), via the atomic `bump_rate_limit` upsert-and-compare function in `supabase/migrations/0004_rate_limits.sql`. Over the limit returns 429 `{error:{code:"rate_limited"}}` before any work is done. `MAX_TOKENS_PER_CASE` (optional) caps total tokens summed from `agent_events`; once reached, the next `/step` sets ERROR with a clear message. Migration 0004 was applied to the live project and `bump_rate_limit` checked there directly (limit 2 → true, true, false; test rows deleted). Offline tests: `tests/rateLimit.test.ts`. Windows are fixed (not sliding), so a burst across a window boundary can briefly reach 2× the limit; old `rate_limits` rows are not pruned automatically.
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

## Still not implemented (time-boxed out of this session)

8. **12-case eval set, run ×3, `evals/results/*.json`, `scripts/update-readme-evals.ts`** — not implemented. Only the original 3 cases (A/B/C) exist, proven once (not three times) against the synthetic policy document — see `README.md`'s eval section for those actual numbers. (`evals/run.ts` now writes its results to `evals/results/<timestamp>-<provider>-<model>.json` in addition to the console table, ready for whenever a real run happens — this was added for `eval.yml`'s artifact upload to have real content, not yet exercised with real data.)
10. **`gitleaks` scan over git history** — not run (tool availability unverified in this environment). The targeted check that *was* run and passed: grepped the built `.next/static` client bundle for both the Supabase service-role key and the Gemini API key after a fresh `pnpm build` — neither appears (see `docs/AUDIT.md`).
11. **`scripts/check-schema.sql`** (diff the migrations folder against the live DB) — not written. All three migrations in `supabase/migrations/` were applied to the live project via the Supabase MCP tool directly as they were written, so they should match, but no automated diff confirms this.
12. ~~`docs/RESUME.md`, `evals/README.md`, the full README rewrite~~ — **done (Phase 6)**, with two honest gaps: (a) the README's `<!-- EVAL:START/END -->` block is hand-written from the 3 verified results, not populated by `scripts/update-readme-evals.ts` (which doesn't exist until there's a real `evals/results/*.json` to read); (b) no demo GIF/video/screenshots, since this environment can't reach a running deployment. Both mermaid diagrams were render-validated with `@mermaid-js/mermaid-cli` against the pre-installed Chromium (no syntax errors, all expected node labels present in the output SVG). `docs/RESUME.md` deliberately omits an accuracy-percentage bullet, since no real verdict-accuracy number exists yet.

## Real bugs found and fixed this session (for context, not "remaining")

See `git log` on `hardening` for full detail: the `.update().order().limit()` PostgREST no-op bug in `approveCase`, the printable letter and simulate-route citation-stripping regexes that had drifted from the centralized fixed version, the stuck-forever `AskUserDialog` on a thrown `onSubmit`, missing Vercel file-tracing for `samples/`, a real `@ai-sdk/anthropic`/`@ai-sdk/google` dependency type conflict, the previously-unvalidated/inconsistent API error contract across all 8 routes, the lack of any step-level concurrency guard, and (Phase 3) `parsePdf()` crashing on a real Node `Buffer`.
