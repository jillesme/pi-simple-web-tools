import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { formatExaResults, searchWithExa, type ExaResponse } from "./exa.ts";
import { fetchAllContent, type FetchedContent } from "./fetch.ts";

/** Content above this size is written to a temp file; only a preview is returned inline. */
const MAX_INLINE_CONTENT = 100_000;
const PREVIEW_CHARS = 4_000;
const TEMP_DIR = join(tmpdir(), "pi-web-tools");

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
			"For research, prefer 'queries' (plural) with 2-4 varied angles over a single query — each query is searched independently for broader coverage.",
		promptSnippet: "Use for web research. Prefer {queries:[...]} with 2-4 varied angles for broader coverage.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query." })),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					description: "Multiple queries, each searched independently. Vary phrasing/scope/angle for coverage.",
				}),
			),
			numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)." })),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"], { description: "Only results published within this window." }),
			),
			domainFilter: Type.Optional(
				Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)." }),
			),
		}),

		async execute(_callId, params, signal) {
			const queryList = (Array.isArray(params.queries) ? params.queries : params.query ? [params.query] : [])
				.map((q) => (typeof q === "string" ? q.trim() : ""))
				.filter(Boolean);

			if (queryList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries'." }],
					details: { error: "No query provided" },
				};
			}

			const numResults = params.numResults ? Math.min(Math.max(params.numResults, 1), 20) : undefined;
			try {
				const responses: ExaResponse[] = [];
				for (const query of queryList) {
					responses.push(
						await searchWithExa(query, {
							numResults,
							recencyFilter: params.recencyFilter,
							domainFilter: params.domainFilter,
							signal,
						}),
					);
				}
				const total = responses.reduce((sum, r) => sum + r.results.length, 0);
				return {
					content: [{ type: "text", text: formatExaResults(responses) }],
					details: { queries: queryList, resultCount: total },
				};
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					details: { queries: queryList, error: message },
				};
			}
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			"Fetch URL(s) and extract the main readable content as markdown. Requests markdown via content negotiation, " +
			"falls back to Readability, then a headless browser (Playwright) for JS-rendered pages. Also extracts text from PDFs. " +
			"Large content is written to a temp file and only a preview is returned inline — use the read tool with offset/limit to read the rest.",
		promptSnippet: "Use to fetch a web page or PDF as markdown. Large results are saved to a file path you can read with offset/limit.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (fetched in parallel)." })),
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
			const results = await fetchAllContent(urlList, signal);

			// Single URL: return content directly (or a preview + path when large).
			if (results.length === 1) {
				const r = results[0];
				const { text, path } = renderResult(r, false);
				return {
					content: [{ type: "text", text }],
					details: r.error
						? { url: r.url, error: r.error }
						: { url: r.url, title: r.title, chars: r.content.length, renderer: r.renderer, path },
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
					paths: rendered.map((s) => s.path).filter(Boolean),
				},
			};
		},
	});
}
