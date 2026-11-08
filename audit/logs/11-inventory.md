# Phase 0 inventory (audited commit 9288e2b on `hardening`)

Sources: `00-git-baseline.log`, `06-tree.log`, `07-loc.log`, `08-deps.log`, `09-env-vars.log`, `10-routes-source.log`, plus grep output reproduced inline below.

## Branches (vs origin/main, after `git fetch --all`)
| Branch | Behind main | Ahead of main |
|---|---|---|
| origin/hardening (= local hardening) | 0 | 3 (PR #4, open) |
| origin/claude/trusting-feynman-m7ekcj | 0 | 3 (same commits as hardening) |
| local claude/trusting-feynman-m7ekcj | 24 | 0 (stale local ref) |
| main / origin/main | 0 | 0 |
Uncommitted: only `audit/` (this audit).

## Fresh-install results (clean clone, `00-fresh-install-summary.log`)
| Command | Result | Time |
|---|---|---|
| `pnpm install --frozen-lockfile` | pass | 6.1 s |
| `pnpm typecheck` | pass | 6.8 s |
| `pnpm lint` | pass | 5.4 s |
| `pnpm test -- --coverage` | pass (220 tests), **but no coverage was collected** (vitest ignores the passed-through flag; `pnpm test:coverage` is the working command) | 4.4 s |
| `pnpm build` | pass, with **no `.env.local`** present | 14.8 s |
`pnpm test:db`: does not exist. `pnpm eval`: exists; needs `.env.local` with live Supabase + LLM key. Not run here (production DB, and the Gemini key's free-tier daily quota is exhausted; see Phase 4).

## LOC (non-blank, ts/tsx/sql/mjs/css)
app 1069 · components 750 · lib 1586 · tests 1770 · evals 149 · scripts 438 · supabase 154. Files >300 lines: `lib/agent/machine.ts` (716), `app/cases/[id]/page.tsx` (325).

## Dependencies (runtime, purpose)
next 16.4.3 (framework) · react/react-dom 19.3.0 · ai ^7.0.159 (Vercel AI SDK, `generateObject`) · @ai-sdk/google ^4.0.109, @ai-sdk/anthropic ^4.0.98 (providers) · @supabase/supabase-js ^2.118.0 (DB + storage) · zod ^4.6.7 (validation) · unpdf ^2.1.0 (PDF text) · fastest-levenshtein ^1.0.16 (verifier) · nanoid ^6.0.2 (owner id) · server-only (import guard) · react-markdown ^10.1.0 (draft render) · radix-ui dialog/label/scroll-area/separator/slot/tabs, class-variance-authority, clsx, tailwind-merge, tw-animate-css, lucide-react, sonner, next-themes (UI).
Dev: vitest 5.0.5 + coverage-v8, fast-check, eslint 9 + eslint-config-next, typescript 5, tsx, tailwindcss 4, @types/node ^20 (note: engines pins node >=22).
pnpm.overrides pin @ai-sdk/provider 4.0.36 and provider-utils 5.0.75.

## Env vars read by code
| Var | Read at | In .env.example |
|---|---|---|
| NEXT_PUBLIC_SUPABASE_URL | lib/env.ts:6 (via getEnv, called lazily from lib/db.ts:13, app/api/health/route.ts:12) | yes |
| SUPABASE_SERVICE_ROLE_KEY | lib/env.ts:7 (same) | yes |
| LLM_PROVIDER | lib/models.ts:18 (direct), lib/env.ts:8, evals/run.ts:154 | yes |
| GEMINI_API_KEY | lib/models.ts:31, scripts/prove-local.mjs:20 | yes |
| ANTHROPIC_API_KEY | lib/models.ts:32 | yes |
| MODEL_FAST / MODEL_STRONG | lib/models.ts:28-29, evals/run.ts, scripts/prove-local.mjs | yes |
| MAX_TOKENS_PER_CASE | lib/agent/machine.ts:99 | yes |
| NODE_ENV | lib/db.ts:29 (cookie Secure flag) | no (platform-provided) |
| VERCEL_GIT_COMMIT_SHA | app/api/health/route.ts:7 | no (platform-provided) |

## API routes
| Route | Method | Input | Auth/owner check | Rate limit | Response codes |
|---|---|---|---|---|---|
| /api/cases | POST | JSON CreateCaseBody | creates cp_owner cookie | newCase 10/h | 200, 400, 429, 500 |
| /api/cases/sample | POST | JSON {sample: a/b/c} | creates cp_owner | newCase 10/h | 200, 400, 429, 500 |
| /api/cases/[id] | GET | — | getOwnedCase | none | 200, 404, (uncaught → framework 500) |
| /api/cases/[id] | DELETE | — | getOwnedCase | none | 200, 404, 500 |
| /api/cases/[id]/documents | POST | multipart: kind, file or text | getOwnedCase | **none** | 200, 400, 404, 413, 415, 422, 500 |
| /api/cases/[id]/step | POST | — | getOwnedCase | step 30/min | 200, 404, 409, 429, 500 |
| /api/cases/[id]/answer | POST | JSON {answers: record} | getOwnedCase | **none** | 200, 400, 404, 500 |
| /api/cases/[id]/approve | POST | — | getOwnedCase + state check | none | 200, 400, 404, 500 |
| /api/cases/[id]/simulate | POST | JSON {days} | getOwnedCase | **none** (can call the LLM) | 200, 400, 404, 500 |
| /api/health | GET | — | none (public) | none | 200, 503 |

## LLM call sites (all through lib/models.ts `generate()`, temperature default 0)
| Tool | File | Tier → default model (google) | System prompt |
|---|---|---|---|
| extract_rejection | lib/agent/tools/extractRejection.ts:10 | MODEL_FAST → gemini-3.5-flash-lite | EXTRACT_REJECTION_SYSTEM |
| write_queries | tools/writeQueries.ts:6 | FAST | WRITE_QUERIES_SYSTEM |
| assess_case | tools/assessCase.ts:29 | STRONG → gemini-3.5-flash-lite | ASSESS_CASE_SYSTEM |
| choose_route | tools/chooseRouteTool.ts:8 | FAST | ROUTE_REASON_SYSTEM |
| draft_appeal | tools/draftAppeal.ts:29 | STRONG | DRAFT_APPEAL_SYSTEM |
| redteam_review | tools/redteamReview.ts:24 | STRONG | REDTEAM_SYSTEM |
| dont_appeal_explanation | tools/dontAppealExplanation.ts:6 | FAST | DONT_APPEAL_SYSTEM |
| escalation_draft | **app/api/cases/[id]/simulate/route.ts:55** (inline system prompt, not in prompts.ts) | STRONG | inline string |
Anthropic defaults: claude-haiku-5-5 / claude-sonnet-5-5 (lib/models.ts:21).

## Database objects (supabase/migrations)
Tables: cases, documents, pages (generated `tsv` + GIN index), evidence (unique case_id+short_id), agent_events (bigserial, index case_id,id), drafts, followups, regulations (5 seed rows), rate_limits (0004). RLS enabled on all 9; no policies (service-role only).
Functions: `search_pages(uuid,text,int)` (language sql stable, invoker), `bump_rate_limit(text,text,timestamptz,int)` (language sql, invoker). No `security definer`.
**Not in migrations:** the `documents` Storage bucket and any storage policies.

## State machine (lib/agent/machine.ts:19-34)
INTAKE, EXTRACT, RETRIEVE, ASSESS, AWAITING_USER, DECIDE, DONT_APPEAL, ROUTE, DRAFT, VERIFY, REDTEAM, AWAITING_APPROVAL, APPROVED, ERROR. PAUSE = AWAITING_USER, AWAITING_APPROVAL; TERMINAL = DONT_APPEAL, APPROVED, ERROR. MAX_STEPS 20, MAX_REDRAFTS 2.
