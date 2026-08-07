// ==========================================================================
// OAuth compatibility shim for pi-multi-pass
//
// Provides standalone OAuth functions (loginAnthropic, refreshOpenAICodexToken,
// etc.) that pi-multi-pass expects, without depending on
// @earendil-works/pi-ai/oauth runtime exports.
//
// Token refresh uses simple fetch() calls. Login flows implement
// PKCE + local callback server or device-code flows as appropriate.
// ==========================================================================

import type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
	OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";

export type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
	OAuthProviderInterface,
};

// ==========================================================================
// PKCE utilities (Web Crypto API)
// ==========================================================================

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64url(verifierBytes);
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const challenge = base64url(new Uint8Array(hash));
	return { verifier, challenge };
}

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function createState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ==========================================================================
// Token refresh implementations (simple fetch calls)
// ==========================================================================

// --- Anthropic ---

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const ANTHROPIC_CALLBACK_PORT = 53692;
const ANTHROPIC_REDIRECT_URI = `http://localhost:${ANTHROPIC_CALLBACK_PORT}/callback`;

export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(ANTHROPIC_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: ANTHROPIC_CLIENT_ID,
		}),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Anthropic token refresh failed (${response.status}): ${text || response.statusText}`);
	}
	const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (!data.access_token || !data.refresh_token) {
		throw new Error("Anthropic token refresh returned invalid response");
	}
	return {
		type: "oauth",
		access: data.access_token,
		refresh: data.refresh_token,
		expires: Date.now() + (data.expires_in || 3600) * 1000 - 300000,
	};
}

export const anthropicOAuthProvider: OAuthProviderInterface = {
	name: "Anthropic (Claude Pro/Max)",
	async login(callbacks) { return loginAnthropic(callbacks); },
	async refreshToken(credentials) { return refreshAnthropicToken(credentials.refresh); },
	getApiKey(credentials) { return credentials.access; },
};

// --- OpenAI Codex ---

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTH_BASE_URL = "https://auth.openai.com";
const CODEX_TOKEN_URL = `${CODEX_AUTH_BASE_URL}/oauth/token`;
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_DEVICE_USER_CODE_URL = `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const CODEX_DEVICE_TOKEN_URL = `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const CODEX_DEVICE_VERIFICATION_URI = `${CODEX_AUTH_BASE_URL}/codex/device`;

export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(CODEX_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CODEX_CLIENT_ID,
		}),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`OpenAI Codex token refresh failed (${response.status}): ${text || response.statusText}`);
	}
	const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (!data.access_token || !data.refresh_token) {
		throw new Error("OpenAI Codex token refresh returned invalid response");
	}
	return {
		type: "oauth",
		access: data.access_token,
		refresh: data.refresh_token,
		expires: Date.now() + (data.expires_in || 3600) * 1000 - 300000,
	};
}

export const openaiCodexOAuthProvider: OAuthProviderInterface = {
	name: "ChatGPT Plus/Pro (Codex)",
	usesCallbackServer: true,
	async login(callbacks) { return loginOpenAICodex(callbacks); },
	async refreshToken(credentials) { return refreshOpenAICodexToken(credentials.refresh); },
	getApiKey(credentials) { return credentials.access; },
};

// --- GitHub Copilot ---

const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecef98";
const COPILOT_USER_AGENT = "GitHubCopilotChat/0.35.0";
const COPILOT_API_VERSION = "2026-06-01";

function normalizeDomain(input: string): string | null {
	const trimmed = (input || "").trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch { return null; }
}

function getBaseUrlFromToken(token: string): string | null {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return null;
	return `https://${match[1].replace(/^proxy\./, "api.")}`;
}

function getGitHubCopilotBaseUrl(token: string, enterpriseDomain?: string): string {
	if (token) {
		const fromToken = getBaseUrlFromToken(token);
		if (fromToken) return fromToken;
	}
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return "https://api.individual.githubcopilot.com";
}

export { normalizeDomain, getGitHubCopilotBaseUrl };

