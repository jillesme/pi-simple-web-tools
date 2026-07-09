import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { formatExaResults, searchWithExa, type ExaResponse } from "./exa.ts";
import { fetchAllContent } from "./fetch.ts";

const MAX_INLINE_CONTENT = 100_000;

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
			"Fetch URL(s) and extract the main readable content as markdown. Uses an HTTP fetch with Readability, " +
			"and automatically falls back to a headless browser (Playwright) for JavaScript-rendered pages when installed.",
		promptSnippet: "Use to fetch a web page and get its readable content as markdown.",
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

			// Single URL: return content directly.
			if (results.length === 1) {
				const r = results[0];
				if (r.error) {
					return {
						content: [{ type: "text", text: `Error: ${r.error}` }],
						details: { url: r.url, error: r.error },
					};
				}
				const truncated = r.content.length > MAX_INLINE_CONTENT;
				const body = truncated
					? `${r.content.slice(0, MAX_INLINE_CONTENT)}\n\n[Content truncated at ${MAX_INLINE_CONTENT} of ${r.content.length} chars.]`
					: r.content;
				return {
					content: [{ type: "text", text: body }],
					details: { url: r.url, title: r.title, chars: r.content.length, renderer: r.renderer, truncated },
				};
			}

			// Multiple URLs: concatenate with headers.
			const sections = results.map((r) =>
				r.error
					? `## ${r.url}\n\n_Error: ${r.error}_`
					: `## ${r.title || r.url}\n${r.url}\n\n${
							r.content.length > MAX_INLINE_CONTENT
								? `${r.content.slice(0, MAX_INLINE_CONTENT)}\n\n[Truncated.]`
								: r.content
						}`,
			);
			const successful = results.filter((r) => !r.error).length;
			return {
				content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
				details: { urls: urlList, successful, failed: results.length - successful },
			};
		},
	});
}
