# Exa search quality comparison — 2026-10-17

## Decision

Keep `auto` plus standard highlights as the default. Quality, not latency or maximum compression, is the priority. Expose bounded and Dynamic Highlights as optional strategies. Preserve the 2,000-character text fallback and provide file-backed output for very large result sets.

The stable improvements are objective/source guidance, optional page freshness, explicit publication ranges, deep-mode starting queries/instructions, corrected company-domain restrictions, diagnostics and bounded transient-error retries. This sample does not establish that the new parameters improve every search or that one highlight strategy is universally superior.

## Procedure

Approved live procedure: two smoke queries with `objective` and `maxAgeHours: 24`, then ten fixed coding/docs queries across three configurations, five results per request. Run with `node benchmarks/exa-quality.ts` from the source checkout. This makes 32 paid calls and overwrites `results.json`.

- **Baseline:** same request body as the old client: auto, five results, 2,000-character text plus standard highlights, no objective.
- **Bounded:** add a source/evidence objective and request `highlights.maxCharacters: 2000`.
- **Dynamic:** add the same objective and request `highlights.dynamic: true` with the required beta header.
- Both new variants retained the text fallback. No forced-freshness setting in the 30-call comparison; freshness was exercised only in the two smoke calls.
- Rotating execution order, one sample per query/variant; no latency-based decisions. Prior benchmarks/provider caches may affect calls.
- Manual review of top-five titles/URLs and excerpt previews across all queries, plus full first-result excerpts for Durable Objects, TaskGroup, PostgreSQL and React security. This was not blinded, not an end-to-end answer evaluation, and not independent fact checking against every source page.
- Objective and excerpt strategy change together: **this is a comparison of configurations, not an isolated causal test of objective**. We did not benchmark standard highlights plus objective independently.

## Results

| Configuration | Success | Total excerpt characters | Reduction vs baseline | API-reported estimated cost |
|---|---:|---:|---:|---:|
| Baseline | 10/10 | 148,292 | — | $0.070 |
| Bounded + objective | 10/10 | 101,094 | 31.8% | $0.070 |
| Dynamic + objective | 10/10 | 116,292 | 21.6% | $0.070 |

Both smoke calls succeeded with five results. All 32 calls completed in one attempt with no API notices or warnings. Total reported estimated cost: **$0.224** (not an invoice measurement).

Characters are the sum of normalized result excerpt string lengths (JavaScript UTF-16 units), excluding headings, titles and URLs; they are not token counts. Exa sometimes exceeded the requested per-page highlight budget, so bounded mode is described as a service-side budget, not a strict local cap. No local chopping of source excerpts was added.

## Observations

- All configurations generally found the same strong primary documentation. Adding the broad objective did not demonstrate a clear, consistent ranking improvement on these already-specific queries.
- **Durable Objects:** Dynamic devoted more text to the canonical storage API, exposing transaction restrictions and SQL caveats while reducing total set size. Standard retained fuller contiguous introductory context. Freshness still matters: the returned source text included old billing language.
- **TypeScript satisfies:** all found the official release note. Dynamic reduced repeated explanation; bounded trimmed context. No clear evidence that either shorter mode universally improved the answerable facts.
- **React effects:** Dynamic surfaced a cleanup example early; standard preserved a more contiguous explanation. Both useful.
- **Svelte:** Dynamic focused excerpts on `$derived`, but raw code excerpts elsewhere could be interrupted by ellipses.
- **Node AbortSignal:** all found useful official material. Dynamic retained relevant method documentation, while bounded dropped some boilerplate.
- **Python TaskGroup:** Dynamic foregrounded cancellation and exception-group semantics. Standard also contained those details plus more surrounding API context; bounded still returned substantial text despite its requested budget.
- **PostgreSQL SKIP LOCKED:** bounded led directly with locking syntax. Dynamic retained useful ordering/isolation caveats, but its excerpt began with broad SELECT syntax. Standard also included the core queue-consistency caveat. No simple winner.
- **SQLite WAL:** Dynamic led directly with reader/writer concurrency facts; standard retained a fuller narrative. Experimental concurrent-write content appeared in all variants and must not be confused with ordinary SQLite WAL behavior.
- **Agents callable RPC:** sources remained useful; Dynamic could fragment code and signatures. Standard's contiguous examples are a safer general default for coding.
- **React security:** Dynamic made some impact statements more prominent, but also returned fragmented package/version lists and truncated sentences on some results. Standard/bounded retained clearer lists in the inspected results. Always fetch current advisories before recommending patched versions; publication dates and short excerpts alone are not enough.

## Validation scope

Live API smoke calls and quality comparison; offline Pi extension loading; package dry run; diff whitespace check. No new automated tests were added. Retry failure paths, cancellation races, deep-mode guidance and company exclusions were reviewed in code but not exercised with additional live calls. API notices/warnings were preserved in code but absent from this run, so their display was not observed live. The package has no configured static TypeScript typecheck.

## Sources

- https://exa.ai/docs/reference/search
- https://exa.ai/docs/search/highlights
- https://exa.ai/docs/search/deep-search
- https://exa.ai/pricing

Raw results and per-call diagnostics are in `results.json`. Credentials are loaded from the existing private config/environment and never written into the benchmark artifacts.
