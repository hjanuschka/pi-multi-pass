/**
 * Multi-Subscription extension for pi.
 *
 * Register additional OAuth subscription accounts for any supported provider.
 * Each extra account gets its own provider name, /login entry, and cloned models.
 *
 * Features:
 *   - /subs: manage subscriptions (add, remove, login, logout, status)
 *   - /pool: define provider pools with auto-rotation on rate limit errors
 *   - Project-level pool config: .pi/multi-pass.json overrides global pools
 *   - MULTI_SUB env var for scripting
 *
 * Pool auto-rotation: group subscriptions into pools. When the active sub
 * hits a rate limit or error, automatically switch to the next available
 * sub in the pool and retry. Keeps the same model ID, just rotates the
 * provider/account.
 *
 * Config files:
 *   Global:  ~/.pi/agent/multi-pass.json  (subscriptions + default pools)
 *   Project: .pi/multi-pass.json          (pool overrides + subscription filtering)
 *
 * Project-level config can:
 *   - Define project-specific pools (override global pools)
 *   - Restrict which subscriptions are usable via "allowedSubs"
 *   - Leave pools empty to inherit global pools
 *
 * Supported providers:
 *   - anthropic          (Claude Pro/Max)
 *   - openai-codex       (ChatGPT Plus/Pro Codex)
 *   - github-copilot     (GitHub Copilot)
 *   - google-gemini-cli  (Google Cloud Code Assist)
 *   - google-antigravity (Antigravity)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	AgentEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	DynamicBorder,
	getAgentDir,
	keyHint,
} from "@earendil-works/pi-coding-agent";
import {
	anthropicOAuthProvider,
	loginAnthropic,
	refreshAnthropicToken,
	openaiCodexOAuthProvider,
	loginOpenAICodex,
	refreshOpenAICodexToken,
	githubCopilotOAuthProvider,
	loginGitHubCopilot,
	refreshGitHubCopilotToken,
	getGitHubCopilotBaseUrl,
	normalizeDomain,
	geminiCliOAuthProvider,
	loginGeminiCli,
	refreshGoogleCloudToken,
	antigravityOAuthProvider,
	loginAntigravity,
	refreshAntigravityToken,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";
import { getModels, type Api, type Model } from "@earendil-works/pi-ai";
import {
	Container,
	Key,
	SelectList,
	Text,
	matchesKey,
	type SelectItem,
} from "@earendil-works/pi-tui";

// ==========================================================================
// Provider templates
// ==========================================================================

type CopilotCredentials = OAuthCredentials & { enterpriseUrl?: string };
type GeminiCredentials = OAuthCredentials & { projectId?: string };

interface ProviderTemplate {
	displayName: string;
	builtinOAuth: OAuthProviderInterface;
	usesCallbackServer?: boolean;
	buildOAuth(index: number): Omit<OAuthProviderInterface, "id">;
	buildModifyModels?(providerName: string): OAuthProviderInterface["modifyModels"];
}

const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = {
	anthropic: {
		displayName: "Anthropic (Claude Pro/Max)",
		builtinOAuth: anthropicOAuthProvider,
		buildOAuth(index: number) {
			return {
				name: `Anthropic #${index}`,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginAnthropic({
						onAuth: callbacks.onAuth,
						onPrompt: callbacks.onPrompt,
						onProgress: callbacks.onProgress,
						onManualCodeInput: callbacks.onManualCodeInput,
					});
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					return refreshAnthropicToken(credentials.refresh);
				},
				getApiKey(credentials: OAuthCredentials): string {
					return credentials.access;
				},
			};
		},
	},

	"openai-codex": {
		displayName: "ChatGPT Plus/Pro (Codex)",
		builtinOAuth: openaiCodexOAuthProvider,
		usesCallbackServer: true,
		buildOAuth(index: number) {
			return {
				name: `ChatGPT Codex #${index}`,
				usesCallbackServer: true,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginOpenAICodex({
						onAuth: callbacks.onAuth,
						onPrompt: callbacks.onPrompt,
						onProgress: callbacks.onProgress,
						onManualCodeInput: callbacks.onManualCodeInput,
					});
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					return refreshOpenAICodexToken(credentials.refresh);
				},
				getApiKey(credentials: OAuthCredentials): string {
					return credentials.access;
				},
			};
		},
	},

	"github-copilot": {
		displayName: "GitHub Copilot",
		builtinOAuth: githubCopilotOAuthProvider,
		buildOAuth(index: number) {
			return {
				name: `GitHub Copilot #${index}`,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginGitHubCopilot({
						onAuth: (url: string, instructions?: string) =>
							callbacks.onAuth({ url, instructions }),
						onPrompt: callbacks.onPrompt,
						onProgress: callbacks.onProgress,
						signal: callbacks.signal,
					});
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					const creds = credentials as CopilotCredentials;
					return refreshGitHubCopilotToken(creds.refresh, creds.enterpriseUrl);
				},
				getApiKey(credentials: OAuthCredentials): string {
					return credentials.access;
				},
			};
		},
		buildModifyModels(providerName: string) {
			return (models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] => {
				const creds = credentials as CopilotCredentials;
				const domain = creds.enterpriseUrl
					? (normalizeDomain(creds.enterpriseUrl) ?? undefined)
					: undefined;
				const baseUrl = getGitHubCopilotBaseUrl(creds.access, domain);
				return models.map((m) =>
					m.provider === providerName ? { ...m, baseUrl } : m,
				);
			};
		},
	},

	"google-gemini-cli": {
		displayName: "Google Cloud Code Assist",
		builtinOAuth: geminiCliOAuthProvider,
		usesCallbackServer: true,
		buildOAuth(index: number) {
			return {
				name: `Google Cloud Code Assist #${index}`,
				usesCallbackServer: true,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginGeminiCli(
						callbacks.onAuth,
						callbacks.onProgress,
						callbacks.onManualCodeInput,
					);
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					const creds = credentials as GeminiCredentials;
					if (!creds.projectId) throw new Error("Missing projectId");
					return refreshGoogleCloudToken(creds.refresh, creds.projectId);
				},
				getApiKey(credentials: OAuthCredentials): string {
					const creds = credentials as GeminiCredentials;
					return JSON.stringify({ token: creds.access, projectId: creds.projectId });
				},
			};
		},
	},

	"google-antigravity": {
		displayName: "Antigravity",
		builtinOAuth: antigravityOAuthProvider,
		usesCallbackServer: true,
		buildOAuth(index: number) {
			return {
				name: `Antigravity #${index}`,
				usesCallbackServer: true,
				async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
					return loginAntigravity(
						callbacks.onAuth,
						callbacks.onProgress,
						callbacks.onManualCodeInput,
					);
				},
				async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
					const creds = credentials as GeminiCredentials;
					if (!creds.projectId) throw new Error("Missing projectId");
					return refreshAntigravityToken(creds.refresh, creds.projectId);
				},
				getApiKey(credentials: OAuthCredentials): string {
					const creds = credentials as GeminiCredentials;
					return JSON.stringify({ token: creds.access, projectId: creds.projectId });
				},
			};
		},
	},
};

const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_TEMPLATES);

// ==========================================================================
// Built-in quota checking
// ==========================================================================

const DEFAULT_CODEX_USAGE_BASE_URL = "https://chatgpt.com/backend-api";
const GOOGLE_GEMINI_QUOTA_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const GOOGLE_ANTIGRAVITY_QUOTA_ENDPOINTS = [
	"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
	"https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
] as const;
const GOOGLE_GEMINI_HEADERS = {
	"User-Agent": "google-api-nodejs-client/9.15.1",
	"X-Goog-Api-Client": "gl-node/22.17.0",
};
const GOOGLE_ANTIGRAVITY_HEADERS = {
	"User-Agent": "antigravity/1.11.9 windows/amd64",
	"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"Client-Metadata": JSON.stringify({
		ideType: "IDE_UNSPECIFIED",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI",
	}),
};
const GOOGLE_ANTIGRAVITY_HIDDEN_MODELS = new Set(["tab_flash_lite_preview"]);
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";

type QuotaStatusKind = "ready" | "watch" | "low" | "blocked" | "error" | "missing-auth";

interface AuthStorageEntry {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
	projectId?: string;
	[key: string]: unknown;
}

interface QuotaAccount {
	providerName: string;
	baseProvider: string;
	displayName: string;
	auth?: AuthStorageEntry;
}

interface QuotaCheckResult {
	account: QuotaAccount;
	kind: QuotaStatusKind;
	summary: string;
	details: string[];
	score: number;
}

interface ProviderQuotaChecker {
	baseProvider: string;
	check(account: QuotaAccount, signal?: AbortSignal): Promise<QuotaCheckResult>;
}

interface CodexUsageWindow {
	usedPercent: number;
	windowSeconds: number;
	resetAt?: number;
}

interface CodexUsageSnapshot {
	planType: string;
	email: string;
	fiveHour?: CodexUsageWindow;
	weekly?: CodexUsageWindow;
}

interface GoogleGeminiQuotaResponse {
	buckets?: Array<{
		modelId?: string;
		remainingFraction?: number;
		resetTime?: string;
	}>;
}

interface GoogleAntigravityQuotaResponse {
	models?: Record<
		string,
		{
			displayName?: string;
			model?: string;
			isInternal?: boolean;
			quotaInfo?: {
				remainingFraction?: number;
				resetTime?: string;
			};
		}
	>;
}

interface GoogleQuotaModelSnapshot {
	model: string;
	remainingPercent?: number;
	resetAt?: number;
}

interface GoogleQuotaAccountSnapshot {
	endpoint: string;
	projectId?: string;
	models: GoogleQuotaModelSnapshot[];
	worstRemainingPercent?: number;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length < 2) return {};
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function getCodexTokenMetadata(accessToken: string): {
	accountId?: string;
	planType?: string;
	email?: string;
} {
	const payload = decodeJwtPayload(accessToken);
	const auth = getRecord(payload[OPENAI_AUTH_CLAIM]);
	const profile = getRecord(payload[OPENAI_PROFILE_CLAIM]);
	const accountId = typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	const planType = typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
	const email = typeof profile?.email === "string" ? profile.email : undefined;
	return { accountId, planType, email };
}

function normalizeCodexUsageWindow(window: unknown): CodexUsageWindow | undefined {
	const raw = getRecord(window);
	if (!raw) return undefined;
	const usedPercent = typeof raw.used_percent === "number" ? raw.used_percent : 0;
	const windowSeconds = typeof raw.limit_window_seconds === "number" ? raw.limit_window_seconds : 0;
	const resetAt = typeof raw.reset_at === "number" ? raw.reset_at : undefined;
	return {
		usedPercent,
		windowSeconds,
		resetAt,
	};
}

function matchesUsageWindow(window: CodexUsageWindow | undefined, expectedSeconds: number): boolean {
	if (!window) return false;
	return Math.abs(window.windowSeconds - expectedSeconds) <= 120;
}

function parseCodexUsageSnapshot(data: unknown): CodexUsageSnapshot {
	const raw = getRecord(data);
	const rateLimit = getRecord(raw?.rate_limit);
	const windows = [
		normalizeCodexUsageWindow(rateLimit?.primary_window),
		normalizeCodexUsageWindow(rateLimit?.secondary_window),
	].filter((window): window is CodexUsageWindow => Boolean(window));
	const fiveHour = windows.find((window) => matchesUsageWindow(window, 5 * 60 * 60));
	const weekly = windows.find((window) => matchesUsageWindow(window, 7 * 24 * 60 * 60));
	return {
		planType: typeof raw?.plan_type === "string" ? raw.plan_type : "unknown",
		email: typeof raw?.email === "string" ? raw.email : "",
		fiveHour,
		weekly,
	};
}

function getCodexWindowRemaining(window: CodexUsageWindow | undefined): number | undefined {
	if (!window) return undefined;
	return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function formatResetShort(resetAt?: number): string {
	if (!resetAt) return "--";
	const diffMs = resetAt * 1000 - Date.now();
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.round(diffMs / 60000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `~${days}d`;
	if (hours > 0) return `~${hours}h`;
	return `~${minutes}m`;
}

function formatResetLong(resetAt?: number): string {
	if (!resetAt) return "unknown";
	const diffMs = resetAt * 1000 - Date.now();
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.round(diffMs / 60000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `in ${days}d ${hours}h`;
	if (hours > 0) return `in ${hours}h ${minutes}m`;
	return `in ${minutes}m`;
}

function formatRemainingPercent(value: number | undefined): string {
	if (value === undefined) return "--";
	return `${Math.round(value)}%`;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function parseIsoTimestampSeconds(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.floor(parsed / 1000);
}

async function readResponseError(response: Response): Promise<string> {
	const raw = await response.text();
	if (response.status === 401) {
		return "Unauthorized - log in again";
	}
	if (!raw) {
		return `HTTP ${response.status}`;
	}
	try {
		const parsed = JSON.parse(raw) as {
			error?: { message?: string };
			message?: string;
		};
		const message = parsed.error?.message || parsed.message;
		if (message) return `HTTP ${response.status}: ${message}`;
	} catch {
		// ignore JSON parse errors and fall back to raw text
	}
	return `HTTP ${response.status}: ${raw}`;
}

function classifyCodexQuotaKind(snapshot: CodexUsageSnapshot): {
	kind: QuotaStatusKind;
	score: number;
} {
	const fiveHourLeft = getCodexWindowRemaining(snapshot.fiveHour);
	const weeklyLeft = getCodexWindowRemaining(snapshot.weekly);
	const values = [fiveHourLeft, weeklyLeft].filter((value): value is number => value !== undefined);
	if (values.length === 0) {
		return { kind: "error", score: 0 };
	}
	const bottleneck = Math.min(...values);
	if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
	if (bottleneck <= 15) return { kind: "low", score: bottleneck };
	if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
	return { kind: "ready", score: bottleneck };
}

function formatQuotaKind(kind: QuotaStatusKind): string {
	switch (kind) {
		case "ready":
			return "ready";
		case "watch":
			return "watch";
		case "low":
			return "low";
		case "blocked":
			return "blocked";
		case "missing-auth":
			return "not logged in";
		default:
			return "error";
	}
}

function compareQuotaResults(left: QuotaCheckResult, right: QuotaCheckResult): number {
	const rank = (kind: QuotaStatusKind): number => {
		switch (kind) {
			case "ready":
				return 0;
			case "watch":
				return 1;
			case "low":
				return 2;
			case "blocked":
				return 3;
			case "error":
				return 4;
			case "missing-auth":
				return 5;
		}
	};
	return rank(left.kind) - rank(right.kind)
		|| right.score - left.score
		|| left.account.displayName.localeCompare(right.account.displayName);
}

function getQuotaStatusGlyph(kind: QuotaStatusKind): string {
	switch (kind) {
		case "ready":
			return "✓";
		case "watch":
			return "◔";
		case "low":
			return "!";
		case "blocked":
			return "✕";
		case "missing-auth":
			return "○";
		default:
			return "?";
	}
}

function formatQuotaOverview(results: QuotaCheckResult[]): string {
	const counts = {
		ready: 0,
		watch: 0,
		low: 0,
		blocked: 0,
		error: 0,
		missingAuth: 0,
	};

	for (const result of results) {
		switch (result.kind) {
			case "ready":
				counts.ready++;
				break;
			case "watch":
				counts.watch++;
				break;
			case "low":
				counts.low++;
				break;
			case "blocked":
				counts.blocked++;
				break;
			case "missing-auth":
				counts.missingAuth++;
				break;
			default:
				counts.error++;
		}
	}

	const parts = [`${results.length} ${results.length === 1 ? "account" : "accounts"}`];
	if (counts.ready > 0) parts.push(`${counts.ready} ready`);
	if (counts.watch > 0) parts.push(`${counts.watch} watch`);
	if (counts.low > 0) parts.push(`${counts.low} low`);
	if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
	if (counts.error > 0) parts.push(`${counts.error} error`);
	if (counts.missingAuth > 0) parts.push(`${counts.missingAuth} not logged in`);

	const best = results[0];
	if (best) {
		parts.push(`best now: ${best.account.displayName}`);
	}

	return parts.join(" • ");
}

function formatQuotaCurrentHint(
	results: QuotaCheckResult[],
	currentProviderName: string | undefined,
): string | undefined {
	if (!currentProviderName) return undefined;

	const current = results.find((result) => result.account.providerName === currentProviderName);
	if (!current) return undefined;

	let hint = `Current: ${current.account.displayName} is ${formatQuotaKind(current.kind)}`;
	const best = results[0];
	if (best && best.account.providerName !== current.account.providerName) {
		hint += ` • best available: ${best.account.displayName}`;
	}
	if (current.kind !== "ready") {
		hint += " • snapshot only: auto-switch happens after a runtime rate-limit error";
	}
	return hint;
}

function buildQuotaSelectItems(
	results: QuotaCheckResult[],
	currentProviderName: string | undefined,
): SelectItem[] {
	const bestProviderName = results[0]?.account.providerName;
	return results.map((result) => {
		const badges: string[] = [];
		if (result.account.providerName === currentProviderName) badges.push("current");
		if (result.account.providerName === bestProviderName) badges.push("best now");
		const badgeSuffix = badges.length > 0 ? ` • ${badges.join(" • ")}` : "";

		return {
			value: result.account.providerName,
			label: `${getQuotaStatusGlyph(result.kind)} ${result.account.displayName}`,
			description: `${result.summary}${badgeSuffix}`,
		};
	});
}

function getWrappedSelectIndex(items: SelectItem[], value: string | undefined): number {
	if (!value) return 0;
	const index = items.findIndex((item) => item.value === value);
	return index >= 0 ? index : 0;
}

async function showWrappedSelect(
	ctx: ExtensionCommandContext,
	options: {
		title: string;
		items: SelectItem[];
		subtitle?: string;
		initialValue?: string;
		confirmHint?: string;
		cancelHint?: string;
	},
): Promise<string | undefined> {
	if (options.items.length === 0) return undefined;

	if (!ctx.hasUI) {
		const renderedItems = options.items.map((item) =>
			item.description ? `${item.label} — ${item.description}` : item.label,
		);
		const selected = await ctx.ui.select(options.title, renderedItems);
		if (!selected) return undefined;
		const index = renderedItems.indexOf(selected);
		return index >= 0 ? options.items[index]?.value : undefined;
	}

	const confirmHint = options.confirmHint || "select";
	const cancelHint = options.cancelHint || "close";

	const selectedValue = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		const footer = [
			keyHint("tui.select.confirm", confirmHint),
			keyHint("tui.select.cancel", cancelHint),
		].join(" • ");

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(options.title))));
		if (options.subtitle) {
			container.addChild(new Text(theme.fg("dim", options.subtitle)));
		}

		const selectList = new SelectList(options.items, Math.min(options.items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.setSelectedIndex(getWrappedSelectIndex(options.items, options.initialValue));
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", footer)));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				const current = selectList.getSelectedItem();
				const currentIndex = current
					? options.items.findIndex((item) => item.value === current.value)
					: 0;

				if (matchesKey(data, Key.up) && options.items.length > 1 && currentIndex === 0) {
					selectList.setSelectedIndex(options.items.length - 1);
					tui.requestRender();
					return;
				}

				if (
					matchesKey(data, Key.down)
					&& options.items.length > 1
					&& currentIndex === options.items.length - 1
				) {
					selectList.setSelectedIndex(0);
					tui.requestRender();
					return;
				}

				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return selectedValue ?? undefined;
}

async function runQuotaChecks(
	accounts: QuotaAccount[],
	signal?: AbortSignal,
): Promise<QuotaCheckResult[]> {
	const results = await Promise.all(accounts.map(async (account) => {
		const checker = PROVIDER_QUOTA_CHECKERS.find(
			(candidate) => candidate.baseProvider === account.baseProvider,
		);
		if (!checker) return undefined;
		return checker.check(account, signal);
	}));

	return results
		.filter((result): result is QuotaCheckResult => Boolean(result))
		.sort(compareQuotaResults);
}

async function loadQuotaResults(
	ctx: ExtensionCommandContext,
	accounts: QuotaAccount[],
): Promise<QuotaCheckResult[] | null> {
	if (!ctx.hasUI) {
		return runQuotaChecks(accounts);
	}

	return ctx.ui.custom<QuotaCheckResult[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(
			tui,
			theme,
			`Checking limits across ${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}...`,
		);
		loader.onAbort = () => done(null);

		runQuotaChecks(accounts, loader.signal)
			.then(done)
			.catch((error) => {
				if (loader.signal.aborted) {
					done(null);
					return;
				}
				console.error("Failed to load quota checks", error);
				done(null);
			});

		return loader;
	});
}

async function selectQuotaResult(
	ctx: ExtensionCommandContext,
	results: QuotaCheckResult[],
	preferredProviderName?: string,
): Promise<QuotaCheckResult | undefined> {
	const currentProviderName = preferredProviderName || ctx.model?.provider;
	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Subscription Limits",
		subtitle: [
			"Select an account to inspect its full quota windows.",
			formatQuotaOverview(results),
			formatQuotaCurrentHint(results, currentProviderName),
		].filter(Boolean).join("\n"),
		items: buildQuotaSelectItems(results, currentProviderName),
		initialValue: currentProviderName,
		confirmHint: "inspect",
		cancelHint: "close",
	});
	if (!selectedProviderName) return undefined;
	return results.find((result) => result.account.providerName === selectedProviderName);
}

function normalizeGoogleRemainingPercent(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, Math.round(value * 100)));
}

function getGoogleProjectId(account: QuotaAccount, auth: AuthStorageEntry): string | undefined {
	if (typeof auth.projectId === "string" && auth.projectId.length > 0) {
		return auth.projectId;
	}

	if (account.baseProvider === "google-antigravity") {
		const projectId = process.env.GOOGLE_ANTIGRAVITY_PROJECT_ID || process.env.GOOGLE_ANTIGRAVITY_PROJECT;
		if (projectId) return projectId;
	}

	const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	return projectId || undefined;
}

function updateGoogleQuotaModel(
	modelsByName: Map<string, GoogleQuotaModelSnapshot>,
	model: string,
	remainingPercent: number | undefined,
	resetAt: number | undefined,
): void {
	const existing = modelsByName.get(model);
	if (!existing) {
		modelsByName.set(model, { model, remainingPercent, resetAt });
		return;
	}

	let next = existing;
	if (remainingPercent !== undefined) {
		if (existing.remainingPercent === undefined || remainingPercent < existing.remainingPercent) {
			next = { ...next, remainingPercent };
		}
	}
	if (resetAt !== undefined) {
		if (next.resetAt === undefined || resetAt < next.resetAt) {
			next = { ...next, resetAt };
		}
	}
	if (next !== existing) {
		modelsByName.set(model, next);
	}
}

function buildGoogleQuotaSnapshot(
	endpoint: string,
	projectId: string | undefined,
	modelsByName: Map<string, GoogleQuotaModelSnapshot>,
): GoogleQuotaAccountSnapshot {
	const models = [...modelsByName.values()];
	const remainingPercents = models
		.map((model) => model.remainingPercent)
		.filter((value): value is number => value !== undefined);
	const worstRemainingPercent = remainingPercents.length > 0
		? Math.min(...remainingPercents)
		: undefined;

	return {
		endpoint,
		projectId,
		models,
		worstRemainingPercent,
	};
}

function getGoogleGeminiModelLabel(modelId: string | undefined): string {
	if (!modelId) return "unknown";
	const normalized = modelId.toLowerCase();
	if (normalized.includes("pro")) return "Pro";
	if (normalized.includes("flash")) return "Flash";
	return modelId;
}

function parseGoogleGeminiQuotaSnapshot(
	data: unknown,
	projectId: string | undefined,
): GoogleQuotaAccountSnapshot {
	const raw = getRecord(data) as GoogleGeminiQuotaResponse | undefined;
	const buckets = Array.isArray(raw?.buckets) ? raw.buckets : [];
	const modelsByName = new Map<string, GoogleQuotaModelSnapshot>();

	for (const bucketValue of buckets) {
		const bucket = getRecord(bucketValue);
		const model = getGoogleGeminiModelLabel(
			typeof bucket?.modelId === "string" ? bucket.modelId : undefined,
		);
		const remainingPercent = normalizeGoogleRemainingPercent(bucket?.remainingFraction);
		const resetAt = typeof bucket?.resetTime === "string"
			? parseIsoTimestampSeconds(bucket.resetTime)
			: undefined;
		if (remainingPercent === undefined && resetAt === undefined) continue;
		updateGoogleQuotaModel(modelsByName, model, remainingPercent, resetAt);
	}

	return buildGoogleQuotaSnapshot(GOOGLE_GEMINI_QUOTA_ENDPOINT, projectId, modelsByName);
}

function parseGoogleAntigravityQuotaSnapshot(
	data: unknown,
	endpoint: string,
	projectId: string | undefined,
): GoogleQuotaAccountSnapshot {
	const raw = getRecord(data) as GoogleAntigravityQuotaResponse | undefined;
	const rawModels = getRecord(raw?.models);
	const modelsByName = new Map<string, GoogleQuotaModelSnapshot>();

	if (rawModels) {
		for (const [modelKey, modelValue] of Object.entries(rawModels)) {
			const model = getRecord(modelValue);
			if (model?.isInternal === true) continue;
			if (GOOGLE_ANTIGRAVITY_HIDDEN_MODELS.has(modelKey.toLowerCase())) continue;
			const displayName = typeof model?.displayName === "string" && model.displayName.length > 0
				? model.displayName
				: typeof model?.model === "string" && model.model.length > 0
					? model.model
					: modelKey;
			if (GOOGLE_ANTIGRAVITY_HIDDEN_MODELS.has(displayName.toLowerCase())) continue;
			const quotaInfo = getRecord(model?.quotaInfo);
			const remainingPercent = normalizeGoogleRemainingPercent(quotaInfo?.remainingFraction);
			const resetAt = typeof quotaInfo?.resetTime === "string"
				? parseIsoTimestampSeconds(quotaInfo.resetTime)
				: undefined;
			if (remainingPercent === undefined && resetAt === undefined) continue;
			updateGoogleQuotaModel(modelsByName, displayName, remainingPercent, resetAt);
		}
	}

	return buildGoogleQuotaSnapshot(endpoint, projectId, modelsByName);
}

function classifyGoogleQuotaKind(snapshot: GoogleQuotaAccountSnapshot): {
	kind: QuotaStatusKind;
	score: number;
} {
	const bottleneck = snapshot.worstRemainingPercent;
	if (bottleneck === undefined) {
		return { kind: "error", score: 0 };
	}
	if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
	if (bottleneck <= 15) return { kind: "low", score: bottleneck };
	if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
	return { kind: "ready", score: bottleneck };
}

async function resolveGoogleQuotaAccess(
	account: QuotaAccount,
	auth: AuthStorageEntry,
): Promise<{ accessToken: string; projectId?: string }> {
	const projectId = getGoogleProjectId(account, auth);
	const hasFreshAccess = typeof auth.access === "string"
		&& auth.access.length > 0
		&& (typeof auth.expires !== "number" || auth.expires > Date.now() + 60_000);
	if (hasFreshAccess) {
		return { accessToken: auth.access, projectId };
	}

	if (typeof auth.refresh === "string" && auth.refresh.length > 0) {
		const credentials = account.baseProvider === "google-gemini-cli"
			? await refreshGoogleCloudToken(auth.refresh, projectId || "") as Promise<GeminiCredentials>
			: await refreshAntigravityToken(auth.refresh, projectId || "") as Promise<GeminiCredentials>;
		return {
			accessToken: credentials.access,
			projectId: typeof credentials.projectId === "string" && credentials.projectId.length > 0
				? credentials.projectId
				: projectId,
		};
	}

	if (typeof auth.access === "string" && auth.access.length > 0) {
		return { accessToken: auth.access, projectId };
	}

	throw new Error("Missing Google access token. Log in again.");
}

async function fetchGoogleGeminiQuotaSnapshot(
	accessToken: string,
	projectId: string | undefined,
	signal?: AbortSignal,
): Promise<GoogleQuotaAccountSnapshot> {
	const response = await fetch(GOOGLE_GEMINI_QUOTA_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			...GOOGLE_GEMINI_HEADERS,
		},
		body: "{}",
		signal,
	});
	if (!response.ok) {
		throw new Error(await readResponseError(response));
	}
	return parseGoogleGeminiQuotaSnapshot(await response.json(), projectId);
}

async function fetchGoogleAntigravityQuotaSnapshot(
	accessToken: string,
	projectId: string | undefined,
	signal?: AbortSignal,
): Promise<GoogleQuotaAccountSnapshot> {
	let lastError = "Google quota lookup failed";

	for (const endpoint of GOOGLE_ANTIGRAVITY_QUOTA_ENDPOINTS) {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
				"Content-Type": "application/json",
				...GOOGLE_ANTIGRAVITY_HEADERS,
			},
			body: JSON.stringify(projectId ? { project: projectId } : {}),
			signal,
		});
		if (response.ok) {
			return parseGoogleAntigravityQuotaSnapshot(await response.json(), endpoint, projectId);
		}
		lastError = await readResponseError(response);
	}

	throw new Error(lastError);
}

function getGoogleQuotaBucketLabel(account: QuotaAccount, count: number): string {
	if (account.baseProvider === "google-gemini-cli") {
		return `${count} ${count === 1 ? "family" : "families"}`;
	}
	return `${count} ${count === 1 ? "model" : "models"}`;
}

function buildGoogleQuotaErrorDetails(
	account: QuotaAccount,
	message: string,
	projectId?: string,
): string[] {
	const details = [
		`account: ${account.displayName}`,
		`provider: ${account.providerName}`,
		"status: error",
	];
	if (projectId) {
		details.push(`project: ${projectId}`);
	}
	details.push(`details: ${message}`);

	if (/401|unauthorized/i.test(message)) {
		details.push("login: use /subs login or /login to authenticate this account again");
		return details;
	}

	if (/403|permission/i.test(message)) {
		if (account.baseProvider === "google-gemini-cli") {
			details.push(
				"hint: Google Cloud Code Assist rejected quota access for this account; try /subs login again and verify this account still has Gemini quota access",
			);
		} else {
			details.push(
				"hint: Google rejected this Antigravity quota request; verify the saved project/account pairing is still valid and try /subs login again",
			);
		}
	}

	return details;
}

function formatGoogleQuotaDetails(
	account: QuotaAccount,
	snapshot: GoogleQuotaAccountSnapshot,
	kind: QuotaStatusKind,
): string[] {
	const details = [
		`account: ${account.displayName}`,
		`provider: ${account.providerName}`,
		`status: ${formatQuotaKind(kind)}`,
	];
	if (snapshot.projectId) {
		details.push(`project: ${snapshot.projectId}`);
	}
	if (snapshot.worstRemainingPercent !== undefined) {
		details.push(`bottleneck: ${formatRemainingPercent(snapshot.worstRemainingPercent)} left`);
	}
	for (const model of [...snapshot.models].sort((left, right) => {
		const leftPercent = left.remainingPercent ?? 101;
		const rightPercent = right.remainingPercent ?? 101;
		return leftPercent - rightPercent || left.model.localeCompare(right.model);
	})) {
		details.push(
			`${model.model}: ${formatRemainingPercent(model.remainingPercent)} left, resets ${formatResetLong(model.resetAt)}`,
		);
	}
	details.push(`endpoint: ${snapshot.endpoint}`);
	return details;
}

async function checkGoogleQuotaAccount(
	account: QuotaAccount,
	fetchSnapshot: (
		accessToken: string,
		projectId: string | undefined,
		signal?: AbortSignal,
	) => Promise<GoogleQuotaAccountSnapshot>,
	signal?: AbortSignal,
): Promise<QuotaCheckResult> {
	const auth = account.auth;
	if (!auth || auth.type !== "oauth") {
		return {
			account,
			kind: "missing-auth",
			summary: "not logged in",
			details: [
				`account: ${account.displayName}`,
				`provider: ${account.providerName}`,
				"status: not logged in",
				"login: use /subs login or /login to authenticate this account",
			],
			score: 0,
		};
	}
	if ((typeof auth.access !== "string" || auth.access.length === 0)
		&& (typeof auth.refresh !== "string" || auth.refresh.length === 0)) {
		return {
			account,
			kind: "missing-auth",
			summary: "missing Google tokens",
			details: [
				`account: ${account.displayName}`,
				`provider: ${account.providerName}`,
				"status: not logged in",
				"details: saved Google credentials are missing both access and refresh tokens",
				"login: use /subs login or /login to authenticate this account again",
			],
			score: 0,
		};
	}

	let projectId: string | undefined;

	try {
		const credentials = await resolveGoogleQuotaAccess(account, auth);
		projectId = credentials.projectId;
		const snapshot = await fetchSnapshot(credentials.accessToken, credentials.projectId, signal);
		if (snapshot.models.length === 0 || snapshot.worstRemainingPercent === undefined) {
			return {
				account,
				kind: "error",
				summary: "no model quota data returned",
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: error",
					...(projectId ? [`project: ${projectId}`] : []),
					"details: Google returned no usable model quota data",
					`endpoint: ${snapshot.endpoint}`,
				],
				score: 0,
			};
		}

		const classification = classifyGoogleQuotaKind(snapshot);
		return {
			account,
			kind: classification.kind,
			summary: `${getGoogleQuotaBucketLabel(account, snapshot.models.length)} | bottleneck ${formatRemainingPercent(snapshot.worstRemainingPercent)} | ${formatQuotaKind(classification.kind)}`,
			details: formatGoogleQuotaDetails(account, snapshot, classification.kind),
			score: classification.score,
		};
	} catch (error: unknown) {
		if (signal?.aborted || isAbortError(error)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		return {
			account,
			kind: "error",
			summary: message,
			details: buildGoogleQuotaErrorDetails(account, message, projectId),
			score: 0,
		};
	}
}

function normalizeQuotaAllowedProviderNames(cwd: string): string[] | undefined {
	const project = loadProjectConfig(cwd);
	if (!project?.allowedSubs || project.allowedSubs.length === 0) return undefined;
	const normalized = [...new Set(project.allowedSubs.map((value) => value.trim()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

function collectQuotaAccounts(ctx: ExtensionContext): QuotaAccount[] {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const allowedProviderNames = normalizeQuotaAllowedProviderNames(ctx.cwd);
	const allowed = allowedProviderNames ? new Set(allowedProviderNames) : undefined;
	const seen = new Set<string>();
	const accounts: QuotaAccount[] = [];
	const pushAccount = (providerName: string, displayName: string) => {
		if (allowed && !allowed.has(providerName)) return;
		if (seen.has(providerName)) return;
		seen.add(providerName);
		accounts.push({
			providerName,
			baseProvider: getBaseProvider(providerName) || providerName,
			displayName,
			auth: ctx.modelRegistry.authStorage.get(providerName) as AuthStorageEntry | undefined,
		});
	};

	for (const checker of PROVIDER_QUOTA_CHECKERS) {
		if (ctx.modelRegistry.authStorage.hasAuth(checker.baseProvider)) {
			pushAccount(
				checker.baseProvider,
				PROVIDER_TEMPLATES[checker.baseProvider]?.displayName || checker.baseProvider,
			);
		}
		for (const entry of allSubs) {
			if (entry.provider !== checker.baseProvider) continue;
			pushAccount(subProviderName(entry), subDisplayName(entry));
		}
	}

	return accounts;
}

const codexQuotaChecker: ProviderQuotaChecker = {
	baseProvider: "openai-codex",
	async check(account: QuotaAccount, signal?: AbortSignal): Promise<QuotaCheckResult> {
		const auth = account.auth;
		if (!auth || auth.type !== "oauth" || typeof auth.access !== "string" || auth.access.length === 0) {
			return {
				account,
				kind: "missing-auth",
				summary: "not logged in",
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: not logged in",
					"login: use /subs login or /login to authenticate this account",
				],
				score: 0,
			};
		}

		const tokenMetadata = getCodexTokenMetadata(auth.access);
		const accountId = typeof auth.accountId === "string" && auth.accountId.length > 0
			? auth.accountId
			: tokenMetadata.accountId;
		const baseUrl = (process.env.CHATGPT_BASE_URL || DEFAULT_CODEX_USAGE_BASE_URL).replace(/\/+$/, "");
		const headers = new Headers({
			Authorization: `Bearer ${auth.access}`,
			Accept: "application/json",
			"User-Agent": "pi-multi-pass",
		});
		if (accountId) {
			headers.set("chatgpt-account-id", accountId);
		}

		try {
			const response = await fetch(`${baseUrl}/wham/usage`, {
				method: "GET",
				headers,
				signal,
			});
			if (!response.ok) {
				const error = await readResponseError(response);
				return {
					account,
					kind: "error",
					summary: error,
					details: [
						`account: ${account.displayName}`,
						`provider: ${account.providerName}`,
						`status: error`,
						`details: ${error}`,
					],
					score: 0,
				};
			}

			const snapshot = parseCodexUsageSnapshot(await response.json());
			if (!snapshot.email && tokenMetadata.email) snapshot.email = tokenMetadata.email;
			if ((!snapshot.planType || snapshot.planType === "unknown") && tokenMetadata.planType) {
				snapshot.planType = tokenMetadata.planType;
			}
			const fiveHourLeft = getCodexWindowRemaining(snapshot.fiveHour);
			const weeklyLeft = getCodexWindowRemaining(snapshot.weekly);
			const classification = classifyCodexQuotaKind(snapshot);
			const summary = [
				snapshot.planType !== "unknown" ? snapshot.planType : "plan unknown",
				`5h ${formatRemainingPercent(fiveHourLeft)} (${formatResetShort(snapshot.fiveHour?.resetAt)})`,
				`7d ${formatRemainingPercent(weeklyLeft)} (${formatResetShort(snapshot.weekly?.resetAt)})`,
				formatQuotaKind(classification.kind),
			].join(" | ");
			const details = [
				`account: ${account.displayName}`,
				`provider: ${account.providerName}`,
				`status: ${formatQuotaKind(classification.kind)}`,
				`plan: ${snapshot.planType}`,
			];
			if (snapshot.email) {
				details.push(`email: ${snapshot.email}`);
			}
			details.push(
				`5-hour window: ${formatRemainingPercent(fiveHourLeft)} left, resets ${formatResetLong(snapshot.fiveHour?.resetAt)}`,
				`7-day window: ${formatRemainingPercent(weeklyLeft)} left, resets ${formatResetLong(snapshot.weekly?.resetAt)}`,
				`endpoint: ${baseUrl}/wham/usage`,
			);
			return {
				account,
				kind: classification.kind,
				summary,
				details,
				score: classification.score,
			};
		} catch (error: unknown) {
			if (signal?.aborted || isAbortError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			return {
				account,
				kind: "error",
				summary: message,
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: error",
					`details: ${message}`,
				],
				score: 0,
			};
		}
	},
};

const googleGeminiCliQuotaChecker: ProviderQuotaChecker = {
	baseProvider: "google-gemini-cli",
	async check(account: QuotaAccount, signal?: AbortSignal): Promise<QuotaCheckResult> {
		return checkGoogleQuotaAccount(account, fetchGoogleGeminiQuotaSnapshot, signal);
	},
};

const googleAntigravityQuotaChecker: ProviderQuotaChecker = {
	baseProvider: "google-antigravity",
	async check(account: QuotaAccount, signal?: AbortSignal): Promise<QuotaCheckResult> {
		return checkGoogleQuotaAccount(account, fetchGoogleAntigravityQuotaSnapshot, signal);
	},
};

const PROVIDER_QUOTA_CHECKERS: ProviderQuotaChecker[] = [
	codexQuotaChecker,
	googleGeminiCliQuotaChecker,
	googleAntigravityQuotaChecker,
];

async function showQuotaDetails(
	ctx: ExtensionCommandContext,
	result: QuotaCheckResult,
): Promise<void> {
	await showWrappedSelect(ctx, {
		title: `Limit Details: ${result.account.displayName}`,
		subtitle: "Press Enter or Escape to go back to the limits list.",
		items: result.details.map((detail, index) => ({ value: `${index}:${detail}`, label: detail })),
		confirmHint: "back",
		cancelHint: "back",
	});
}

async function handleSubsLimits(ctx: ExtensionCommandContext): Promise<void> {
	const allowedProviderNames = normalizeQuotaAllowedProviderNames(ctx.cwd);
	const accounts = collectQuotaAccounts(ctx);
	if (accounts.length === 0) {
		const suffix = allowedProviderNames && allowedProviderNames.length > 0
			? ` for this project restriction (${allowedProviderNames.join(", ")})`
			: "";
		ctx.ui.notify(
			`No supported subscription limits are available yet${suffix}. Login to a supported provider first.`,
			"info",
		);
		return;
	}

	const results = await loadQuotaResults(ctx, accounts);
	if (!results) {
		ctx.ui.notify("Cancelled subscription limit check.", "info");
		return;
	}
	if (results.length === 0) {
		ctx.ui.notify("No supported quota checks matched the configured subscriptions.", "info");
		return;
	}

	let preferredProviderName = ctx.model?.provider;
	while (true) {
		const selected = await selectQuotaResult(ctx, results, preferredProviderName);
		if (!selected) return;
		preferredProviderName = selected.account.providerName;
		await showQuotaDetails(ctx, selected);
	}
}

// ==========================================================================
// Config persistence (~/.pi/agent/multi-pass.json)
// ==========================================================================

interface SubEntry {
	provider: string;
	index: number;
	label?: string;
}

/** Pool member selection strategy.
 *  - "round-robin": rotate sequentially through members (default).
 *  - "quota-first": query built-in quota checkers and prefer the member
 *    with the most remaining quota. Falls back to round-robin when no
 *    quota data is available.
 *  - "scheduled": use per-member time-window schedules to pick the best
 *    member. Preferred members in their active window go first (shortest
 *    remaining window first), then default members, then overflow.
 *  - "custom": delegate selection to a user-provided JS script. */
