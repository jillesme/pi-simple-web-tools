import { getExaApiKey } from "./config.ts";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const REQUEST_TIMEOUT_MS = 60_000;
/** Deep search types do multi-step research and can take considerably longer. */
const DEEP_REQUEST_TIMEOUT_MS = 180_000;

export const SEARCH_TYPES = ["instant", "fast", "auto", "deep-lite", "deep", "deep-reasoning"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const SEARCH_CATEGORIES = [
	"company",
	"people",
	"publication",
	"news",
	"personal site",
	"financial report",
] as const;
export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

export interface ExaSearchOptions {
	numResults?: number;
	type?: SearchType;
	category?: SearchCategory;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
}

export interface ExaResult {
	title: string;
	url: string;
	text: string;
	publishedDate?: string;
}

export interface ExaResponse {
	query: string;
	results: ExaResult[];
	error?: string;
}

interface ExaApiResponse {
	results?: Array<{
		title?: string;
		url?: string;
		text?: string;
		publishedDate?: string;
		highlights?: unknown;
	}>;
}

function recencyToStartDate(filter: NonNullable<ExaSearchOptions["recencyFilter"]>): string {
	const days = { day: 1, week: 7, month: 30, year: 365 }[filter];
	return new Date(Date.now() - days * 86_400_000).toISOString();
}

function mapDomainFilter(domainFilter?: string[]): {
	includeDomains?: string[];
	excludeDomains?: string[];
} {
	if (!domainFilter?.length) return {};
	const include = domainFilter.filter((d) => !d.startsWith("-") && d.trim()).map((d) => d.trim());
	const exclude = domainFilter
		.filter((d) => d.startsWith("-"))
		.map((d) => d.slice(1).trim())
		.filter(Boolean);
	return {
		...(include.length ? { includeDomains: include } : {}),
		...(exclude.length ? { excludeDomains: exclude } : {}),
	};
}

function normalizeHighlights(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value.filter((h): h is string => typeof h === "string" && h.trim().length > 0).join(" … ");
}

function requestSignal(type: SearchType, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(type.startsWith("deep") ? DEEP_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function searchWithExa(
	query: string,
	options: ExaSearchOptions = {},
): Promise<ExaResponse> {
	const apiKey = getExaApiKey();
	if (!apiKey) {
		throw new Error(
			"No Exa API key. Set EXA_API_KEY or add \"exaApiKey\" to ~/.pi/web-tools.json (get one at https://exa.ai).",
		);
	}

	const type = options.type ?? "auto";
	const domains = mapDomainFilter(options.domainFilter);
	// Exa rejects date filters and excludeDomains for the company/people categories (400).
	if (options.category === "company" || options.category === "people") {
		if (options.recencyFilter || domains.excludeDomains) {
			throw new Error(
				`Category "${options.category}" does not support recencyFilter or excluded domains ("-domain"). Remove them and retry.`,
			);
		}
	}

	const startDate = options.recencyFilter ? recencyToStartDate(options.recencyFilter) : null;
	const response = await fetch(EXA_SEARCH_URL, {
		method: "POST",
		headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({
			query,
			type,
			numResults: options.numResults ?? 5,
			...(options.category ? { category: options.category } : {}),
			...domains,
			...(startDate ? { startPublishedDate: startDate } : {}),
			contents: {
				text: { maxCharacters: 2000 },
				highlights: true,
			},
		}),
		signal: requestSignal(type, options.signal),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Exa API error ${response.status}: ${body.slice(0, 300)}`);
	}

	const data = (await response.json()) as ExaApiResponse;
	const results: ExaResult[] = (data.results ?? [])
		.filter((r): r is typeof r & { url: string } => typeof r?.url === "string")
		.map((r, i) => ({
			title: r.title || `Source ${i + 1}`,
			url: r.url,
			text: normalizeHighlights(r.highlights) || (typeof r.text === "string" ? r.text.trim() : ""),
			publishedDate: r.publishedDate,
		}));

	return { query, results };
}

/** Format one or more Exa responses as markdown for the tool output. */
export function formatExaResults(responses: ExaResponse[]): string {
	const blocks = responses.map(({ query, results, error }) => {
		const header = `## Results for "${query}"`;
		if (error) return `${header}\n\n_Error: ${error}_`;
		if (results.length === 0) return `${header}\n\n_No results._`;
		const items = results.map((r, i) => {
			const date = r.publishedDate ? ` — ${r.publishedDate.slice(0, 10)}` : "";
			const snippet = r.text ? `\n${r.text}` : "";
			return `### ${i + 1}. ${r.title}${date}\n${r.url}${snippet}`;
		});
		return `${header}\n\n${items.join("\n\n")}`;
	});
	return blocks.join("\n\n---\n\n");
}
