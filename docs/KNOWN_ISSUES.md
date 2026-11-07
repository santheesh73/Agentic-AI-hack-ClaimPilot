# Known Issues / Remaining Work

Tracked honestly per the hardening effort's ground rule: never claim something is done that wasn't actually run. Each item below states exactly what's blocking it and the command to run once unblocked.

## Blocked on external input

1. **Real UIIC policy PDF.** `samples/policy.pdf` is still an authored substitute (disclosed in `docs/AI_DISCLOSURE.md`), grounded in real IRDAI standard clauses but not the actual United India Insurance document. This sandbox's network policy blocks `uiic.co.in` outright. **Action:** place the real PDF at `samples/policy.pdf`, then re-run `node --env-file=.env.local scripts/prove-local.mjs` to re-verify the three existing cases still produce the expected verdicts against the real text (page numbers for Excl01/Excl08 will likely differ), and expand to the 12-case eval set (`evals/cases/*.json`) once `samples/CLAUSE_MAP.md` is built from the real document.
2. **Anthropic key.** The dual-provider code path (`LLM_PROVIDER=anthropic`) is implemented and type-checks, but has never been exercised against a real `sk-ant-...` key. **Action:** set `ANTHROPIC_API_KEY` and `LLM_PROVIDER=anthropic` in `.env.local`, then re-run the smoke test and eval suite to get real numbers for that provider.
3. **Supabase reachability from this environment.** This sandbox cannot reach `supabase.co` directly (confirmed repeatedly); all live-DB work here went through the Supabase MCP tool (`apply_migration`), which has SQL-execution parity but not full client-library parity. **Action:** run `pnpm test:db` (once written, see below) and `pnpm eval` from an environment that can reach Supabase directly — your own machine, or a differently-configured cloud environment.

## Not yet implemented (time-boxed out of this session)

4. **`pnpm test:db`** (DB integration tests: `search_pages` per-clause correctness, RLS zero-read-for-anon, cascading deletes, `tsv` population) — not written. The schema and the manual `search_pages` verification earlier in this project's history (via direct SQL) support that it works, but no automated, re-runnable test exists yet.
5. **Rate limiting / abuse guards** (30 `/step`/min, 10 new cases/hour, `MAX_TOKENS_PER_CASE`) — not implemented. `lib/env.ts` already parses `MAX_TOKENS_PER_CASE` as an optional env var in anticipation of this, but nothing reads it yet.
6. **Record/replay LLM fixtures + mocked-LLM integration tests** — not implemented. This is the single highest-value remaining item for making `pnpm test` prove the agent's behavior offline and deterministically; `scripts/prove-local.mjs` is the live, online equivalent used so far.
7. **Exhaustive 3⁶=729 verdict truth-table test** — not implemented. The existing `decideVerdict` logic is exercised only by the three real cases via `scripts/prove-local.mjs`, not by a systematic truth table against an independently-written reference.
8. **12-case eval set, run ×3, `evals/results/*.json`, `scripts/update-readme-evals.ts`** — not implemented. Only the original 3 cases (A/B/C) exist, proven once (not three times) against the synthetic policy document — see `README.md`'s eval section for those actual numbers.
9. **CI workflows** (`.github/workflows/ci.yml`, `eval.yml`) — not implemented.
10. **`gitleaks` scan over git history** — not run (tool availability unverified in this environment). The targeted check that *was* run and passed: grepped the built `.next/static` client bundle for both the Supabase service-role key and the Gemini API key after a fresh `pnpm build` — neither appears (see `docs/AUDIT.md`).
11. **`scripts/check-schema.sql`** (diff the migrations folder against the live DB) — not written. All three migrations in `supabase/migrations/` (`0001_init`, `0002_agent_events_provider`, `0003_step_lock`) were applied to the live project via the Supabase MCP tool directly as they were written, so they should match, but no automated diff confirms this.
12. **`docs/RESUME.md`, `evals/README.md`, the full README rewrite per the hardening spec's §7 structure** — not done. The README still reflects the hackathon-era structure with incremental honest updates, not the recruiter/engineer-facing rewrite with mermaid diagrams and a script-populated eval block.
13. **`engines`/`.nvmrc` pinning** — not done.

## Real bugs found and fixed this session (for context, not "remaining")

See `git log` on `hardening` for full detail: the `.update().order().limit()` PostgREST no-op bug in `approveCase`, the printable letter and simulate-route citation-stripping regexes that had drifted from the centralized fixed version, the stuck-forever `AskUserDialog` on a thrown `onSubmit`, missing Vercel file-tracing for `samples/`, a real `@ai-sdk/anthropic`/`@ai-sdk/google` dependency type conflict, and (this session) the previously-unvalidated/inconsistent API error contract across all 8 routes and the lack of any step-level concurrency guard.
