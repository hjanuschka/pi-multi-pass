import { isDeepStrictEqual } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";

export const MINIMAX_TEXT_CHOICES = ["MiniMax-M3.1-Flash", "MiniMax-M3"] as const;

export function minimaxBase(provider: string): string | undefined {
	const base = provider.replace(/-\d+$/, "");
	return base === "minimax" || base === "minimax-cn" ? base : undefined;
}

export interface CatalogEntry {
	model: Model<Api>;
	origin: "builtin" | "remote";
}

/** Keep origin before flattening; remote metadata still wins unchanged. */
export function mergeCatalog(builtin: Model<Api>[], remote: Model<Api>[]): CatalogEntry[] {
	const merged = new Map(builtin.map((model) => [model.id, { model, origin: "builtin" as const }]));
	const result = new Map<string, CatalogEntry>(merged);
	for (const model of remote) result.set(model.id, { model, origin: "remote" });
	return [...result.values()];
}

/** Explicit declarations count even when their values equal the builtin model. */
export function configuredModelOverride(config: unknown, provider: string, id: string): boolean {
	if (!config || typeof config !== "object") return false;
	const providers = (config as { providers?: Record<string, unknown> }).providers;
	const value = providers?.[provider];
	if (!value || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	if (["baseUrl", "api", "headers", "compat"].some((key) => key in entry)) return true;
	if (Array.isArray(entry.models) && entry.models.some((model) => model?.id === id)) return true;
	const overrides = entry.modelOverrides;
	return !!overrides && typeof overrides === "object" && Object.hasOwn(overrides, id);
}

/** Unknown or changed runtime metadata is custom, never safe to hide. */
export function matchesCatalogModel(model: Model<Api>, expected: Model<Api>): boolean {
	const defined = (value: object) => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
	return isDeepStrictEqual(defined(model), defined(expected));
}

export function minimaxChoiceRank(model: Pick<Model<Api>, "provider" | "id">): number {
	if (!minimaxBase(model.provider)) return 0;
	const index = MINIMAX_TEXT_CHOICES.indexOf(model.id as typeof MINIMAX_TEXT_CHOICES[number]);
	return index < 0 ? MINIMAX_TEXT_CHOICES.length : index;
}

/** Filter only identified catalog text entries; explicit/custom requests stay usable. */
export function ordinaryModelChoices(
	models: Model<Api>[],
	isCatalogModel: (model: Model<Api>) => boolean,
	current?: Pick<Model<Api>, "provider" | "id">,
): Model<Api>[] {
	return models.filter((model) =>
		!minimaxBase(model.provider)
		|| !model.input.includes("text")
		|| MINIMAX_TEXT_CHOICES.some((id) => id === model.id)
		|| (current?.provider === model.provider && current.id === model.id)
		|| !isCatalogModel(model),
	).sort((a, b) => a.provider === b.provider ? minimaxChoiceRank(a) - minimaxChoiceRank(b) : 0);
}
