/**
 * pi-tinyfish — TinyFish web services for Pi.
 *
 * TinyFish Search, Fetch, Agent, and Browser APIs exposed as Pi tools.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SEARCH_ENDPOINT = "https://api.search.tinyfish.ai";
const FETCH_ENDPOINT = "https://api.fetch.tinyfish.ai";
const AGENT_ENDPOINT = "https://agent.tinyfish.ai/v1/automation/run";
const WALLET_ENDPOINT = "https://agent.tinyfish.ai/v1/wallet";
const BROWSER_ENDPOINT = "https://api.browser.tinyfish.ai";
const MAX_OUTPUT_BYTES = 48_000;
const BROWSER_SESSIONS_FILE = join(homedir(), ".pi", "agent", "tinyfish-browser-sessions.json");

type BrowserSessionRecord = {
	session_id: string;
	url?: string;
	created_at: string;
};

async function loadBrowserSessions(): Promise<BrowserSessionRecord[]> {
	try {
		const text = await readFile(BROWSER_SESSIONS_FILE, "utf8");
		const value = JSON.parse(text);
		return Array.isArray(value) ? value : [];
	} catch {
		return [];
	}
}

async function saveBrowserSessions(sessions: BrowserSessionRecord[]): Promise<void> {
	await mkdir(dirname(BROWSER_SESSIONS_FILE), { recursive: true });
	await writeFile(BROWSER_SESSIONS_FILE, JSON.stringify(sessions, null, 2), "utf8");
}

function requireKey(key: string | undefined): string {
	if (!key) {
		throw new Error(
			"TinyFish API key is not configured. Run /login, select TinyFish, and enter the API key, " +
			"or set TINYFISH_API_KEY.",
		);
	}
	return key;
}

async function getApiKey(ctx: ExtensionContext): Promise<string> {
	const resolved = await ctx.modelRegistry.getProviderAuth("tinyfish");
	return requireKey(resolved?.auth.apiKey);
}

function compactJson(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;

	let result = text;
	while (Buffer.byteLength(result, "utf8") > MAX_OUTPUT_BYTES - 160) {
		result = result.slice(0, Math.floor(result.length * 0.9));
	}
	return `${result}\n\n[Output truncated by pi-tinyfish; the remote response was larger than 48 KB.]`;
}

async function tinyfishRequest(
	url: string,
	init: RequestInit,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<unknown> {
	const key = await getApiKey(ctx);
	const response = await fetch(url, {
		...init,
		signal,
		headers: {
			"X-API-Key": key,
			...(init.headers || {}),
		},
	});
	const bodyText = await response.text();
	let body: unknown = bodyText;
	try {
		body = bodyText ? JSON.parse(bodyText) : {};
	} catch {
		// Keep non-JSON error bodies readable.
	}
	if (!response.ok) {
		throw new Error(`TinyFish API ${response.status} ${response.statusText}: ${compactJson(body)}`);
	}
	return body;
}

async function tinyfishSseRequest(
	url: string,
	init: RequestInit,
	ctx: ExtensionContext,
	_signal?: AbortSignal,
): Promise<unknown> {
	const key = await getApiKey(ctx);
	const response = await fetch(url, {
		...init,
		headers: {
			"X-API-Key": key,
			Accept: "text/event-stream",
			...(init.headers || {}),
		},
	});
	const bodyText = await response.text();
	if (!response.ok) throw new Error(`TinyFish API ${response.status} ${response.statusText}: ${compactJson(bodyText)}`);
	const events = bodyText
		.split(/\n\s*\n/)
		.map(block => block.split("\n").find(line => line.startsWith("data: "))?.slice(6))
		.filter(Boolean)
		.map(value => {
			try { return JSON.parse(value as string) as Record<string, unknown>; } catch { return { raw: value }; }
		});
	const complete = events.find(event => event.type === "COMPLETE") as Record<string, unknown> | undefined;
	return complete || events[events.length - 1] || { status: "UNKNOWN", raw: bodyText };
}

function okResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function searchResults(data: unknown): Array<Record<string, any>> {
	if (!data || typeof data !== "object") return [];
	const results = (data as { results?: unknown }).results;
	return Array.isArray(results) ? results as Array<Record<string, any>> : [];
}

function formatSearchResults(data: unknown): { text: string; count: number } {
	const results = searchResults(data);
	if (results.length === 0) return { text: "No results found.", count: 0 };
	const text = results.map((result, index) => {
		const title = String(result.title || "Untitled");
		const url = String(result.url || "");
		const snippet = String(result.snippet || "").replace(/\s+/g, " ").trim().slice(0, 300);
		const page = result.source_page === undefined ? "" : ` [page ${result.source_page}]`;
		return `${index + 1}. ${title}${page}\n   URL: ${url}${snippet ? `\n   ${snippet}` : ""}`;
	}).join("\n\n");
	return { text, count: results.length };
}

function formatFetchResponse(data: unknown): { text: string; count: number } {
	if (!data || typeof data !== "object") return { text: compactJson(data), count: 0 };
	const results = (data as { results?: unknown }).results;
	if (!Array.isArray(results)) return { text: compactJson(data), count: 0 };
	const text = results.map((item: Record<string, any>, index) => {
		const header = results.length > 1 ? `## ${index + 1}. ${item.title || item.url || "Fetched page"}` : "";
		const metadata = [
			item.url ? `URL: ${item.url}` : "",
			item.final_url && item.final_url !== item.url ? `Final URL: ${item.final_url}` : "",
			item.description ? `Description: ${item.description}` : "",
			item.language ? `Language: ${item.language}` : "",
		].filter(Boolean).join("\n");
		const content = item.text === undefined
			? "(no text content extracted)"
			: typeof item.text === "string" ? item.text : JSON.stringify(item.text, null, 2);
		return [header, metadata, content].filter(Boolean).join("\n\n");
	}).join("\n\n");
	return { text: compactJson(text), count: results.length };
}

function formatAgentResponse(data: unknown): { text: string; status: string; runId?: string; hasResult: boolean } {
	if (!data || typeof data !== "object") {
		return { text: compactJson(data), status: "UNKNOWN", hasResult: false };
	}
	const response = data as Record<string, any>;
	const status = String(response.status || (response.error ? "FAILED" : response.result !== undefined ? "COMPLETED" : "SUBMITTED"));
	const result = response.result ?? response.output ?? response.data;
	const output = result === undefined
		? response.error ? compactJson(response.error) : "(no structured result returned)"
		: typeof result === "string" ? result : JSON.stringify(result, null, 2);
	const text = [
		`Status: ${status}`,
		response.run_id ? `Run ID: ${response.run_id}` : "",
		"",
		"Final result:",
		output,
	].filter(Boolean).join("\n");
	return { text: compactJson(text), status, runId: response.run_id, hasResult: result !== undefined };
}

function formatBrowserResponse(data: unknown): string {
	if (!data || typeof data !== "object") return compactJson(data);
	const response = data as Record<string, any>;
	return [
		"Browser session created.",
		response.session_id ? `Session ID: ${response.session_id}` : "",
		response.cdp_url ? `CDP URL: ${response.cdp_url}` : "",
		response.base_url ? `Base URL: ${response.base_url}` : "",
	].filter(Boolean).join("\n");
}

function joinDomains(values?: string[]): string | undefined {
	return values?.length ? values.join(",") : undefined;
}

export default function (pi: ExtensionAPI) {
	// Register TinyFish only for Pi's unified /login and /logout provider auth.
	// TinyFish is a tools API, not a chat-model provider, so it intentionally
	// registers no models and must not appear in the model selector.
	pi.registerProvider("tinyfish", {
		name: "TinyFish",
		baseUrl: "https://agent.tinyfish.ai/v1",
		apiKey: "$TINYFISH_API_KEY",
		api: "openai-completions",
		models: [],
	});

	pi.registerTool({
		name: "tinyfish_search",
		label: "Web Search",
		description:
			"Search the entire live web for current information, news, discussions, documentation, and other web content. " +
			"Use this for factual or time-sensitive questions before answering. Defaults to deep mode with parallel " +
			"consecutive pages; use simple mode for one page. Supports site operators, domain include/exclude, " +
			"and optional date, location, language, and content-type filters.",
		promptSnippet: "Search the web for current information",
		promptGuidelines: [
			"Use tinyfish_search as the default for factual, current, or time-sensitive questions; search before answering.",
			"It searches the entire web, including news, forums, documentation, blogs, and other public web content.",
			"Deep mode is the default and requests 3 consecutive result pages in parallel; use mode=\"simple\" for one page.",
			"Use site:domain/-site:domain or include_domains/exclude_domains for site filtering; location and language filters are also available.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query. Supports site:domain and -site:domain operators." }),
			mode: Type.Optional(StringEnum(["deep", "simple"] as const, { description: "deep requests multiple pages in parallel; simple requests one page" })),
			rounds: Type.Optional(Type.Integer({ description: "Number of consecutive pages in deep mode; default 3, maximum 10", minimum: 1, maximum: 10 })),
			purpose: Type.Optional(Type.String({ description: "Short explanation of what the search is for" })),
			location: Type.Optional(Type.String({ description: "Country code, e.g. US, GB, JP" })),
			language: Type.Optional(Type.String({ description: "Result language code, e.g. en, zh, ja" })),
			include_domains: Type.Optional(Type.Array(Type.String({ description: "Only return results from these domains, e.g. example.com" }))),
			exclude_domains: Type.Optional(Type.Array(Type.String({ description: "Exclude results from these domains" }))),
			recency_minutes: Type.Optional(Type.Integer({ description: "Only return results published within the last N minutes", minimum: 1 })),
			after_date: Type.Optional(Type.String({ description: "Only return results on or after this date (YYYY-MM-DD)" })),
			before_date: Type.Optional(Type.String({ description: "Only return results on or before this date (YYYY-MM-DD)" })),
			domain_type: Type.Optional(StringEnum(["web", "news", "research_paper"] as const, { description: "Restrict results to web, news, or research papers" })),
			pub_year_min: Type.Optional(Type.Integer({ description: "Minimum publication year" })),
			pub_year_max: Type.Optional(Type.Integer({ description: "Maximum publication year" })),
			include_thumbnail: Type.Optional(Type.Boolean({ description: "Include thumbnail_url when available" })),
			fetch_config: Type.Optional(Type.String({ description: "JSON-encoded fetch configuration object, maximum 256 characters" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const firstPage = 0;
			const deep = (params.mode ?? "deep") === "deep";
			const pageCount = deep ? (params.rounds ?? 3) : 1;
			if (pageCount < 1 || pageCount > 10) {
				throw new Error("rounds must be between 1 and 10");
			}

			const searchPage = async (pageNumber: number) => {
				const query = new URLSearchParams({ query: params.query });
				const optional: Record<string, string | undefined> = {
					purpose: params.purpose,
					location: params.location,
					language: params.language,
					include_domains: joinDomains(params.include_domains),
					exclude_domains: joinDomains(params.exclude_domains),
					recency_minutes: params.recency_minutes?.toString(),
					after_date: params.after_date,
					before_date: params.before_date,
					domain_type: params.domain_type,
					pub_year_min: params.pub_year_min?.toString(),
					pub_year_max: params.pub_year_max?.toString(),
					page: pageNumber.toString(),
					include_thumbnail: params.include_thumbnail === undefined ? undefined : String(params.include_thumbnail),
					fetch_config: params.fetch_config,
				};
				for (const [name, value] of Object.entries(optional)) {
					if (value !== undefined) query.set(name, value);
				}
				return tinyfishRequest(`${SEARCH_ENDPOINT}?${query}`, { method: "GET" }, ctx, signal);
			};

			const pages = await Promise.all(
				Array.from({ length: pageCount }, (_, index) => searchPage(firstPage + index)),
			);
			const pagePayloads = pages as Array<Record<string, any>>;
			const data = pageCount === 1
				? pagePayloads[0]
				: {
					query: params.query,
					first_page: firstPage,
					pages_requested: pageCount,
					total_results: pagePayloads.reduce((sum, page) => sum + (Array.isArray(page.results) ? page.results.length : 0), 0),
					results: pagePayloads.flatMap((page, index) =>
						(Array.isArray(page.results) ? page.results : []).map((result: Record<string, unknown>) => ({
							...result,
							source_page: firstPage + index,
						})),
					),
				};
			const formatted = formatSearchResults(data);
			return {
				content: [{ type: "text" as const, text: formatted.text }],
				details: {
					service: "tinyfish-search",
					query: params.query,
					count: formatted.count,
					pages: pageCount,
				},
			};
		},
		renderCall(args, theme) {
			const mode = args.mode === "simple" ? " [simple]" : ` [deep ×${args.rounds ?? 3}]`;
			const filters = [
				args.include_domains?.length ? `include_domains=${args.include_domains.join(",")}` : undefined,
				args.exclude_domains?.length ? `exclude_domains=${args.exclude_domains.join(",")}` : undefined,
				args.recency_minutes !== undefined ? `recency_minutes=${args.recency_minutes}` : undefined,
				args.after_date ? `after_date=${args.after_date}` : undefined,
				args.before_date ? `before_date=${args.before_date}` : undefined,
				args.location ? `location=${args.location}` : undefined,
				args.language ? `language=${args.language}` : undefined,
				args.domain_type ? `domain_type=${args.domain_type}` : undefined,
				args.pub_year_min !== undefined ? `pub_year_min=${args.pub_year_min}` : undefined,
				args.pub_year_max !== undefined ? `pub_year_max=${args.pub_year_max}` : undefined,
			].filter(Boolean).join(" ");
			const label = `${args.query}${mode}${filters ? ` ${filters}` : ""}`;
			return new Text(theme.fg("toolTitle", theme.bold("tinyfish_search ")) + theme.fg("dim", label), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
			if (result.isError) return new Text(theme.fg("error", "Failed"), 0, 0);
			const count = Number(result.details?.count ?? 0);
			const pages = Number(result.details?.pages ?? 1);
			return new Text(theme.fg(count > 0 ? "success" : "warning", count > 0 ? `✓ ${count} result(s) in ${pages} page(s)` : "No results"), 0, 0);
		},
	});

	pi.registerTool({
		name: "tinyfish_wallet",
		label: "TinyFish Wallet",
		description: "Check the authenticated TinyFish wallet balance and billing status.",
		promptSnippet: "Check TinyFish wallet balance",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const data = await tinyfishRequest(WALLET_ENDPOINT, { method: "GET" }, ctx, signal);
			const wallet = data && typeof data === "object" ? data as Record<string, any> : {};
			const nestedWallet = wallet.wallet && typeof wallet.wallet === "object" ? wallet.wallet : {};
			const balance = wallet.balance ?? wallet.available_balance ?? wallet.wallet_balance ?? wallet.amount ?? nestedWallet.balance;
			const currency = wallet.currency ?? nestedWallet.currency;
			const lines = [
				balance !== undefined ? `Balance: ${balance} ${currency ?? ""}`.trim() : "",
				currency ? `Currency: ${currency}` : "",
				wallet.auto_reload_enabled !== undefined ? `Auto-reload: ${wallet.auto_reload_enabled ? "enabled" : "disabled"}` : "",
				wallet.auto_reload_needs_payment_fix ? "Auto-reload payment method needs attention" : "",
			].filter(Boolean);
			const text = lines.length > 0 ? lines.join("\n") : `Wallet response:\n${compactJson(data)}`;
			return {
				content: [{ type: "text" as const, text }],
				details: { service: "tinyfish-wallet", balance, currency },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("tinyfish_wallet ")) + theme.fg("dim", "wallet status"), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Checking TinyFish wallet..."), 0, 0);
			if (result.isError) return new Text(theme.fg("error", "Wallet check failed"), 0, 0);
			const balance = result.details?.balance;
			const currency = result.details?.currency ?? "";
			return new Text(theme.fg("success", balance === undefined ? "✓ Wallet status received" : `✓ Balance: ${balance} ${currency}`.trim()), 0, 0);
		},
	});

	pi.registerTool({
		name: "tinyfish_fetch",
		label: "Web Fetch",
		description:
			"Fetch and extract clean content from up to 10 known web URLs. " +
			"Use this when you need to read page content without clicking, login, or other interaction.",
		promptSnippet: "Fetch clean content from web URLs",
		parameters: Type.Object({
			urls: Type.Array(Type.String({ description: "One or more http(s) URLs to fetch; maximum 10" })),
			purpose: Type.Optional(Type.String({ description: "Short explanation of what the fetch is for" })),
			format: Type.Optional(StringEnum(["markdown", "html", "json"] as const, { description: "Output format; default markdown" })),
			links: Type.Optional(Type.Boolean({ description: "Include extracted links in the output" })),
			image_links: Type.Optional(Type.Boolean({ description: "Include image URLs in the output" })),
			ttl: Type.Optional(Type.Integer({ description: "Cache freshness tolerance in seconds; use 0 for live fetch" })),
			per_url_timeout_ms: Type.Optional(Type.Integer({ description: "Timeout for each URL in milliseconds; 1-110000" })),
			if_none_match: Type.Optional(Type.String({ description: "ETag from a previous fetch; single URL only" })),
			if_modified_since: Type.Optional(Type.String({ description: "Last-Modified value from a previous fetch; single URL only" })),
			include_etag_and_last_modified: Type.Optional(Type.Boolean({ description: "Return current ETag and Last-Modified values for reuse" })),
			include_selectors: Type.Optional(Type.Array(Type.String({ description: "CSS selectors whose content should be included" }))),
			exclude_selectors: Type.Optional(Type.Array(Type.String({ description: "CSS selectors whose content should be excluded" }))),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.urls.length === 0 || params.urls.length > 10) {
				throw new Error("tinyfish_fetch accepts between 1 and 10 URLs");
			}
			const body: Record<string, unknown> = { urls: params.urls };
			for (const key of [
				"purpose", "format", "links", "image_links", "ttl", "per_url_timeout_ms",
				"if_none_match", "if_modified_since", "include_etag_and_last_modified",
				"include_selectors", "exclude_selectors",
			] as const) {
				const value = params[key];
				if (value !== undefined) body[key] = value;
			}
			const data = await tinyfishRequest(FETCH_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}, ctx, signal);
			const formatted = formatFetchResponse(data);
			return {
				content: [{ type: "text" as const, text: formatted.text }],
				details: { service: "tinyfish-fetch", urls: params.urls, count: formatted.count },
			};
		},
		renderCall(args, theme) {
			const count = args.urls.length > 1 ? ` (${args.urls.length} URLs)` : "";
			const options = [
				args.format ? `format=${args.format}` : undefined,
				args.links ? "links=true" : undefined,
				args.image_links ? "image_links=true" : undefined,
				args.ttl !== undefined ? `ttl=${args.ttl}` : undefined,
				args.include_selectors?.length ? `include_selectors=${args.include_selectors.length}` : undefined,
				args.exclude_selectors?.length ? `exclude_selectors=${args.exclude_selectors.length}` : undefined,
			].filter(Boolean).join(" ");
			return new Text(theme.fg("toolTitle", theme.bold("tinyfish_fetch ")) + theme.fg("dim", `${args.urls[0]}${count}${options ? ` ${options}` : ""}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			if (result.isError) return new Text(theme.fg("error", "Failed"), 0, 0);
			const count = Number(result.details?.count ?? 0);
			return new Text(theme.fg(count > 0 ? "success" : "warning", count > 0 ? `✓ ${count} page(s) fetched` : "No content fetched"), 0, 0);
		},
	});

	pi.registerTool({
		name: "tinyfish_agent",
		label: "Web Agent",
		description:
			"Complete a multi-step task on a real website from a starting URL and natural-language goal. " +
			"The agent may click, submit forms, use saved login state, and cause external side effects, so inspect the goal before calling. " +
			"Request precise structured output when the result will be used programmatically.",
		promptSnippet: "Delegate an interactive website task",
		parameters: Type.Object({
			url: Type.String({ description: "Starting http(s) URL" }),
			goal: Type.String({ description: "Natural-language task and desired output" }),
			endpoint: Type.Optional(StringEnum(["run", "run-async", "run-sse"] as const, { description: "Execution mode: run waits for the result, async returns a run ID, sse streams progress" })),
			browser_profile: Type.Optional(StringEnum(["lite", "stealth"] as const, { description: "Browser profile; lite is faster, stealth is more evasive" })),
			proxy_config: Type.Optional(Type.Object({
				enabled: Type.Optional(Type.Boolean({ description: "Enable proxying for the run" })),
				type: Type.Optional(StringEnum(["tetra", "custom"] as const, { description: "Proxy infrastructure or a custom proxy" }))
				country_code: Type.Optional(StringEnum(["US", "GB", "CA", "DE", "FR", "JP", "AU"] as const, { description: "Proxy country for tetra routing" })),
				url: Type.Optional(Type.String({ description: "Custom proxy URL" })),
				username: Type.Optional(Type.String({ description: "Custom proxy username" })),
				password: Type.Optional(Type.String({ description: "Custom proxy password" })),
			})),
			agent_config: Type.Optional(Type.Object({
				mode: Type.Optional(StringEnum(["default", "strict"] as const, { description: "Agent execution mode; strict is beta and fails fast" })),
				max_steps: Type.Optional(Type.Integer({ description: "Maximum agent steps; beta-gated, 1-500" })),
				max_duration_seconds: Type.Optional(Type.Integer({ description: "Maximum wall-clock runtime in seconds" })),
			})),
			webhook_url: Type.Optional(Type.String({ description: "HTTPS URL for run lifecycle notifications" })),
			capture_config: Type.Optional(Type.Object({
				screenshots: Type.Optional(Type.Boolean({ description: "Capture screenshots" })),
				recording: Type.Optional(Type.Boolean({ description: "Capture a run recording" })),
				html: Type.Optional(Type.Boolean({ description: "Capture HTML artifacts" })),
				snapshots: Type.Optional(Type.Boolean({ description: "Capture page snapshots" })),
				elements: Type.Optional(Type.Boolean({ description: "Capture element artifacts" })),
			})),
			use_profile: Type.Optional(Type.Boolean({ description: "Reuse a saved authenticated Browser Context Profile" })),
			profile_id: Type.Optional(Type.String({ description: "Saved Browser Context Profile ID" })),
			use_vault: Type.Optional(Type.Boolean({ description: "Use saved credentials for login" })),
			credential_item_ids: Type.Optional(Type.Array(Type.String({ description: "Credential URIs allowed for this run" }))),
			output_schema: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "JSON Schema for the returned result" })),
			// Backward-compatible aliases; native callers should use agent_config.
			max_steps: Type.Optional(Type.Integer({ description: "Deprecated alias for agent_config.max_steps" })),
			max_duration_seconds: Type.Optional(Type.Integer({ description: "Deprecated alias for agent_config.max_duration_seconds" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Stage 1/3: Preparing the remote browser and task..." }] });
			const body: Record<string, unknown> = {
				url: params.url,
				goal: params.goal,
			};
			for (const key of [
				"browser_profile", "proxy_config", "webhook_url", "capture_config",
				"use_profile", "profile_id", "use_vault", "credential_item_ids", "output_schema",
			] as const) {
				const value = params[key];
				if (value !== undefined) body[key] = value;
			}
			const agentConfig: Record<string, unknown> = { ...(params.agent_config || {}) };
			if (params.max_steps !== undefined && agentConfig.max_steps === undefined) agentConfig.max_steps = params.max_steps;
			if (params.max_duration_seconds !== undefined && agentConfig.max_duration_seconds === undefined) agentConfig.max_duration_seconds = params.max_duration_seconds;
			if (Object.keys(agentConfig).length > 0) body.agent_config = agentConfig;
			onUpdate?.({ content: [{ type: "text", text: "Stage 2/3: Navigating the site and executing the goal..." }] });

			const endpoint = params.endpoint ?? "run";
			const endpointUrl = AGENT_ENDPOINT.replace(/\/run$/, `/${endpoint}`);
			const requestInit: RequestInit = {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			};
			const data = endpoint === "run-sse"
				? await tinyfishSseRequest(endpointUrl, requestInit, ctx, signal)
				: await tinyfishRequest(endpointUrl, requestInit, ctx, signal);
			const formatted = formatAgentResponse(data);
			onUpdate?.({ content: [{ type: "text", text: `Stage 3/3: Agent ${formatted.status.toLowerCase()}; final result received.` }] });
			return {
				content: [{ type: "text" as const, text: formatted.text }],
				details: {
					service: "tinyfish-agent",
					url: params.url,
					endpoint,
					status: formatted.status,
					run_id: formatted.runId,
					has_result: formatted.hasResult,
				},
			};
		},
		renderCall(args, theme) {
			const options = [
				args.endpoint ? `endpoint=${args.endpoint}` : undefined,
				args.browser_profile ? `browser_profile=${args.browser_profile}` : undefined,
				args.agent_config?.mode ? `mode=${args.agent_config.mode}` : undefined,
				args.agent_config?.max_steps !== undefined ? `max_steps=${args.agent_config.max_steps}` : undefined,
				args.agent_config?.max_duration_seconds !== undefined ? `max_duration_seconds=${args.agent_config.max_duration_seconds}` : undefined,
				args.proxy_config?.enabled ? `proxy=${args.proxy_config.type ?? "enabled"}` : undefined,
				args.use_profile ? "use_profile=true" : undefined,
				args.use_vault ? "use_vault=true" : undefined,
			].filter(Boolean).join(" ");
			return new Text(theme.fg("toolTitle", theme.bold("tinyfish_agent ")) + theme.fg("dim", `${args.url} — ${args.goal}${options ? ` [${options}]` : ""}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Agent is executing..."), 0, 0);
			if (result.isError) return new Text(theme.fg("error", "Agent failed"), 0, 0);
			const status = String(result.details?.status ?? "completed");
			return new Text(theme.fg(status.toUpperCase() === "COMPLETED" ? "success" : "warning", `✓ Agent ${status.toLowerCase()} — final result available`), 0, 0);
		},
	});

	pi.registerTool({
		name: "tinyfish_browser_session",
		label: "Browser Session",
		description:
			"Manage a browser session in one tool: list locally tracked sessions, create a session and return its CDP connection URL, " +
			"or terminate an existing session by ID. Use the CDP URL with Playwright, Puppeteer, or another CDP client to control the browser. " +
			"The list is local and cannot discover sessions created elsewhere.",
		promptSnippet: "Create, control, or terminate a browser session",
		parameters: Type.Object({
			action: Type.Optional(StringEnum(["list", "create", "close"] as const, { description: "List tracked sessions, create a session, or close an existing session; default create" })),
			url: Type.Optional(Type.String({ description: "Initial http(s) URL when creating a session" })),
			timeout_seconds: Type.Optional(Type.Integer({ description: "Browser inactivity timeout in seconds; 5-86400" })),
			browser_profile: Type.Optional(StringEnum(["lite", "stealth"] as const, { description: "Browser profile; lite is faster, stealth is more evasive" })),
			session_id: Type.Optional(Type.String({ description: "Existing session ID; required when action is close" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const action = params.action ?? "create";
			const tracked = await loadBrowserSessions();
			if (action === "list") {
				const text = tracked.length === 0
					? "No locally tracked browser sessions. The Browser API does not provide a global session list."
					: tracked.map((session, index) => `${index + 1}. ${session.session_id}${session.url ? `\n   URL: ${session.url}` : ""}\n   Created: ${session.created_at}`).join("\n\n");
				return {
					content: [{ type: "text" as const, text }],
					details: { service: "tinyfish-browser", action, count: tracked.length, local_only: true },
				};
			}
			if (action === "close") {
				if (!params.session_id) throw new Error("session_id is required when action is close");
				await tinyfishRequest(`${BROWSER_ENDPOINT}/${encodeURIComponent(params.session_id)}`, { method: "DELETE" }, ctx, signal);
				await saveBrowserSessions(tracked.filter(session => session.session_id !== params.session_id));
				return {
					content: [{ type: "text" as const, text: `Browser session terminated: ${params.session_id}` }],
					details: { service: "tinyfish-browser", action, session_id: params.session_id, terminated: true },
				};
			}
			const body: Record<string, unknown> = {};
			if (params.url) body.url = params.url;
			if (params.timeout_seconds !== undefined) body.timeout_seconds = params.timeout_seconds;
			if (params.browser_profile) body.browser_profile = params.browser_profile;
			const data = await tinyfishRequest(BROWSER_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}, ctx, signal);
			const text = formatBrowserResponse(data);
			const sessionId = typeof data === "object" && data ? (data as Record<string, unknown>).session_id : undefined;
			if (typeof sessionId === "string") {
				await saveBrowserSessions([
					...tracked.filter(session => session.session_id !== sessionId),
					{ session_id: sessionId, url: params.url, created_at: new Date().toISOString() },
				]);
			}
			return {
				content: [{ type: "text" as const, text }],
				details: { service: "tinyfish-browser", action, session_id: sessionId },
			};
		},
		renderCall(args, theme) {
			if (args.action === "list") {
				return new Text(theme.fg("toolTitle", theme.bold("tinyfish_browser_session ")) + theme.fg("dim", "list (locally tracked)"), 0, 0);
			}
			if (args.action === "close") {
				return new Text(theme.fg("toolTitle", theme.bold("tinyfish_browser_session ")) + theme.fg("dim", `close ${args.session_id}`), 0, 0);
			}
			const target = args.url ? `${args.url} [${args.browser_profile ?? "lite"}]` : `[${args.browser_profile ?? "lite"}]`;
			const timeout = args.timeout_seconds === undefined ? "" : ` timeout_seconds=${args.timeout_seconds}`;
			return new Text(theme.fg("toolTitle", theme.bold("tinyfish_browser_session ")) + theme.fg("dim", `create ${target}${timeout}`), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Managing browser session..."), 0, 0);
			if (result.isError) return new Text(theme.fg("error", "Browser session operation failed"), 0, 0);
			const action = result.details?.action ?? "create";
			if (action === "list") return new Text(theme.fg("success", `✓ ${result.details?.count ?? 0} locally tracked session(s)`), 0, 0);
			return new Text(theme.fg("success", action === "close" ? "✓ Browser session terminated" : "✓ Browser session created"), 0, 0);
		},
	});

}
