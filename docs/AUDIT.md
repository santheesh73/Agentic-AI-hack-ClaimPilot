# ClaimPilot — Audit (Phase 0)

Generated from the actual repository state on branch `hardening`, commit `651f901` (merge of the hackathon build into `main`). Every figure below came from a command listed next to it; none are estimated.

## 1. File tree (2 levels)

```
.
├── app/
│   ├── api/                  — route handlers (see §4)
│   ├── cases/[id]/           — case view + /letter printable view
│   ├── error.tsx, not-found.tsx, layout.tsx, page.tsx
├── components/
│   ├── ui/                   — shadcn primitives (manually ported; registry was network-blocked)
│   └── *.tsx                 — Trace, RubricPanel, Ledger, DraftView, Deadlines, RedTeamCard, AskUserDialog
├── docs/                     — ARCHITECTURE.md, AI_DISCLOSURE.md, this file
├── evals/                    — cases/*.json, run.ts
├── lib/
│   ├── agent/                — machine.ts, verify.ts, deadlines.ts, prompts.ts, schemas.ts, tools/
│   ├── ingest/                — pdf.ts, normalize.ts
│   └── db.ts, models.ts, ownership.ts, utils.ts
├── samples/                  — policy.pdf (synthetic, see §7 gap list), letter_a/b/c.txt
├── scripts/                  — prove-local.mjs
├── supabase/migrations/      — 0001_init.sql
└── tests/                    — verify.test.ts, deadlines.test.ts, DraftView.test.tsx
```

## 2. State machine (as implemented, `lib/agent/machine.ts`)

States: `INTAKE, EXTRACT, RETRIEVE, ASSESS, AWAITING_USER, DECIDE, DONT_APPEAL, ROUTE, DRAFT, VERIFY, REDTEAM, AWAITING_APPROVAL, APPROVED, ERROR`

Pause states: `AWAITING_USER, AWAITING_APPROVAL`. Terminal states: `DONT_APPEAL, APPROVED, ERROR`.

| From | Handler | To |
| --- | --- | --- |
| INTAKE | checks policy+rejection docs have extractable text | EXTRACT or ERROR |
| EXTRACT | `extract_rejection` (fast model) | RETRIEVE |
| RETRIEVE | `write_queries` + `search_policy` (Postgres FTS) + definitions/exclusions heuristic, capped at 14 pages | ASSESS |
| ASSESS | `assess_case` (strong model) → six-check rubric + evidence ledger, each quote verified immediately | AWAITING_USER (if C5 is "unknown"/"no" and unanswered missing facts exist) else DECIDE |
| AWAITING_USER | pause; `/answer` merges answers and returns to ASSESS | — |
| DECIDE | `decideVerdict()` in code (see §7 for the bug found and fixed here) | DONT_APPEAL (WEAK) or ROUTE |
| DONT_APPEAL | fast model writes plain-language explanation | terminal |
| ROUTE | `choose_route` (code) + fast model reason | DRAFT |
| DRAFT | `draft_appeal` (strong model) from verified evidence only | VERIFY |
| VERIFY | `verify_citations` (pure code, no model) | REDTEAM (all ok) / DRAFT (redraft, ×2 max) / strip-and-continue after 2 redrafts |
| REDTEAM | `redteam_review` (strong model) | DRAFT (severity medium/high, once) or AWAITING_APPROVAL |
| AWAITING_APPROVAL | pause; `/approve` sets state, schedules follow-ups | — |
| APPROVED | terminal; `/simulate` fires due follow-ups | — |
| ERROR | terminal; set on any uncaught handler exception or 20-step limit | — |

Limits enforced: 20 total state-transition steps (counted via `agent_events` rows with `tool IS NULL`), 2 redrafts, 1 red-team redraft round, 30s timeout per model call, 1 retry on schema failure then throw.

## 3. Every LLM call site (`rg "generate(" lib/agent/tools app/api`)

All 8 call sites go through the single helper `lib/models.ts#generate()` — no other file calls a provider SDK directly.