export async function refreshGitHubCopilotToken(refreshToken: string, enterpriseDomain?: string): Promise<OAuthCredentials> {
	const domain = enterpriseDomain || "github.com";
	const response = await fetch(`https://${domain}/login/oauth/access_token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json",
			"User-Agent": COPILOT_USER_AGENT,
			"Editor-Version": "vscode/1.107.0",
			"Editor-Plugin-Version": "copilot-chat/0.35.0",
			"Copilot-Integration-Id": "vscode-chat",
			"X-GitHub-Api-Version": COPILOT_API_VERSION,
		},
		body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, refresh_token: refreshToken, grant_type: "refresh_token" }),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`GitHub Copilot token refresh failed (${response.status}): ${text || response.statusText}`);
	}
	const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string };
	if (!data.access_token) {
		throw new Error("GitHub Copilot token refresh returned invalid response");
	}
	return {
		type: "oauth",
		access: data.access_token,
		refresh: data.refresh_token || refreshToken,
		expires: Date.now() + (data.expires_in || 3600) * 1000 - 300000,
		...(enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : {}),
	} as OAuthCredentials & { enterpriseUrl?: string };
}

export const githubCopilotOAuthProvider: OAuthProviderInterface = {
	name: "GitHub Copilot",
	async login(callbacks) { return loginGitHubCopilot(callbacks); },
	async refreshToken(credentials) {
		const creds = credentials as OAuthCredentials & { enterpriseUrl?: string };
		return refreshGitHubCopilotToken(creds.refresh, creds.enterpriseUrl ?? undefined);
	},
	getApiKey(credentials) { return credentials.access; },
};

// ==========================================================================
// Login flow implementations
// ==========================================================================

// --- Anthropic login (PKCE + callback server) ---

export async function loginAnthropic(callbacks: Partial<OAuthLoginCallbacks>): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();

	let server: import("node:http").Server | undefined;
	let pendingCode: string | undefined;
	let pendingState: string | undefined;

	const { promise: serverReady, resolve: serverReadyResolve } = Promise.withResolvers<void>();

	import("node:http").then((http) => {
		server = http.createServer((req, res) => {
			try {
				const reqUrl = new URL(req.url || "", `http://127.0.0.1:${ANTHROPIC_CALLBACK_PORT}`);
				if (reqUrl.pathname !== "/callback") {
					res.statusCode = 404; res.end("Not found"); return;
				}
				if (reqUrl.searchParams.get("state") !== verifier) {
					res.statusCode = 400; res.end("State mismatch"); return;
				}
				const code = reqUrl.searchParams.get("code");
				if (!code) { res.statusCode = 400; res.end("Missing code"); return; }
				res.statusCode = 200;
				res.end("<h1>Anthropic auth complete!</h1><p>You can close this window.</p>");
				pendingCode = code;
				pendingState = verifier;
				server?.close();
				server = undefined;
			} catch { res.statusCode = 500; res.end("Error"); }
		});
		server.listen(ANTHROPIC_CALLBACK_PORT, "127.0.0.1", () => serverReadyResolve());
	}).catch((e) => {
		throw new Error(`Failed to start callback server: ${e.message}`);
	});

	await serverReady;

	const authUrl = new URL(ANTHROPIC_AUTHORIZE_URL);
	authUrl.searchParams.set("code", "true");
	authUrl.searchParams.set("client_id", ANTHROPIC_CLIENT_ID);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("redirect_uri", ANTHROPIC_REDIRECT_URI);
	authUrl.searchParams.set("scope", ANTHROPIC_SCOPES);
	authUrl.searchParams.set("code_challenge", challenge);
	authUrl.searchParams.set("code_challenge_method", "S256");
	authUrl.searchParams.set("state", verifier);

	if (callbacks.onAuth) {
		callbacks.onAuth({
			url: authUrl.toString(),
			instructions: "Complete login in your browser. If on another machine, paste the redirect URL here.",
		});
	}

	const timeout = 5 * 60 * 1000;
	const start = Date.now();

	while (Date.now() - start < timeout) {
		if (pendingCode) {
			if (callbacks.onProgress) callbacks.onProgress("Exchanging authorization code for tokens...");

			const exchangeResponse = await fetch(ANTHROPIC_TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					client_id: ANTHROPIC_CLIENT_ID,
					code: pendingCode,
					code_verifier: verifier,
					redirect_uri: ANTHROPIC_REDIRECT_URI,
				}),
			});
			if (!exchangeResponse.ok) {
				const text = await exchangeResponse.text().catch(() => "");
				throw new Error(`Token exchange failed (${exchangeResponse.status}): ${text}`);
			}
			const data = await exchangeResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
			if (!data.access_token || !data.refresh_token) throw new Error("Invalid token response");
			return {
				type: "oauth",
				access: data.access_token,
				refresh: data.refresh_token,
				expires: Date.now() + (data.expires_in || 3600) * 1000 - 300000,
			};
		}
		await new Promise((r) => setTimeout(r, 500));
	}

	server?.close();
	throw new Error("Anthropic login timed out");
}

