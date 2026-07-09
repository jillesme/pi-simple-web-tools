import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Config lives in `~/.pi/web-tools.json` (override with PI_WEB_TOOLS_CONFIG).
 * Every field is optional except that Exa search requires an API key, provided
 * here as `exaApiKey` or via the EXA_API_KEY environment variable.
 *
 * {
 *   "exaApiKey": "exa-...",
 *   "ssrf": { "allowRanges": ["198.18.0.0/15"] }
 * }
 */
export interface WebToolsConfig {
	exaApiKey?: unknown;
	ssrf?: { allowRanges?: unknown };
}

export const CONFIG_PATH =
	process.env.PI_WEB_TOOLS_CONFIG ?? join(homedir(), ".pi", "web-tools.json");

let cached: WebToolsConfig | null = null;

function loadConfig(): WebToolsConfig {
	if (cached) return cached;
	if (!existsSync(CONFIG_PATH)) {
		cached = {};
		return cached;
	}
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cached = JSON.parse(raw) as WebToolsConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
	return cached;
}

function normalizeString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function getExaApiKey(): string | null {
	return normalizeString(process.env.EXA_API_KEY) ?? normalizeString(loadConfig().exaApiKey);
}

/** CIDR ranges to exempt from the SSRF guard (TUN/fake-IP proxies). */
export function getSsrfAllowRanges(): string[] {
	const value = loadConfig().ssrf?.allowRanges;
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		throw new Error(`ssrf.allowRanges in ${CONFIG_PATH} must be an array of CIDR strings`);
	}
	return value
		.map((entry) => {
			if (typeof entry !== "string") {
				throw new Error(`ssrf.allowRanges in ${CONFIG_PATH} must contain only CIDR strings`);
			}
			return entry.trim();
		})
		.filter((entry) => entry.length > 0);
}
