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
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const PLAYWRIGHT_HINT =
	"Install the browser fallback to render JS/bot-protected pages: in the pi-simple-web-tools extension directory run " +
	"`npm i -D playwright && npx playwright install chromium`";

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
	renderer: "markdown" | "http" | "playwright" | "pdf" | null;
	/** True when served from the in-memory cache. */
	cached?: boolean;
}

export interface FetchOptions {
	/** Skip plain HTTP and render with a headless browser directly. */
	forceBrowser?: boolean;
	signal?: AbortSignal;
}

/** HTTP result, plus whether a headless browser might succeed where plain HTTP failed. */
type HttpResult = FetchedContent & { browserMayHelp?: boolean };

/** Successful results keyed by mode + URL. Map insertion order gives cheap oldest-first eviction. */
const cache = new Map<string, { result: FetchedContent; expires: number }>();

function cacheKey(url: string, forceBrowser: boolean): string {
	return `${forceBrowser ? "browser" : "auto"}:${url}`;
}

function cacheGet(key: string): FetchedContent | null {
	const entry = cache.get(key);
	if (!entry) return null;
	if (entry.expires < Date.now()) {
		cache.delete(key);
		return null;
	}
	return { ...entry.result, cached: true };
}

function cacheSet(key: string, result: FetchedContent): void {
	cache.delete(key);
	cache.set(key, { result, expires: Date.now() + CACHE_TTL_MS });
	if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
}

/** Error message including the underlying cause (e.g. ENOTFOUND, ECONNREFUSED) that fetch hides behind "fetch failed". */
function errorMessage(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	if (err.name === "TimeoutError") return `Timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`;
	const cause = err.cause as { code?: string; message?: string } | undefined;
	const detail = cause?.code || cause?.message;
	return detail && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message;
}

/** Human-friendly explanation for an HTTP error status, and whether a real browser might get past it. */
function describeHttpError(status: number, statusText: string): { message: string; browserMayHelp: boolean } {
	const base = `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
	if (status === 401 || status === 403)
		return { message: `${base}: access denied — the site may block automated requests or require login`, browserMayHelp: true };
	if (status === 402 || status === 451)
		return { message: `${base}: content is paywalled or legally restricted`, browserMayHelp: false };
	if (status === 404 || status === 410) return { message: `${base}: page not found`, browserMayHelp: false };
	if (status === 429) return { message: `${base}: rate limited — wait before retrying`, browserMayHelp: false };
	if (status >= 500) return { message: `${base}: server error — may be temporary, retry later`, browserMayHelp: status === 503 };
	return { message: base, browserMayHelp: false };
}

/** Detect bot-protection interstitials (Cloudflare, DataDome, captchas) served with a 200/403/503. */
function isBotChallenge(html: string): boolean {
	return /(<title>\s*(just a moment|attention required|access denied|verify you are human)|cf-chl-|challenge-platform|captcha-delivery\.com|g-recaptcha|h-captcha)/i.test(
		html.slice(0, 50_000),
	);
}

/** Heuristic for paywalled/login-walled articles where only a teaser is visible. */
function looksPaywalled(html: string): boolean {
	return /("isAccessibleForFree"\s*:\s*"?false|class="[^"]*(paywall|subscriber-only|premium-content))/i.test(html);
}

/** Title from the first markdown heading, falling back to the URL basename. */
function firstHeadingTitle(text: string, url: string): string {
	return (
		text.match(/^#{1,6}\s+(.+)/m)?.[1]?.trim() ||
		urlBasename(url)
	);
}

function urlBasename(url: string): string {
	try {
		return new URL(url).pathname.split("/").filter(Boolean).pop() || url;
	} catch {
		return url;
	}
}

function isPdf(url: string, mediaType: string): boolean {
	return mediaType === "application/pdf" || urlBasename(url).toLowerCase().endsWith(".pdf");
}

/** Extract PDF text page-by-page (with page markers) via unpdf, lazily loaded. */
async function extractPdfText(buffer: ArrayBuffer, url: string): Promise<string> {
	const { getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(new Uint8Array(buffer));
	const lines: string[] = [`# ${urlBasename(url)}`, "", `> Source: ${url}`, `> Pages: ${pdf.numPages}`, "", "---", ""];
	for (let i = 1; i <= pdf.numPages; i++) {
		const page = await pdf.getPage(i);
		const content = await page.getTextContent();
		const pageText = content.items
			.map((item) => (item as { str?: string }).str ?? "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (!pageText) continue;
		if (i > 1) lines.push("", `<!-- Page ${i} -->`, "");
		lines.push(pageText);
	}
	return lines.join("\n");
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
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
		const response = await page.goto(url, { waitUntil: "networkidle", timeout: DEFAULT_TIMEOUT_MS });
		if (response && response.status() >= 400) {
			throw new Error(describeHttpError(response.status(), response.statusText()).message);
		}
		const html = await page.content();
		if (isBotChallenge(html)) throw new Error("Blocked by a bot-protection challenge (captcha / Cloudflare) even in the browser");
		return html;
	} finally {
		await browser.close();
	}
}