// --- OpenAI Codex login ---

const CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length !== 3) return {};
	try {
		return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Extract the ChatGPT account id from the access token JWT (like pi's built-in flow). */
function extractCodexAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const auth = payload[CODEX_JWT_CLAIM_PATH];
	if (auth && typeof auth === "object") {
		const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
		if (typeof accountId === "string" && accountId.length > 0) return accountId;
	}
	return undefined;
}

function getCodexCallbackHost(): string {
	return process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
}

/** Parse the code/state out of a pasted redirect URL, query string, or raw code. */
function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = (input || "").trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

async function exchangeCodexAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const response = await fetch(CODEX_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CODEX_CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
		signal,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`OpenAI Codex token exchange failed (${response.status}): ${text || response.statusText}`);
	}
	const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (!data.access_token || !data.refresh_token) {
		throw new Error("OpenAI Codex token exchange returned an invalid response");
	}
	const access = data.access_token;
	const accountId = extractCodexAccountId(access);
	return {
		type: "oauth",
		access,
		refresh: data.refresh_token,
		expires: Date.now() + (data.expires_in || 3600) * 1000 - 300000,
		...(accountId ? { accountId } : {}),
	};
}

type CodexCallbackServerInfo = {
	close: () => void;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string } | null>;
};

/**
 * Start a local HTTP callback server on port 1455 that captures the OAuth
 * authorization code, mirroring pi's built-in Codex login. Returns null when
 * the port is unavailable so the caller can fall back to manual input.
 */
function startCodexCallbackServer(state: string, signal?: AbortSignal): Promise<CodexCallbackServerInfo | null> {
	let settleWait: ((value: { code: string } | null) => void) | undefined;
	const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
		let settled = false;
		settleWait = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});

	return import("node:http").then((http) => {
		const server = http.createServer((req, res) => {
			try {
				const url = new URL(req.url || "", "http://localhost");
				if (url.pathname !== "/auth/callback") {
					res.statusCode = 404;
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.end("<h1>Callback route not found.</h1>");
					return;
				}
				if (url.searchParams.get("state") !== state) {
					res.statusCode = 400;
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.end("<h1>State mismatch.</h1>");
					return;
				}
				const code = url.searchParams.get("code");
				if (!code) {
					res.statusCode = 400;
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.end("<h1>Missing authorization code.</h1>");
					return;
				}
				res.statusCode = 200;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end("<h1>OpenAI authentication completed.</h1><p>You can close this window.</p>");
				settleWait?.({ code });
			} catch {
				res.statusCode = 500;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end("<h1>Internal error while processing OAuth callback.</h1>");
			}
		});

		return new Promise<CodexCallbackServerInfo | null>((resolve) => {
			const onError = () => {
				settleWait?.(null);
				resolve(null);
			};
			server.once("error", onError);
			server.listen(1455, getCodexCallbackHost(), () => {
				server.removeListener("error", onError);
				resolve({
					close: () => {
						try { server.close(); } catch { /* ignore */ }
					},
					cancelWait: () => settleWait?.(null),
					waitForCode: () => waitForCodePromise,
				});
			});
		});
	}).catch(() => null);
}

/**
 * OpenAI Codex login. Mirrors pi's built-in Codex OAuth flow:
 *  - Asks the user to pick browser login (default) or device-code login.
 *  - Browser login runs PKCE against the registered redirect URI
 *    (http://localhost:1455/auth/callback) and captures the callback with a
 *    local server on port 1455, exactly like pi's built-in flow. If the port
 *    is unavailable (or the callback never arrives), it falls back to asking
 *    the user to paste the redirect URL manually.
 */