type PoolStrategy = "round-robin" | "quota-first" | "scheduled" | "custom";

type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
const ALL_DAYS: readonly DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** A time window during which a pool member is considered "preferred". */
interface ScheduleWindow {
	/** Hour range [start, end) in 24-hour local time. Wraps midnight
	 *  when start > end (e.g. [22, 6] = 22:00-05:59). */
	hours?: [number, number];
	/** Days of week this window is active. Omit for every day. */
	days?: DayOfWeek[];
	/** Optional date range (ISO date strings YYYY-MM-DD, inclusive). */
	dateRange?: { from?: string; to?: string };
}

/** Per-member schedule configuration. */
interface MemberSchedule {
	/** Time windows when this member is preferred. */
	windows?: ScheduleWindow[];
	/** Role controls ordering priority:
	 *  - "preferred": used during its active windows, skipped otherwise
	 *  - "overflow": last resort, used when no preferred/default member is available
	 *  - undefined (default): always available, used after preferred members */
	role?: "preferred" | "overflow";
}

/** Context passed to a custom pool selector script. */
interface PoolSelectorContext {
	/** Available (non-exhausted, authenticated) member provider names */
	members: string[];
	/** Provider that just hit the rate limit */
	currentProvider: string;
	/** Model ID being used */
	modelId: string;
	/** Pool metadata */
	pool: { name: string; baseProvider: string; members: string[] };
	/** Current Unix timestamp (ms) */
	timestamp: number;
	/** Current hour (0-23, local time) */
	hour: number;
	/** Current day of week */
	day: DayOfWeek;
	/** Last user prompt, if available */
	prompt?: string;
}

