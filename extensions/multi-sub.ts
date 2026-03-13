/**
 * Multi-Subscription extension for pi.
 *
 * Register additional OAuth subscription accounts for any supported provider.
 * Each extra account gets its own provider name, /login entry, and cloned models.
 *
 * Manage subscriptions via the /subs command (TUI) or MULTI_SUB env var.
 *
 * TUI commands:
 *   /subs          -- open subscription manager
 *   /subs list     -- list all extra subscriptions
 *   /subs add      -- add a new subscription
 *   /subs remove   -- remove a subscription
 *   /subs login    -- login to a subscription
 *   /subs logout   -- logout from a subscription
 *   /subs status   -- show auth status for all subscriptions
 *
 * Environment variable (alternative, merged with config file):
 *   MULTI_SUB=anthropic:2,openai-codex:1
 *
 * Config file: ~/.pi/agent/multi-pass.json
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
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import {
	// Anthropic
	anthropicOAuthProvider,
	loginAnthropic,
	refreshAnthropicToken,
	// OpenAI Codex
	openaiCodexOAuthProvider,
	loginOpenAICodex,
	refreshOpenAICodexToken,
	// GitHub Copilot
	githubCopilotOAuthProvider,
	loginGitHubCopilot,
	refreshGitHubCopilotToken,
	getGitHubCopilotBaseUrl,
	normalizeDomain,
	// Google Gemini CLI
	geminiCliOAuthProvider,
	loginGeminiCli,
	refreshGoogleCloudToken,
	// Google Antigravity
	antigravityOAuthProvider,
	loginAntigravity,
	refreshAntigravityToken,
	// Types
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderInterface,
} from "@mariozechner/pi-ai/oauth";
import { getModels, type Api, type Model } from "@mariozechner/pi-ai";

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
					return loginAnthropic(
						(url: string) => callbacks.onAuth({ url }),
						() => callbacks.onPrompt({ message: "Paste the authorization code:" }),
					);
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
// Config persistence (~/.pi/agent/multi-pass.json)
// ==========================================================================

interface SubEntry {
	provider: string;
	index: number;
	label?: string;
}

interface MultiPassConfig {
	subscriptions: SubEntry[];
}

function configPath(): string {
	return join(getAgentDir(), "multi-pass.json");
}

function loadConfig(): MultiPassConfig {
	const path = configPath();
	if (!existsSync(path)) return { subscriptions: [] };
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as MultiPassConfig;
	} catch {
		return { subscriptions: [] };
	}
}

function saveConfig(config: MultiPassConfig): void {
	const path = configPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

// ==========================================================================
// Merge env var into config (env entries are additive, not persisted)
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
			entries.push({ provider, index: 0 }); // index assigned during merge
		}
	}
	return entries;
}

function mergeConfigs(fileConfig: MultiPassConfig, envEntries: SubEntry[]): SubEntry[] {
	const merged = [...fileConfig.subscriptions];

	// For each env entry, check if we already have enough for that provider
	for (const envEntry of envEntries) {
		const existingCount = merged.filter((s) => s.provider === envEntry.provider).length;
		const envCountForProvider = envEntries.filter((e) => e.provider === envEntry.provider).length;
		if (existingCount < envCountForProvider) {
			// Need to add more -- find next available index
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

// Assign indices to entries that don't have one yet
function normalizeEntries(entries: SubEntry[]): SubEntry[] {
	const byProvider = new Map<string, SubEntry[]>();
	for (const entry of entries) {
		const list = byProvider.get(entry.provider) || [];
		list.push(entry);
		byProvider.set(entry.provider, list);
	}

	const result: SubEntry[] = [];
	for (const [provider, list] of byProvider) {
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

function providerName(entry: SubEntry): string {
	return `${entry.provider}-${entry.index}`;
}

function displayName(entry: SubEntry): string {
	const template = PROVIDER_TEMPLATES[entry.provider];
	const label = entry.label ? ` (${entry.label})` : "";
	return `${template?.displayName || entry.provider} #${entry.index}${label}`;
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

	const name = providerName(entry);
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
// TUI command handlers
// ==========================================================================

async function handleList(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	if (all.length === 0) {
		ctx.ui.notify("No extra subscriptions configured. Use /subs add to create one.", "info");
		return;
	}

	const lines = all.map((entry) => {
		const name = providerName(entry);
		const hasAuth = ctx.modelRegistry.authStorage.hasAuth(name);
		const status = hasAuth ? "[logged in]" : "[not logged in]";
		const source = config.subscriptions.find(
			(s) => s.provider === entry.provider && s.index === entry.index,
		)
			? "config"
			: "env";
		return `${displayName(entry)} -- ${status} (${source})`;
	});

	await ctx.ui.select("Extra Subscriptions", lines);
}

async function handleAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const providerLabels = SUPPORTED_PROVIDERS.map((p) => {
		const t = PROVIDER_TEMPLATES[p];
		return `${p} -- ${t.displayName}`;
	});

	const selected = await ctx.ui.select("Select provider to add", providerLabels);
	if (!selected) return;

	const provider = selected.split(" -- ")[0];
	if (!PROVIDER_TEMPLATES[provider]) {
		ctx.ui.notify(`Unknown provider: ${provider}`, "error");
		return;
	}

	const label = await ctx.ui.input("Label (optional)", "e.g. work, personal");

	const config = loadConfig();
	const usedIndices = new Set(
		config.subscriptions.filter((s) => s.provider === provider).map((s) => s.index),
	);
	// Also account for env-based entries
	const envEntries = parseEnvConfig();
	const allEntries = normalizeEntries(mergeConfigs(config, envEntries));
	for (const e of allEntries) {
		if (e.provider === provider) usedIndices.add(e.index);
	}
	let nextIndex = 2;
	while (usedIndices.has(nextIndex)) nextIndex++;

	const entry: SubEntry = {
		provider,
		index: nextIndex,
		label: label?.trim() || undefined,
	};

	config.subscriptions.push(entry);
	saveConfig(config);

	// Register immediately
	registerSub(pi, entry);
	ctx.modelRegistry.refresh();

	const loginNow = await ctx.ui.confirm(
		displayName(entry),
		`Created ${displayName(entry)}.\n\nLogin now?`,
	);

	if (loginNow) {
		await triggerLogin(ctx, entry);
	} else {
		ctx.ui.notify(`Added ${displayName(entry)}. Use /subs login to authenticate.`, "info");
	}
}

async function handleRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const config = loadConfig();
	if (config.subscriptions.length === 0) {
		ctx.ui.notify("No saved subscriptions to remove. (Env-based ones can't be removed here.)", "info");
		return;
	}

	const options = config.subscriptions.map((entry) => {
		const name = providerName(entry);
		const hasAuth = ctx.modelRegistry.authStorage.hasAuth(name);
		const status = hasAuth ? " [logged in]" : "";
		return `${displayName(entry)}${status}`;
	});

	const selected = await ctx.ui.select("Remove subscription", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	const entry = config.subscriptions[idx];
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		`Remove ${displayName(entry)}?\nThis will also logout if authenticated.`,
	);
	if (!confirmed) return;

	// Logout if authenticated
	const name = providerName(entry);
	if (ctx.modelRegistry.authStorage.hasAuth(name)) {
		ctx.modelRegistry.authStorage.logout(name);
	}

	// Unregister provider
	pi.unregisterProvider(name);

	// Remove from config
	config.subscriptions.splice(idx, 1);
	saveConfig(config);

	ctx.modelRegistry.refresh();
	ctx.ui.notify(`Removed ${displayName(entry)}`, "info");
}

async function triggerLogin(ctx: ExtensionCommandContext, entry: SubEntry): Promise<void> {
	const name = providerName(entry);
	try {
		// Use the built-in /login flow by telling the user which provider to pick
		ctx.ui.notify(
			`Use /login and select "${PROVIDER_TEMPLATES[entry.provider]?.buildOAuth(entry.index).name}" to authenticate.`,
			"info",
		);
	} catch (error: unknown) {
		ctx.ui.notify(
			`Login hint failed: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

async function handleLogin(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	const notLoggedIn = all.filter(
		(entry) => !ctx.modelRegistry.authStorage.hasAuth(providerName(entry)),
	);

	if (notLoggedIn.length === 0) {
		if (all.length === 0) {
			ctx.ui.notify("No subscriptions configured. Use /subs add first.", "info");
		} else {
			ctx.ui.notify("All subscriptions are already logged in.", "info");
		}
		return;
	}

	const options = notLoggedIn.map((entry) => displayName(entry));
	const selected = await ctx.ui.select("Login to subscription", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	await triggerLogin(ctx, notLoggedIn[idx]);
}

async function handleLogout(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	const loggedIn = all.filter((entry) =>
		ctx.modelRegistry.authStorage.hasAuth(providerName(entry)),
	);

	if (loggedIn.length === 0) {
		ctx.ui.notify("No subscriptions are currently logged in.", "info");
		return;
	}

	const options = loggedIn.map((entry) => displayName(entry));
	const selected = await ctx.ui.select("Logout from subscription", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	const entry = loggedIn[idx];
	const name = providerName(entry);
	ctx.modelRegistry.authStorage.logout(name);
	ctx.modelRegistry.refresh();
	ctx.ui.notify(`Logged out of ${displayName(entry)}`, "info");
}

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	if (all.length === 0) {
		ctx.ui.notify("No extra subscriptions configured.", "info");
		return;
	}

	const lines: string[] = [];
	for (const entry of all) {
		const name = providerName(entry);
		const cred = ctx.modelRegistry.authStorage.get(name);
		const hasAuth = ctx.modelRegistry.authStorage.hasAuth(name);

		let status: string;
		if (!hasAuth) {
			status = "not logged in";
		} else if (cred?.type === "oauth") {
			const expiresIn = cred.expires - Date.now();
			if (expiresIn > 0) {
				const mins = Math.round(expiresIn / 60000);
				status = `logged in (token expires in ${mins}m)`;
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

		lines.push(`${displayName(entry)} | ${status} | ${modelCount} models | ${source}`);
	}

	await ctx.ui.select("Subscription Status", lines);
}

async function handleMainMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const actions = [
		"list     -- Show all extra subscriptions",
		"add      -- Add a new subscription",
		"remove   -- Remove a subscription",
		"login    -- Login to a subscription",
		"logout   -- Logout from a subscription",
		"status   -- Show auth status and token info",
	];

	const selected = await ctx.ui.select("Subscription Manager", actions);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();
	switch (action) {
		case "list":
			return handleList(ctx);
		case "add":
			return handleAdd(pi, ctx);
		case "remove":
			return handleRemove(pi, ctx);
		case "login":
			return handleLogin(ctx);
		case "logout":
			return handleLogout(ctx);
		case "status":
			return handleStatus(ctx);
	}
}

// ==========================================================================
// Extension entry point
// ==========================================================================

export default function multiSub(pi: ExtensionAPI) {
	// Load and register all configured subscriptions at startup
	const config = loadConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	for (const entry of all) {
		registerSub(pi, entry);
	}

	// Register /subs command
	pi.registerCommand("subs", {
		description: "Manage extra OAuth subscriptions",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["list", "add", "remove", "login", "logout", "status"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const subcommand = args.trim().toLowerCase();
			switch (subcommand) {
				case "list":
				case "ls":
					return handleList(ctx);
				case "add":
				case "new":
					return handleAdd(pi, ctx);
				case "remove":
				case "rm":
				case "delete":
					return handleRemove(pi, ctx);
				case "login":
					return handleLogin(ctx);
				case "logout":
					return handleLogout(ctx);
				case "status":
				case "info":
					return handleStatus(ctx);
				default:
					return handleMainMenu(pi, ctx);
			}
		},
	});
}
