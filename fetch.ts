import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import pLimit from "p-limit";
import { fetchRemoteUrl, validateRemoteUrl } from "./ssrf.ts";
import { getSsrfAllowRanges } from "./config.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const CONCURRENT_LIMIT = 3;
const MIN_USEFUL_CONTENT = 500;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const BROWSER_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
	// Prefer server-negotiated markdown, fall back to HTML (acceptmarkdown.com convention).
	Accept: "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, */*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Upgrade-Insecure-Requests": "1",
};

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
const fetchLimit = pLimit(CONCURRENT_LIMIT);

export interface FetchedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	renderer: "markdown" | "http" | "playwright" | null;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Title from the first markdown heading, falling back to the URL basename. */
function firstHeadingTitle(text: string, url: string): string {
	return (
		text.match(/^#{1,6}\s+(.+)/m)?.[1]?.trim() ||
		new URL(url).pathname.split("/").filter(Boolean).pop() ||
		url
	);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

/** Heuristic: little text but many scripts suggests client-side rendering. */
function isLikelyJSRendered(html: string): boolean {
	const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? "";
	const text = body
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const scriptCount = (html.match(/<script/gi) || []).length;
	return text.length < 500 && scriptCount > 3;
}

/** Run Readability + Turndown over raw HTML. Returns null if no readable article. */
function htmlToMarkdown(html: string): { title: string; markdown: string } | null {
	const { document } = parseHTML(html);
	const article = new Readability(document as unknown as Document).parse();
	if (!article?.content) return null;
	return { title: article.title || "", markdown: turndown.turndown(article.content) };
}

/**
 * Turndown the whole <body> (minus scripts/styles). Used only as a last resort
 * after a browser render, where Readability may reject short/app-shell content
 * (e.g. a bare "Hello World" SPA) that we still want to return.
 */
function bodyToMarkdown(html: string): { title: string; markdown: string } | null {
	const { document } = parseHTML(html);
	const body = document.querySelector("body");
	if (!body) return null;
	for (const el of Array.from(body.querySelectorAll("script,style,noscript,template"))) el.remove();
	const markdown = turndown.turndown(body.innerHTML).trim();
	if (!markdown) return null;
	const title = document.querySelector("title")?.textContent?.trim() || "";
	return { title, markdown };
}

/**
 * Lazy Playwright fallback for client-side-rendered pages. Returns rendered HTML,
 * or null when Playwright is not installed. Enable it with:
 *   npm i -D playwright && npx playwright install chromium   (in this extension dir)
 */
async function renderWithPlaywright(url: string, signal?: AbortSignal): Promise<string | null> {
	let chromium: typeof import("playwright").chromium;
	try {
		({ chromium } = await import("playwright"));
	} catch {
		return null;
	}
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ userAgent: BROWSER_HEADERS["User-Agent"] });
		if (signal) signal.addEventListener("abort", () => void page.close().catch(() => {}), { once: true });
		await page.goto(url, { waitUntil: "networkidle", timeout: DEFAULT_TIMEOUT_MS });
		return await page.content();
	} finally {
		await browser.close();
	}
}

async function extractViaHttp(url: string, signal?: AbortSignal): Promise<FetchedContent> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetchRemoteUrl(
			url,
			{ signal: controller.signal, headers: BROWSER_HEADERS },
			{ allowRanges: getSsrfAllowRanges() },
		);

		if (!response.ok) {
			return err(url, `HTTP ${response.status}: ${response.statusText}`);
		}

		const contentType = response.headers.get("content-type") || "";
		const mediaType = contentType.split(";")[0].trim().toLowerCase();
		const contentLength = Number(response.headers.get("content-length") ?? 0);
		if (contentLength > MAX_RESPONSE_BYTES) {
			return err(url, `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`);
		}
		if (/(application\/octet-stream|image\/|audio\/|video\/|application\/zip|application\/pdf)/.test(contentType)) {
			return err(url, `Unsupported content type: ${mediaType}`);
		}

		const text = await response.text();

		// Server negotiated markdown (Content-Type: text/markdown): it's already clean,
		// so return it as-is and skip Readability/Turndown entirely.
		if (mediaType === "text/markdown" || mediaType === "text/x-markdown" || mediaType === "application/markdown") {
			return { url, title: firstHeadingTitle(text, url), content: text, error: null, renderer: "markdown" };
		}

		const isHTML = mediaType === "text/html" || mediaType === "application/xhtml+xml";
		if (!isHTML) {
			return { url, title: firstHeadingTitle(text, url), content: text, error: null, renderer: "http" };
		}

		const parsed = htmlToMarkdown(text);
		if (parsed && parsed.markdown.length >= MIN_USEFUL_CONTENT) {
			return { url, title: parsed.title, content: parsed.markdown, error: null, renderer: "http" };
		}

		return err(
			url,
			isLikelyJSRendered(text)
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML",
		);
	} catch (e) {
		return err(url, errorMessage(e));
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

function err(url: string, error: string): FetchedContent {
	return { url, title: "", content: "", error, renderer: null };
}

async function extractContent(url: string, signal?: AbortSignal): Promise<FetchedContent> {
	if (signal?.aborted) return err(url, "Aborted");

	try {
		await validateRemoteUrl(url, { allowRanges: getSsrfAllowRanges() });
	} catch (e) {
		return err(url, errorMessage(e));
	}

	const httpResult = await extractViaHttp(url, signal);
	if (!httpResult.error || signal?.aborted) return httpResult;

	// Fallback: render the page in a real browser for client-side-rendered apps.
	try {
		const rendered = await renderWithPlaywright(url, signal);
		if (rendered) {
			// Prefer Readability's article extraction; fall back to the full body so
			// short SPA pages aren't discarded now that we have the real rendered DOM.
			const parsed = htmlToMarkdown(rendered) ?? bodyToMarkdown(rendered);
			if (parsed && parsed.markdown.trim().length > 0) {
				return {
					url,
					title: parsed.title || firstHeadingTitle(parsed.markdown, url),
					content: parsed.markdown,
					error: null,
					renderer: "playwright",
				};
			}
			return err(url, `${httpResult.error} (Playwright render found no readable content)`);
		}
	} catch (e) {
		if (isAbortError(e)) return err(url, "Aborted");
		return err(url, `${httpResult.error} — Playwright fallback failed: ${errorMessage(e)}`);
	}

	// Playwright not installed: return the HTTP error with a hint.
	return err(
		url,
		`${httpResult.error}. Install the browser fallback to render JS pages: ` +
			"cd ~/.pi/agent/extensions/web-tools && npm i -D playwright && npx playwright install chromium",
	);
}

export async function fetchAllContent(urls: string[], signal?: AbortSignal): Promise<FetchedContent[]> {
	return Promise.all(urls.map((url) => fetchLimit(() => extractContent(url, signal))));
}
