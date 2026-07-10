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
web_search({ query: "typescript structural typing" })
web_search({ queries: ["react server components", "next.js app router caching"] })
web_search({ query: "llm evals", numResults: 10, recencyFilter: "month" })
web_search({ query: "vite plugins", domainFilter: ["github.com", "-medium.com"] })
```

| Parameter | Description |
|-----------|-------------|
| `query` / `queries` | Single query, or multiple searched independently |
| `numResults` | Results per query (default 5, max 20) |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains (prefix with `-` to exclude) |

### `fetch_content`

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["https://a.com", "https://b.com"] })
```

| Parameter | Description |
|-----------|-------------|
| `url` / `urls` | Single URL or multiple (fetched in parallel, max 3 concurrent) |

## How `fetch_content` works

```
fetch_content(url)
  → SSRF guard (blocks localhost / private / reserved IPs)
  → HTTP fetch with `Accept: text/markdown, text/html;q=0.9, …`
      → PDF (Content-Type or .pdf)?   unpdf text extraction (with page markers)
      → Content-Type: text/markdown?  return as-is (skip Readability entirely)
      → HTML?                         Readability → Turndown → markdown
      → text / json / plain?          return as-is
  → still empty / looks JS-rendered?  render with headless Chromium (Playwright),
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
