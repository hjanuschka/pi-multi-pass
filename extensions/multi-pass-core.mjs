/**
 * multi-pass-core — Pure helper functions for pi-multi-pass.
 *
 * This module has NO imports from pi packages, so it can be imported
 * by both the TypeScript extension source and plain-JS test files
 * without any transpilation or runtime dependencies.
 *
 * @module multi-pass-core
 */

// ---------------------------------------------------------------------------
// Subscription entry helpers
// ---------------------------------------------------------------------------

/**
 * @param {{ provider: string; index: number }} entry
 * @returns {string}
 */
export function subProviderName(entry) {
	return `${entry.provider}-${entry.index}`;
}

// ---------------------------------------------------------------------------
// Config normalization
// ---------------------------------------------------------------------------

/**
 * @param {unknown} raw
 * @returns {{ subscriptions: Array<{ provider: string; index: number; label?: string }>; pools: Array<any>; chains: Array<any>; presets: Array<any> }}
 */
export function normalizeMultiPassConfig(raw) {
	const parsed = raw && typeof raw === "object" ? raw : {};
	return {
		subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
		pools: Array.isArray(parsed.pools) ? parsed.pools : [],
		chains: Array.isArray(parsed.chains) ? parsed.chains : [],
		presets: Array.isArray(parsed.presets) ? parsed.presets : [],
	};
}

/**
 * @param {unknown} raw
 * @returns {{ pools?: any[]; chains?: any[]; allowedSubs?: string[] }}
 */
export function normalizeProjectConfig(raw) {
	const parsed = raw && typeof raw === "object" ? raw : {};
	const config = {};
	if (Array.isArray(parsed.pools)) config.pools = parsed.pools;
	if (Array.isArray(parsed.chains)) config.chains = parsed.chains;
	if (Array.isArray(parsed.allowedSubs)) config.allowedSubs = parsed.allowedSubs;
	return config;
}

/**
 * @returns {{ subscriptions: []; pools: []; chains: []; presets: [] }}
 */
export function emptyMultiPassConfig() {
	return { subscriptions: [], pools: [], chains: [], presets: [] };
}

// ---------------------------------------------------------------------------
// Provider name / entry normalization
// ---------------------------------------------------------------------------

/**
 * @param {string[] | undefined} allowedSubs
 * @returns {string[] | undefined}
 */
