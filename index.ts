import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import pLimit from "p-limit";
import { formatExaResults, searchWithExa, SEARCH_CATEGORIES, SEARCH_TYPES, type ExaResponse } from "./exa.ts";
import { fetchAllContent, type FetchedContent } from "./fetch.ts";

/** Content above this size is written to a temp file; only a preview is returned inline. */
const MAX_INLINE_CONTENT = 100_000;
const PREVIEW_CHARS = 4_000;
const TEMP_DIR = join(tmpdir(), "pi-web-tools");
/** Max Exa requests in flight at once for multi-query searches. */
const SEARCH_CONCURRENCY = 5;

/** Write full content to a stable temp path derived from the URL and return the path. */
function persistContent(url: string, content: string): string {
	mkdirSync(TEMP_DIR, { recursive: true });
	let host = "page";
	try {
		host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, "_") || "page";
	} catch {
		/* keep default */
	}
	const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
	const path = join(TEMP_DIR, `${host}-${hash}.md`);
	writeFileSync(path, content, "utf-8");
	return path;
}

/** Render one fetched result: inline if small, otherwise persist and return a preview + path. */
function renderResult(r: FetchedContent, multi: boolean): { text: string; path: string | null } {
	if (r.error) {
		return { text: multi ? `## ${r.url}\n\n_Error: ${r.error}_` : `Error: ${r.error}`, path: null };
	}
	const heading = multi ? `## ${r.title || r.url}\n${r.url}\n\n` : "";
	if (r.content.length <= MAX_INLINE_CONTENT) {
		return { text: `${heading}${r.content}`, path: null };
	}
	const path = persistContent(r.url, r.content);
	const preview =
		`Fetched ${r.content.length} chars from ${r.url} (renderer: ${r.renderer}).\n` +
		`Full content saved to:\n${path}\n\n` +
		`Read specific sections with the read tool (offset/limit) instead of loading it all.\n\n` +
		`--- Preview (first ${PREVIEW_CHARS} chars) ---\n\n${r.content.slice(0, PREVIEW_CHARS)}`;
	return { text: `${heading}${preview}`, path };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web with Exa and return ranked results with source URLs and text snippets. " +
			"For research, prefer 'queries' (plural) with 2-4 varied angles over a single query — queries run in parallel and are searched independently for broader coverage. " +
			"Use objective to describe the evidence needed and preferred sources. Default auto is suitable for most searches; use deep for multi-step research. " +
			"Publication dates are estimates, not freshness guarantees; maxAgeHours controls retrieved content freshness. Prefer domainFilter over site: query operators. " +
			"Large search output is saved to a file with an inline preview.",
		promptSnippet:
			"Use for web research. Prefer {queries:[...]} with 2-4 varied angles (run in parallel). Set objective for source/evidence preferences; use maxAgeHours when fresh page content matters.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query." })),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					description: "Multiple queries, each searched independently. Vary phrasing/scope/angle for coverage.",
				}),
			),
			numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results per query (default: 5, max: 20)." })),
			objective: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Goal for this search turn; say which documents should rank first, which should be excluded, and what specific facts or figures to pull from them. Do not include secrets or unrelated conversation context." })),
			maxAgeHours: Type.Optional(Type.Integer({ minimum: -1, maximum: 720, description: "Maximum cached page-content age in hours. 0: fetch fresh; -1: cache only. Omit for normal behavior. Does not filter publication dates." })),
			highlightMode: Type.Optional(StringEnum(["standard", "bounded", "dynamic"], { description: "Excerpt strategy: standard (default) lets Exa choose per-page excerpts; bounded requests a smaller excerpt budget; dynamic (beta) allocates context across results." })),
			highlightMaxCharacters: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000, description: "Per-page excerpt budget for bounded mode only (default 2000)." })),
			startPublishedDate: Type.Optional(Type.String({ description: "ISO 8601 publication start timestamp. Cannot combine with recencyFilter." })),
			endPublishedDate: Type.Optional(Type.String({ description: "ISO 8601 publication end timestamp." })),
			additionalQueries: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 10, description: "Deep modes only: distinct starting queries within ONE research request, unlike queries which makes separate requests." })),
			systemPrompt: Type.Optional(Type.String({ minLength: 1, description: "Deep modes only: research guidance such as official-source preferences and deduplication." })),
			type: Type.Optional(
				StringEnum(SEARCH_TYPES, {
					description:
						"Search mode (default: auto). 'instant'/'fast': lowest latency, good for simple lookups. " +
						"'auto': balanced, best for most queries. 'deep-lite': light multi-step research (~4s). " +
						"'deep': comprehensive multi-step research, slower. 'deep-reasoning': deepest, for complex analysis — slowest and most expensive.",
				}),
			),
			category: Type.Optional(
				StringEnum(SEARCH_CATEGORIES, {
					description:
						"Focus on a type of source. 'publication': research papers/preprints/journals. 'news': news articles. " +
						"'company': company pages. 'people': person profiles. 'personal site': blogs/personal pages. 'financial report': filings/earnings. " +
						"Note: 'company' and 'people' do not support publication-date filters; only 'people' disallows excluded domains.",
				}),
			),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"], { description: "Only results published within this window." }),
			),
			domainFilter: Type.Optional(
				Type.Array(Type.String(), { description: "Limit to domains, path prefixes (example.com/docs), or wildcard subdomains (*.example.com). Prefix with - to exclude." }),
			),
		}),

		async execute(_callId, params, signal, onUpdate) {
			const queryList = (Array.isArray(params.queries) ? params.queries : params.query ? [params.query] : [])
				.map((q) => (typeof q === "string" ? q.trim() : ""))
				.filter(Boolean);

			if (queryList.length === 0) {
				throw new Error("No query provided. Use 'query' or 'queries'.");
			}

			const numResults = params.numResults;
			onUpdate?.({ content: [{ type: "text", text: `Searching ${queryList.length} quer${queryList.length === 1 ? "y" : "ies"}...` }] });

			// Run queries in parallel; a failing query is reported inline without discarding the others.
			const limit = pLimit(SEARCH_CONCURRENCY);
			const responses: ExaResponse[] = await Promise.all(
				queryList.map((query) =>
					limit(() =>
						searchWithExa(query, {
							numResults,
							type: params.type,
							category: params.category,
							objective: params.objective,
							maxAgeHours: params.maxAgeHours,
							highlightMode: params.highlightMode,
							highlightMaxCharacters: params.highlightMaxCharacters,
							startPublishedDate: params.startPublishedDate,
							endPublishedDate: params.endPublishedDate,
							additionalQueries: params.additionalQueries,
							systemPrompt: params.systemPrompt,
							recencyFilter: params.recencyFilter,
							domainFilter: params.domainFilter,
							signal,
						}).catch((e): ExaResponse => {
							if (signal?.aborted) throw e;
							return { query, results: [], error: e instanceof Error ? e.message : String(e) };
						}),
					),
				),
			);

			const total = responses.reduce((sum, r) => sum + r.results.length, 0);
			const errors = responses.filter((r) => r.error).map((r) => ({ query: r.query, error: r.error }));
			const output = formatExaResults(responses);
			const path = output.length > MAX_INLINE_CONTENT ? persistContent(JSON.stringify([queryList, output]), output) : null;
			return {
				isError: errors.length === responses.length,
				content: [{ type: "text", text: path
					? `Full search results saved to ${path}. Read with offset/limit.\n\n${output.slice(0, PREVIEW_CHARS)}`
					: output }],
				details: {
					queries: queryList,
					type: params.type ?? "auto",
					category: params.category,
					resultCount: total,
					path,
					diagnostics: responses.map(({ query, diagnostics }) => ({ query, ...diagnostics })),
					...(errors.length ? { errors } : {}),
				},
			};
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			"Fetch URL(s) and extract the main readable content as markdown. Requests markdown via content negotiation, " +
			"falls back to Readability, then a headless browser (Playwright) for JS-rendered pages. Also extracts text from PDFs. " +
			"Large content is written to a temp file and only a preview is returned inline — use the read tool with offset/limit to read the rest. " +
			"Successful fetches are cached for 15 minutes. Set forceBrowser: true when the normal fetch returns incomplete/placeholder content (e.g. single-page apps).",
		promptSnippet: "Use to fetch a web page or PDF as markdown. Large results are saved to a file path you can read with offset/limit.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (fetched in parallel)." })),
			forceBrowser: Type.Optional(
				Type.Boolean({
					description:
						"Skip the plain HTTP fetch and render with a headless browser (Playwright). Use when a previous fetch returned " +
						"incomplete, placeholder, or 'enable JavaScript' content. Slower. Default: false (browser is used automatically as a fallback).",
				}),
			),
		}),

		async execute(_callId, params, signal, onUpdate) {
			const urlList = (Array.isArray(params.urls) ? params.urls : params.url ? [params.url] : [])
				.map((u) => (typeof u === "string" ? u.trim() : ""))
				.filter(Boolean);

			if (urlList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No URL provided. Use 'url' or 'urls'." }],
					details: { error: "No URL provided" },
				};
			}

			onUpdate?.({ content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }] });
			const results = await fetchAllContent(urlList, { signal, forceBrowser: params.forceBrowser });

			// Single URL: return content directly (or a preview + path when large).
			if (results.length === 1) {
				const r = results[0];
				const { text, path } = renderResult(r, false);
				return {
					content: [{ type: "text", text }],
					details: r.error
						? { url: r.url, error: r.error }
						: { url: r.url, title: r.title, chars: r.content.length, renderer: r.renderer, cached: !!r.cached, path },
				};
			}

			// Multiple URLs: concatenate sections; large ones are persisted to their own file.
			const rendered = results.map((r) => renderResult(r, true));
			const successful = results.filter((r) => !r.error).length;
			return {
				content: [{ type: "text", text: rendered.map((s) => s.text).join("\n\n---\n\n") }],
				details: {
					urls: urlList,
					successful,
					failed: results.length - successful,
					cached: results.filter((r) => r.cached).length,
					paths: rendered.map((s) => s.path).filter(Boolean),
				},
			};
		},
	});
}