export async function loginOpenAICodex(callbacks: Partial<OAuthLoginCallbacks>): Promise<OAuthCredentials> {
	let method = "browser";
	if (callbacks.onSelect) {
		method = (await callbacks.onSelect({
			message: "Select OpenAI Codex login method:",
			options: [
				{ id: "browser", label: "Browser login (default)" },
				{ id: "device_code", label: "Device code login (headless)" },
			],
		})) ?? "browser";
	}

	if (method === "device_code") {
		return loginOpenAICodexDeviceCode(callbacks);
	}
	if (method !== "browser") {
		throw new Error(`Unknown OpenAI Codex login method: ${method}`);
	}

	const { verifier, challenge } = await generatePKCE();
	const state = createState();

	const authUrl = new URL("https://auth.openai.com/oauth/authorize");
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("client_id", CODEX_CLIENT_ID);
	authUrl.searchParams.set("redirect_uri", CODEX_REDIRECT_URI);
	authUrl.searchParams.set("scope", "openid profile email offline_access");
	authUrl.searchParams.set("code_challenge", challenge);
	authUrl.searchParams.set("code_challenge_method", "S256");
	authUrl.searchParams.set("state", state);
	authUrl.searchParams.set("id_token_add_organizations", "true");
	authUrl.searchParams.set("codex_cli_simplified_flow", "true");
	authUrl.searchParams.set("originator", "pi");

	// Local callback server on port 1455 so the browser redirect is captured
	// automatically (same as pi's built-in Codex login).
	const server = await startCodexCallbackServer(state, callbacks.signal);

	if (callbacks.onAuth) {
		callbacks.onAuth({
			url: authUrl.toString(),
			instructions: server
				? "A browser window should open. Complete login to finish."
				: "Port 1455 is busy, so the callback cannot be captured automatically. After logging in, paste the full redirect URL (http://localhost:1455/auth/callback?code=...) back here.",
		});
	}

	let code: string | undefined;
	let aborted = false;
	const onAbort = () => {
		aborted = true;
		server?.cancelWait();
	};
	callbacks.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		if (server) {
			callbacks.onProgress?.("Waiting for the browser to complete login...");
			const waitResult = await Promise.race([
				server.waitForCode(),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 120_000)),
			]);
			if (waitResult?.code) code = waitResult.code;
		}

		// Fallback: port busy or callback never arrived — ask for manual paste.
		if (!code && callbacks.onManualCodeInput) {
			callbacks.onProgress?.(server
				? "No callback captured yet — you can also paste the redirect URL here."
				: "Waiting for you to paste the redirect URL...");
			const input = await callbacks.onManualCodeInput();
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
			code = parsed.code;
		}

		if (aborted) throw new Error("Login cancelled");
		if (!code) throw new Error("Missing authorization code");

		callbacks.onProgress?.("Exchanging authorization code for tokens...");
		return await exchangeCodexAuthorizationCode(code, verifier, CODEX_REDIRECT_URI, callbacks.signal);
	} finally {
		callbacks.signal?.removeEventListener("abort", onAbort);
		server?.close();
	}
}

async function loginOpenAICodexDeviceCode(callbacks: Partial<OAuthLoginCallbacks>): Promise<OAuthCredentials> {
	const response = await fetch(CODEX_DEVICE_USER_CODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
		signal: callbacks.signal,
	});
	if (response.status === 404) {
		throw new Error("OpenAI Codex device code login is not enabled for this server. Use browser login.");
	}
	if (!response.ok) throw new Error(`Device code request failed (${response.status})`);
	const device = await response.json() as {
		device_auth_id?: string; user_code?: string; verification_uri?: string;
		interval?: number; expires_in?: number;
	};
	if (!device.device_auth_id || !device.user_code) throw new Error("Invalid device code response");

	if (callbacks.onDeviceCode) {
		callbacks.onDeviceCode({
			userCode: device.user_code,
			verificationUri: device.verification_uri || CODEX_DEVICE_VERIFICATION_URI,
			intervalSeconds: device.interval || 5,
			expiresInSeconds: device.expires_in || 900,
		});
	}

	const pollInterval = (device.interval || 5) * 1000;
	const timeout = (device.expires_in || 900) * 1000;
	const start = Date.now();

	while (Date.now() - start < timeout) {
		if (callbacks.signal?.aborted) throw new Error("Login cancelled");
		await new Promise((r) => setTimeout(r, pollInterval));
		const pollResponse = await fetch(CODEX_DEVICE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
			signal: callbacks.signal,
		});
		if (pollResponse.ok) {
			const data = await pollResponse.json() as { authorization_code?: string; code_verifier?: string };
			if (data.authorization_code && data.code_verifier) {
				return await exchangeCodexAuthorizationCode(
					data.authorization_code,
					data.code_verifier,
					"https://auth.openai.com/deviceauth/callback",
					callbacks.signal,
				);
			}
		}
	}
	throw new Error("OpenAI Codex device auth timed out");
}