| File | step | tool | model |
| --- | --- | --- | --- |
| `lib/agent/tools/extractRejection.ts` | EXTRACT | `extract_rejection` | MODEL_FAST |
| `lib/agent/tools/writeQueries.ts` | RETRIEVE | `write_queries` | MODEL_FAST |
| `lib/agent/tools/assessCase.ts` | ASSESS | `assess_case` | MODEL_STRONG |
| `lib/agent/tools/chooseRouteTool.ts` | ROUTE | `choose_route` | MODEL_FAST |
| `lib/agent/tools/draftAppeal.ts` | DRAFT | `draft_appeal` | MODEL_STRONG |
| `lib/agent/tools/redteamReview.ts` | REDTEAM | `redteam_review` | MODEL_STRONG |
| `lib/agent/tools/dontAppealExplanation.ts` | DONT_APPEAL | `dont_appeal_explanation` | MODEL_FAST |
| `app/api/cases/[id]/simulate/route.ts` | SIMULATE | `escalation_draft` | MODEL_STRONG |

**As-is, this is Gemini-only** (`@ai-sdk/google`, `createGoogleGenerativeAI`). Provider is not currently configurable — Phase 0 task below fixes this (`LLM_PROVIDER=anthropic|google`).

## 4. Every API route, validation and auth

| Route | Auth | Body/param validation (current) |
| --- | --- | --- |
| `POST /api/cases` | sets owner cookie (none to check yet) | none — accepts any JSON shape |
| `GET /api/cases/[id]` | `getOwnedCase` (owner-cookie match) | none (path param only) |
| `DELETE /api/cases/[id]` | `getOwnedCase` | none |
| `POST /api/cases/[id]/documents` | `getOwnedCase` | `kind` checked against an allowlist; file-type sniffed by extension/MIME, PDF parse wrapped in try/catch (see git history); no size cap |
| `POST /api/cases/[id]/step` | `getOwnedCase` | none (no body) |
| `POST /api/cases/[id]/answer` | `getOwnedCase` | `typeof answers === "object"` only |
| `POST /api/cases/[id]/approve` | `getOwnedCase` + state check (`AWAITING_APPROVAL`) | none |
| `POST /api/cases/[id]/simulate` | `getOwnedCase` | `typeof days === "number" && days > 0` |
| `POST /api/cases/sample` | none (creates a fresh case) | `sample` checked against a fixed map |

**Gap:** no Zod schema validation anywhere; checks are ad-hoc `typeof`/allowlist checks. No rate limiting. No request size caps. `lib/ownership.ts` does return 404 (not 403) for a non-owned/malformed id, which is correct per the spec's "don't reveal a case exists" requirement — this one is already right.

## 5. Every env var read anywhere in the code (`rg "process\.env\."`)

| Var | File | Required |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `lib/db.ts` | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | `lib/db.ts` | yes |
| `GEMINI_API_KEY` | `lib/models.ts` | yes (current Gemini-only setup) |
| `MODEL_FAST` | `lib/models.ts` | no (defaults to `gemini-3.5-flash-lite` in `.env.example`) |
| `MODEL_STRONG` | `lib/models.ts` | no (same default) |
| `NODE_ENV` | `lib/db.ts` | implicit (set by Next.js) |

**Gap:** no validation at boot — a missing var surfaces only when the relevant code path first runs, as a raw thrown error. No `lib/env.ts`. `.env.example` has no per-var comments.

## 6. Test count and coverage (`npx vitest run --coverage`, `include: ["lib/agent/**","lib/ingest/**","app/api/**"]`)

