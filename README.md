# pi-simple-web-tools

A deliberately small [Pi](https://github.com/earendil-works/pi-mono) extension that adds exactly two tools:

- **`web_search`** — web search via [Exa](https://exa.ai) (API key required).
- **`fetch_content`** — fetch a URL (web page or PDF) and return clean markdown, using HTTP
  content negotiation → Readability → a lazy headless-browser fallback for JavaScript-rendered
  pages. Large content is saved to a temp file and returned as a preview + path.

It's a focused alternative to the excellent but feature-rich
[`pi-web-access`](https://github.com/nicobailon/pi-web-access) by Nico Bailon — if
you only want search + fetch and nothing else (no video, YouTube, GitHub cloning,
curator UI, or multi-provider routing), this is that.

## Install

```bash
pi install npm:pi-simple-web-tools
```

Or clone into your extensions directory for local development:

```bash
git clone https://github.com/jillesme/pi-simple-web-tools \
  ~/.pi/agent/extensions/pi-simple-web-tools
cd ~/.pi/agent/extensions/pi-simple-web-tools && npm install
```

Restart Pi (or `/reload`).

> **Note:** `web_search` and `fetch_content` are common tool names. If you also run
> `pi-web-access`, disable its tools to avoid a collision — add `"extensions": []`
> to its entry in `~/.pi/agent/settings.json`.

## Configuration

Set an Exa API key ([get one here](https://exa.ai)) via environment variable:

```bash
export EXA_API_KEY="exa-..."
```

or in `~/.pi/web-tools.json`:

```json
{
  "exaApiKey": "exa-...",
  "ssrf": { "allowRanges": ["198.18.0.0/15"] }
}
```

`ssrf.allowRanges` is optional and only needed if a TUN/fake-IP proxy (Surge,
Clash, Mihomo, …) resolves public domains into reserved IP ranges that the SSRF
guard would otherwise block.

Config precedence: `EXA_API_KEY` env var → `exaApiKey` in the config file.
Override the config path with `PI_WEB_TOOLS_CONFIG`.

## Tools

### `web_search`

```typescript
web_search({ query: "typescript structural typing", objective: "Find current official documentation and explain assignability caveats with examples." })
web_search({ query: "Cloudflare Workers pricing", maxAgeHours: 24 })
web_search({ query: "React server components", highlightMode: "dynamic" })
web_search({ query: "SQLite WAL", highlightMode: "bounded", highlightMaxCharacters: 3000 })
web_search({ queries: ["react server components", "next.js app router caching"] })
web_search({ query: "llm evals", numResults: 10, recencyFilter: "month" })
web_search({ query: "vite plugins", domainFilter: ["github.com", "-medium.com"] })
web_search({ query: "state space models vs transformers", type: "deep", category: "publication" })
web_search({ queries: ["cloudflare earnings", "cloudflare workers pricing change"], type: "fast", category: "news" })
```

| Parameter | Description |
|-----------|-------------|
| `query` / `queries` | Single query, or multiple searched independently and in parallel (max 5 in flight). A failing query is reported inline without dropping the others. |
| `numResults` | Results per query (default 5, max 20) |
| `type` | `instant`, `fast`, `auto` (default), `deep-lite`, `deep`, `deep-reasoning` — trade speed for depth |
| `category` | `publication`, `news`, `company`, `people`, `personal site`, `financial report` |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Domains, path prefixes (`example.com/docs`), or wildcard subdomains (`*.example.com`); prefix with `-` to exclude |
| `objective` | Broader search goal: preferred sources, exclusions, and facts/code to extract (1–4096 characters). Do not include secrets or unnecessary context. |
| `maxAgeHours` | Maximum cached page-content age, -1 to 720 hours. `0` always fetches fresh; `-1` uses cache only. Omit for normal behavior. |
| `highlightMode` | `standard` (default), `bounded`, or `dynamic` (beta, cross-result context allocation) |
| `highlightMaxCharacters` | Excerpt budget per page in `bounded` mode only; default 2000, range 1–20000 |
| `startPublishedDate` / `endPublishedDate` | ISO 8601 publication timestamps; start cannot be combined with `recencyFilter` |
| `additionalQueries` | 1–10 distinct starting queries within one deep-mode research request, not independent requests like `queries` |
| `systemPrompt` | Deep-mode research instructions: source preferences, deduplication, etc. |

`company` and `people` categories don't support publication-date filters. Only
`people` disallows excluded domains; company exclusions are supported. Prefer
`domainFilter` over `site:` operators, which the service may relax when no matches
are found. Publication dates are estimates, not proof of when a page changed.

### Quality and context

`auto` remains the default; use `deep` for tasks requiring iterative research,
not for every lookup. The tool returns source excerpts, not a synthesized Exa
answer. `additionalQueries` and `systemPrompt` are deliberately limited to deep
modes by this tool. `outputSchema` and synthesis are not exposed.

Regular highlights let Exa choose the excerpt size. The 2,000-character text
fallback **does not cap highlights**. Bounded mode applies a per-page highlight
budget (the service can exceed it; this is not a hard local truncation limit).
Dynamic Highlights allocates context across all results and automatically
sends `Exa-Beta: dynamic-highlights-2026-08-28`. Dynamic is opt-in because it is a
research preview. It cannot be combined with `highlightMaxCharacters`. Text is
still requested as fallback when highlights are empty, including in dynamic mode.

Use `maxAgeHours` for content freshness (current pricing or evolving docs), not
`recencyFilter`, which selects by estimated publication date. Fresh retrieval can
add latency. No forced-fresh default is imposed on static documentation.

Search output above 100,000 characters is saved to a temporary file, with a
4,000-character preview and a path to read the complete result. This protects
context without losing the source evidence.

### Reliability and diagnostics

HTTP 429 and 5xx receive up to two retries with exponential backoff, jitter and
`Retry-After`, all within the original 60-second request deadline (180 seconds for
deep modes). Other HTTP errors and transport failures are not automatically
retried. Cancellation interrupts requests and backoff. Independent query failures
are preserved inline; when all queries fail the tool result is marked as an error.

API notices explaining result behavior are included with the model-facing results.
Request IDs, estimated `costDollars`, server `searchTime`, warning messages and
attempt counts are retained in tool-result `details.diagnostics`, not added to the
model's evidence. Costs are estimates, not invoice records; server timing need not
include all end-to-end work. API warnings describe request issues, while notices
can explain relaxed query restrictions.

No SDK dependency was added. The REST API and current parameters are documented at
https://exa.ai/docs/reference/search . The paid quality comparison runner and
results are under `benchmarks/` in the source checkout (not the npm tarball).

### `fetch_content`

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["https://a.com", "https://b.com"] })
fetch_content({ url: "https://some-spa.example.com", forceBrowser: true })
```

| Parameter | Description |
|-----------|-------------|
| `url` / `urls` | Single URL or multiple (fetched in parallel, max 3 concurrent) |
| `forceBrowser` | Skip plain HTTP and render with headless Chromium directly (requires Playwright). Useful when a normal fetch returns placeholder/partial content. |

Successful fetches are cached in memory for 15 minutes (max 100 entries), so
re-fetching the same URL in a session is instant. `forceBrowser` results are cached
separately.

## How `fetch_content` works

```
fetch_content(url)
  → in-memory cache hit (< 15 min)?   return it
  → SSRF guard (blocks localhost / private / reserved IPs)
  → HTTP fetch with `Accept: text/markdown, text/html;q=0.9, …`
      → PDF (Content-Type or .pdf)?   unpdf text extraction (with page markers)
      → Content-Type: text/markdown?  return as-is (skip Readability entirely)
      → HTML?                         Readability → Turndown → markdown
      → text / json / plain?          return as-is
  → HTTP error?                       explain it (404, 429, paywall, timeout, DNS, …);
                                      only 401/403/503 fall through to the browser
  → bot challenge / JS-rendered /     render with headless Chromium (Playwright)
    no readable content?              (or immediately, with forceBrowser: true),
                                      then Readability, falling back to full <body>
  → large result (> 100k chars)?      write to a temp file, return a preview + path
```

- **Markdown content negotiation.** Many docs sites (Cloudflare, Vercel, Mintlify,
  Fastly, HackMD, …) now return `Content-Type: text/markdown` when asked. When they
  do, the response is already clean and Readability/Turndown are skipped. See the
  [`Accept: text/markdown` convention](https://acceptmarkdown.com/).
- **Playwright fallback is lazy.** It's an optional dependency, imported at runtime
  only when a page can't be extracted otherwise. To enable it:

  ```bash
  cd ~/.pi/agent/extensions/pi-simple-web-tools
  npm i -D playwright && npx playwright install chromium
  ```

  Without it, JavaScript-rendered pages return an error with this hint instead of
  silently failing.
- **PDFs** are extracted to text with [`unpdf`](https://github.com/unjs/unpdf),
  one page at a time with `<!-- Page N -->` markers so you can jump to a section.
  Text-based extraction only — no OCR for scanned/image-only PDFs.
- **Large content is never truncated away.** Anything over 100k chars is written to
  `$TMPDIR/pi-web-tools/<host>-<hash>.md`; the tool returns a short preview plus the
  file path so the agent reads exactly the slice it needs with the built-in `read`
  tool (`offset`/`limit`) instead of loading the whole page into context.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry — registers the two tools |
| `exa.ts` | Exa search client + markdown result formatting |
| `fetch.ts` | Fetch → content negotiation → PDF/Readability/Turndown → Playwright |
| `ssrf.ts` | SSRF guard (DNS resolution + private/reserved IP checks) |
| `config.ts` | Loads `~/.pi/web-tools.json` and `EXA_API_KEY` |

## Credits

This project is derived from and inspired by
[**pi-web-access**](https://github.com/nicobailon/pi-web-access) by
[Nico Bailon](https://github.com/nicobailon) (MIT). The `ssrf.ts` guard is used
essentially verbatim, and the fetch/Exa logic follows patterns from that project.
Go check out `pi-web-access` if you want the full-featured version.

## License

MIT — see [LICENSE](LICENSE).