/** Function signature a custom selector script must export (default export). */
type PoolSelectorFn =
	(ctx: PoolSelectorContext) => string | string[] | undefined | Promise<string | string[] | undefined>;

/** A named routing preset that maps to an ordered list of provider+model entries. */
interface PresetEntry {
	/** Provider name (e.g. "openai-codex", "anthropic-2") */
	provider: string;
	/** Model ID to use */
	model: string;
	/** Whether this entry is active */
	enabled: boolean;
}

interface PresetConfig {
	/** Preset name (e.g. "coding-premium", "coding-budget") */
	name: string;
	/** Ordered provider+model entries to try */
	entries: PresetEntry[];
	/** Whether this preset is available */
	enabled: boolean;
}

interface PoolConfig {
	/** Pool name (user-defined) */
	name: string;
	/** Base provider type, e.g. "openai-codex" */
	baseProvider: string;
	/** Provider names in rotation order. Includes the original (e.g. "openai-codex")
	 *  and extras (e.g. "openai-codex-2", "openai-codex-3") */
	members: string[];
	/** Whether auto-rotation is enabled */
	enabled: boolean;
	/** Selection strategy when picking the next member on failover.
	 *  Defaults to "round-robin" when omitted. */
	strategy?: PoolStrategy;
	/** Per-member schedule rules (keyed by provider name).
	 *  Only used when strategy is "scheduled". */
	memberSchedule?: Record<string, MemberSchedule>;
	/** Path to a JS module exporting a selector function.
	 *  Only used when strategy is "custom". Resolved relative to the
	 *  global config directory (~/.pi/agent/). */
	selectorScript?: string;
}

interface ChainEntryConfig {
	/** Target pool name to enter when traversing the chain */
	pool: string;
	/** Model to select when entering the target pool */
	model: string;
	/** Whether this chain entry participates in traversal */
	enabled: boolean;
}

interface ChainConfig {
	/** Chain name (user-defined) */
	name: string;
	/** Ordered chain traversal entries */
	entries: ChainEntryConfig[];
	/** Whether chain traversal is enabled */
	enabled: boolean;
}

interface MultiPassConfig {
	subscriptions: SubEntry[];
	pools: PoolConfig[];
	chains: ChainConfig[];
	presets: PresetConfig[];
}

/** Project-level config (.pi/multi-pass.json) */
interface ProjectConfig {
	/** Override pools for this project. If set, replaces global pools. */
	pools?: PoolConfig[];
	/** Override chains for this project. If set, replaces global chains. */
	chains?: ChainConfig[];
	/** Restrict which provider names can be used in this project (for example
	 *  "openai-codex" or "openai-codex-2"). If set, only these exact providers
	 *  are available in this project. If not set, all global providers are available. */
	allowedSubs?: string[];
}

/** Effective config after merging global + project */
interface EffectiveConfig {
	subscriptions: SubEntry[];
	pools: PoolConfig[];
	chains: ChainConfig[];
	presets: PresetConfig[];
	/** Exact provider names allowed in this project, if restricted. */
	allowedProviderNames?: string[];
	/** Which project config was loaded from, if any */
	projectConfigPath?: string;
}

function globalConfigPath(): string {
	return join(getAgentDir(), "multi-pass.json");
}

function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "multi-pass.json");
}

function emptyMultiPassConfig(): MultiPassConfig {
	return { subscriptions: [], pools: [], chains: [], presets: [] };
}

function normalizeMultiPassConfig(raw: unknown): MultiPassConfig {
	const parsed = raw && typeof raw === "object" ? (raw as Partial<MultiPassConfig>) : {};
	return {
		subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
		pools: Array.isArray(parsed.pools) ? parsed.pools : [],
		chains: Array.isArray(parsed.chains) ? parsed.chains : [],
		presets: Array.isArray(parsed.presets) ? parsed.presets : [],
	};
}

function normalizeProjectConfig(raw: unknown): ProjectConfig {
	const parsed = raw && typeof raw === "object" ? (raw as Partial<ProjectConfig>) : {};
	const config: ProjectConfig = {};
	if (Array.isArray(parsed.pools)) config.pools = parsed.pools;
	if (Array.isArray(parsed.chains)) config.chains = parsed.chains;
	if (Array.isArray(parsed.allowedSubs)) config.allowedSubs = parsed.allowedSubs;
	return config;
}

function loadGlobalConfig(): MultiPassConfig {
	const path = globalConfigPath();
	if (!existsSync(path)) return emptyMultiPassConfig();
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return normalizeMultiPassConfig(raw);
	} catch {
		return emptyMultiPassConfig();
	}
}

function loadProjectConfig(cwd: string): ProjectConfig | undefined {
	const path = projectConfigPath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		return normalizeProjectConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return undefined;
	}
}

