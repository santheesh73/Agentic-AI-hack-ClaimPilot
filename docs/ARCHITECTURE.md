# ClaimPilot Architecture

## Data flow

```
                      +-------------------+
 policy.pdf  -------->|  lib/ingest/pdf.ts |---+
 rejection   -------->|  (unpdf, per-page) |   |
                      +-------------------+   |
                                               v
                                   pages table (text, text_norm, tsvector)
                                               |
                                               v
                          search_pages(case, query) Postgres RPC
                                               |
                                               v
                      +----------------------------------------------+
                      |            Agent state machine                |
                      |         (lib/agent/machine.ts)                |
                      |                                                |
                      |  INTAKE -> EXTRACT -> RETRIEVE -> ASSESS       |
                      |     -> [AWAITING_USER] -> DECIDE               |
                      |     -> DONT_APPEAL (terminal, verdict WEAK*)   |
                      |     -> ROUTE -> DRAFT -> VERIFY -> REDTEAM     |
                      |     -> AWAITING_APPROVAL -> APPROVED           |
                      |     -> ERROR (any state, on failure)           |
                      +----------------------------------------------+
                                               |
                         every handler logs to agent_events (the live trace)
                                               |
                                               v
                      citation verifier (lib/agent/verify.ts, pure, tested)
                      deadline engine  (lib/agent/deadlines.ts, pure, tested)
```

*verdict WEAK is produced by `DECIDE` whenever check C4 (explicit exclusion elsewhere) is `yes`; STRONG when the cited clause doesn't exist, its conditions don't hold, or an overriding clause applies; otherwise ARGUABLE. This decision is made in plain TypeScript (`decideVerdict` in `lib/agent/machine.ts`), not by asking the model for a verdict directly — the model only answers the six underlying yes/no/unknown checks.

## Why citations are verified in code, not trusted from the model

`lib/agent/verify.ts` is the one place where the product's core trust claim lives. Every `[cite:E#]` marker in a drafted letter is checked against the literal text of the cited policy page:

