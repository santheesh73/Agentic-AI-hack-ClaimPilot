# ClaimPilot — Resume Material

Every number below comes from a command actually run on branch `hardening` (see `docs/KNOWN_ISSUES.md` and `docs/AUDIT.md`). None are projected. Re-run `pnpm test:coverage` before quoting them, since they change as the code does.

## Project description (2 sentences)

ClaimPilot is an AI agent that turns a rejected Indian health insurance claim into an honest appeal verdict and a policy-cited appeal letter, where every citation is verified against the literal policy text in code rather than trusted from the model. It runs a durable state machine over Postgres full-text search, a six-check rubric, a fuzzy-match citation verifier, a self red-team pass, and a deadline engine for the GRO → IRDAI → Ombudsman escalation path.

## Resume bullets

- Built an AI claim-appeal agent (Next.js, Postgres FTS, Vercel AI SDK) whose verdict comes from a code-level rubric, not the model, and whose citations are fuzzy-matched against source text.
- Raised backend test coverage from 15% to 87% (286 tests) with an offline mocked-LLM, in-memory-DB harness that runs the real state machine end to end.
- Found and fixed 10+ production bugs by running code against real data, including a PDF parser crash that would have broken both the sample flow and the eval suite.

- Built a 16-case live eval against Gemini and the live database (12 development cases plus 4 held-out cases). It found 4 real bugs and 3 reasoning failures, each traced to a root cause and fixed. The last complete run scored 16/16, including all held-out cases, with 100% of citations verified in every drafted letter (measured on an authored stand-in policy, before the audit fixes to the verifier and question gate; stability across runs and a post-fix re-run are still pending).

## Likely interview questions

**1. Why is the verdict computed in code instead of asking the model "should I appeal?"**
Because a model's yes/no answer isn't auditable and drifts between runs. The model answers six narrow factual checks against retrieved policy pages — does the cited clause exist, do its conditions hold, is there an overriding clause, etc. — and `decideVerdict` in `lib/agent/machine.ts` maps those to STRONG/ARGUABLE/WEAK with plain conditionals. That function is tested against all 81 combinations of the four checks it reads, against a reference written independently in the test file.

**2. How do you know the citations in the letter are real?**
`lib/agent/verify.ts` re-checks every `[cite:E#]` marker against the actual page text after drafting: exact substring first, then a sliding token window scored by normalized Levenshtein distance, accepting ≥0.92. Quotes under six words need an exact match. A failing citation triggers a redraft (twice max), then the offending sentence is stripped rather than shown. Property-based tests run that matcher against random spans of the real policy PDF.

**3. Why no vector database?**
The retrieval problem is "find the pages about this specific clause in one 80-page document," not semantic search across a corpus. Postgres full-text search with `tsvector`/`ts_rank_cd` handles that directly, keeps everything in one database, and avoids embedding cost and drift. The model writes the search queries itself from the extracted rejection facts.

**4. How do you test an LLM agent without calling the LLM?**
I mock exactly two boundaries — `generate()` in `lib/models.ts` (canned responses per tool) and `supabaseAdmin()` (an in-memory fake implementing the slice of the Supabase client the code actually uses) — and run everything else unmocked: the real state machine, verifier, deadline engine, and validation. The canned evidence quote has to be a genuine substring of the fake policy page, so the real verifier still has to pass it. That suite moved `machine.ts` from 0% to ~80% coverage, fully offline.

**5. What's a bug you found that tests alone wouldn't have caught?**
`parsePdf()` checked `buffer instanceof Uint8Array` before handing bytes to `unpdf`. A Node `Buffer` passes that check, but `unpdf` explicitly rejects a real Buffer — so any caller reading the file with `fs.readFile` crashed, including the "Load sample case" route and the eval harness. Unit tests used `ArrayBuffer`s and never hit it; it only surfaced when a route test loaded the real sample PDF from disk. The fix always materializes a plain `Uint8Array` view.