export function normalizeAllowedProviderNames(allowedSubs) {
	if (!allowedSubs || allowedSubs.length === 0) return undefined;
	const normalized = [...new Set(allowedSubs.map((v) => v.trim()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

/**
 * Merge file config subscriptions with env-var entries.
 * @param {{ subscriptions: Array<{ provider: string; index: number }> }} fileConfig
 * @param {Array<{ provider: string; index: number }>} envEntries
 * @returns {Array<{ provider: string; index: number }>}
 */
export function mergeConfigs(fileConfig, envEntries) {
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

/**
 * Assign stable indices (>= 2) to entries that have index 0.
 * @param {Array<{ provider: string; index: number }>} entries
 * @returns {Array<{ provider: string; index: number }>}
 */
export function normalizeEntries(entries) {
	const byProvider = new Map();
	for (const entry of entries) {
		const list = byProvider.get(entry.provider) || [];
		list.push(entry);
		byProvider.set(entry.provider, list);
	}
	const result = [];
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

// ---------------------------------------------------------------------------
// Pool / chain filtering
// ---------------------------------------------------------------------------

/**
 * @param {Array<{ name: string; baseProvider: string; members: string[] }>} pools
 * @param {string[] | undefined} allowedProviderNames
 * @returns {Array}
 */
export function filterPoolsByAllowedProviders(pools, allowedProviderNames) {
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

/**
 * @param {Array<{ name: string; entries: Array<{ pool: string }> }>} chains
 * @param {Array<{ name: string }>} pools
 * @returns {Array}
 */
export function filterChainsByAvailablePools(chains, pools) {
	const poolNames = new Set(pools.map((pool) => pool.name));
	return chains
		.map((chain) => ({
			...chain,
			entries: chain.entries.filter((entry) => poolNames.has(entry.pool)),
		}))
		.filter((chain) => chain.entries.length > 0);
}

// ---------------------------------------------------------------------------
// Failover helpers
// ---------------------------------------------------------------------------

/**
 * @param {{ provider: string; modelId: string } | null} candidate
 * @returns {string}
 */
export function formatFailoverTarget(candidate) {
	if (!candidate) return "none";
	return `${candidate.provider} (${candidate.modelId})`;
}

/**
 * @param {{ provider: string; modelId: string; source?: string; chainName?: string; chainIndex?: number; poolName?: string } | null} candidate
 * @param {string | undefined} fallbackPoolName
 * @returns {string}
 */
export function formatFailoverStatus(candidate, fallbackPoolName) {
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

/**
 * @param {{ provider: string; modelId: string; source?: string; chainName?: string; chainIndex?: number; poolName?: string } | null} nextCandidate
 * @returns {string}
 */
export function formatFailoverContinuation(nextCandidate) {
	if (!nextCandidate) {
		return "cascade exhausted; no later eligible target";
	}
	const phase = nextCandidate.source === "chain"
		? `continuing forward to chain ${nextCandidate.chainName}#${(nextCandidate.chainIndex ?? 0) + 1}`
		: `continuing within pool ${nextCandidate.poolName}`;
	return `${phase} -> ${formatFailoverTarget(nextCandidate)}`;
}

/**
 * @param {string} poolName
 * @param {string} currentProvider
 * @param {{ provider: string; modelId: string; source?: string; chainName?: string; chainIndex?: number; poolName?: string } | null} nextCandidate
 * @returns {string}
 */
export function formatFailoverTransition(poolName, currentProvider, nextCandidate) {
	if (!nextCandidate) {
		return `[pool:${poolName}] Failover exhausted after ${currentProvider}; no eligible target remained.`;
	}
	const phase = nextCandidate.source === "chain"
		? `advancing to chain ${nextCandidate.chainName}#${(nextCandidate.chainIndex ?? 0) + 1}`
		: `rotating within pool ${poolName}`;
	return `[pool:${poolName}] Rate limited on ${currentProvider}; ${phase}; active ${formatFailoverTarget(nextCandidate)}`;
}

/**
 * @param {string} poolName
 * @param {string} currentProvider
 * @returns {string}
 */
export function formatFailoverExhausted(poolName, currentProvider) {
	return `[pool:${poolName}] Failover exhausted after ${currentProvider}; no eligible target remained in this cascade.`;
}

/**
 * @param {{ pool: string; model: string; enabled: boolean }} entry
 * @param {{ pools: Array<{ name: string; enabled: boolean; baseProvider: string }> }} config
 * @param {{ get: (provider: string) => string[] }} modelRegistry
 * @returns {string | null}
 */
export function getChainEntryIssue(entry, config, modelRegistry) {
	const pool = config.pools.find((candidate) => candidate.name === entry.pool);
	if (!pool) return `invalid pool: ${entry.pool} missing`;
	if (!pool.enabled) return `invalid pool: ${pool.name} disabled`;
	const selectableModels = [...(modelRegistry.get(pool.baseProvider) || [])];
	if (selectableModels.length === 0) {
		return `invalid model: no selectable models for ${pool.baseProvider}`;
	}
	if (!selectableModels.includes(entry.model)) {
		return `invalid model: ${entry.model} unavailable for ${pool.name}`;
	}
	return null;
}

/**
 * @param {string} poolName
 * @param {string} provider
 * @param {{ hasAuth(provider: string): boolean }} authStorage
 * @param {boolean} exhausted
 * @returns {{ type: string; poolName: string; reason: string; detail: string } | null}
 */
export function classifyPoolMemberSkip(poolName, provider, authStorage, exhausted) {
	if (!authStorage.hasAuth(provider)) {
		return {
			type: "pool-member",
			poolName,
			reason: "no-auth",
			detail: `${provider} skipped (no auth)`,
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

/**
 * @param {{ name: string; enabled: boolean; entries: Array<{ pool: string; model: string; enabled: boolean }> }} chain
 * @param {number} chainIndex
 * @param {{ pool: string; model: string }} entry
 * @param {{ pools: Array<{ name: string; enabled: boolean; baseProvider: string }> }} config
 * @returns {{ type: string; poolName: string; reason: string; detail: string; chainName: string; chainIndex: number } | null}
 */
export function classifyChainEntrySkip(chain, chainIndex, entry, config) {
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
	const issue = getChainEntryIssue(entry, config, createModelCatalog());
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

// ---------------------------------------------------------------------------
// Quota / usage parsing helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} window
 * @returns {{ seconds: number; resetAt: string } | undefined}
 */
export function normalizeCodexUsageWindow(window) {
	if (!window || typeof window !== "object") return undefined;
	const w = window;
	if (typeof w.seconds !== "number" || typeof w.resetAt !== "string") return undefined;
	return { seconds: w.seconds, resetAt: w.resetAt };
}

/**
 * @param {unknown} data
 * @returns {{ fiveHour: { seconds: number; resetAt: string } | undefined; weekly: { seconds: number; resetAt: string } | undefined; planType: string; email?: string }}
 */
export function parseCodexUsageSnapshot(data) {
	const parsed = data && typeof data === "object" ? data : {};
	return {
		fiveHour: normalizeCodexUsageWindow(parsed.fiveHour || parsed["five_hour"]),
		weekly: normalizeCodexUsageWindow(parsed.weekly || parsed["weekly"]),
		planType: typeof parsed.planType === "string" ? parsed.planType : "unknown",
		email: typeof parsed.email === "string" ? parsed.email : undefined,
	};
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function normalizeGoogleRemainingPercent(value) {
	if (typeof value === "number" && !Number.isNaN(value)) return value;
	if (typeof value === "string") {
		const n = parseFloat(value);
		if (!Number.isNaN(n)) return n;
	}
	return undefined;
}

/**
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
export function parseIsoTimestampSeconds(value) {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

// ---------------------------------------------------------------------------
// Small mock used by classifyChainEntrySkip and getChainEntryIssue
// ---------------------------------------------------------------------------

function createModelCatalog() {
	const catalog = new Map();
	catalog.set("openai-codex", [
		"gpt-4o",
		"gpt-4o-mini",
		"o1",
		"o1-mini",
		"o3-mini",
		"gpt-4.1",
		"gpt-4.1-mini",
		"gpt-4.1-nano",
	]);
	catalog.set("anthropic", [
		"claude-sonnet-4-20250514",
		"claude-sonnet-4",
		"claude-4-20250514",
		"claude-opus-4-20250514",
		"claude-sonnet-4-20250514-thinking",
	]);
	return catalog;
}