function normalizeAllowedProviderNames(allowedSubs: string[] | undefined): string[] | undefined {
	if (!allowedSubs || allowedSubs.length === 0) return undefined;
	const normalized = [...new Set(allowedSubs.map((value) => value.trim()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

function filterPoolsByAllowedProviders(
	pools: PoolConfig[],
	allowedProviderNames: string[] | undefined,
): PoolConfig[] {
	if (!allowedProviderNames || allowedProviderNames.length === 0) {
		return pools;
	}
	const allowed = new Set(allowedProviderNames);
	return pools
		.map((pool) => ({
			...pool,
			members: pool.members.filter((member) => allowed.has(member)),
		}))
		.filter((pool) => pool.members.length > 0);
}

function filterChainsByAvailablePools(chains: ChainConfig[], pools: PoolConfig[]): ChainConfig[] {
	const poolNames = new Set(pools.map((pool) => pool.name));
	return chains
		.map((chain) => ({
			...chain,
			entries: chain.entries.filter((entry) => poolNames.has(entry.pool)),
		}))
		.filter((chain) => chain.entries.length > 0);
}

function loadEffectiveConfig(cwd: string): EffectiveConfig {
	const global = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const mergedSubscriptions = normalizeEntries(mergeConfigs(global, envEntries));
	const project = loadProjectConfig(cwd);

	if (!project) {
		return {
			subscriptions: mergedSubscriptions,
			pools: global.pools,
			chains: global.chains,
			presets: global.presets,
		};
	}

	const allowedProviderNames = normalizeAllowedProviderNames(project.allowedSubs);
	let subs = mergedSubscriptions;
	if (allowedProviderNames) {
		const allowed = new Set(allowedProviderNames);
		subs = mergedSubscriptions.filter((s) => allowed.has(subProviderName(s)));
	}

	let pools = project.pools !== undefined ? project.pools : global.pools;
	let chains = project.chains !== undefined ? project.chains : global.chains;
	if (allowedProviderNames) {
		pools = filterPoolsByAllowedProviders(pools, allowedProviderNames);
		chains = filterChainsByAvailablePools(chains, pools);
	}

	return {
		subscriptions: subs,
		pools,
		chains,
		presets: global.presets,
		allowedProviderNames,
		projectConfigPath: projectConfigPath(cwd),
	};
}

function saveGlobalConfig(config: MultiPassConfig): void {
	const path = globalConfigPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

function saveProjectConfig(cwd: string, config: ProjectConfig): void {
	const path = projectConfigPath(cwd);
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

function getProviderDisplayName(providerName: string, subscriptions: SubEntry[]): string {
	const subEntry = subscriptions.find((entry) => subProviderName(entry) === providerName);
	if (subEntry) {
		return subDisplayName(subEntry);
	}
	return PROVIDER_TEMPLATES[providerName]?.displayName || providerName;
}

function getProjectScopedProviderNames(
	ctx: ExtensionContext | ExtensionCommandContext,
	effective: EffectiveConfig,
): string[] {
	const seen = new Set<string>();
	const providerNames: string[] = [];
	const push = (providerName: string) => {
		if (!providerName || seen.has(providerName)) return;
		seen.add(providerName);
		providerNames.push(providerName);
	};

	if (effective.allowedProviderNames && effective.allowedProviderNames.length > 0) {
		for (const providerName of effective.allowedProviderNames) {
			const isExtraSubscription = effective.subscriptions.some(
				(entry) => subProviderName(entry) === providerName,
			);
			const isSupportedBaseProvider = SUPPORTED_PROVIDERS.includes(providerName);
			if (!isExtraSubscription && !isSupportedBaseProvider) continue;
			push(providerName);
		}
		return providerNames;
	}

	for (const providerName of SUPPORTED_PROVIDERS) {
		if (ctx.modelRegistry.authStorage.hasAuth(providerName)) {
			push(providerName);
		}
	}
	for (const entry of effective.subscriptions) {
		push(subProviderName(entry));
	}
	return providerNames;
}

function findSelectableModelForProvider(
	ctx: ExtensionContext | ExtensionCommandContext,
	providerName: string,
	preferredModelId?: string,
): Model<Api> | undefined {
	if (!ctx.modelRegistry.authStorage.hasAuth(providerName)) {
		return undefined;
	}
	if (preferredModelId) {
		const preferred = ctx.modelRegistry.find(providerName, preferredModelId);
		if (preferred) {
			return preferred as Model<Api>;
		}
	}
	const baseProvider = getBaseProvider(providerName);
	if (!baseProvider) {
		return undefined;
	}
	for (const baseModel of getModels(baseProvider as any) as Model<Api>[]) {
		const candidate = ctx.modelRegistry.find(providerName, baseModel.id);
		if (candidate) {
			return candidate as Model<Api>;
		}
	}
	return undefined;
}

function formatAllowedProviderSummary(effective: EffectiveConfig): string | undefined {
	return effective.allowedProviderNames && effective.allowedProviderNames.length > 0
		? effective.allowedProviderNames.join(", ")
		: undefined;
}

// ==========================================================================
// Merge env var into config
// ==========================================================================

function parseEnvConfig(): SubEntry[] {
	const raw = process.env.MULTI_SUB;
	if (!raw) return [];
	const entries: SubEntry[] = [];
	for (const part of raw.split(",")) {
		const [provider, countStr] = part.trim().split(":");
		if (!provider || !PROVIDER_TEMPLATES[provider]) continue;
		const count = parseInt(countStr || "1", 10);
		if (isNaN(count) || count < 1) continue;
		for (let i = 0; i < count; i++) {
			entries.push({ provider, index: 0 });
		}
	}
	return entries;
}

function mergeConfigs(fileConfig: MultiPassConfig, envEntries: SubEntry[]): SubEntry[] {
	const merged = [...fileConfig.subscriptions];
	for (const envEntry of envEntries) {
		const existingCount = merged.filter((s) => s.provider === envEntry.provider).length;
		const envCountForProvider = envEntries.filter((e) => e.provider === envEntry.provider).length;
		if (existingCount < envCountForProvider) {
			const usedIndices = merged
				.filter((s) => s.provider === envEntry.provider)
				.map((s) => s.index);
			let nextIndex = 2;
			while (usedIndices.includes(nextIndex)) nextIndex++;
			merged.push({ provider: envEntry.provider, index: nextIndex });
		}
	}
	return merged;
}

function normalizeEntries(entries: SubEntry[]): SubEntry[] {
	const byProvider = new Map<string, SubEntry[]>();
	for (const entry of entries) {
		const list = byProvider.get(entry.provider) || [];
		list.push(entry);
		byProvider.set(entry.provider, list);
	}
	const result: SubEntry[] = [];
	for (const [, list] of byProvider) {
		const usedIndices = new Set(list.filter((e) => e.index > 0).map((e) => e.index));
		let nextIndex = 2;
		for (const entry of list) {
			if (entry.index > 0) {
				result.push(entry);
			} else {
				while (usedIndices.has(nextIndex)) nextIndex++;
				result.push({ ...entry, index: nextIndex });
				usedIndices.add(nextIndex);
				nextIndex++;
			}
		}
	}
	return result;
}

// ==========================================================================
// Provider name helpers
// ==========================================================================

function subProviderName(entry: SubEntry): string {
	return `${entry.provider}-${entry.index}`;
}

function subDisplayName(entry: SubEntry): string {
	const template = PROVIDER_TEMPLATES[entry.provider];
	const providerName = `${template?.displayName || entry.provider} #${entry.index}`;
	if (!entry.label) return providerName;
	return `${entry.label} — ${providerName}`;
}

/** Get the base provider type from a provider name, e.g. "openai-codex-2" -> "openai-codex" */
function getBaseProvider(providerName: string): string | undefined {
	// Direct match
	if (PROVIDER_TEMPLATES[providerName]) return providerName;
	// Strip trailing -N
	const match = providerName.match(/^(.+)-(\d+)$/);
	if (match && PROVIDER_TEMPLATES[match[1]]) return match[1];
	return undefined;
}

// ==========================================================================
// Model cloning
// ==========================================================================

function cloneModels(originalProvider: string, index: number) {
	const models = getModels(originalProvider as any) as Model<Api>[];
	return models.map((m) => ({
		id: m.id,
		name: `${m.name} (#${index})`,
		api: m.api,
		reasoning: m.reasoning,
		thinkingLevelMap: m.thinkingLevelMap ? { ...m.thinkingLevelMap } : undefined,
		input: m.input as ("text" | "image")[],
		cost: { ...m.cost },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		headers: m.headers ? { ...m.headers } : undefined,
		compat: m.compat,
	}));
}

// ==========================================================================
// Register a single subscription as a provider
// ==========================================================================

function registerSub(pi: ExtensionAPI, entry: SubEntry): void {
	const template = PROVIDER_TEMPLATES[entry.provider];
	if (!template) return;

	const name = subProviderName(entry);
	const oauth = template.buildOAuth(entry.index);
	const modifyModels = template.buildModifyModels?.(name);
	const builtinModels = getModels(entry.provider as any) as Model<Api>[];
	const baseUrl = builtinModels[0]?.baseUrl || "";
	const models = cloneModels(entry.provider, entry.index);

	pi.registerProvider(name, {
		baseUrl,
		api: builtinModels[0]?.api,
		oauth: modifyModels ? { ...oauth, modifyModels } : oauth,
		models,
	});
}

// ==========================================================================
// Pool rotation engine
// ==========================================================================

const RATE_LIMIT_PATTERNS = [
	/usage.?limit/i,
	/rate.?limit/i,
	/limit.*reached/i,
	/too many requests/i,
	/overloaded/i,
	/capacity/i,
	/429/,
	/quota/i,
];

function isRateLimitError(errorMessage: string): boolean {
	return RATE_LIMIT_PATTERNS.some((p) => p.test(errorMessage));
}

// ==========================================================================
// Schedule evaluation helpers
// ==========================================================================

const JS_DAY_TO_DOW: DayOfWeek[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function getDayOfWeek(date: Date): DayOfWeek {
	return JS_DAY_TO_DOW[date.getDay()];
}

function isInHourRange(hour: number, range: [number, number]): boolean {
	const [start, end] = range;
	if (start <= end) {
		// Normal range, e.g. [9, 17] = 09:00-16:59
		return hour >= start && hour < end;
	}
	// Wrapping range, e.g. [22, 6] = 22:00-05:59
	return hour >= start || hour < end;
}

function isInDateRange(date: Date, range: { from?: string; to?: string }): boolean {
	const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	if (range.from && dateStr < range.from) return false;
	if (range.to && dateStr > range.to) return false;
	return true;
}

function isInScheduleWindow(window: ScheduleWindow, now: Date): boolean {
	if (window.days && window.days.length > 0) {
		if (!window.days.includes(getDayOfWeek(now))) return false;
	}
	if (window.hours) {
		if (!isInHourRange(now.getHours(), window.hours)) return false;
	}
	if (window.dateRange) {
		if (!isInDateRange(now, window.dateRange)) return false;
	}
	return true;
}

/** Calculate ms until the current window closes. Returns Infinity if window
 *  has no hour constraint (open-ended). */
function getWindowRemainingMs(window: ScheduleWindow, now: Date): number {
	if (!window.hours) return Infinity;
	const [, end] = window.hours;
	const endToday = new Date(now);
	endToday.setHours(end, 0, 0, 0);
	let remaining = endToday.getTime() - now.getTime();
	if (remaining <= 0) {
		// End is tomorrow (wrapped range like [22, 6])
		remaining += 24 * 60 * 60 * 1000;
	}
	return remaining;
}

interface ScheduledMemberState {
	provider: string;
	role: "preferred" | "default" | "overflow";
	active: boolean;
	shortestRemainingMs: number;
}

function getScheduledMemberState(
	provider: string,
	schedule: MemberSchedule | undefined,
	now: Date,
): ScheduledMemberState {
	if (!schedule) {
		return { provider, role: "default", active: true, shortestRemainingMs: Infinity };
	}
	const role: "preferred" | "default" | "overflow" = schedule.role || "default";
	if (role === "overflow") {
		return { provider, role, active: true, shortestRemainingMs: Infinity };
	}

	const windows = schedule.windows || [];
	if (windows.length === 0) {
		return { provider, role, active: true, shortestRemainingMs: Infinity };
	}

	let anyActive = false;
	let shortestRemainingMs = Infinity;
	for (const w of windows) {
		if (isInScheduleWindow(w, now)) {
			anyActive = true;
			const remaining = getWindowRemainingMs(w, now);
			if (remaining < shortestRemainingMs) shortestRemainingMs = remaining;
		}
	}

	return { provider, role, active: anyActive, shortestRemainingMs };
}

/** Sort available members by schedule priority:
 *  1. Preferred members in their active window (shortest remaining first)
 *  2. Default members (always available)
 *  3. Overflow members (last resort) */
function getScheduledMemberOrder(
	pool: PoolConfig,
	available: string[],
	now: Date,
): string[] {
	const memberSchedule = pool.memberSchedule || {};
	const states = available.map((provider) =>
		getScheduledMemberState(provider, memberSchedule[provider], now),
	);

	const preferred = states
		.filter((s) => s.role === "preferred" && s.active)
		.sort((a, b) => a.shortestRemainingMs - b.shortestRemainingMs);
	const defaults = states.filter((s) => s.role === "default");
	const overflow = states.filter((s) => s.role === "overflow");
	// Preferred members NOT in their window are skipped entirely
	return [...preferred, ...defaults, ...overflow].map((s) => s.provider);
}

// ==========================================================================
// Custom selector script loader
// ==========================================================================

const selectorCache = new Map<string, PoolSelectorFn | null>();

function resolveSelectorScriptPath(scriptPath: string): string {
	if (scriptPath.startsWith("/")) return scriptPath;
	if (scriptPath.startsWith("~/")) {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		return join(home, scriptPath.slice(2));
	}
	// Resolve relative to global config directory
	return join(getAgentDir(), scriptPath);
}

async function loadSelectorScript(scriptPath: string): Promise<PoolSelectorFn | null> {
	const resolved = resolveSelectorScriptPath(scriptPath);
	const cached = selectorCache.get(resolved);
	if (cached !== undefined) return cached;

	if (!existsSync(resolved)) {
		selectorCache.set(resolved, null);
		return null;
	}

	try {
		const mod = await import(resolved);
		const fn: PoolSelectorFn = typeof mod.default === "function"
			? mod.default
			: typeof mod === "function"
				? mod
				: null;
		selectorCache.set(resolved, fn);
		return fn;
	} catch {
		selectorCache.set(resolved, null);
		return null;
	}
}

async function runCustomSelector(
	pool: PoolConfig,
	available: string[],
	currentProvider: string,
	modelId: string,
	prompt?: string,
): Promise<string | undefined> {
	if (!pool.selectorScript) return undefined;
	const fn = await loadSelectorScript(pool.selectorScript);
	if (!fn) return undefined;

	const now = new Date();
	const ctx: PoolSelectorContext = {
		members: [...available],
		currentProvider,
		modelId,
		pool: { name: pool.name, baseProvider: pool.baseProvider, members: [...pool.members] },
		timestamp: now.getTime(),
		hour: now.getHours(),
		day: getDayOfWeek(now),
		prompt,
	};

	try {
		const result = await fn(ctx);
		if (typeof result === "string" && available.includes(result)) return result;
		if (Array.isArray(result)) {
			const first = result.find((r) => typeof r === "string" && available.includes(r));
			if (first) return first;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

// ==========================================================================
// Pool rotation engine
// ==========================================================================

interface PoolState {
	/** Current index into pool.members */
	currentIndex: number;
	/** Members that are temporarily "exhausted" (hit limit), with timestamps */
	exhausted: Map<string, number>;
	/** Cooldown period in ms before retrying an exhausted member */
	cooldownMs: number;
}

class PoolManager {
	private pools: Map<string, PoolConfig> = new Map();
	private poolStates: Map<string, PoolState> = new Map();
	/** Map from provider name -> pool name (for quick lookup) */
	private providerToPool: Map<string, string> = new Map();
	private pi: ExtensionAPI;
	private cascadeState: FailoverCascadeState | null = null;
	private suppressNextStartTurn = false;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	private getOrCreatePoolState(poolName: string): PoolState {
		let state = this.poolStates.get(poolName);
		if (!state) {
			state = {
				currentIndex: 0,
				exhausted: new Map(),
				cooldownMs: 5 * 60 * 1000, // 5 min default cooldown
			};
			this.poolStates.set(poolName, state);
		}
		return state;
	}

	loadPools(configs: PoolConfig[]): void {
		this.pools.clear();
		this.providerToPool.clear();

		const activePoolNames = new Set<string>();
		for (const pool of configs) {
			if (!pool.enabled) continue;
			activePoolNames.add(pool.name);
			this.pools.set(pool.name, pool);

			const state = this.getOrCreatePoolState(pool.name);
			state.currentIndex = pool.members.length > 0 ? state.currentIndex % pool.members.length : 0;
			for (const member of Array.from(state.exhausted.keys())) {
				if (!pool.members.includes(member)) {
					state.exhausted.delete(member);
				}
			}

			// Map each member to this pool
			for (const member of pool.members) {
				this.providerToPool.set(member, pool.name);
			}
		}

		for (const poolName of Array.from(this.poolStates.keys())) {
			if (!activePoolNames.has(poolName)) {
				this.poolStates.delete(poolName);
			}
		}
	}

	/** Find pool for a given provider name */
	getPoolForProvider(providerName: string): PoolConfig | undefined {
		const poolName = this.providerToPool.get(providerName);
		return poolName ? this.pools.get(poolName) : undefined;
	}

	/** Get available (non-exhausted, authenticated) members of a pool */
	getAvailableMembers(
		pool: PoolConfig,
		authStorage: { hasAuth(provider: string): boolean },
	): string[] {
		const state = this.getOrCreatePoolState(pool.name);
		const now = Date.now();
		return pool.members.filter((member) => {
			if (!authStorage.hasAuth(member)) return false;
			const exhaustedAt = state.exhausted.get(member);
			if (exhaustedAt && now - exhaustedAt < state.cooldownMs) return false;
			if (exhaustedAt && now - exhaustedAt >= state.cooldownMs) {
				state.exhausted.delete(member);
			}
			return true;
		});
	}

	isMemberExhausted(pool: PoolConfig, provider: string): boolean {
		const state = this.getOrCreatePoolState(pool.name);
		const exhaustedAt = state.exhausted.get(provider);
		if (!exhaustedAt) return false;
		if (Date.now() - exhaustedAt >= state.cooldownMs) {
			state.exhausted.delete(provider);
			return false;
		}
		return true;
	}

	getEnabledChains(config: MultiPassConfig): ChainConfig[] {
		return config.chains.filter((chain) => chain.enabled);
	}

	findApplicableChain(poolName: string, config: MultiPassConfig): {
		chain: ChainConfig;
		index: number;
	} | undefined {
		for (const chain of this.getEnabledChains(config)) {
			const index = chain.entries.findIndex((entry) => entry.pool === poolName);
			if (index >= 0) {
				return { chain, index };
			}
		}
		return undefined;
	}

	buildFailoverPlan(
		currentModel: Model<Api>,
		config: MultiPassConfig,
		authStorage: { hasAuth(provider: string): boolean },
		options?: FailoverPlanOptions,
	): FailoverPlan {
		const attemptedProviders = options?.attemptedProviders ?? new Set<string>();
		const visitedChainIndexes = options?.visitedChainIndexes ?? new Set<number>();
		const pool = this.getPoolForProvider(currentModel.provider);
		if (!pool) {
			return { candidates: [], skips: [] };
		}

		const skips: FailoverSkip[] = [];
		const candidates: FailoverCandidate[] = [];
		const poolSize = pool.members.length;
		const currentIndex = pool.members.indexOf(currentModel.provider);
		const startIndex = currentIndex >= 0 ? currentIndex : 0;

		for (let step = 1; step <= poolSize; step++) {
			const candidateIndex = poolSize <= 0 ? -1 : (startIndex + step) % poolSize;
			if (candidateIndex < 0) break;
			const candidate = pool.members[candidateIndex];
			if (candidate === currentModel.provider) continue;
			if (attemptedProviders.has(candidate)) {
				skips.push({
					type: "pool-member",
					poolName: pool.name,
					reason: "already-attempted",
					detail: `${candidate} skipped (already attempted this turn)`,
				});
				continue;
			}
			const skip = classifyPoolMemberSkip(
				pool.name,
				candidate,
				authStorage,
				this.isMemberExhausted(pool, candidate),
			);
			if (skip) {
				skips.push(skip);
				continue;
			}
			candidates.push({
				poolName: pool.name,
				provider: candidate,
				modelId: currentModel.id,
				source: "pool",
			});
		}

		const applicable = this.findApplicableChain(pool.name, config);
		if (!applicable) {
			return { pool, candidates, skips };
		}

		for (let chainIndex = applicable.index + 1; chainIndex < applicable.chain.entries.length; chainIndex++) {
			const entry = applicable.chain.entries[chainIndex];
			if (visitedChainIndexes.has(chainIndex)) {
				skips.push({
					type: "chain-entry",
					poolName: entry.pool,
					reason: "already-visited-chain-entry",
					detail: `${entry.pool} -> ${entry.model} skipped (chain entry already visited this turn)`,
					chainName: applicable.chain.name,
					chainIndex,
				});
				continue;
			}
			const entrySkip = classifyChainEntrySkip(applicable.chain, chainIndex, entry, config);
			if (entrySkip) {
				skips.push(entrySkip);
				continue;
			}
			const targetPool = config.pools.find((candidate) => candidate.name === entry.pool);
			if (!targetPool) {
				skips.push({
					type: "chain-entry",
					poolName: entry.pool,
					reason: "missing-pool",
					detail: `${entry.pool} -> ${entry.model} skipped (pool missing)`,
					chainName: applicable.chain.name,
					chainIndex,
				});
				continue;
			}
			let foundEligible = false;
			for (const member of targetPool.members) {
				if (attemptedProviders.has(member)) {
					skips.push({
						type: "pool-member",
						poolName: targetPool.name,
						reason: "already-attempted",
						detail: `${member} skipped (already attempted this turn)`,
						chainName: applicable.chain.name,
						chainIndex,
					});
					continue;
				}
				const memberSkip = classifyPoolMemberSkip(
					targetPool.name,
					member,
					authStorage,
					this.isMemberExhausted(targetPool, member),
				);
				if (memberSkip) {
					skips.push({
						...memberSkip,
						chainName: applicable.chain.name,
						chainIndex,
					});
					continue;
				}
				foundEligible = true;
				candidates.push({
					poolName: targetPool.name,
					provider: member,
					modelId: entry.model,
					source: "chain",
					chainName: applicable.chain.name,
					chainIndex,
				});
			}
			if (!foundEligible) {
				skips.push({
					type: "chain-entry",
					poolName: targetPool.name,
					reason: "no-eligible-members",
					detail: `${targetPool.name} -> ${entry.model} skipped (no eligible members)`,
					chainName: applicable.chain.name,
					chainIndex,
				});
			}
		}

		return {
			pool,
			chain: applicable.chain,
			currentChainIndex: applicable.index,
			candidates,
			skips,
		};
	}

	/** Mark a member as exhausted (hit rate limit) */
	markExhausted(providerName: string): void {
		const poolName = this.providerToPool.get(providerName);
		if (!poolName) return;
		const state = this.getOrCreatePoolState(poolName);
		state.exhausted.set(providerName, Date.now());
	}

	/** Get the next available member in a pool, skipping the current one */
	getNextMember(
		pool: PoolConfig,
		currentProvider: string,
		authStorage: { hasAuth(provider: string): boolean },
	): string | undefined {
		const state = this.getOrCreatePoolState(pool.name);
		const available = this.getAvailableMembers(pool, authStorage);
		if (available.length === 0) return undefined;

		const poolSize = pool.members.length;
		if (poolSize <= 1) {
			return available[0] === currentProvider ? undefined : available[0];
		}

		const currentIndex = pool.members.indexOf(currentProvider);
		const startIndex = currentIndex >= 0 ? currentIndex : state.currentIndex % poolSize;

		for (let step = 1; step <= poolSize; step++) {
			const candidateIndex = (startIndex + step) % poolSize;
			const candidate = pool.members[candidateIndex];
			if (candidate === currentProvider) continue;
			if (!available.includes(candidate)) continue;
			state.currentIndex = candidateIndex;
			return candidate;
		}

		return undefined;
	}

	/**
	 * Pick the best member using built-in quota checkers.
	 * Returns the provider name with the highest remaining quota,
	 * or undefined if no quota data is available (caller should
	 * fall back to round-robin).
	 */
	async getQuotaBestMember(
		pool: PoolConfig,
		currentProvider: string,
		authStorage: { hasAuth(provider: string): boolean; get(provider: string): unknown },
		excludeProviders?: Set<string>,
	): Promise<string | undefined> {
		const available = this.getAvailableMembers(pool, authStorage);
		const eligible = available.filter(
			(member) => member !== currentProvider && !(excludeProviders?.has(member)),
		);
		if (eligible.length === 0) return undefined;
		// If only one candidate, skip the network calls.
		if (eligible.length === 1) return eligible[0];

		const accounts: QuotaAccount[] = eligible.map((providerName) => ({
			providerName,
			baseProvider: getBaseProvider(providerName) || providerName,
			displayName: providerName,
			auth: authStorage.get(providerName) as AuthStorageEntry | undefined,
		}));

		try {
			const results = await runQuotaChecks(accounts);
			if (results.length === 0) return undefined;
			// runQuotaChecks returns sorted best-first.
			const best = results[0];
			// Only use quota selection when the best result has real data.
			if (best.kind === "error" || best.kind === "missing-auth") return undefined;
			return best.account.providerName;
		} catch {
			// Network failure etc. -- fall back to round-robin.
			return undefined;
		}
	}

	/**
	 * Reorder failover plan candidates based on the pool's strategy.
	 * Mutates plan.candidates in place.
	 */
	private async reorderCandidatesByStrategy(
		pool: PoolConfig,
		plan: FailoverPlan,
		currentModel: Model<Api>,
		ctx: ExtensionContext,
		cascade: FailoverCascadeState,
		lastUserPrompt: string | null,
	): Promise<void> {
		const strategy = pool.strategy || "round-robin";
		if (strategy === "round-robin") return;

		const poolCandidates = plan.candidates.filter(
			(c) => c.source === "pool" && c.poolName === pool.name,
		);
		if (poolCandidates.length < 2 && strategy !== "custom") return;

		if (strategy === "quota-first") {
			try {
				const best = await this.getQuotaBestMember(
					pool,
					currentModel.provider,
					ctx.modelRegistry.authStorage,
					cascade.attemptedProviders,
				);
				if (best) {
					const bestIdx = plan.candidates.findIndex(
						(c) => c.provider === best && c.source === "pool",
					);
					if (bestIdx > 0) {
						const [moved] = plan.candidates.splice(bestIdx, 1);
						plan.candidates.unshift(moved);
						ctx.ui.notify(
							`[pool:${pool.name}] quota-first: ${best} has the most remaining quota`,
							"info",
						);
					}
				}
			} catch {
				// Quota check failed -- proceed with default order.
			}
			return;
		}

		if (strategy === "scheduled") {
			const available = poolCandidates.map((c) => c.provider);
			const ordered = getScheduledMemberOrder(pool, available, new Date());
			if (ordered.length === 0) return;

			// Rebuild pool candidates in schedule order, keep chain candidates at the end.
			const chainCandidates = plan.candidates.filter(
				(c) => c.source === "chain" || c.poolName !== pool.name,
			);
			const reordered = ordered
				.map((provider) => poolCandidates.find((c) => c.provider === provider))
				.filter((c): c is FailoverCandidate => Boolean(c));
			plan.candidates = [...reordered, ...chainCandidates];

			const first = ordered[0];
			if (first) {
				ctx.ui.notify(
					`[pool:${pool.name}] scheduled: ${first} selected by schedule priority`,
					"info",
				);
			}
			return;
		}

		if (strategy === "custom") {
			const available = poolCandidates.map((c) => c.provider);
			try {
				const best = await runCustomSelector(
					pool,
					available,
					currentModel.provider,
					currentModel.id,
					lastUserPrompt || undefined,
				);
				if (best) {
					const bestIdx = plan.candidates.findIndex(
						(c) => c.provider === best && c.source === "pool",
					);
					if (bestIdx > 0) {
						const [moved] = plan.candidates.splice(bestIdx, 1);
						plan.candidates.unshift(moved);
						ctx.ui.notify(
							`[pool:${pool.name}] custom: selector chose ${best}`,
							"info",
						);
					}
				}
			} catch {
				// Custom selector failed -- proceed with default order.
			}
			return;
		}
	}

	private ensureCascadeState(prompt: string | null, currentModel: Model<Api>): FailoverCascadeState {
		if (!prompt) {
			const fallbackState: FailoverCascadeState = {
				prompt: "",
				attemptedProviders: new Set([currentModel.provider]),
				visitedChainIndexes: new Set<number>(),
			};
			this.cascadeState = fallbackState;
			return fallbackState;
		}

		if (!this.cascadeState || this.cascadeState.prompt !== prompt) {
			this.cascadeState = {
				prompt,
				attemptedProviders: new Set([currentModel.provider]),
				visitedChainIndexes: new Set<number>(),
			};
		} else {
			this.cascadeState.attemptedProviders.add(currentModel.provider);
		}

		return this.cascadeState;
	}

	startTurn(prompt: string | null, currentModel?: Model<Api>): void {
		if (this.suppressNextStartTurn) {
			this.suppressNextStartTurn = false;
			return;
		}
		if (!prompt) {
			this.cascadeState = null;
			return;
		}
		if (!this.cascadeState || this.cascadeState.prompt !== prompt) {
			this.cascadeState = {
				prompt,
				attemptedProviders: new Set(currentModel ? [currentModel.provider] : []),
				visitedChainIndexes: new Set<number>(),
			};
			return;
		}
		if (currentModel) {
			this.cascadeState.attemptedProviders.add(currentModel.provider);
		}
	}

	clearCascadeState(): void {
		this.cascadeState = null;
	}

	getCascadeStateSnapshot():
		| { prompt: string; attemptedProviders: string[]; visitedChainIndexes: number[] }
		| null {
		if (!this.cascadeState) return null;
		return {
			prompt: this.cascadeState.prompt,
			attemptedProviders: [...this.cascadeState.attemptedProviders],
			visitedChainIndexes: [...this.cascadeState.visitedChainIndexes],
		};
	}

	/**
	 * Handle an error: if it's a rate limit and the provider is in a pool,
	 * build an ordered failover plan, switch to the first usable candidate, and retry.
	 * Returns true if rotation happened.
	 */
	async handleError(
		errorMessage: string,
		currentModel: Model<Api> | undefined,
		ctx: ExtensionContext,
		lastUserPrompt: string | null,
		config: MultiPassConfig,
	): Promise<boolean> {
		if (!currentModel) return false;
		if (!isRateLimitError(errorMessage)) return false;

		const pool = this.getPoolForProvider(currentModel.provider);
		if (!pool) return false;

		const cascade = this.ensureCascadeState(lastUserPrompt, currentModel);

		// Mark current as exhausted before planning the forward-only cascade.
		this.markExhausted(currentModel.provider);

		const plan = this.buildFailoverPlan(
			currentModel,
			config,
			ctx.modelRegistry.authStorage,
			{
				attemptedProviders: cascade.attemptedProviders,
				visitedChainIndexes: cascade.visitedChainIndexes,
			},
		);

		// Strategy-aware reordering of pool candidates before failover.
		await this.reorderCandidatesByStrategy(
			pool,
			plan,
			currentModel,
			ctx,
			cascade,
			lastUserPrompt,
		);

		const continuation = formatFailoverContinuation(plan.candidates[0]);
		for (const skip of plan.skips) {
			ctx.ui.notify(
				`[pool:${skip.poolName}] ${skip.detail}; ${continuation}`,
				"warning",
			);
		}

		const nextCandidate = plan.candidates[0];
		if (!nextCandidate) {
			ctx.ui.notify(formatFailoverExhausted(pool.name, currentModel.provider), "warning");
			ctx.ui.setStatus("multi-pass", formatFailoverStatus(null, pool.name));
			return false;
		}

		const nextModel = ctx.modelRegistry.find(nextCandidate.provider, nextCandidate.modelId);
		if (!nextModel) {
			ctx.ui.notify(
				`[pool:${nextCandidate.poolName}] ${nextCandidate.provider} -> ${nextCandidate.modelId} skipped (model missing at runtime); cascade exhausted; no later eligible target`,
				"warning",
			);
			ctx.ui.notify(formatFailoverExhausted(pool.name, currentModel.provider), "warning");
			ctx.ui.setStatus("multi-pass", formatFailoverStatus(null, pool.name));
			return false;
		}

		const success = await this.pi.setModel(nextModel);
		if (!success) {
			ctx.ui.notify(
				`[pool:${nextCandidate.poolName}] ${nextCandidate.provider} skipped (authentication unavailable during switch); cascade exhausted; no later eligible target`,
				"warning",
			);
			ctx.ui.notify(formatFailoverExhausted(pool.name, currentModel.provider), "warning");
			ctx.ui.setStatus("multi-pass", formatFailoverStatus(null, pool.name));
			return false;
		}

		cascade.attemptedProviders.add(nextCandidate.provider);
		if (typeof nextCandidate.chainIndex === "number") {
			cascade.visitedChainIndexes.add(nextCandidate.chainIndex);
		}

		ctx.ui.notify(
			formatFailoverTransition(pool.name, currentModel.provider, nextCandidate),
			"info",
		);
		ctx.ui.setStatus("multi-pass", formatFailoverStatus(nextCandidate));

		if (lastUserPrompt) {
			this.suppressNextStartTurn = true;
			this.pi.sendUserMessage(lastUserPrompt);
		}

		return true;
	}

	getPoolConfigs(): PoolConfig[] {
		return Array.from(this.pools.values());
	}

	getAllPoolConfigs(config: MultiPassConfig): PoolConfig[] {
		return config.pools || [];
	}
}

// ==========================================================================
// /subs command handlers
// ==========================================================================

function getSubscriptionSource(config: MultiPassConfig, entry: SubEntry): "config" | "env" {
	return config.subscriptions.find(
		(s) => s.provider === entry.provider && s.index === entry.index,
	)
		? "config"
		: "env";
}

function formatSubscriptionMeta(
	entry: SubEntry,
	config: MultiPassConfig,
	authStorage: { hasAuth(provider: string): boolean },
): string {
	const name = subProviderName(entry);
	const hasAuth = authStorage.hasAuth(name);
	const status = hasAuth ? "[logged in]" : "[not logged in]";
	const source = getSubscriptionSource(config, entry);
	return `${status} (${source})`;
}

function formatSubscriptionListLine(
	entry: SubEntry,
	config: MultiPassConfig,
	authStorage: { hasAuth(provider: string): boolean },
): string {
	return `${subDisplayName(entry)} -- ${formatSubscriptionMeta(entry, config, authStorage)}`;
}

function normalizeSwitchAllowedProviderNames(cwd: string): string[] | undefined {
	const project = loadProjectConfig(cwd);
	if (!project?.allowedSubs || project.allowedSubs.length === 0) return undefined;
	const normalized = [...new Set(project.allowedSubs.map((value) => value.trim()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

function getSwitchableProviderOptions(
	ctx: ExtensionContext | ExtensionCommandContext,
): Array<{ providerName: string; label: string; description: string }> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const allowedProviderNames = normalizeSwitchAllowedProviderNames(ctx.cwd);
	const allowed = allowedProviderNames ? new Set(allowedProviderNames) : undefined;
	const options: Array<{ providerName: string; label: string; description: string }> = [];
	const seen = new Set<string>();
	const push = (providerName: string, label: string, description: string) => {
		if (allowed && !allowed.has(providerName)) return;
		if (!ctx.modelRegistry.authStorage.hasAuth(providerName)) return;
		if (seen.has(providerName)) return;
		seen.add(providerName);
		options.push({ providerName, label, description });
	};

	for (const providerName of SUPPORTED_PROVIDERS) {
		push(
			providerName,
			PROVIDER_TEMPLATES[providerName]?.displayName || providerName,
			"base provider",
		);
	}
	for (const entry of allSubs) {
		push(subProviderName(entry), subDisplayName(entry), "extra subscription");
	}
	return options;
}

function resolveSwitchTargetModel(
	ctx: ExtensionContext | ExtensionCommandContext,
	providerName: string,
	preferredModelId?: string,
): Model<Api> | undefined {
	if (!ctx.modelRegistry.authStorage.hasAuth(providerName)) {
		return undefined;
	}
	if (preferredModelId) {
		const preferred = ctx.modelRegistry.find(providerName, preferredModelId);
		if (preferred) {
			return preferred as Model<Api>;
		}
	}
	const baseProvider = getBaseProvider(providerName);
	if (!baseProvider) {
		return undefined;
	}
	for (const baseModel of getModels(baseProvider as any) as Model<Api>[]) {
		const candidate = ctx.modelRegistry.find(providerName, baseModel.id);
		if (candidate) {
			return candidate as Model<Api>;
		}
	}
	return undefined;
}

async function handleSubsSwitch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	requestedProviderName?: string,
): Promise<void> {
	const options = getSwitchableProviderOptions(ctx);
	if (options.length === 0) {
		const allowedProviderNames = normalizeSwitchAllowedProviderNames(ctx.cwd);
		const suffix = allowedProviderNames && allowedProviderNames.length > 0
			? ` for this project restriction (${allowedProviderNames.join(", ")})`
			: "";
		ctx.ui.notify(`No authenticated subscriptions are available to switch${suffix}.`, "info");
		return;
	}

	let providerName = requestedProviderName?.trim();
	if (!providerName) {
		providerName = await showWrappedSelect(ctx, {
			title: "Switch Subscription",
			subtitle: "Select the subscription/provider to use now.",
			items: options.map((option) => ({
				value: option.providerName,
				label: option.label,
				description: option.description,
			})),
			initialValue: ctx.model?.provider,
			confirmHint: "switch",
			cancelHint: "back",
		});
		if (!providerName) return;
	}

	const selected = options.find((option) => option.providerName === providerName);
	if (!selected) {
		ctx.ui.notify(`Subscription not available for switching: ${providerName}`, "error");
		return;
	}

	const nextModel = resolveSwitchTargetModel(ctx, selected.providerName, ctx.model?.id);
	if (!nextModel) {
		ctx.ui.notify(`No selectable models found for ${selected.label}.`, "error");
		return;
	}
	if (ctx.model?.provider === nextModel.provider && ctx.model?.id === nextModel.id) {
		ctx.ui.notify(`Already using ${selected.label} (${nextModel.id}).`, "info");
		return;
	}

	const success = await pi.setModel(nextModel);
	if (!success) {
		ctx.ui.notify(`Failed to switch to ${selected.label}.`, "error");
		return;
	}
	ctx.ui.notify(`Switched to ${selected.label} (${nextModel.id}).`, "info");
}

async function renameSubscriptionLabel(
	ctx: ExtensionCommandContext,
	config: MultiPassConfig,
	entry: SubEntry,
): Promise<void> {
	const previousName = subDisplayName(entry);
	const nextLabel = await ctx.ui.input(
		"Friendly label (optional)",
		entry.label || "e.g. work, personal, team, outlook",
	);
	if (nextLabel === undefined) return;

	entry.label = nextLabel.trim() || undefined;
	saveGlobalConfig(config);

	const nextName = subDisplayName(entry);
	if (nextName === previousName) {
		ctx.ui.notify(`No changes for ${nextName}.`, "info");
		return;
	}

	ctx.ui.notify(`Updated ${previousName} -> ${nextName}`, "info");
}

async function removeSubscriptionEntry(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiPassConfig,
	entry: SubEntry,
	poolManager: PoolManager,
): Promise<void> {
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		`Remove ${subDisplayName(entry)}?\nThis will also logout if authenticated.`,
	);
	if (!confirmed) return;

	const name = subProviderName(entry);
	if (ctx.modelRegistry.authStorage.hasAuth(name)) {
		ctx.modelRegistry.authStorage.logout(name);
	}
	pi.unregisterProvider(name);

	for (const pool of config.pools) {
		pool.members = pool.members.filter((member) => member !== name);
	}
	const removedPoolNames = new Set(
		config.pools.filter((pool) => pool.members.length === 0).map((pool) => pool.name),
	);
	config.pools = config.pools.filter((pool) => pool.members.length > 0);
	if (removedPoolNames.size > 0) {
		const pruned = pruneRemovedPoolReferences(config.chains, removedPoolNames);
		config.chains = pruned.chains;
	}
	config.subscriptions = config.subscriptions.filter(
		(candidate) => !(candidate.provider === entry.provider && candidate.index === entry.index),
	);

	saveGlobalConfig(config);
	ctx.modelRegistry.refresh();
	reloadPoolManagerForCurrentProject(ctx, poolManager);
	ctx.ui.notify(`Removed ${subDisplayName(entry)}`, "info");
}

async function showSubscriptionActions(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiPassConfig,
	entry: SubEntry,
	poolManager: PoolManager,
): Promise<void> {
	const source = getSubscriptionSource(config, entry);
	if (source === "env") {
		await showWrappedSelect(ctx, {
			title: `Subscription: ${subDisplayName(entry)}`,
			subtitle: "This entry comes from MULTI_SUB and is read-only here.",
			items: [
				{
					value: subProviderName(entry),
					label: formatSubscriptionListLine(entry, config, ctx.modelRegistry.authStorage),
				},
			],
			confirmHint: "back",
			cancelHint: "back",
		});
		return;
	}

	const name = subProviderName(entry);
	const hasAuth = ctx.modelRegistry.authStorage.hasAuth(name);
	const actionItems: SelectItem[] = [
		{ value: "rename", label: "rename", description: "Change friendly label" },
		hasAuth
			? { value: "logout", label: "logout", description: "Log out this subscription" }
			: { value: "login", label: "login", description: "Show login instructions" },
		{ value: "remove", label: "remove", description: "Remove this subscription" },
	];

	const action = await showWrappedSelect(ctx, {
		title: subDisplayName(entry),
		subtitle: "Escape returns to the subscriptions list.",
		items: actionItems,
		confirmHint: "open",
		cancelHint: "back",
	});
	if (!action) return;

	if (action === "rename") {
		return renameSubscriptionLabel(ctx, config, entry);
	}
	if (action === "login") {
		ctx.ui.notify(
			`Use /login and select "${PROVIDER_TEMPLATES[entry.provider]?.buildOAuth(entry.index).name}" to authenticate.`,
			"info",
		);
		return;
	}
	if (action === "logout") {
		ctx.modelRegistry.authStorage.logout(name);
		ctx.modelRegistry.refresh();
		ctx.ui.notify(`Logged out of ${subDisplayName(entry)}`, "info");
		return;
	}
	if (action === "remove") {
		return removeSubscriptionEntry(pi, ctx, config, entry, poolManager);
	}
}

async function handleSubsList(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiPassConfig,
	poolManager: PoolManager,
): Promise<void> {
	let preferredProviderName: string | undefined = ctx.model?.provider;

	while (true) {
		const envEntries = parseEnvConfig();
		const all = normalizeEntries(mergeConfigs(config, envEntries));

		if (all.length === 0) {
			ctx.ui.notify("No extra subscriptions configured. Use /subs add to create one.", "info");
			return;
		}

		const selectedProviderName = await showWrappedSelect(ctx, {
			title: "Extra Subscriptions",
			subtitle: "Select a subscription for quick actions.",
			items: all.map((entry) => ({
				value: subProviderName(entry),
				label: subDisplayName(entry),
				description: formatSubscriptionMeta(entry, config, ctx.modelRegistry.authStorage),
			})),
			initialValue: preferredProviderName,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!selectedProviderName) return;

		preferredProviderName = selectedProviderName;
		const entry = all.find((candidate) => subProviderName(candidate) === selectedProviderName);
		if (!entry) continue;
		await showSubscriptionActions(pi, ctx, config, entry, poolManager);
	}
}

async function handleSubsAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const providerItems: SelectItem[] = SUPPORTED_PROVIDERS.map((provider) => ({
		value: provider,
		label: provider,
		description: PROVIDER_TEMPLATES[provider]?.displayName,
	}));

	const provider = await showWrappedSelect(ctx, {
		title: "Select provider to add",
		items: providerItems,
		confirmHint: "select",
		cancelHint: "close",
	});
	if (!provider) return;

	if (!PROVIDER_TEMPLATES[provider]) {
		ctx.ui.notify(`Unknown provider: ${provider}`, "error");
		return;
	}

	const label = await ctx.ui.input("Label (optional)", "e.g. work, personal");

	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allEntries = normalizeEntries(mergeConfigs(config, envEntries));
	const usedIndices = new Set(
		allEntries.filter((e) => e.provider === provider).map((e) => e.index),
	);
	let nextIndex = 2;
	while (usedIndices.has(nextIndex)) nextIndex++;

	const entry: SubEntry = {
		provider,
		index: nextIndex,
		label: label?.trim() || undefined,
	};

	config.subscriptions.push(entry);
	saveGlobalConfig(config);

	registerSub(pi, entry);
	ctx.modelRegistry.refresh();

	const loginNow = await ctx.ui.confirm(
		subDisplayName(entry),
		`Created ${subDisplayName(entry)}.\n\nLogin now?`,
	);

	if (loginNow) {
		ctx.ui.notify(
			`Use /login and select "${PROVIDER_TEMPLATES[entry.provider]?.buildOAuth(entry.index).name}" to authenticate.`,
			"info",
		);
	} else {
		ctx.ui.notify(`Added ${subDisplayName(entry)}. Use /subs login to authenticate.`, "info");
	}
}

async function handleSubsRemove(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.subscriptions.length === 0) {
		ctx.ui.notify("No saved subscriptions to remove.", "info");
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Remove subscription",
		subtitle: "Select a saved subscription to remove.",
		initialValue: ctx.model?.provider,
		items: config.subscriptions.map((entry) => ({
			value: subProviderName(entry),
			label: subDisplayName(entry),
			description: ctx.modelRegistry.authStorage.hasAuth(subProviderName(entry))
				? "logged in"
				: "not logged in",
		})),
		confirmHint: "remove",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const entry = config.subscriptions.find(
		(candidate) => subProviderName(candidate) === selectedProviderName,
	);
	if (!entry) return;

	return removeSubscriptionEntry(pi, ctx, config, entry, poolManager);
}

async function handleSubsLogin(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	const notLoggedIn = all.filter(
		(entry) => !ctx.modelRegistry.authStorage.hasAuth(subProviderName(entry)),
	);

	if (notLoggedIn.length === 0) {
		ctx.ui.notify(
			all.length === 0
				? "No subscriptions configured. Use /subs add first."
				: "All subscriptions are already logged in.",
			"info",
		);
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Login to subscription",
		subtitle: "Select a subscription to see login instructions.",
		initialValue: ctx.model?.provider,
		items: notLoggedIn.map((entry) => ({
			value: subProviderName(entry),
			label: subDisplayName(entry),
			description: "not logged in",
		})),
		confirmHint: "open",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const entry = notLoggedIn.find((candidate) => subProviderName(candidate) === selectedProviderName);
	if (!entry) return;

	ctx.ui.notify(
		`Use /login and select "${PROVIDER_TEMPLATES[entry.provider]?.buildOAuth(entry.index).name}" to authenticate.`,
		"info",
	);
}

async function handleSubsLogout(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	const loggedIn = all.filter((entry) =>
		ctx.modelRegistry.authStorage.hasAuth(subProviderName(entry)),
	);

	if (loggedIn.length === 0) {
		ctx.ui.notify("No subscriptions are currently logged in.", "info");
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Logout from subscription",
		subtitle: "Select a subscription to log out.",
		initialValue: ctx.model?.provider,
		items: loggedIn.map((entry) => ({
			value: subProviderName(entry),
			label: subDisplayName(entry),
			description: "logged in",
		})),
		confirmHint: "logout",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const entry = loggedIn.find((candidate) => subProviderName(candidate) === selectedProviderName);
	if (!entry) return;

	ctx.modelRegistry.authStorage.logout(subProviderName(entry));
	ctx.modelRegistry.refresh();
	ctx.ui.notify(`Logged out of ${subDisplayName(entry)}`, "info");
}

async function handleSubsStatus(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	if (all.length === 0) {
		ctx.ui.notify("No extra subscriptions configured.", "info");
		return;
	}

	const lines: string[] = [];
	for (const entry of all) {
		const name = subProviderName(entry);
		const cred = ctx.modelRegistry.authStorage.get(name);
		const hasAuth = ctx.modelRegistry.authStorage.hasAuth(name);

		let status: string;
		if (!hasAuth) {
			status = "not logged in";
		} else if (cred?.type === "oauth") {
			const expiresIn = cred.expires - Date.now();
			if (expiresIn > 0) {
				const mins = Math.round(expiresIn / 60000);
				status = `logged in (expires ${mins}m)`;
			} else {
				status = "logged in (token expired, will refresh)";
			}
		} else {
			status = "logged in (api key)";
		}

		const modelCount = (getModels(entry.provider as any) as Model<Api>[]).length;
		const source = config.subscriptions.find(
			(s) => s.provider === entry.provider && s.index === entry.index,
		)
			? "saved"
			: "env";

		// Check if in any pool
		const inPools = config.pools
			.filter((p) => p.members.includes(name))
			.map((p) => p.name);
		const poolInfo = inPools.length > 0 ? ` | pools: ${inPools.join(", ")}` : "";

		lines.push(
			`${subDisplayName(entry)} | ${status} | ${modelCount} models | ${source}${poolInfo}`,
		);
	}

	await showWrappedSelect(ctx, {
		title: "Subscription Status",
		subtitle: "Press Enter or Escape to go back.",
		items: lines.map((line, index) => ({ value: `${index}:${line}`, label: line })),
		confirmHint: "back",
		cancelHint: "back",
	});
}

// ==========================================================================
// /pool command handlers
// ==========================================================================

/** Get all provider names that belong to a base provider type (including the original) */
function getAllProvidersForBase(
	baseProvider: string,
	allSubs: SubEntry[],
): string[] {
	const providers = [baseProvider]; // original
	for (const entry of allSubs) {
		if (entry.provider === baseProvider) {
			providers.push(subProviderName(entry));
		}
	}
	return providers;
}

function createPoolValidationMessage(members: string[]): string | null {
	if (members.length < 1) {
		return "Pool needs at least 1 member.";
	}
	return null;
}

/** Parse a human-friendly schedule window like "9-17 mon-fri" or "22-6". */
function parseScheduleWindowInput(raw: string): ScheduleWindow | null {
	const window: ScheduleWindow = {};
	const parts = raw.trim().split(/\s+/);

	for (const part of parts) {
		// Hour range: "9-17" or "22-6"
		const hourMatch = part.match(/^(\d{1,2})-(\d{1,2})$/);
		if (hourMatch) {
			const start = parseInt(hourMatch[1], 10);
			const end = parseInt(hourMatch[2], 10);
			if (start >= 0 && start <= 23 && end >= 0 && end <= 23) {
				window.hours = [start, end];
				continue;
			}
		}
		// Day range: "mon-fri" or single day: "mon"
		const dayRangeMatch = part.match(/^([a-z]{3})-([a-z]{3})$/);
		if (dayRangeMatch) {
			const startDay = dayRangeMatch[1] as DayOfWeek;
			const endDay = dayRangeMatch[2] as DayOfWeek;
			const startIdx = ALL_DAYS.indexOf(startDay);
			const endIdx = ALL_DAYS.indexOf(endDay);
			if (startIdx >= 0 && endIdx >= 0) {
				const days: DayOfWeek[] = [];
				for (let i = startIdx; i !== (endIdx + 1) % 7; i = (i + 1) % 7) {
					days.push(ALL_DAYS[i]);
				}
				days.push(ALL_DAYS[endIdx]);
				window.days = [...new Set(days)];
				continue;
			}
		}
		// Single day
		if (ALL_DAYS.includes(part as DayOfWeek)) {
			window.days = window.days || [];
			if (!window.days.includes(part as DayOfWeek)) {
				window.days.push(part as DayOfWeek);
			}
			continue;
		}
		// Date range: "2025-01-01..2025-01-31"
		const dateMatch = part.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
		if (dateMatch) {
			window.dateRange = { from: dateMatch[1], to: dateMatch[2] };
		}
	}

	if (!window.hours && !window.days && !window.dateRange) return null;
	return window;
}

function buildPoolConfig(input: {
	name: string;
	baseProvider: string;
	members: string[];
	enabled?: boolean;
	strategy?: PoolStrategy;
	memberSchedule?: Record<string, MemberSchedule>;
	selectorScript?: string;
}): { ok: true; pool: PoolConfig } | { ok: false; error: string } {
	const name = input.name.trim();
	if (!name) {
		return { ok: false, error: "Pool name is required." };
	}
	const validation = createPoolValidationMessage(input.members);
	if (validation) {
		return { ok: false, error: validation };
	}
	const pool: PoolConfig = {
		name,
		baseProvider: input.baseProvider,
		members: [...input.members],
		enabled: input.enabled ?? true,
	};
	if (input.strategy && input.strategy !== "round-robin") {
		pool.strategy = input.strategy;
	}
	if (input.memberSchedule && Object.keys(input.memberSchedule).length > 0) {
		pool.memberSchedule = input.memberSchedule;
	}
	if (input.selectorScript) {
		pool.selectorScript = input.selectorScript;
	}
	return { ok: true, pool };
}

function persistPoolConfig(
	config: MultiPassConfig,
	pool: PoolConfig,
): { action: "created" | "updated"; config: MultiPassConfig } {
	const existingIdx = config.pools.findIndex((candidate) => candidate.name === pool.name);
	if (existingIdx >= 0) {
		config.pools[existingIdx] = pool;
		return { action: "updated", config };
	}
	config.pools.push(pool);
	return { action: "created", config };
}

function reloadPoolManagerForCurrentProject(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): void {
	poolManager.loadPools(loadEffectiveConfig(ctx.cwd).pools);
}

function renamePoolReferences(
	chains: ChainConfig[],
	previousName: string,
	nextName: string,
): number {
	let updatedEntries = 0;
	for (const chain of chains) {
		for (const entry of chain.entries) {
			if (entry.pool !== previousName) continue;
			entry.pool = nextName;
			updatedEntries += 1;
		}
	}
	return updatedEntries;
}

function pruneRemovedPoolReferences(
	chains: ChainConfig[],
	removedPoolNames: Set<string>,
): { chains: ChainConfig[]; removedEntries: number; removedChains: number } {
	let removedEntries = 0;
	let removedChains = 0;

	for (const chain of chains) {
		const beforeCount = chain.entries.length;
		chain.entries = chain.entries.filter((entry) => !removedPoolNames.has(entry.pool));
		removedEntries += beforeCount - chain.entries.length;
	}

	const remainingChains = chains.filter((chain) => {
		if (chain.entries.length > 0) return true;
		removedChains += 1;
		return false;
	});

	return { chains: remainingChains, removedEntries, removedChains };
}

async function renamePoolConfig(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<void> {
	const previousName = pool.name;
	const nextName = await ctx.ui.input("Pool name", pool.name);
	if (nextName === undefined) return;

	const trimmedName = nextName.trim();
	if (!trimmedName) {
		ctx.ui.notify("Pool name is required.", "warning");
		return;
	}
	if (trimmedName === previousName) {
		ctx.ui.notify(`No changes for pool "${previousName}".`, "info");
		return;
	}
	if (config.pools.some((candidate) => candidate.name === trimmedName)) {
		ctx.ui.notify(`Pool "${trimmedName}" already exists.`, "warning");
		return;
	}

	pool.name = trimmedName;
	const updatedEntries = renamePoolReferences(config.chains, previousName, trimmedName);
	saveGlobalConfig(config);
	reloadPoolManagerForCurrentProject(ctx, poolManager);
	ctx.ui.notify(
		updatedEntries > 0
			? `Renamed pool "${previousName}" -> "${trimmedName}" and updated ${updatedEntries} chain entr${updatedEntries === 1 ? "y" : "ies"}.`
			: `Renamed pool "${previousName}" -> "${trimmedName}".`,
		"info",
	);
}

async function editPoolMembers(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<void> {
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const availableProviders = getAllProvidersForBase(pool.baseProvider, allSubs);
	const selectedMembers = [...pool.members];

	while (true) {
		const removableItems: SelectItem[] = selectedMembers.map((member) => ({
			value: `remove:${member}`,
			label: `remove ${member}`,
			description: ctx.modelRegistry.authStorage.hasAuth(member) ? "logged in" : "not logged in",
		}));
		const addableItems: SelectItem[] = availableProviders
			.filter((providerName) => !selectedMembers.includes(providerName))
			.map((providerName) => ({
				value: `add:${providerName}`,
				label: `add ${providerName}`,
				description: ctx.modelRegistry.authStorage.hasAuth(providerName)
					? "logged in"
					: "not logged in",
			}));

		const action = await showWrappedSelect(ctx, {
			title: `Pool Members: ${pool.name}`,
			subtitle: [
				`Base provider: ${pool.baseProvider}`,
				`Selected (${selectedMembers.length}): ${selectedMembers.join(", ") || "none"}`,
				"Choose add/remove entries, then save when done.",
			].join("\n"),
			items: [
				{
					value: "save",
					label: "save",
					description: "Persist member changes",
				},
				...removableItems,
				...addableItems,
			],
			confirmHint: "select",
			cancelHint: "back",
		});
		if (!action) return;

		if (action === "save") {
			const validation = createPoolValidationMessage(selectedMembers);
			if (validation) {
				ctx.ui.notify(validation, "warning");
				continue;
			}
			const changed = pool.members.length !== selectedMembers.length
				|| pool.members.some((member, index) => member !== selectedMembers[index]);
			if (!changed) {
				ctx.ui.notify(`No changes for pool "${pool.name}".`, "info");
				return;
			}
			pool.members = [...selectedMembers];
			saveGlobalConfig(config);
			reloadPoolManagerForCurrentProject(ctx, poolManager);
			ctx.ui.notify(
				`Updated pool "${pool.name}" with ${pool.members.length} member${pool.members.length === 1 ? "" : "s"}: ${pool.members.join(", ")}.`,
				"info",
			);
			return;
		}

		if (action.startsWith("remove:")) {
			const member = action.slice("remove:".length);
			const index = selectedMembers.indexOf(member);
			if (index >= 0) selectedMembers.splice(index, 1);
			continue;
		}

		if (action.startsWith("add:")) {
			const member = action.slice("add:".length);
			if (!selectedMembers.includes(member)) {
				selectedMembers.push(member);
			}
		}
	}
}

async function promptForPoolDefinition(
	ctx: ExtensionCommandContext,
	options?: {
		allowOverwrite?: boolean;
		resumeChainName?: string;
	},
): Promise<PoolConfig | undefined> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const providerLabels = SUPPORTED_PROVIDERS.map((p) => {
		const t = PROVIDER_TEMPLATES[p];
		return `${p} -- ${t.displayName}`;
	});

	const selectedProvider = await ctx.ui.select("Pool base provider", providerLabels);
	if (!selectedProvider) return undefined;
	const baseProvider = selectedProvider.split(" -- ")[0];

	const poolName = await ctx.ui.input("Pool name", `e.g. ${baseProvider}-pool`);
	if (!poolName?.trim()) return undefined;

	const allProviders = getAllProvidersForBase(baseProvider, allSubs);
	const authedProviders = allProviders.filter((p) =>
		ctx.modelRegistry.authStorage.hasAuth(p),
	);

	if (authedProviders.length === 0) {
		ctx.ui.notify(
			`No authenticated ${baseProvider} subscriptions found. Login first with /subs login.`,
			"warning",
		);
		return undefined;
	}

	const members: string[] = [];
	let selecting = true;
	while (selecting) {
		const remaining = allProviders.filter((p) => !members.includes(p));
		if (remaining.length === 0) break;

		const optionsList = [
			`--- Selected (${members.length}): ${members.join(", ") || "none"} ---`,
			...remaining.map((p) => {
				const authed = ctx.modelRegistry.authStorage.hasAuth(p);
				return `${p} ${authed ? "[logged in]" : "[not logged in]"}`;
			}),
			"[Done - create pool]",
		];

		const picked = await ctx.ui.select("Add members ([Done] saves, Esc cancels)", optionsList);
		if (!picked) {
			ctx.ui.notify(`Cancelled pool creation${poolName ? ` for "${poolName}"` : ""}.`, "info");
			return undefined;
		}
		if (picked.startsWith("---")) {
			continue;
		}
		if (picked === "[Done - create pool]") {
			if (members.length === 0) {
				ctx.ui.notify("Select at least one member.", "warning");
				continue;
			}
			selecting = false;
			continue;
		}

		const provName = picked.split(" ")[0];
		if (provName && allProviders.includes(provName)) {
			members.push(provName);
		}
	}

	// Ask for selection strategy
	const strategyItems = [
		"round-robin -- Rotate members sequentially (default)",
		"quota-first -- Prefer the member with the most remaining quota",
		"scheduled -- Use per-member time windows and priority roles",
		"custom -- Delegate to a JS selector script",
	];
	const strategyPick = await ctx.ui.select("Selection strategy", strategyItems);
	let strategy: PoolStrategy = "round-robin";
	if (strategyPick?.startsWith("quota-first")) strategy = "quota-first";
	else if (strategyPick?.startsWith("scheduled")) strategy = "scheduled";
	else if (strategyPick?.startsWith("custom")) strategy = "custom";

	// Collect strategy-specific config
	let memberSchedule: Record<string, MemberSchedule> | undefined;
	let selectorScript: string | undefined;

	if (strategy === "scheduled" && members.length > 0) {
		memberSchedule = {};
		for (const member of members) {
			const roleItems = [
				"default -- Always available (no schedule needed)",
				"preferred -- Only during time windows (burn quota when window active)",
				"overflow -- Last resort (used when preferred/default exhausted)",
			];
			const rolePick = await ctx.ui.select(`Role for ${member}`, roleItems);
			if (!rolePick) continue;

			let role: "preferred" | "overflow" | undefined;
			if (rolePick.startsWith("preferred")) role = "preferred";
			else if (rolePick.startsWith("overflow")) role = "overflow";

			if (role === "preferred") {
				const windowDef = await ctx.ui.input(
					`Time window for ${member}`,
					"hours e.g. 9-17, days e.g. mon-fri (or leave empty for always)",
				);
				const schedule: MemberSchedule = { role, windows: [] };
				if (windowDef?.trim()) {
					const window = parseScheduleWindowInput(windowDef.trim());
					if (window) schedule.windows = [window];
				}
				memberSchedule[member] = schedule;
			} else if (role === "overflow") {
				memberSchedule[member] = { role };
			}
			// "default" role = no entry needed
		}
		if (Object.keys(memberSchedule).length === 0) memberSchedule = undefined;
	}

	if (strategy === "custom") {
		const scriptPath = await ctx.ui.input(
			"Selector script path",
			"e.g. selectors/my-pool.js (relative to ~/.pi/agent/)",
		);
		if (scriptPath?.trim()) {
			selectorScript = scriptPath.trim();
			const resolved = resolveSelectorScriptPath(selectorScript);
			if (!existsSync(resolved)) {
				ctx.ui.notify(
					`Warning: script not found at ${resolved}. You can create it later.`,
					"warning",
				);
			}
		} else {
			ctx.ui.notify("No selector script provided. Pool will fall back to round-robin.", "warning");
			strategy = "round-robin";
		}
	}

	const built = buildPoolConfig({
		name: poolName,
		baseProvider,
		members,
		enabled: true,
		strategy,
		memberSchedule,
		selectorScript,
	});
	if (!built.ok) {
		ctx.ui.notify(built.error, "warning");
		return undefined;
	}

	const existing = config.pools.find((pool) => pool.name === built.pool.name);
	if (existing && !options?.allowOverwrite) {
		ctx.ui.notify(`Pool "${built.pool.name}" already exists.`, "warning");
		return undefined;
	}
	if (existing && options?.allowOverwrite) {
		const overwrite = await ctx.ui.confirm(
			"Pool exists",
			`Pool "${built.pool.name}" already exists. Overwrite?`,
		);
		if (!overwrite) return undefined;
	}

	if (options?.resumeChainName) {
		ctx.ui.notify(
			`Prepared pool "${built.pool.name}" for chain "${options.resumeChainName}".`,
			"info",
		);
	}

	return built.pool;
}

async function createAndPersistPool(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	options?: {
		allowOverwrite?: boolean;
		resumeChainName?: string;
	},
): Promise<PoolConfig | undefined> {
	const pool = await promptForPoolDefinition(ctx, options);
	if (!pool) return undefined;

	const config = loadGlobalConfig();
	const persisted = persistPoolConfig(config, pool);
	saveGlobalConfig(persisted.config);
	reloadPoolManagerForCurrentProject(ctx, poolManager);

	const resumeSuffix = options?.resumeChainName
		? ` Chain builder resumed for "${options.resumeChainName}".`
		: "";
	ctx.ui.notify(
		`${persisted.action === "created" ? "Created" : "Updated"} pool "${pool.name}" with ${pool.members.length} member${pool.members.length === 1 ? "" : "s"}: ${pool.members.join(", ")}.${resumeSuffix}`,
		"info",
	);
	return pool;
}

function getSelectableModelsForPool(pool: PoolConfig): string[] {
	return (getModels(pool.baseProvider as any) as Model<Api>[]).map((model) => model.id);
}

function createChainValidationError(
	config: MultiPassConfig,
	chain: ChainConfig,
): string | null {
	if (!chain.name.trim()) {
		return "Chain name is required.";
	}
	if (findChainByName(config.chains, chain.name)) {
		return `Chain "${chain.name}" already exists.`;
	}
	if (chain.entries.length === 0) {
		return `Chain "${chain.name}" needs at least 1 entry.`;
	}

	for (const entry of chain.entries) {
		const pool = config.pools.find((candidate) => candidate.name === entry.pool);
		if (!pool) {
			return `Chain entry pool "${entry.pool}" does not exist.`;
		}
		const selectableModels = getSelectableModelsForPool(pool);
		if (selectableModels.length === 0) {
			return `Pool "${pool.name}" has no selectable models for ${pool.baseProvider}.`;
		}
		if (!selectableModels.includes(entry.model)) {
			return `Model "${entry.model}" is not available for pool "${pool.name}".`;
		}
	}

	return null;
}

function buildChainConfig(
	config: MultiPassConfig,
	input: { name: string; entries: ChainEntryConfig[]; enabled?: boolean },
): { ok: true; chain: ChainConfig } | { ok: false; error: string } {
	const chain: ChainConfig = {
		name: input.name.trim(),
		entries: input.entries.map((entry) => ({ ...entry })),
		enabled: input.enabled ?? true,
	};
	const validationError = createChainValidationError(config, chain);
	if (validationError) {
		return { ok: false, error: validationError };
	}
	return { ok: true, chain };
}

async function handlePoolCreate(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	await createAndPersistPool(ctx, poolManager, { allowOverwrite: true });
}

async function inspectPoolConfig(
	ctx: ExtensionCommandContext,
	pool: PoolConfig,
	poolManager: PoolManager,
): Promise<void> {
	await showWrappedSelect(ctx, {
		title: `Pool Status: ${pool.name}`,
		subtitle: "Press Enter or Escape to go back to the pools list.",
		items: formatPoolStatusLines(pool, ctx.modelRegistry.authStorage, poolManager)
			.map((line, index) => ({ value: `${index}:${line}`, label: line })),
		confirmHint: "back",
		cancelHint: "back",
	});
}

async function togglePoolConfig(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<void> {
	pool.enabled = !pool.enabled;
	saveGlobalConfig(config);
	reloadPoolManagerForCurrentProject(ctx, poolManager);
	ctx.ui.notify(`Pool "${pool.name}" is now ${pool.enabled ? "enabled" : "disabled"}`, "info");
}

async function changePoolStrategy(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<void> {
	const current = pool.strategy || "round-robin";
	const items: SelectItem[] = [
		{
			value: "round-robin",
			label: "round-robin",
			description: "Rotate members sequentially (default)",
		},
		{
			value: "quota-first",
			label: "quota-first",
			description: "Prefer the member with the most remaining quota",
		},
		{
			value: "scheduled",
			label: "scheduled",
			description: "Use per-member time windows and priority roles",
		},
		{
			value: "custom",
			label: "custom",
			description: "Delegate to a JS selector script",
		},
	];

	const selected = await showWrappedSelect(ctx, {
		title: `Strategy: ${pool.name}`,
		subtitle: `Currently: ${current}`,
		items,
		initialValue: current,
		confirmHint: "select",
		cancelHint: "back",
	});
	if (!selected) return;

	const nextStrategy = selected as PoolStrategy;
	if (nextStrategy === current) {
		ctx.ui.notify(`Strategy unchanged (${current}).`, "info");
		return;
	}

	if (nextStrategy === "round-robin") {
		delete pool.strategy;
		delete pool.memberSchedule;
		delete pool.selectorScript;
	} else {
		pool.strategy = nextStrategy;
	}

	// Collect strategy-specific config
	if (nextStrategy === "scheduled") {
		const memberSchedule: Record<string, MemberSchedule> = {};
		for (const member of pool.members) {
			const roleItems = [
				"default -- Always available (no schedule needed)",
				"preferred -- Only during time windows",
				"overflow -- Last resort",
			];
			const rolePick = await ctx.ui.select(`Role for ${member}`, roleItems);
			if (!rolePick) continue;

			let role: "preferred" | "overflow" | undefined;
			if (rolePick.startsWith("preferred")) role = "preferred";
			else if (rolePick.startsWith("overflow")) role = "overflow";

			if (role === "preferred") {
				const windowDef = await ctx.ui.input(
					`Time window for ${member}`,
					"e.g. 9-17 mon-fri",
				);
				const schedule: MemberSchedule = { role, windows: [] };
				if (windowDef?.trim()) {
					const window = parseScheduleWindowInput(windowDef.trim());
					if (window) schedule.windows = [window];
				}
				memberSchedule[member] = schedule;
			} else if (role === "overflow") {
				memberSchedule[member] = { role };
			}
		}
		pool.memberSchedule = Object.keys(memberSchedule).length > 0 ? memberSchedule : undefined;
		delete pool.selectorScript;
	} else if (nextStrategy === "custom") {
		const scriptPath = await ctx.ui.input(
			"Selector script path",
			"e.g. selectors/my-pool.js (relative to ~/.pi/agent/)",
		);
		if (!scriptPath?.trim()) {
			ctx.ui.notify("No script path provided. Reverting to round-robin.", "warning");
			delete pool.strategy;
			return;
		}
		pool.selectorScript = scriptPath.trim();
		selectorCache.delete(resolveSelectorScriptPath(pool.selectorScript));
		delete pool.memberSchedule;
	} else if (nextStrategy === "quota-first") {
		delete pool.memberSchedule;
		delete pool.selectorScript;
	}

	saveGlobalConfig(config);
	reloadPoolManagerForCurrentProject(ctx, poolManager);
	ctx.ui.notify(`Pool "${pool.name}" strategy changed to ${nextStrategy}.`, "info");
}

async function removePoolConfig(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<boolean> {
	const referencedEntries = config.chains.reduce(
		(count, chain) => count + chain.entries.filter((entry) => entry.pool === pool.name).length,
		0,
	);
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		referencedEntries > 0
			? `Remove pool "${pool.name}"? (Subscriptions are kept.)\n\nThis will also remove ${referencedEntries} chain entr${referencedEntries === 1 ? "y" : "ies"} that reference this pool.`
			: `Remove pool "${pool.name}"? (Subscriptions are kept.)`,
	);
	if (!confirmed) return false;

	const pruned = pruneRemovedPoolReferences(config.chains, new Set([pool.name]));
	const removedEntries = pruned.removedEntries;
	const removedChains = pruned.removedChains;
	config.chains = pruned.chains;
	config.pools = config.pools.filter((candidate) => candidate.name !== pool.name);
	saveGlobalConfig(config);
	reloadPoolManagerForCurrentProject(ctx, poolManager);

	let message = `Removed pool "${pool.name}"`;
	if (removedEntries > 0) {
		message += ` and ${removedEntries} linked chain entr${removedEntries === 1 ? "y" : "ies"}`;
	}
	if (removedChains > 0) {
		message += ` (${removedChains} empty chain${removedChains === 1 ? "" : "s"} deleted)`;
	}
	ctx.ui.notify(`${message}.`, "info");
	return true;
}

async function showPoolActions(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<"removed" | undefined> {
	const currentStrategy = pool.strategy || "round-robin";
	const action = await showWrappedSelect(ctx, {
		title: pool.name,
		subtitle: "Escape returns to the pools list.",
		items: [
			{ value: "inspect", label: "inspect", description: "View pool health and member status" },
			{ value: "rename", label: "rename", description: "Change pool name" },
			{ value: "members", label: "members", description: "Add or remove pool members" },
			{
				value: "strategy",
				label: "strategy",
				description: `Currently ${currentStrategy}`,
			},
			{
				value: "toggle",
				label: pool.enabled ? "disable" : "enable",
				description: `Currently ${pool.enabled ? "enabled" : "disabled"}`,
			},
			{ value: "remove", label: "remove", description: "Delete this pool (subscriptions are kept)" },
		],
		confirmHint: "open",
		cancelHint: "back",
	});
	if (!action) return undefined;

	if (action === "inspect") {
		await inspectPoolConfig(ctx, pool, poolManager);
		return undefined;
	}
	if (action === "rename") {
		await renamePoolConfig(ctx, poolManager, config, pool);
		return undefined;
	}
	if (action === "members") {
		await editPoolMembers(ctx, poolManager, config, pool);
		return undefined;
	}
	if (action === "strategy") {
		await changePoolStrategy(ctx, poolManager, config, pool);
		return undefined;
	}
	if (action === "toggle") {
		await togglePoolConfig(ctx, poolManager, config, pool);
		return undefined;
	}
	if (action === "remove") {
		const removed = await removePoolConfig(ctx, poolManager, config, pool);
		return removed ? "removed" : undefined;
	}
	return undefined;
}

async function handlePoolList(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	let preferredPoolName: string | undefined;

	while (true) {
		const config = loadGlobalConfig();
		const pools = config.pools;

		if (pools.length === 0) {
			ctx.ui.notify("No pools configured. Use /pool create to make one.", "info");
			return;
		}

		const selectedPoolName = await showWrappedSelect(ctx, {
			title: "Pools",
			subtitle: "Select a pool for quick actions.",
			items: pools.map((pool) => ({
				value: pool.name,
				label: pool.name,
				description: formatPoolListDescription(pool, ctx.modelRegistry.authStorage, poolManager),
			})),
			initialValue: preferredPoolName,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!selectedPoolName) return;

		preferredPoolName = selectedPoolName;
		const pool = config.pools.find((candidate) => candidate.name === selectedPoolName);
		if (!pool) continue;
		const result = await showPoolActions(ctx, poolManager, config, pool);
		if (result === "removed") {
			preferredPoolName = undefined;
			continue;
		}
		preferredPoolName = pool.name;
	}
}

async function handlePoolToggle(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.pools.length === 0) {
		ctx.ui.notify("No pools configured.", "info");
		return;
	}

	const options = config.pools.map(
		(p) => `${p.name} -- currently ${p.enabled ? "enabled" : "disabled"}`,
	);

	const selected = await ctx.ui.select("Toggle pool", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	return togglePoolConfig(ctx, poolManager, config, config.pools[idx]);
}

async function handlePoolRemove(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.pools.length === 0) {
		ctx.ui.notify("No pools configured.", "info");
		return;
	}

	const options = config.pools.map((p) => {
		const memberLabel = p.members.length === 1 ? "member" : "members";
		return `${p.name} (${p.members.length} ${memberLabel})`;
	});

	const selected = await ctx.ui.select("Remove pool", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	await removePoolConfig(ctx, poolManager, config, config.pools[idx]);
}

function summarizePoolHealth(
	pool: PoolConfig,
	authStorage: { hasAuth(provider: string): boolean },
	poolManager: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): {
	availableCount: number;
	authedCount: number;
	memberCount: number;
	unavailableCount: number;
	statusLabel: string;
} {
	const availableMembers = pool.enabled
		? poolManager.getAvailableMembers(pool, authStorage)
		: [];
	let authedCount = 0;
	for (const member of pool.members) {
		if (authStorage.hasAuth(member)) authedCount += 1;
	}
	const availableCount = availableMembers.length;
	const memberCount = pool.members.length;
	const unavailableCount = memberCount - availableCount;
	let statusLabel = `${availableCount}/${memberCount} available`;
	if (!pool.enabled) {
		statusLabel += " | pool disabled";
	} else if (memberCount === 0) {
		statusLabel += " | no members configured";
	} else if (availableCount === 0) {
		if (authedCount === 0) {
			statusLabel += " | no auth";
		} else {
			statusLabel += " | cooldown/no eligible members";
		}
	}
	return {
		availableCount,
		authedCount,
		memberCount,
		unavailableCount,
		statusLabel,
	};
}

function formatPoolListDescription(
	pool: PoolConfig,
	authStorage: { hasAuth(provider: string): boolean },
	poolManager: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string {
	const summary = summarizePoolHealth(pool, authStorage, poolManager);
	const status = pool.enabled ? "enabled" : "disabled";
	return `${pool.baseProvider} | ${summary.memberCount} member${summary.memberCount === 1 ? "" : "s"} (${summary.authedCount} authed, ${summary.availableCount} available) | ${status}${summary.unavailableCount > 0 ? ` | ${summary.unavailableCount} unavailable` : ""}`;
}

function formatPoolStatusLines(
	pool: PoolConfig,
	authStorage: { hasAuth(provider: string): boolean },
	poolManager: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string[] {
	const summary = summarizePoolHealth(pool, authStorage, poolManager);
	const strategy = pool.strategy || "round-robin";
	const lines = [
		`=== ${pool.name} (${pool.enabled ? "enabled" : "disabled"}) ===`,
		`provider: ${pool.baseProvider}`,
		`strategy: ${strategy}`,
		`members: ${summary.memberCount}`,
		`availability: ${summary.statusLabel}`,
	];
	if (pool.selectorScript) {
		lines.push(`selector: ${pool.selectorScript}`);
	}
	if (pool.members.length === 0) {
		lines.push("  [no members configured]");
		return lines;
	}
	const memberSchedule = pool.memberSchedule || {};
	for (const member of pool.members) {
		const authed = authStorage.hasAuth(member);
		const exhausted = pool.enabled && authed && poolManager.isMemberExhausted(pool, member);
		let status = authed ? "logged in" : "not logged in";
		if (exhausted) status += " (rate limited, cooling down)";
		if (pool.enabled && authed && !exhausted) status += " (available)";
		if (!pool.enabled && authed) status += " (pool disabled)";

		const schedule = memberSchedule[member];
		if (schedule) {
			const role = schedule.role || "default";
			status += ` [${role}]`;
			if (schedule.windows && schedule.windows.length > 0) {
				const now = new Date();
				const state = getScheduledMemberState(member, schedule, now);
				status += state.active ? " (in window)" : " (outside window)";
			}
		}

		lines.push(`  ${member} -- ${status}`);
	}
	return lines;
}

async function handlePoolStatus(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.pools.length === 0) {
		ctx.ui.notify("No pools configured.", "info");
		return;
	}

	const lines: string[] = [];
	for (const pool of config.pools) {
		lines.push(
			...formatPoolStatusLines(pool, ctx.modelRegistry.authStorage, poolManager),
		);
	}

	await ctx.ui.select("Pool Status", lines);
}

function findChainByName(chains: ChainConfig[], name: string): ChainConfig | undefined {
	return chains.find((chain) => chain.name === name);
}

function getChainEntryIssue(entry: ChainEntryConfig, config: MultiPassConfig): string | null {
	const pool = config.pools.find((candidate) => candidate.name === entry.pool);
	if (!pool) {
		return `invalid pool: ${entry.pool} missing`;
	}
	if (!pool.enabled) {
		return `invalid pool: ${pool.name} disabled`;
	}
	const selectableModels = getSelectableModelsForPool(pool);
	if (selectableModels.length === 0) {
		return `invalid model: no selectable models for ${pool.baseProvider}`;
	}
	if (!selectableModels.includes(entry.model)) {
		return `invalid model: ${entry.model} unavailable for ${pool.name}`;
	}
	return null;
}

interface FailoverCandidate {
	poolName: string;
	provider: string;
	modelId: string;
	source: "pool" | "chain";
	chainName?: string;
	chainIndex?: number;
}

interface FailoverSkip {
	type: "pool-member" | "chain-entry";
	poolName: string;
	reason:
		| "no-auth"
		| "exhausted"
		| "missing-pool"
		| "disabled-entry"
		| "disabled-pool"
		| "unavailable-model"
		| "no-eligible-members"
		| "already-attempted"
		| "already-visited-chain-entry";
	detail: string;
	chainName?: string;
	chainIndex?: number;
}

interface FailoverPlanOptions {
	attemptedProviders?: Set<string>;
	visitedChainIndexes?: Set<number>;
}

interface FailoverPlan {
	pool?: PoolConfig;
	chain?: ChainConfig;
	currentChainIndex?: number;
	candidates: FailoverCandidate[];
	skips: FailoverSkip[];
}

interface FailoverCascadeState {
	prompt: string;
	attemptedProviders: Set<string>;
	visitedChainIndexes: Set<number>;
}

function formatFailoverTarget(candidate: Pick<FailoverCandidate, "provider" | "modelId">): string {
	return `${candidate.provider} (${candidate.modelId})`;
}

function formatFailoverStatus(
	candidate:
		| Pick<FailoverCandidate, "provider" | "modelId" | "source" | "poolName" | "chainName" | "chainIndex">
		| null,
	fallbackPoolName?: string,
): string {
	if (!candidate) {
		return fallbackPoolName
			? `pool:${fallbackPoolName} | cascade exhausted | no eligible target`
			: "cascade exhausted | no eligible target";
	}
	const scope = candidate.source === "chain"
		? `chain:${candidate.chainName}#${(candidate.chainIndex ?? 0) + 1}`
		: `pool:${candidate.poolName}`;
	return `${scope} | active ${formatFailoverTarget(candidate)}`;
}

function formatFailoverContinuation(
	nextCandidate: Pick<FailoverCandidate, "provider" | "modelId" | "source" | "poolName" | "chainName" | "chainIndex"> | undefined,
): string {
	if (!nextCandidate) {
		return "cascade exhausted; no later eligible target";
	}
	const phase = nextCandidate.source === "chain"
		? `continuing forward to chain ${nextCandidate.chainName}#${(nextCandidate.chainIndex ?? 0) + 1}`
		: `continuing within pool ${nextCandidate.poolName}`;
	return `${phase} -> ${formatFailoverTarget(nextCandidate)}`;
}

function formatFailoverTransition(
	poolName: string,
	currentProvider: string,
	nextCandidate: Pick<FailoverCandidate, "provider" | "modelId" | "source" | "poolName" | "chainName" | "chainIndex">,
): string {
	const phase = nextCandidate.source === "chain"
		? `advancing to chain ${nextCandidate.chainName}#${(nextCandidate.chainIndex ?? 0) + 1}`
		: `rotating within pool ${poolName}`;
	return `[pool:${poolName}] Rate limited on ${currentProvider}; ${phase}; active ${formatFailoverTarget(nextCandidate)}`;
}

function formatFailoverExhausted(poolName: string, currentProvider: string): string {
	return `[pool:${poolName}] Failover exhausted after ${currentProvider}; no eligible target remained in this cascade.`;
}

function classifyPoolMemberSkip(
	poolName: string,
	provider: string,
	authStorage: { hasAuth(provider: string): boolean },
	exhausted: boolean,
): FailoverSkip | null {
	if (!authStorage.hasAuth(provider)) {
		return {
			type: "pool-member",
			poolName,
			reason: "no-auth",
			detail: `${provider} skipped (no auth)` ,
		};
	}
	if (exhausted) {
		return {
			type: "pool-member",
			poolName,
			reason: "exhausted",
			detail: `${provider} skipped (cooldown active)`,
		};
	}
	return null;
}

function classifyChainEntrySkip(
	chain: ChainConfig,
	chainIndex: number,
	entry: ChainEntryConfig,
	config: MultiPassConfig,
): FailoverSkip | null {
	if (!entry.enabled) {
		return {
			type: "chain-entry",
			poolName: entry.pool,
			reason: "disabled-entry",
			detail: `${entry.pool} -> ${entry.model} skipped (entry disabled)`,
			chainName: chain.name,
			chainIndex,
		};
	}
	const issue = getChainEntryIssue(entry, config);
	if (!issue) return null;
	const reason = issue.includes("missing")
		? "missing-pool"
		: issue.includes("disabled")
			? "disabled-pool"
			: "unavailable-model";
	return {
		type: "chain-entry",
		poolName: entry.pool,
		reason,
		detail: `${entry.pool} -> ${entry.model} skipped (${issue})`,
		chainName: chain.name,
		chainIndex,
	};
}

function formatChainEntryStatus(
	entry: ChainEntryConfig,
	config?: MultiPassConfig,
	authStorage?: { hasAuth(provider: string): boolean },
	poolManager?: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string {
	const entryState = entry.enabled ? "enabled" : "disabled";
	const issue = config ? getChainEntryIssue(entry, config) : null;
	let healthSuffix = "";
	if (config && authStorage && poolManager) {
		const pool = config.pools.find((candidate) => candidate.name === entry.pool);
		if (pool) {
			const summary = summarizePoolHealth(pool, authStorage, poolManager);
			healthSuffix = ` | pool ${pool.enabled ? "enabled" : "disabled"} | ${summary.availableCount}/${summary.memberCount} available | ${summary.authedCount} authed`;
		}
	}
	const issueSuffix = issue ? ` | ${issue} | skipped` : "";
	return `${entry.pool} -> ${entry.model} (${entryState}${healthSuffix}${issueSuffix})`;
}

function formatChainListLine(
	chain: ChainConfig,
	config?: MultiPassConfig,
	authStorage?: { hasAuth(provider: string): boolean },
	poolManager?: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string {
	const entryLabel = chain.entries.length === 1 ? "entry" : "entries";
	const invalidEntries = config
		? chain.entries.filter((entry) => getChainEntryIssue(entry, config)).length
		: 0;
	let usableEntries = 0;
	if (config && authStorage && poolManager) {
		usableEntries = chain.entries.filter((entry) => {
			if (!entry.enabled) return false;
			if (getChainEntryIssue(entry, config)) return false;
			const pool = config.pools.find((candidate) => candidate.name === entry.pool);
			if (!pool || !pool.enabled) return false;
			return summarizePoolHealth(pool, authStorage, poolManager).availableCount > 0;
		}).length;
	}
	const issueLabel = invalidEntries > 0 ? ` | ${invalidEntries} invalid` : "";
	const usableLabel = config && authStorage && poolManager
		? ` | ${usableEntries}/${chain.entries.length} usable now`
		: "";
	return `${chain.name} | ${chain.entries.length} ${entryLabel} | ${chain.enabled ? "enabled" : "disabled"}${issueLabel}${usableLabel}`;
}

function formatChainToggleOption(chain: ChainConfig): string {
	return `${chain.name} -- currently ${chain.enabled ? "enabled" : "disabled"}`;
}

function formatChainRemoveOption(chain: ChainConfig): string {
	const entryLabel = chain.entries.length === 1 ? "entry" : "entries";
	return `${chain.name} (${chain.entries.length} ${entryLabel})`;
}

function formatChainStatusLines(
	chain: ChainConfig,
	config?: MultiPassConfig,
	authStorage?: { hasAuth(provider: string): boolean },
	poolManager?: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string[] {
	const invalidEntries = config
		? chain.entries.filter((entry) => getChainEntryIssue(entry, config)).length
		: 0;
	const usableEntries = config && authStorage && poolManager
		? chain.entries.filter((entry) => {
			if (!entry.enabled) return false;
			if (getChainEntryIssue(entry, config)) return false;
			const pool = config.pools.find((candidate) => candidate.name === entry.pool);
			if (!pool || !pool.enabled) return false;
			return summarizePoolHealth(pool, authStorage, poolManager).availableCount > 0;
		}).length
		: undefined;
	const lines = [
		`=== ${chain.name} (${chain.enabled ? "enabled" : "disabled"}) ===`,
		`entries: ${chain.entries.length}`,
		`chain state: ${chain.enabled ? "active" : "disabled (all entries skipped)"}`,
	];

	if (usableEntries !== undefined) {
		lines.push(`usable entries now: ${usableEntries}/${chain.entries.length}`);
	}

	if (invalidEntries > 0) {
		lines.push(`invalid entries: ${invalidEntries} (skipped until fixed)`);
	}

	if (chain.entries.length === 0) {
		lines.push("  [no entries configured]");
		return lines;
	}

	for (let i = 0; i < chain.entries.length; i++) {
		const entry = chain.entries[i];
		lines.push(`  ${i + 1}. ${formatChainEntryStatus(entry, config, authStorage, poolManager)}`);
	}

	return lines;
}

async function handlePoolChainCreate(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	const chainName = await ctx.ui.input("Chain name", "e.g. primary-fallback");
	if (!chainName?.trim()) return;
	if (findChainByName(config.chains, chainName.trim())) {
		ctx.ui.notify(`Chain "${chainName.trim()}" already exists.`, "warning");
		return;
	}

	const entries: ChainEntryConfig[] = [];
	let selecting = true;
	while (selecting) {
		const latestConfig = loadGlobalConfig();
		const availablePools = latestConfig.pools;
		const options = [
			`--- Selected (${entries.length}): ${entries.map((entry) => formatChainEntryStatus(entry, latestConfig)).join(", ") || "none"} ---`,
			...availablePools.map((pool) => `${pool.name} -- ${pool.baseProvider} (${pool.enabled ? "enabled" : "disabled"})`),
			"[Create pool inline]",
			"[Done - save chain]",
		];

		const selected = await ctx.ui.select("Add chain entries ([Done] saves, Esc cancels)", options);
		if (!selected) {
			ctx.ui.notify(`Cancelled chain creation for "${chainName.trim()}".`, "info");
			return;
		}
		if (selected.startsWith("---")) {
			continue;
		}

		if (selected === "[Done - save chain]") {
			if (entries.length === 0) {
				ctx.ui.notify(`Chain "${chainName.trim()}" needs at least 1 entry.`, "warning");
				continue;
			}
			selecting = false;
			continue;
		}

		if (selected === "[Create pool inline]") {
			await createAndPersistPool(ctx, poolManager, {
				allowOverwrite: false,
				resumeChainName: chainName.trim(),
			});
			continue;
		}

		const poolName = selected.split(" -- ")[0];
		const pool = availablePools.find((candidate) => candidate.name === poolName);
		if (!pool) {
			ctx.ui.notify(`Pool "${poolName}" is no longer available.`, "warning");
			continue;
		}

		const selectableModels = getSelectableModelsForPool(pool);
		if (selectableModels.length === 0) {
			ctx.ui.notify(
				`Pool "${pool.name}" has no selectable models for ${pool.baseProvider}.`,
				"warning",
			);
			continue;
		}

		const selectedModel = await ctx.ui.select(
			`Default model for ${pool.name}`,
			selectableModels,
		);
		if (!selectedModel) continue;

		const enabled = await ctx.ui.confirm(
			`Enable entry for ${pool.name}?`,
			`${pool.name} -> ${selectedModel}\n\nEnable this chain entry?`,
		);
		entries.push({ pool: pool.name, model: selectedModel, enabled });
	}

	const latestConfig = loadGlobalConfig();
	const built = buildChainConfig(latestConfig, {
		name: chainName.trim(),
		entries,
		enabled: true,
	});
	if (!built.ok) {
		ctx.ui.notify(built.error, "warning");
		return;
	}

	latestConfig.chains.push(built.chain);
	saveGlobalConfig(latestConfig);
	ctx.ui.notify(
		`Created chain "${built.chain.name}" with ${built.chain.entries.length} ${built.chain.entries.length === 1 ? "entry" : "entries"}.`,
		"info",
	);
}

async function handlePoolChainList(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured. Use /pool chain to create one.", "info");
		return;
	}

	await ctx.ui.select(
		"Chains",
		config.chains.map((chain) =>
			formatChainListLine(chain, config, ctx.modelRegistry.authStorage, poolManager),
		),
	);
}

async function handlePoolChainToggle(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured.", "info");
		return;
	}

	const options = config.chains.map(formatChainToggleOption);
	const selected = await ctx.ui.select("Toggle chain", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	config.chains[idx].enabled = !config.chains[idx].enabled;
	saveGlobalConfig(config);

	const chain = config.chains[idx];
	ctx.ui.notify(
		`Chain "${chain.name}" is now ${chain.enabled ? "enabled" : "disabled"}`,
		"info",
	);
}

async function handlePoolChainRemove(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured.", "info");
		return;
	}

	const options = config.chains.map(formatChainRemoveOption);
	const selected = await ctx.ui.select("Remove chain", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	const chain = config.chains[idx];
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		`Remove chain "${chain.name}"?`,
	);
	if (!confirmed) return;

	config.chains.splice(idx, 1);
	saveGlobalConfig(config);
	ctx.ui.notify(`Removed chain "${chain.name}"`, "info");
}

async function handlePoolChainStatus(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured.", "info");
		return;
	}

	const selected = await ctx.ui.select(
		"Chain Status",
		config.chains.map((chain) => `${chain.name} -- inspect chain entries`),
	);
	if (!selected) return;

	const chainName = selected.split(" -- ")[0];
	const chain = findChainByName(config.chains, chainName);
	if (!chain) {
		ctx.ui.notify(`Chain "${chainName}" not found.`, "warning");
		return;
	}

	await ctx.ui.select(
		`Chain Status: ${chain.name}`,
		formatChainStatusLines(chain, config, ctx.modelRegistry.authStorage, poolManager),
	);
}

async function handlePoolChainMenu(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const actions = [
		"create   -- Create a new fallback chain",
		"list     -- Show all chains",
		"toggle   -- Enable/disable a chain",
		"remove   -- Remove a chain",
		"status   -- Inspect ordered chain entries",
	];

	const selected = await ctx.ui.select("Chain Manager", actions);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();
	switch (action) {
		case "create":
			return handlePoolChainCreate(ctx, poolManager);
		case "list":
			return handlePoolChainList(ctx, poolManager);
		case "toggle":
			return handlePoolChainToggle(ctx);
		case "remove":
			return handlePoolChainRemove(ctx);
		case "status":
			return handlePoolChainStatus(ctx, poolManager);
	}
}

async function handlePoolProject(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const projectPath = projectConfigPath(ctx.cwd);
	const projectConf = loadProjectConfig(ctx.cwd);
	const globalConf = loadGlobalConfig();

	const hasProjectConfig = projectConf !== undefined;

	const actions: string[] = [];
	if (hasProjectConfig) {
		actions.push(`edit     -- Edit project pool config (${projectPath})`);
		actions.push("clear    -- Remove project config (use global pools)");
	}
	actions.push("restrict -- Set allowed subs for this project");
	actions.push("pools    -- Set project-specific pools");
	actions.push("info     -- Show effective config for this project");

	const selected = await ctx.ui.select(
		`Project Config (${hasProjectConfig ? "active" : "none"})`,
		actions,
	);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();

	if (action === "clear") {
		if (!hasProjectConfig) {
			ctx.ui.notify("No project config to clear.", "info");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			"Clear project config",
			`Remove ${projectPath}?\nGlobal pools will be used instead.`,
		);
		if (!confirmed) return;
		try {
			writeFileSync(projectPath, "{}", "utf-8");
			const effective = loadEffectiveConfig(ctx.cwd);
			poolManager.loadPools(effective.pools);
			ctx.ui.notify("Project config cleared. Using global pools.", "info");
		} catch (err: unknown) {
			ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
		return;
	}

	if (action === "restrict") {
		// Show all global subs and let user pick which are allowed
		const envEntries = parseEnvConfig();
		const allSubs = normalizeEntries(mergeConfigs(globalConf, envEntries));
		const allProviderNames = [
			...SUPPORTED_PROVIDERS.filter((p) =>
				ctx.modelRegistry.authStorage.hasAuth(p),
			),
			...allSubs.map((s) => subProviderName(s)),
		];

		if (allProviderNames.length === 0) {
			ctx.ui.notify("No subscriptions available to restrict.", "info");
			return;
		}

		const currentAllowed = projectConf?.allowedSubs || [];
		const allowed: string[] = [];
		let selecting = true;

		while (selecting) {
			const remaining = allProviderNames.filter((p) => !allowed.includes(p));
			if (remaining.length === 0) break;

			const options = [
				`--- Allowed (${allowed.length}): ${allowed.join(", ") || "all (no restriction)"} ---`,
				...remaining.map((p) => {
					const authed = ctx.modelRegistry.authStorage.hasAuth(p);
					const current = currentAllowed.includes(p) ? " [currently allowed]" : "";
					return `${p} ${authed ? "[logged in]" : "[not logged in]"}${current}`;
				}),
				"[Done - save]",
				"[Clear - allow all]",
			];

			const picked = await ctx.ui.select("Select allowed subs (Esc when done)", options);
			if (!picked || picked.startsWith("---")) {
				selecting = false;
				continue;
			}
			if (picked === "[Done - save]") {
				selecting = false;
				continue;
			}
			if (picked === "[Clear - allow all]") {
				allowed.length = 0;
				selecting = false;
				continue;
			}

			const provName = picked.split(" ")[0];
			if (provName && allProviderNames.includes(provName)) {
				allowed.push(provName);
			}
		}

		const newProjectConf: ProjectConfig = {
			...projectConf,
			allowedSubs: allowed.length > 0 ? allowed : undefined,
		};
		saveProjectConfig(ctx.cwd, newProjectConf);

		const effective = loadEffectiveConfig(ctx.cwd);
		poolManager.loadPools(effective.pools);

		if (allowed.length > 0) {
			ctx.ui.notify(
				`Project restricted to: ${allowed.join(", ")}`,
				"info",
			);
		} else {
			ctx.ui.notify("Project restriction cleared. All subs available.", "info");
		}
		return;
	}

	if (action === "pools") {
		// Copy global pools and let user toggle which are active for this project
		const globalPools = globalConf.pools;
		if (globalPools.length === 0) {
			ctx.ui.notify("No global pools defined. Create pools first with /pool create.", "info");
			return;
		}

		const currentProjectPools = projectConf?.pools;
		const options = [
			"[Use global pools (no override)]",
			...globalPools.map((p) => {
				const isIncluded = currentProjectPools
					? currentProjectPools.some((pp) => pp.name === p.name)
					: true;
				return `${p.name} (${p.members.length} members) ${isIncluded ? "[included]" : "[excluded]"}`;
			}),
		];

		const selected2 = await ctx.ui.select("Project pools (select to toggle)", options);
		if (!selected2) return;

		if (selected2 === "[Use global pools (no override)]") {
			const newProjectConf: ProjectConfig = { ...projectConf };
			delete newProjectConf.pools;
			saveProjectConfig(ctx.cwd, newProjectConf);
			const effective = loadEffectiveConfig(ctx.cwd);
			poolManager.loadPools(effective.pools);
			ctx.ui.notify("Project will use global pools.", "info");
			return;
		}

		// Toggle: build project pool list
		const poolName = selected2.split(" (")[0];
		const pool = globalPools.find((p) => p.name === poolName);
		if (!pool) return;

		let projectPools = currentProjectPools ? [...currentProjectPools] : [...globalPools];
		const existingIdx = projectPools.findIndex((p) => p.name === pool.name);
		if (existingIdx >= 0) {
			projectPools.splice(existingIdx, 1);
		} else {
			projectPools.push(pool);
		}

		const newProjectConf: ProjectConfig = { ...projectConf, pools: projectPools };
		saveProjectConfig(ctx.cwd, newProjectConf);
		const effective = loadEffectiveConfig(ctx.cwd);
		poolManager.loadPools(effective.pools);

		const activeNames = projectPools.map((p) => p.name).join(", ") || "none";
		ctx.ui.notify(`Project pools: ${activeNames}`, "info");
		return;
	}

	if (action === "info") {
		const effective = loadEffectiveConfig(ctx.cwd);
		const lines: string[] = [];

		if (effective.projectConfigPath && loadProjectConfig(ctx.cwd)) {
			lines.push(`Project config: ${projectPath}`);
		} else {
			lines.push("Project config: none (using global)");
		}

		const pc = loadProjectConfig(ctx.cwd);
		if (pc?.allowedSubs && pc.allowedSubs.length > 0) {
			lines.push(`Allowed subs: ${pc.allowedSubs.join(", ")}`);
		} else {
			lines.push("Allowed subs: all (no restriction)");
		}

		lines.push("");
		lines.push(`Effective pools (${effective.pools.length}):`);
		for (const pool of effective.pools) {
			const src = pc?.pools ? "project" : "global";
			lines.push(`  ${pool.name} [${src}] -- ${pool.members.join(", ")} (${pool.enabled ? "enabled" : "disabled"})`);
		}

		lines.push("");
		lines.push(`Effective subs (${effective.subscriptions.length}):`);
		for (const sub of effective.subscriptions) {
			const authed = ctx.modelRegistry.authStorage.hasAuth(subProviderName(sub));
			lines.push(`  ${subDisplayName(sub)} -- ${authed ? "logged in" : "not logged in"}`);
		}

		await ctx.ui.select("Effective Config", lines);
		return;
	}
}

async function handlePoolMenu(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const actions = [
		"create   -- Create a new rotation pool",
		"list     -- Show pools and quick actions",
		"chain    -- Manage saved fallback chains",
		"toggle   -- Enable/disable a pool",
		"remove   -- Remove a pool",
		"status   -- Detailed pool status with member health",
		"project  -- Project-level pool config (.pi/multi-pass.json)",
	];

	const selected = await ctx.ui.select("Pool Manager", actions);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();
	switch (action) {
		case "create":
			return handlePoolCreate(ctx, poolManager);
		case "list":
			return handlePoolList(ctx, poolManager);
		case "chain":
			return handlePoolChainMenu(ctx, poolManager);
		case "toggle":
			return handlePoolToggle(ctx, poolManager);
		case "remove":
			return handlePoolRemove(ctx, poolManager);
		case "status":
			return handlePoolStatus(ctx, poolManager);
		case "project":
			return handlePoolProject(ctx, poolManager);
	}
}

// ==========================================================================
// /subs main menu
// ==========================================================================

async function handleSubsMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const actions: SelectItem[] = [
		{ value: "list", label: "list", description: "Show all extra subscriptions" },
		{ value: "add", label: "add", description: "Add a new subscription" },
		{ value: "remove", label: "remove", description: "Remove a subscription" },
		{ value: "login", label: "login", description: "Login to a subscription" },
		{ value: "logout", label: "logout", description: "Logout from a subscription" },
		{ value: "switch", label: "switch", description: "Switch to a different subscription/provider now" },
		{ value: "status", label: "status", description: "Show auth status and token info" },
		{ value: "limits", label: "limits", description: "Check built-in quota support (Codex + Google)" },
	];
	let preferredAction = "list";

	while (true) {
		const action = await showWrappedSelect(ctx, {
			title: "Subscription Manager",
			items: actions,
			initialValue: preferredAction,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!action) return;

		preferredAction = action;
		const config = loadGlobalConfig();
		switch (action) {
			case "list":
				await handleSubsList(pi, ctx, config, poolManager);
				break;
			case "add":
				await handleSubsAdd(pi, ctx);
				break;
			case "remove":
				await handleSubsRemove(pi, ctx, poolManager);
				break;
			case "login":
				await handleSubsLogin(ctx);
				break;
			case "logout":
				await handleSubsLogout(ctx);
				break;
			case "switch":
				await handleSubsSwitch(pi, ctx);
				break;
			case "status":
				await handleSubsStatus(ctx);
				break;
			case "limits":
				await handleSubsLimits(ctx);
				break;
		}
	}
}

// ==========================================================================
// /mp-preset command handlers
// ==========================================================================

/** Pretty-print a preset entry using subscription labels when available. */
function formatPresetEntry(entry: PresetEntry): string {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const displayName = getProviderDisplayName(entry.provider, allSubs);
	return `${displayName} / ${entry.model}`;
}

/** Lightweight version that takes pre-loaded subs to avoid re-reading config per entry. */
function formatPresetEntryWith(entry: PresetEntry, allSubs: SubEntry[]): string {
	const displayName = getProviderDisplayName(entry.provider, allSubs);
	return `${displayName} / ${entry.model}`;
}

async function handlePresetCreate(
	ctx: ExtensionCommandContext,
): Promise<void> {
	const presetName = await ctx.ui.input("Preset name", "e.g. coding-premium, coding-budget, fastest");
	if (!presetName?.trim()) return;

	const config = loadGlobalConfig();
	if (config.presets.find((p) => p.name === presetName.trim())) {
		const overwrite = await ctx.ui.confirm("Preset exists", `Overwrite "${presetName.trim()}"?`);
		if (!overwrite) return;
	}

	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const allProviders: string[] = [];
	for (const provider of SUPPORTED_PROVIDERS) {
		allProviders.push(provider);
	}
	for (const entry of allSubs) {
		allProviders.push(subProviderName(entry));
	}

	const entries: PresetEntry[] = [];
	let adding = true;
	while (adding) {
		const providerOptions = [
			`--- Entries (${entries.length}): ${entries.map((e) => formatPresetEntryWith(e, allSubs)).join(", ") || "none"} ---`,
			...allProviders.map((p) => {
				const template = PROVIDER_TEMPLATES[p];
				const display = template?.displayName || p;
				const sub = allSubs.find((s) => subProviderName(s) === p);
				const label = sub ? subDisplayName(sub) : display;
				return `${p} -- ${label}`;
			}),
			"[Done - save preset]",
		];

		const picked = await ctx.ui.select("Add entry (Esc cancels)", providerOptions);
		if (!picked) return;
		if (picked.startsWith("---")) continue;
		if (picked === "[Done - save preset]") {
			if (entries.length === 0) {
				ctx.ui.notify("Add at least one entry.", "warning");
				continue;
			}
			adding = false;
			continue;
		}

		const provider = picked.split(" -- ")[0].trim();
		const base = getBaseProvider(provider);
		if (!base) continue;

		const models = (getModels(base as any) as Model<Api>[]).map((m) => m.id);
		if (models.length === 0) {
			ctx.ui.notify(`No models available for ${provider}.`, "warning");
			continue;
		}

		const model = await ctx.ui.select(`Model for ${provider}`, models);
		if (!model) continue;

		entries.push({ provider, model, enabled: true });
	}

	const preset: PresetConfig = {
		name: presetName.trim(),
		entries,
		enabled: true,
	};
	const existingIdx = config.presets.findIndex((p) => p.name === preset.name);
	if (existingIdx >= 0) {
		config.presets[existingIdx] = preset;
	} else {
		config.presets.push(preset);
	}
	saveGlobalConfig(config);
	ctx.ui.notify(
		`Preset "${preset.name}" saved with ${entries.length} ${entries.length === 1 ? "entry" : "entries"}: ${entries.map((e) => formatPresetEntryWith(e, allSubs)).join(", ")}`,
		"info",
	);
}

async function handlePresetList(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.presets.length === 0) {
		ctx.ui.notify("No presets configured. Use /mp-preset create to add one.", "info");
		return;
	}

	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const items: SelectItem[] = config.presets.map((preset) => ({
		value: preset.name,
		label: `${preset.enabled ? "+" : "-"} ${preset.name}`,
		description: preset.entries.map((e) => formatPresetEntryWith(e, allSubs)).join(" -> "),
	}));

	await showWrappedSelect(ctx, {
		title: "Model Presets",
		subtitle: "Presets are named routing shortcuts across providers.",
		items,
		confirmHint: "back",
		cancelHint: "close",
	});
}

async function handlePresetActivate(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	requestedName?: string,
): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const enabled = config.presets.filter((p) => p.enabled);
	if (enabled.length === 0) {
		ctx.ui.notify("No enabled presets. Use /mp-preset create to add one.", "info");
		return;
	}

	let presetName = requestedName?.trim();
	if (!presetName) {
		presetName = await showWrappedSelect(ctx, {
			title: "Activate Preset",
			subtitle: "Select a preset to switch to its best available entry.",
			items: enabled.map((p) => ({
				value: p.name,
				label: p.name,
				description: p.entries.filter((e) => e.enabled).map((e) => formatPresetEntryWith(e, allSubs)).join(" -> "),
			})),
			confirmHint: "activate",
			cancelHint: "back",
		});
	}
	if (!presetName) return;

	const preset = enabled.find((p) => p.name === presetName);
	if (!preset) {
		ctx.ui.notify(`Preset "${presetName}" not found.`, "error");
		return;
	}

	for (const entry of preset.entries) {
		if (!entry.enabled) continue;
		if (!ctx.modelRegistry.authStorage.hasAuth(entry.provider)) continue;
		const model = ctx.modelRegistry.find(entry.provider, entry.model);
		if (!model) continue;

		const success = await pi.setModel(model);
		if (!success) continue;

		const prettyEntry = formatPresetEntryWith(entry, allSubs);
		ctx.ui.notify(`Preset "${preset.name}": switched to ${prettyEntry}`, "info");
		ctx.ui.setStatus("multi-pass", `preset:${preset.name} | ${prettyEntry}`);
		return;
	}

	ctx.ui.notify(
		`Preset "${preset.name}": no entry has a logged-in provider with the required model available.`,
		"warning",
	);
}

async function handlePresetRemove(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.presets.length === 0) {
		ctx.ui.notify("No presets to remove.", "info");
		return;
	}

	const selected = await showWrappedSelect(ctx, {
		title: "Remove Preset",
		items: config.presets.map((p) => ({
			value: p.name,
			label: p.name,
			description: `${p.entries.length} entries`,
		})),
		confirmHint: "remove",
		cancelHint: "back",
	});
	if (!selected) return;

	const confirmed = await ctx.ui.confirm("Confirm", `Remove preset "${selected}"?`);
	if (!confirmed) return;

	config.presets = config.presets.filter((p) => p.name !== selected);
	saveGlobalConfig(config);
	ctx.ui.notify(`Removed preset "${selected}".`, "info");
}

async function handlePresetToggle(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.presets.length === 0) {
		ctx.ui.notify("No presets configured.", "info");
		return;
	}

	const selected = await showWrappedSelect(ctx, {
		title: "Toggle Preset",
		items: config.presets.map((p) => ({
			value: p.name,
			label: `${p.enabled ? "+" : "-"} ${p.name}`,
			description: p.enabled ? "enabled" : "disabled",
		})),
		confirmHint: "toggle",
		cancelHint: "back",
	});
	if (!selected) return;

	const preset = config.presets.find((p) => p.name === selected);
	if (!preset) return;

	preset.enabled = !preset.enabled;
	saveGlobalConfig(config);
	ctx.ui.notify(`Preset "${preset.name}" is now ${preset.enabled ? "enabled" : "disabled"}.`, "info");
}

async function handlePresetMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const actions: SelectItem[] = [
		{ value: "activate", label: "activate", description: "Switch to a preset's best available entry" },
		{ value: "create", label: "create", description: "Create a new preset" },
		{ value: "list", label: "list", description: "Show all presets" },
		{ value: "toggle", label: "toggle", description: "Enable/disable a preset" },
		{ value: "remove", label: "remove", description: "Delete a preset" },
	];

	let preferredAction = "activate";
	while (true) {
		const action = await showWrappedSelect(ctx, {
			title: "Model Presets",
			items: actions,
			initialValue: preferredAction,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!action) return;

		preferredAction = action;
		switch (action) {
			case "activate":
				await handlePresetActivate(pi, ctx);
				break;
			case "create":
				await handlePresetCreate(ctx);
				break;
			case "list":
				await handlePresetList(ctx);
				break;
			case "toggle":
				await handlePresetToggle(ctx);
				break;
			case "remove":
				await handlePresetRemove(ctx);
				break;
		}
	}
}

// ==========================================================================
// Extension entry point
// ==========================================================================

export default function multiSub(pi: ExtensionAPI) {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	// Register all subscriptions (always global)
	for (const entry of all) {
		registerSub(pi, entry);
	}

	// Initialize pool manager with global pools (updated on session_start with project config)
	const poolManager = new PoolManager(pi);
	poolManager.loadPools(config.pools);

	let projectRestrictionSwitchInFlight = false;
	const enforceProjectRestriction = async (
		ctx: ExtensionContext | ExtensionCommandContext,
		reason: "session" | "model" | "input",
	): Promise<boolean> => {
		if (projectRestrictionSwitchInFlight) return true;
		const effective = loadEffectiveConfig(ctx.cwd);
		const allowedSummary = formatAllowedProviderSummary(effective);
		if (!allowedSummary) {
			return true;
		}
		if (ctx.model && effective.allowedProviderNames?.includes(ctx.model.provider)) {
			return true;
		}

		for (const providerName of getProjectScopedProviderNames(ctx, effective)) {
			const model = findSelectableModelForProvider(ctx, providerName, ctx.model?.id);
			if (!model) continue;

			projectRestrictionSwitchInFlight = true;
			try {
				const success = await pi.setModel(model);
				if (!success) continue;
				const displayName = getProviderDisplayName(providerName, effective.subscriptions);
				ctx.ui.notify(
					`multi-pass: project restricted to ${allowedSummary}; switched to ${displayName} (${model.id}).`,
					"info",
				);
				return true;
			} finally {
				projectRestrictionSwitchInFlight = false;
			}
		}

		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the current model";
		ctx.ui.notify(
			`multi-pass: project restricted to ${allowedSummary}, but no authenticated allowed provider can serve ${currentModel}.`,
			"warning",
		);
		return false;
	};

	// On session start, reload pools with project-level config
	pi.on("session_start", async (_event, ctx) => {
		const effective = loadEffectiveConfig(ctx.cwd);
		poolManager.loadPools(effective.pools);

		const statusParts: string[] = [];
		const enabledChains = effective.chains.filter((chain) => chain.enabled);
		const activeChain = enabledChains[0];
		if (activeChain) {
			const firstEnabledEntry = activeChain.entries.find((entry) => entry.enabled);
			if (firstEnabledEntry) {
				statusParts.push(`chain:${activeChain.name} | starts ${firstEnabledEntry.pool} -> ${firstEnabledEntry.model}`);
			}
		}
		const allowedSummary = formatAllowedProviderSummary(effective);
		if (allowedSummary) {
			statusParts.push(`allowed ${allowedSummary}`);
		} else {
			const poolCount = effective.pools.filter((p) => p.enabled).length;
			if (poolCount > 0 && !activeChain) {
				statusParts.push(`${poolCount} pool(s)`);
			}
		}
		if (statusParts.length > 0) {
			ctx.ui.setStatus("multi-pass", statusParts.join(" | "));
		}

		await enforceProjectRestriction(ctx, "session");
	});

	pi.on("model_select", async (_event, ctx) => {
		await enforceProjectRestriction(ctx, "model");
	});

	pi.on("input", async (event, ctx) => {
		if (event.text.trimStart().startsWith("/")) {
			return { action: "continue" as const };
		}
		const ok = await enforceProjectRestriction(ctx, "input");
		return ok ? { action: "continue" as const } : { action: "handled" as const };
	});

	// Track last user prompt for retry on rotation
	let lastUserPrompt: string | null = null;

	// Listen for user input to track last prompt
	pi.on("before_agent_start", async (event, ctx) => {
		lastUserPrompt = event.prompt;
		poolManager.startTurn(event.prompt, ctx.model);
	});

	// Listen for errors to trigger pool rotation
	pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
		if (!event.messages || event.messages.length === 0) return;

		const lastMsg = event.messages[event.messages.length - 1];
		if (!lastMsg || lastMsg.role !== "assistant") return;

		const assistantMsg = lastMsg as any;
		if (assistantMsg.stopReason !== "error") return;
		if (!assistantMsg.errorMessage) return;

		const effective = loadEffectiveConfig(ctx.cwd);
		const rotated = await poolManager.handleError(
			assistantMsg.errorMessage,
			ctx.model,
			ctx,
			lastUserPrompt,
			normalizeMultiPassConfig({
				subscriptions: effective.subscriptions,
				pools: effective.pools,
				chains: effective.chains,
				presets: effective.presets,
			}),
		);

		if (!rotated && isRateLimitError(assistantMsg.errorMessage)) {
			const pool = ctx.model
				? poolManager.getPoolForProvider(ctx.model.provider)
				: undefined;
			if (pool) {
				const available = poolManager.getAvailableMembers(
					pool,
					ctx.modelRegistry.authStorage,
				);
				if (available.length === 0) {
					ctx.ui.notify(
						`[pool:${pool.name}] All members rate limited. Try again in a few minutes.`,
						"warning",
					);
				}
			}
		}
	});

	// Register /subs command
	pi.registerCommand("subs", {
		description: "Manage extra OAuth subscriptions",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["list", "add", "remove", "login", "logout", "switch", "status", "limits"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const config = loadGlobalConfig();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ");
			switch (subcommand) {
				case "list":
				case "ls":
					return handleSubsList(pi, ctx, config, poolManager);
				case "add":
				case "new":
					return handleSubsAdd(pi, ctx);
				case "remove":
				case "rm":
				case "delete":
					return handleSubsRemove(pi, ctx, poolManager);
				case "login":
					return handleSubsLogin(ctx);
				case "logout":
					return handleSubsLogout(ctx);
				case "switch":
					return handleSubsSwitch(pi, ctx, rest || undefined);
				case "status":
				case "info":
					return handleSubsStatus(ctx);
				case "limits":
				case "quota":
				case "usage":
					return handleSubsLimits(ctx);
				default:
					return handleSubsMenu(pi, ctx, poolManager);
			}
		},
	});

	// Register /pool command
	pi.registerCommand("pool", {
		description: "Manage subscription rotation pools",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["create", "list", "chain", "toggle", "remove", "status", "project"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args
				.trim()
				.toLowerCase()
				.split(/\s+/)
				.filter(Boolean);
			const subcommand = parts[0] || "";
			const chainSubcommand = parts[1] || "";
			switch (subcommand) {
				case "create":
				case "new":
					return handlePoolCreate(ctx, poolManager);
				case "list":
				case "ls":
					return handlePoolList(ctx, poolManager);
				case "chain":
					switch (chainSubcommand) {
						case "":
							return handlePoolChainMenu(ctx, poolManager);
						case "list":
						case "ls":
							return handlePoolChainList(ctx);
						case "toggle":
							return handlePoolChainToggle(ctx);
						case "remove":
						case "rm":
						case "delete":
							return handlePoolChainRemove(ctx);
						case "status":
						case "info":
							return handlePoolChainStatus(ctx);
						case "create":
						case "new":
							return handlePoolChainCreate(ctx, poolManager);
						default:
							return handlePoolChainMenu(ctx, poolManager);
					}
				case "toggle":
					return handlePoolToggle(ctx, poolManager);
				case "remove":
				case "rm":
				case "delete":
					return handlePoolRemove(ctx, poolManager);
				case "status":
				case "info":
					return handlePoolStatus(ctx, poolManager);
				case "project":
					return handlePoolProject(ctx, poolManager);
				default:
					return handlePoolMenu(ctx, poolManager);
			}
		},
	});

	// Register /mp-preset command (namespaced to avoid collision with pi's built-in /preset)
	pi.registerCommand("mp-preset", {
		description: "Manage multi-pass model presets (named routing shortcuts across providers)",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["activate", "create", "list", "toggle", "remove"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			if (filtered.length > 0) {
				return filtered.map((s) => ({ value: s, label: s }));
			}
			// Also complete preset names for quick activation
			const config = loadGlobalConfig();
			const presetNames = config.presets
				.filter((p) => p.enabled && p.name.startsWith(prefix))
				.map((p) => ({ value: p.name, label: p.name }));
			return presetNames.length > 0 ? presetNames : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ");
			switch (subcommand) {
				case "activate":
				case "use":
					return handlePresetActivate(pi, ctx, rest || undefined);
				case "create":
				case "new":
					return handlePresetCreate(ctx);
				case "list":
				case "ls":
					return handlePresetList(ctx);
				case "toggle":
					return handlePresetToggle(ctx);
				case "remove":
				case "rm":
				case "delete":
					return handlePresetRemove(ctx);
				default:
					// If the argument matches a preset name, activate it directly
					if (subcommand) {
						const config = loadGlobalConfig();
						const preset = config.presets.find(
							(p) => p.name.toLowerCase() === subcommand && p.enabled,
						);
						if (preset) {
							return handlePresetActivate(pi, ctx, preset.name);
						}
					}
					return handlePresetMenu(pi, ctx);
			}
		},
	});
}
