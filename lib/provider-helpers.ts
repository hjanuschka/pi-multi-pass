import type { Api, Model, Provider } from "@earendil-works/pi-ai";

function cloneModel(model: Model<Api>, providerId: string, index: number): Model<Api> {
	return {
		...model,
		name: model.name.endsWith(`(#${index})`) ? model.name : `${model.name} (#${index})`,
		provider: providerId,
	};
}

export function cloneNativeProvider(
	base: Provider,
	providerId: string,
	displayName: string,
	index: number,
): Provider {
	let sourceModels = [...base.getModels()] as Model<Api>[];
	const toBaseModel = (model: Model<Api>): Model<Api> => ({
		...model,
		provider: base.id,
	});
	const getModels = () => sourceModels.map((model) => cloneModel(model, providerId, index));

	return {
		id: providerId,
		name: displayName,
		baseUrl: base.baseUrl,
		headers: base.headers,
		auth: base.auth,
		getModels,
		...(base.refreshModels
			? {
					async refreshModels(context) {
						await base.refreshModels!.call(base, context);
						sourceModels = [...base.getModels()] as Model<Api>[];
					},
				}
			: {}),
		...(base.filterModels
			? {
					filterModels(models, credential) {
						return base
							.filterModels!.call(base, models.map(toBaseModel), credential)
							.map((model) => cloneModel(model as Model<Api>, providerId, index));
					},
				}
			: {}),
		stream(model, context, options) {
			return base.stream.call(base, toBaseModel(model), context, options);
		},
		streamSimple(model, context, options) {
			return base.streamSimple.call(base, toBaseModel(model), context, options);
		},
	};
}


export function createDeferredNativeProvider(
	baseProviderId: string,
	initialModels: Model<Api>[],
	providerId: string,
	displayName: string,
	index: number,
): { provider: Provider; bind(base: Provider): void } {
	let base: Provider | undefined;
	let sourceModels = [...initialModels];
	const requireBase = (): Provider => {
		if (!base) throw new Error(`Base provider ${baseProviderId} is not available yet.`);
		return base;
	};
	const requireOAuth = () => {
		const oauth = requireBase().auth.oauth;
		if (!oauth) throw new Error(`Base provider ${baseProviderId} does not support OAuth.`);
		return oauth;
	};
	const toBaseModel = (model: Model<Api>): Model<Api> => ({
		...model,
		provider: baseProviderId,
	});
	const provider: Provider = {
		id: providerId,
		name: displayName,
		get baseUrl() {
			return base?.baseUrl ?? initialModels[0]?.baseUrl;
		},
		get headers() {
			return base?.headers ?? initialModels[0]?.headers;
		},
		auth: {
			oauth: {
				name: displayName,
				login: (interaction) => requireOAuth().login(interaction),
				refresh: (credential) => requireOAuth().refresh(credential),
				toAuth: (credential) => requireOAuth().toAuth(credential),
			},
		},
		getModels: () => sourceModels.map((model) => cloneModel(model, providerId, index)),
		async refreshModels(context) {
			if (!base) return;
			if (base.refreshModels) await base.refreshModels.call(base, context);
			sourceModels = [...base.getModels()] as Model<Api>[];
		},
		filterModels(models, credential) {
			if (!base) return models;
			const filtered = base.filterModels
				? base.filterModels(models.map(toBaseModel), credential)
				: models.map(toBaseModel);
			return filtered.map((model) => cloneModel(model as Model<Api>, providerId, index));
		},
		stream(model, context, options) {
			const native = requireBase();
			return native.stream.call(native, toBaseModel(model), context, options);
		},
		streamSimple(model, context, options) {
			const native = requireBase();
			return native.streamSimple.call(native, toBaseModel(model), context, options);
		},
	};

	return {
		provider,
		bind(native) {
			base = native;
			sourceModels = [...native.getModels()] as Model<Api>[];
		},
	};
}


type KiroCredential = {
	access: string;
	refresh: string;
	expires?: number;
	authMethod?: string;
	region?: string;
	[key: string]: unknown;
};

type KiroOAuthConfig = {
	name: string;
	login: (...args: unknown[]) => unknown;
	refreshToken: (credentials: KiroCredential) => Promise<KiroCredential> | KiroCredential;
	getApiKey: (credentials: KiroCredential) => string;
	modifyModels?: (models: Model<Api>[], credentials: KiroCredential) => Model<Api>[];
	[key: string]: unknown;
};

type KiroProviderConfig = {
	models?: Model<Api>[];
	refreshModels?: (context: unknown) => Promise<Model<Api>[]>;
	oauth?: KiroOAuthConfig;
	[key: string]: unknown;
};

