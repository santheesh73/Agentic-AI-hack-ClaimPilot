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
| `parse_documents` | PDF → per-page text | none |
| `extract_rejection` | Rejection letter → structured facts | fast |
| `write_queries` (part of RETRIEVE) | Facts → 3–6 search queries | fast |
| `search_policy` | Query → ranked policy pages | none (Postgres FTS) |
| `lookup_regulation` | Rule ids → regulation rows | none |
| `assess_case` | Facts + candidate pages → six-check rubric + evidence ledger | strong |
| `choose_route` | Facts → escalation step + reason | code + fast |
| `draft_appeal` | Facts + verified evidence + route → letter | strong |
| `verify_citations` | Draft + evidence → per-citation pass/fail | none (code) |
| `redteam_review` | Draft + policy pages → insurer's best counter-argument | strong |
| `schedule_followup` | Route + sent date → follow-up rows | none |

## Model provider

Model calls go through `lib/models.ts` using Google Gemini (`@ai-sdk/google`) via the Vercel AI SDK's `generateObject` + Zod. `MODEL_FAST` (default `gemini-2.5-flash`) handles extraction, query writing, and short explanations; `MODEL_STRONG` (default `gemini-2.5-pro`) handles assessment, drafting, and red-teaming.

<!-- TODO(phase-b): the original design used Anthropic's ephemeral prompt caching on the large policy-pages context reused across ASSESS/DRAFT/REDTEAM. Gemini's context-caching API differs (explicit cache objects with their own lifecycle) and isn't wired up yet; `CachedTextPart.cache` is currently a no-op in lib/models.ts. -->

## Security model

All Supabase access happens server-side with the service role key; no client ever sees it. Each browser is assigned a random owner id in an httpOnly cookie (`cp_owner`); every query filters on `owner_id`, and RLS is enabled on every table with no client-facing policies (the anon key can read nothing).