// --- GitHub Copilot login (device code flow) ---

export async function loginGitHubCopilot(callbacks: Partial<OAuthLoginCallbacks>): Promise<OAuthCredentials> {
	const domain = "github.com";

	const deviceResponse = await fetch(`https://${domain}/login/device/code`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept": "application/json",
			"User-Agent": COPILOT_USER_AGENT,
			"Editor-Version": "vscode/1.107.0",
			"Editor-Plugin-Version": "copilot-chat/0.35.0",
			"Copilot-Integration-Id": "vscode-chat",
		},
		body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: "read:user" }),
	});
	if (!deviceResponse.ok) throw new Error(`Device code request failed (${deviceResponse.status})`);
	const device = await deviceResponse.json() as {
		device_code?: string; user_code?: string; verification_uri?: string;
		interval?: number; expires_in?: number;
	};
	if (!device.device_code || !device.user_code) throw new Error("Invalid device code response");

	(callbacks.onAuth as any)(
		device.verification_uri || `https://${domain}/login/device`,
		`Your code: ${device.user_code}`,
	);

	const pollInterval = (device.interval || 5) * 1000;
	const timeout = (device.expires_in || 900) * 1000;
	const start = Date.now();

	while (Date.now() - start < timeout) {
		await new Promise((r) => setTimeout(r, pollInterval));
		const pollResponse = await fetch(`https://${domain}/login/oauth/access_token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept": "application/json",
				"User-Agent": COPILOT_USER_AGENT,
				"Editor-Version": "vscode/1.107.0",
				"Editor-Plugin-Version": "copilot-chat/0.35.0",
				"Copilot-Integration-Id": "vscode-chat",
			},
			body: JSON.stringify({
				client_id: COPILOT_CLIENT_ID,
				device_code: device.device_code,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});
		if (pollResponse.ok) {
			const data = await pollResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
			if (data.access_token) {
				return {
					type: "oauth",
					access: data.access_token,
					refresh: data.refresh_token || "",
					expires: Date.now() + (data.expires_in || 3600) * 1000 - 300000,
				};
			}
		}
	}
	throw new Error("GitHub Copilot device auth timed out");
}

// ==========================================================================
// Removed providers (gemini-cli, antigravity)
// ==========================================================================

function missingProvider(name: string): never {
	throw new Error(
		`Provider "${name}" is no longer bundled with this version of pi-ai. ` +
		"Please remove it from your pi-multi-pass configuration.",
	);
}

export const geminiCliOAuthProvider: OAuthProviderInterface = {
	name: "Google Cloud Code Assist (removed)",
	login: () => missingProvider("google-gemini-cli"),
	refreshToken: () => missingProvider("google-gemini-cli"),
	getApiKey: () => missingProvider("google-gemini-cli"),
};

export async function loginGeminiCli(): Promise<never> {
	return missingProvider("google-gemini-cli");
}

export async function refreshGoogleCloudToken(): Promise<never> {
	return missingProvider("google-gemini-cli");
}

export const antigravityOAuthProvider: OAuthProviderInterface = {
	name: "Antigravity (removed)",
	login: () => missingProvider("google-antigravity"),
	refreshToken: () => missingProvider("google-antigravity"),
	getApiKey: () => missingProvider("google-antigravity"),
};

export async function loginAntigravity(): Promise<never> {
	return missingProvider("google-antigravity");
}

export async function refreshAntigravityToken(): Promise<never> {
	return missingProvider("google-antigravity");
}