export function cloneKiroProviderConfig<T extends KiroProviderConfig>(
	source: T,
	providerId: string,
	index: number,
	refreshToken: KiroOAuthConfig["refreshToken"],
): T {
	if (!source.oauth) throw new Error("The registered Kiro provider has no OAuth configuration.");
	const { getCliCredentials: _getCliCredentials, refreshToken: _unsafeRefresh, ...oauth } = source.oauth;
	const { apiKey: _sharedApiKey, ...provider } = source;
	const cloneModels = (models: Model<Api>[]) =>
		models.map((model) => cloneModel(model, providerId, index));

	return {
		...provider,
		models: cloneModels(source.models ?? []),
		...(source.refreshModels
			? {
					async refreshModels(context: unknown) {
						return cloneModels(await source.refreshModels!.call(source, context));
					},
				}
			: {}),
		oauth: {
			...oauth,
			refreshToken,
			...(source.oauth.modifyModels
				? {
						modifyModels(models: Model<Api>[], credentials: KiroCredential) {
							const baseModels = models.map((model) => ({ ...model, provider: "kiro" }));
							return source.oauth!.modifyModels!.call(source.oauth, baseModels, credentials)
								.map((model) => ({ ...model, provider: providerId }));
						},
					}
				: {}),
		},
	} as T;
}

interface KiroRefreshOptions {
	fetch?: typeof globalThis.fetch;
	now?: () => number;
}

export async function refreshKiroCredential(
	credentials: KiroCredential,
	options: KiroRefreshOptions = {},
): Promise<KiroCredential> {
	if (typeof credentials.access !== "string" || credentials.access.length === 0) {
		throw new Error("Invalid Kiro refresh credential. Log in again.");
	}
	const encodedRefresh = typeof credentials.refresh === "string" ? credentials.refresh : "";
	const method = credentials.authMethod ?? encodedRefresh.split("|").at(-1);
	if (method === "apikey" || credentials.access.startsWith("ksk_")) return credentials;
	if (!encodedRefresh) throw new Error("Invalid Kiro refresh credential. Log in again.");

	const parts = encodedRefresh.split("|");
	const refreshToken = parts[0];
	const region = credentials.region || "us-east-1";
	if (!refreshToken || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region)) {
		throw new Error("Invalid Kiro refresh credential. Log in again.");
	}
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const now = options.now ?? Date.now;

	if (method === "desktop") {
		const response = await fetchImpl(`https://prod.${region}.auth.desktop.kiro.dev/refreshToken`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": "Kiro-Desktop/0.2.13 (darwin; arm64)",
			},
			body: JSON.stringify({ refreshToken }),
		});
		if (!response.ok) throw new Error(`Kiro desktop token refresh failed: ${response.status}. Log in again.`);
		const data = await response.json() as Record<string, unknown>;
		if (typeof data.accessToken !== "string" || typeof data.expiresIn !== "number") {
			throw new Error("Invalid Kiro desktop refresh response. Log in again.");
		}
		const nextRefresh = typeof data.refreshToken === "string" ? data.refreshToken : refreshToken;
		return {
			...credentials,
			access: data.accessToken,
			refresh: `${nextRefresh}|desktop`,
			expires: now() + data.expiresIn * 1000 - 5 * 60 * 1000,
			authMethod: "desktop",
			region,
			...(typeof data.profileArn === "string" ? { profileArn: data.profileArn } : {}),
		};
	}

	if (method === "idc") {
		const clientId = parts[1];
		const clientSecret = parts[2];
		if (!clientId || !clientSecret || parts.length < 4) {
			throw new Error("Invalid Kiro IDC refresh credential. Log in again.");
		}
		const response = await fetchImpl(`https://oidc.${region}.amazonaws.com/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: "refresh_token" }),
		});
		if (!response.ok) throw new Error(`Kiro IDC token refresh failed: ${response.status}. Log in again.`);
		const data = await response.json() as Record<string, unknown>;
		if (typeof data.accessToken !== "string" || typeof data.expiresIn !== "number") {
			throw new Error("Invalid Kiro IDC refresh response. Log in again.");
		}
		const nextRefresh = typeof data.refreshToken === "string" ? data.refreshToken : refreshToken;
		return {
			...credentials,
			access: data.accessToken,
			refresh: `${nextRefresh}|${clientId}|${clientSecret}|idc`,
			expires: now() + data.expiresIn * 1000 - 5 * 60 * 1000,
			authMethod: "idc",
			region,
			clientId,
			clientSecret,
		};
	}

	throw new Error("Unsupported Kiro refresh credential. Log in again.");
}
