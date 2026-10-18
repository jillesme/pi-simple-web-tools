import { setTimeout as delay } from "node:timers/promises";
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
	objective?: string;
	maxAgeHours?: number;
	highlightMode?: "standard" | "bounded" | "dynamic";
	highlightMaxCharacters?: number;
	startPublishedDate?: string;
	endPublishedDate?: string;
	additionalQueries?: string[];
	systemPrompt?: string;
	signal?: AbortSignal;
}

export interface ExaResult {
	title: string;
	url: string;
	text: string;
	publishedDate?: string;
}

interface ExaMessage {
	code: string;
	path: string;
	message: string;
}

export interface ExaResponse {
	query: string;
	results: ExaResult[];
	error?: string;
	notices?: ExaMessage[];
	diagnostics?: {
		requestId?: string;
		searchTime?: number;
		costDollars?: unknown;
		warnings?: ExaMessage[];
		attempts: number;
	};
}

interface ExaApiResponse {
	requestId?: string;
	searchTime?: number;
	costDollars?: unknown;
	warnings?: ExaMessage[];
	notices?: ExaMessage[];
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
	const normalized = domainFilter.map((d) => d.trim()).filter(Boolean);
	const include = normalized.filter((d) => !d.startsWith("-"));
	const exclude = normalized
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
	if (!query.trim()) throw new Error("Search query cannot be empty.");
	const count = options.numResults ?? 5;
	if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("numResults must be an integer from 1 to 20.");
	if (options.objective !== undefined && (!options.objective.trim() || options.objective.length > 4096)) {
		throw new Error("objective must contain 1–4096 characters.");
	}
	if (options.maxAgeHours !== undefined && (!Number.isInteger(options.maxAgeHours) || options.maxAgeHours < -1 || options.maxAgeHours > 720)) {
		throw new Error("maxAgeHours must be an integer from -1 to 720.");
	}
	if (options.recencyFilter && options.startPublishedDate) throw new Error("Use recencyFilter or startPublishedDate, not both.");
	for (const value of [options.startPublishedDate, options.endPublishedDate]) {
		if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) {
			throw new Error("Publication dates must be ISO 8601 timestamps.");
		}
	}
	const startDate = options.recencyFilter ? recencyToStartDate(options.recencyFilter) : options.startPublishedDate;
	if (startDate && options.endPublishedDate && Date.parse(startDate) >= Date.parse(options.endPublishedDate)) {
		throw new Error("Publication start date must precede end date.");
	}
	const domains = mapDomainFilter(options.domainFilter);
	if ((options.category === "company" || options.category === "people") && (startDate || options.endPublishedDate)) {
		throw new Error(`Category "${options.category}" does not support publication-date filters.`);
	}
	if (options.category === "people" && domains.excludeDomains) throw new Error('Category "people" does not support excluded domains.');
	if ((options.additionalQueries || options.systemPrompt) && !type.startsWith("deep")) {
		throw new Error("additionalQueries and systemPrompt require a deep search type in this tool.");
	}
	if (options.additionalQueries && (options.additionalQueries.length < 1 || options.additionalQueries.length > 10 || options.additionalQueries.some(q => !q.trim()))) {
		throw new Error("additionalQueries must contain 1–10 non-empty queries.");
	}
	const highlightMode = options.highlightMode ?? "standard";
	if (!["standard", "bounded", "dynamic"].includes(highlightMode)) throw new Error("Unknown highlightMode.");
	if (options.highlightMaxCharacters !== undefined && highlightMode !== "bounded") {
		throw new Error("highlightMaxCharacters requires highlightMode: bounded.");
	}
	const maxCharacters = options.highlightMaxCharacters ?? 2000;
	if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 20000) {
		throw new Error("highlightMaxCharacters must be an integer from 1 to 20000.");
	}
	const highlights = highlightMode === "dynamic" ? { dynamic: true }
		: highlightMode === "bounded" ? { maxCharacters } : true;
	const signal = requestSignal(type, options.signal);
	const body = JSON.stringify({
		query, type, numResults: count, ...domains,
		...(options.category ? { category: options.category } : {}),
		...(options.objective ? { objective: options.objective } : {}),
		...(startDate ? { startPublishedDate: startDate } : {}),
		...(options.endPublishedDate ? { endPublishedDate: options.endPublishedDate } : {}),
		...(options.additionalQueries ? { additionalQueries: options.additionalQueries } : {}),
		...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
		contents: {
			text: { maxCharacters: 2000 },
			highlights,
			...(options.maxAgeHours !== undefined ? { maxAgeHours: options.maxAgeHours } : {}),
		},
	});
	for (let attempt = 1; attempt <= 3; attempt++) {
		signal.throwIfAborted();
		const response = await fetch(EXA_SEARCH_URL, {
			method: "POST",
			headers: {
				"x-api-key": apiKey, "Content-Type": "application/json",
				...(highlightMode === "dynamic" ? { "Exa-Beta": "dynamic-highlights-2026-08-28" } : {}),
			},
			body, signal,
		});
		if (!response.ok) {
			const errorBody = await response.text();
			if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
				const header = response.headers.get("retry-after");
				const seconds = header === null ? NaN : Number(header);
				const retryMs = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : 0;
				await delay(Math.max(500 * 2 ** (attempt - 1) + Math.random() * 250, retryMs || 0), undefined, { signal });
				continue;
			}
			throw new Error(`Exa API error ${response.status} (request ${response.headers.get("x-request-id") ?? "unknown"}): ${errorBody.replaceAll(apiKey, "[REDACTED]").slice(0, 300)}`);
		}
		const data = (await response.json()) as ExaApiResponse;
		if (!Array.isArray(data.results)) throw new Error("Invalid Exa response: missing results array.");
		const results: ExaResult[] = data.results
			.filter((r): r is typeof r & { url: string } => typeof r?.url === "string")
			.map((r, i) => ({
				title: r.title || `Source ${i + 1}`,
				url: r.url,
				text: normalizeHighlights(r.highlights) || (typeof r.text === "string" ? r.text.trim() : ""),
				publishedDate: r.publishedDate,
			}));
		return {
			query, results, notices: data.notices,
			diagnostics: {
				requestId: data.requestId ?? response.headers.get("x-request-id") ?? undefined,
				searchTime: data.searchTime, costDollars: data.costDollars,
				warnings: data.warnings, attempts: attempt,
			},
		};
	}
	throw new Error("Exa retry limit exceeded.");
}

/** Format one or more Exa responses as markdown for the tool output. */
export function formatExaResults(responses: ExaResponse[]): string {
	const blocks = responses.map(({ query, results, error, notices }) => {
		const notes = notices?.map((notice) => `Notice (${notice.code}): ${notice.message}`).join("\n");
		const header = `## Results for "${query}"${notes ? `\n\n${notes}` : ""}`;
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