1. Both quote and page text are run through `normalize()` (NFKC, ligature expansion, soft-hyphen removal, hyphenated line-break joining, curly-quote/dash ASCII-fication, lowercasing, whitespace collapse) so that formatting artifacts from PDF extraction don't cause false negatives.
2. An exact substring match scores 1.
3. Otherwise a sliding token window (±15% of the quote's length) is scored by normalized Levenshtein distance; a window at or above 0.92 similarity counts as a match.
4. Quotes under 6 words require an exact substring match — fuzzy matching on short strings is unreliable.

If verification fails, the agent redrafts (up to 2 times), then as a last resort strips the unverifiable sentences from the letter rather than ever showing an uncited or misquoted claim.

## Agent tools

| Tool | Does | Model |
| --- | --- | --- |
| `extract_rejection` | Rejection letter → structured facts | fast |
| `write_queries` (part of RETRIEVE) | Facts → 3–6 search queries | fast |
| `search_policy` | Query → ranked policy pages | none (Postgres FTS) |
| `assess_case` | Facts + candidate pages → six-check rubric + evidence ledger | strong |
| `choose_route` | Facts → escalation step + reason | code + fast |
| `draft_appeal` | Facts + verified evidence + route → letter | strong |
| `verify_citations` | Draft + evidence → per-citation pass/fail | none (code) |
| `redteam_review` | Draft + policy pages → insurer's best counter-argument | strong |
| `exception_review` | Clause text with an exception marker + letter + answers → which exceptions are established (verifiable quote) + one yes/no question; runs only when code found a marker behind a WEAK verdict | strong |
| `schedule_followup` | Route + sent date → follow-up rows | none |

PDF parsing (`lib/ingest/pdf.ts`'s `parsePdf`/`isLikelyImageOnly`) is called directly from the document-upload API routes rather than through a separate agent tool, since it has no model involvement and no case-state dependency. Regulation text is a small, fixed set baked into `lib/agent/deadlines.ts` as pure, unit-tested functions rather than queried from the `regulations` table at runtime -- that table exists for reference/display and to make the source-of-truth auditable in the database, but `deadlines.ts` intentionally stays DB-free so its date arithmetic can be unit-tested without a database (see `tests/deadlines.test.ts`).

## Model provider

Model calls go through the single helper `lib/models.ts#generate()`, used by all 8 call sites in the codebase (`rg "generate(" lib/agent/tools app/api` — see `docs/AUDIT.md` §3 for the full list). No other file imports a provider SDK directly.

The provider is configurable: `LLM_PROVIDER=anthropic|google`, defaulting to `google`. Each provider has its own default model pair (`MODEL_FAST`/`MODEL_STRONG`, overridable):

- `anthropic`: `claude-haiku-5-5` / `claude-sonnet-5-5`.
- `google`: `gemini-3.5-flash-lite` for both (see the free-tier constraint below).

`generate()` applies a 30s timeout, retries once on a schema-validation failure, and retries up to twice more with exponential backoff (500ms, 1000ms) on a 429 or 5xx HTTP status. Every attempt — success or failure — is logged to `agent_events` with `{provider, model, tokens_in, tokens_out, ms}`.

**Anthropic prompt caching** (`providerOptions.anthropic.cacheControl`) is applied only when `LLM_PROVIDER=anthropic` and the caller passes `CachedTextPart[]` with `cache: true` parts (used for the large policy-pages context in `assess_case` and `redteam_review`, reused across the assessment/drafting/red-team loop within one case). Under `google`, `CachedTextPart.cache` is a documented no-op — Gemini's context-caching API differs (explicit cache objects with their own lifecycle) and isn't wired up.

**Free-tier constraint (Google).** A free (unbilled) Gemini API key's model availability and quota shift over time and by key/project — at various points during development, `gemini-2.5-pro`, `gemini-2.5-flash` and `gemini-3.1-pro-preview` were all 404 or zero-quota for the key in use, and `gemini-3.8-flash` returned transient "high demand" errors. `gemini-3.5-flash-lite` was the model that actually worked, with a hard cap of ~20 requests/day on the free tier observed during testing. One case run through the full pipeline (extract, assess, draft, verify, red-team, plus any redraft) costs 4-7 requests. For sustained use, enable billing on the key or switch to `LLM_PROVIDER=anthropic`.

**Dependency note.** `@ai-sdk/anthropic` and `@ai-sdk/google` independently pin slightly different patch versions of `@ai-sdk/provider`/`@ai-sdk/provider-utils`, which are structurally incompatible at the TypeScript level despite matching semver ranges (an upstream inconsistency, not a bug in this codebase). `package.json`'s `pnpm.overrides` pins both to a single compatible version across the whole dependency tree; if either `@ai-sdk/*` package is upgraded, re-run `pnpm why @ai-sdk/provider` to confirm the tree is still uniform before trusting a build.

## Security model

All Supabase access happens server-side with the service role key; no client ever sees it. Each browser is assigned a random owner id in an httpOnly cookie (`cp_owner`); every query filters on `owner_id`, and RLS is enabled on every table with no client-facing policies (the anon key can read nothing). A request for a case id that exists but belongs to a different owner returns 404, not 403 or any other status that would confirm the id is real.

## Input validation and error contract

Every route validates its input with Zod (`lib/validation.ts`) and returns a consistent `{error:{code,message}}` shape (`ApiError`/`errorResponse`), never a bare string. Concrete limits enforced: claim amount positive and ≤10 crore, pasted letter text ≤20,000 characters, uploaded file ≤15MB and ≤200 pages, PDF sniffed by magic bytes (not just extension/MIME) with 415 for a non-PDF file and 422 for an image-only (scanned) one.

## Concurrency: the step lock

`POST /api/cases/[id]/step` claims a 60-second lease (`cases.step_lock_until`) via an atomic `UPDATE ... WHERE step_lock_until IS NULL OR step_lock_until < now()` before running a state transition, and releases it in a `finally` block. A concurrent call while a lease is held returns 409 with the case's current state, so a double-click or two open tabs can never run the same transition twice. See `lib/agent/machine.ts`'s `claimStepLock`/`releaseStepLock`/`StepLockedError`.

## Boot-time configuration

`lib/env.ts` validates every environment variable with Zod at first use (not eagerly at module load, to avoid breaking `next build` in an environment without secrets configured), throwing one readable error listing every problem rather than failing on whichever var happens to be read first. `GET /api/health` surfaces `{ok, provider, db, storage, version}` without ever echoing which specific vars are missing.

## Testing approach (see also `docs/KNOWN_ISSUES.md` and the README's Testing Strategy section)

The two genuine I/O boundaries — the LLM (`lib/models.ts#generate`) and the database (`lib/db.ts#supabaseAdmin`) — are the only things mocked in the integration and route-handler tests. `tests/helpers/fakeSupabase.ts` is an in-memory stand-in for the subset of the Supabase client this codebase actually uses (not a full PostgREST reimplementation — in particular its `search_pages` RPC stand-in does simple keyword-overlap scoring, not real `ts_rank_cd` full-text ranking, which is covered separately by the live-DB verification recorded in `docs/AUDIT.md`). Everything else in the pipeline — the real state machine, the real citation verifier, the real deadline engine, the real Zod validation — runs unmocked against that fake, which is what lets `pnpm test` prove the agent's actual behavior offline and deterministically instead of only asserting against mocks of the logic under test.