async function extractViaHttp(url: string, signal?: AbortSignal): Promise<HttpResult> {
	const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
	try {
		const response = await fetchRemoteUrl(
			url,
			{ signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: BROWSER_HEADERS },
			{ allowRanges: getSsrfAllowRanges() },
		);

		if (!response.ok) {
			const { message, browserMayHelp } = describeHttpError(response.status, response.statusText);
			// Bot walls often come back as 403/503 with a challenge page.
			const body = await response.text().catch(() => "");
			return isBotChallenge(body)
				? err(url, `${message} (bot-protection challenge detected)`, true)
				: err(url, message, browserMayHelp);
		}

		const contentType = response.headers.get("content-type") || "";
		const mediaType = contentType.split(";")[0].trim().toLowerCase();
		const pdf = isPdf(url, mediaType);
		const contentLength = Number(response.headers.get("content-length") ?? 0);
		const maxBytes = pdf ? MAX_PDF_BYTES : MAX_RESPONSE_BYTES;
		if (contentLength > maxBytes) {
			return err(url, `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`);
		}

		if (pdf) {
			try {
				const content = await extractPdfText(await response.arrayBuffer(), url);
				return content.trim()
					? { url, title: urlBasename(url), content, error: null, renderer: "pdf" }
					: err(url, "PDF contained no extractable text (may be scanned/image-only)");
			} catch (e) {
				return err(url, `PDF extraction failed: ${errorMessage(e)}`);
			}
		}

		if (/(application\/octet-stream|image\/|audio\/|video\/|application\/zip)/.test(contentType)) {
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

		if (isBotChallenge(text)) {
			return err(url, "Blocked by a bot-protection challenge (captcha / Cloudflare)", true);
		}

		const parsed = htmlToMarkdown(text);
		if (parsed && parsed.markdown.length >= MIN_USEFUL_CONTENT) {
			return { url, title: parsed.title, content: parsed.markdown, error: null, renderer: "http" };
		}

		if (looksPaywalled(text)) {
			return err(url, "Content appears to be behind a paywall or login (only a teaser is available)", false);
		}
		return err(
			url,
			isLikelyJSRendered(text)
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML",
			true,
		);
	} catch (e) {
		if (isAbortError(e) && signal?.aborted) return err(url, "Aborted");
		return err(url, errorMessage(e));
	}
}

function err(url: string, error: string, browserMayHelp = false): HttpResult {
	return { url, title: "", content: "", error, renderer: null, browserMayHelp };
}

/** Strip the internal browserMayHelp flag before returning results to the tool. */
function publicResult({ browserMayHelp: _, ...result }: HttpResult): FetchedContent {
	return result;
}

async function extractContent(url: string, options: FetchOptions): Promise<FetchedContent> {
	const { signal, forceBrowser = false } = options;
	if (signal?.aborted) return publicResult(err(url, "Aborted"));

	const key = cacheKey(url, forceBrowser);
	const cached = cacheGet(key);
	if (cached) return cached;

	const result = publicResult(await extractUncached(url, forceBrowser, signal));
	if (!result.error) cacheSet(key, result);
	return result;
}

async function extractUncached(url: string, forceBrowser: boolean, signal?: AbortSignal): Promise<HttpResult> {
	try {
		await validateRemoteUrl(url, { allowRanges: getSsrfAllowRanges() });
	} catch (e) {
		return err(url, errorMessage(e));
	}

	const httpResult = forceBrowser ? null : await extractViaHttp(url, signal);
	// Don't waste a browser launch on errors a browser can't fix (404, timeouts, DNS, paywalls, ...).
	if (httpResult && (!httpResult.error || signal?.aborted || !httpResult.browserMayHelp)) return httpResult;
	// Prefix browser errors with the original HTTP failure so the agent sees both.
	const prefix = httpResult ? `${httpResult.error} — ` : "";

	// Render the page in a real browser for client-side-rendered or bot-protected pages.
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
			return err(url, `${prefix}browser render found no readable content`);
		}
	} catch (e) {
		if (signal?.aborted) return err(url, "Aborted");
		const reason = e instanceof Error && e.name === "TimeoutError" ? `timed out after ${DEFAULT_TIMEOUT_MS / 1000}s` : errorMessage(e);
		return err(url, `${prefix}browser render failed: ${reason}`);
	}

	// Playwright not installed: return the HTTP error with a hint.
	return err(url, `${prefix}Playwright is not installed. ${PLAYWRIGHT_HINT}`);
}

export async function fetchAllContent(urls: string[], options: FetchOptions = {}): Promise<FetchedContent[]> {
	return Promise.all(urls.map((url) => fetchLimit(() => extractContent(url, options))));
}
