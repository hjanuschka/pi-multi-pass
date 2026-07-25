/**
 * Pure model-cloning logic for multi-pass subscription providers.
 * Extracted from multi-sub.ts for testability (no pi-ai dependency).
 */

export interface CloneableModel {
	provider: string;
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, unknown> | undefined;
	input: readonly string[];
	cost: Record<string, unknown>;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string> | undefined;
	compat?: unknown;
}

export interface ClonedModel {
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, unknown> | undefined;
	input: readonly string[];
	cost: Record<string, unknown>;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string> | undefined;
	compat?: unknown;
}

/** Clone a single model with the (#index) suffix. */
export function cloneOne(m: CloneableModel, index: number): ClonedModel {
	return {
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
	};
}

/** Clone models from a static list. */
export function cloneFromList(models: CloneableModel[], index: number): ClonedModel[] {
	return models.map((m) => cloneOne(m, index));
}

/**
 * Clone models from the live registry catalog for a base provider.
 * Falls back to the static list when the registry is unavailable or
 * has no models for the requested provider.
 */
export function cloneModelsLive(
	registry: { getAll(): CloneableModel[] } | undefined,
	originalProvider: string,
	index: number,
	staticFallback: () => ClonedModel[],
): ClonedModel[] {
	if (registry) {
		const live = registry.getAll().filter((m) => m.provider === originalProvider);
		if (live.length > 0) {
			return live.map((m) => cloneOne(m, index));
		}
	}
	return staticFallback();
}