- **32 tests, 3 test files, all passing** (`verify.test.ts`, `deadlines.test.ts`, `DraftView.test.tsx`).
- **Coverage across the target modules: 15.14% statements / 7.78% branches / 17.35% functions / 15.48% lines** (93/614 statements). Per-file:
  - `lib/agent/verify.ts`: 91.52% stmts — well tested.
  - `lib/agent/deadlines.ts`: 82.35% stmts — well tested.
  - `lib/ingest/normalize.ts`: 91.66% stmts (via verify.ts's re-export).
  - `lib/agent/machine.ts`: **0%** — the entire state machine has no tests.
  - `lib/agent/tools/*.ts` (8 files): **0%** each.
  - `lib/ingest/pdf.ts`: **0%**.
  - All 8 `app/api/**/route.ts` files: **0%**.
  - `components/DraftView.tsx`: 85.71% (new render test from the previous session).

This is the real, unflattering baseline Phase 3 needs to close to reach the ≥85% target.

## 7. Gap list vs. the original spec

| Spec item | Status | Note |
| --- | --- | --- |
| Postgres full-text search (`search_pages`) | ✅ done, confirmed against live DB | correctly ranks Excl01/Excl08 pages top |
| Six-check rubric | ✅ done | `lib/agent/schemas.ts` `Check`, enforced in `assess_case` prompt |
| Verdict decision | ✅ done, **1 bug found+fixed**: `decideVerdict()` never returned WEAK when the cited clause genuinely held and nothing overrode it (fell to ARGUABLE); fixed in commit `388dc93`/`357e403` history |
| `AWAITING_USER` trigger | ✅ done, **1 bug found+fixed**: only fired on C5="unknown", not "no" (same meaning); same commits |
| Verifier ≥0.92 fuzzy match | ✅ done, tested (`matchQuote`, token-window Levenshtein) |
| Citation format tolerance | ✅ done, **3 duplicate-bug instances found+fixed** (machine.ts redraft cleanup, printable letter, simulate route all had independently-drifting strict regexes before being centralized into `verify.ts`'s `extractCites`/`replaceCites`/`stripSentencesCiting`) |
| Red-team (1 round) | ✅ done | severity medium/high triggers exactly one redraft, gated by `redteam_done` |
| Deadline engine (GRO 14d → Bima Bharosa → Ombudsman 1mo/1yr, ≤₹50L) | ✅ done, tested | `lib/agent/deadlines.ts`, pure functions, calendar-month edge cases tested |
| Ask-user | ✅ done | `AskUserDialog`, 1 bug found+fixed (stuck "Submitting…" on throw) |
| Simulate (+N days) | ✅ done | fires due follow-ups, drafts escalation letter |
| Replay (`?replay=1`) | ✅ done | reveals trace events on a timer from already-stored `agent_events` |
| Print letter | ✅ done | citation markers rendered as "(Policy p. N)" |
| Citation chips (clickable, scroll to ledger) | ✅ done (was missing entirely until the previous session; raw `[cite:E1]` text was shown) |
| Dual provider (Anthropic/Google) | ❌ **not done** — Gemini-only, hardcoded; this document's own commission fixes it next |
| Real UIIC policy PDF | ❌ **not done** — authored substitute in use; network-blocked from this sandbox, blocked on the user supplying the file |
| Zod validation on routes | ❌ not done |
| Idempotent/race-safe `/step` | ❌ not done — no compare-and-set, no lease |
| Rate limiting / abuse guards | ❌ not done |
| `/api/health` | ❌ not done |
| `lib/env.ts` boot validation | ❌ not done |
| Record/replay LLM fixtures for offline CI | ❌ not done |
| 12-case eval set | ❌ not done — only the original 3 cases exist |
| CI workflows | ❌ not done |
| `docs/KNOWN_ISSUES.md`, `evals/README.md`, `docs/RESUME.md` | ❌ not done |

## 7a. Phase 2 updates (post-initial-audit)

Since this document was first written, Phase 2 added: `lib/env.ts` (Zod-validated boot config, 7 tests), `GET /api/health`, `LLM_PROVIDER=anthropic|google` dual-provider support (found and fixed a real `@ai-sdk/anthropic`/`@ai-sdk/google` dependency conflict along the way), `lib/validation.ts` (Zod schemas + a consistent `{error:{code,message}}` contract on all 8 routes, replacing the ad-hoc string-error responses this document originally flagged), PDF magic-byte sniffing + 413/415/422 status codes on upload, and a lease-based idempotent `/step` (`cases.step_lock_until`, migration `0003`) returning 409 on a concurrent call instead of silently double-running a state transition.

**Verified:** after a fresh `rm -rf .next && pnpm build`, grepped `.next/static` for both the Supabase service-role key and the Gemini API key (by their actual values' prefixes, read from `.env.local`) — neither appears. Confirms `server-only`/the service-role key genuinely never reach the client bundle.

Test count is now 62 (up from 32), still all pure/unit-level — `lib/agent/machine.ts`, the tool files, and the route handlers remain at 0% coverage pending the mocked-LLM integration suite and route-handler tests (see `docs/KNOWN_ISSUES.md`).

## 8. Next

See the task list for the remaining phases (2–6). Phase 2 (dual-provider abstraction) starts immediately after this document.
