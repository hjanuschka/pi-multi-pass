import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cloneModelsLive, cloneFromList, type CloneableModel } from "../extensions/model-clone.ts";

// WHY: registerSub() snapshots models at load time via cloneModels(). Without a
// refreshModels callback on registerProvider, cloned subscription providers
// (anthropic-2, etc.) NEVER receive remote catalog updates (e.g. new Opus pushed
// via pi.dev). This is the bug that kept opus-5 off multipass subs while the
// primary subscription had it. These tests fail if the callback is dropped or
// the live-clone path breaks.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "extensions", "multi-sub.ts"), "utf8");

// ---------------------------------------------------------------------------
// 1. STRUCTURAL: registerSub passes refreshModels to BOTH registerProvider calls
// ---------------------------------------------------------------------------

test("registerSub passes refreshModels to BOTH registerProvider calls (api_key + oauth)", () => {
	const start = SRC.indexOf("function registerSub(");
	assert.ok(start >= 0, "registerSub not found");
	const end = SRC.indexOf("\n// ====", start + 1);
	assert.ok(end > start, "registerSub end boundary not found");
	const body = SRC.slice(start, end);

	// Direct count: exactly TWO refreshModels property occurrences in registerSub.
	// Fails if EITHER call site drops the callback — indentation-independent.
	const refreshCount = (body.match(/refreshModels\s*[,:]/g) ?? []).length;
	assert.equal(
		refreshCount,
		2,
		`registerSub must have exactly 2 refreshModels occurrences (one per registerProvider call), found ${refreshCount}`,
	);

	// Per-call guard: slice by call boundaries (not brace indentation).
	const callStarts = [...body.matchAll(/pi\.registerProvider\(/g)].map((m) => m.index!);
	assert.equal(callStarts.length, 2, `expected 2 registerProvider calls, found ${callStarts.length}`);

	for (const [i, callStart] of callStarts.entries()) {
		const callEnd = callStarts[i + 1] ?? body.length;
		const call = body.slice(callStart, callEnd);
		assert.ok(
			call.includes("refreshModels"),
			`registerProvider call #${i + 1} is missing the refreshModels callback — cloned models will go stale on catalog update`,
		);
	}
});

// ---------------------------------------------------------------------------
// 2. FUNCTIONAL: cloneModelsLive returns live-catalog models with (#index) suffix
// ---------------------------------------------------------------------------

const FAKE_OPUS5: CloneableModel = {
	provider: "anthropic",
	id: "claude-opus-5",
	name: "Claude Opus 5",
	api: "anthropic-messages",
	reasoning: true,
	thinkingLevelMap: undefined,
	input: ["text", "image"],
	cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	contextWindow: 1000000,
	maxTokens: 128000,
	headers: undefined,
	compat: undefined,
};

test("cloneModelsLive returns models from the live registry (not just static builtin)", () => {
	const registry = { getAll: () => [FAKE_OPUS5] };
	const result = cloneModelsLive(registry, "anthropic", 2, () => []);

	const opus5 = result.find((m) => m.id === "claude-opus-5");
	assert.ok(opus5, "live-catalog model (claude-opus-5) must appear in cloneModelsLive result");
	assert.equal(opus5!.name, "Claude Opus 5 (#2)", "cloned model must carry the (#index) suffix");
	assert.equal(opus5!.contextWindow, 1000000, "field values must be preserved from the live model");
	assert.deepEqual(opus5!.cost, FAKE_OPUS5.cost, "cost must be deep-copied");
});

test("cloneModelsLive filters to the requested base provider only", () => {
	const other: CloneableModel = { ...FAKE_OPUS5, provider: "openai-codex", id: "gpt-5" };
	const registry = { getAll: () => [FAKE_OPUS5, other] };
	const result = cloneModelsLive(registry, "anthropic", 2, () => []);

	assert.equal(result.length, 1, "must only include models for the requested provider");
	assert.equal(result[0].id, "claude-opus-5");
});

// ---------------------------------------------------------------------------
// 3. FUNCTIONAL: fallback to static cloneModels when registry is unavailable
// ---------------------------------------------------------------------------

test("cloneModelsLive falls back to static list when registry is undefined", () => {
	const staticModels = cloneFromList([FAKE_OPUS5], 3);
	const result = cloneModelsLive(undefined, "anthropic", 3, () => staticModels);

	assert.ok(result.length > 0, "fallback must return non-empty model list");
	assert.equal(result[0].name, "Claude Opus 5 (#3)", "fallback models must carry the (#index) suffix");
});

test("cloneModelsLive falls back to static list when registry has no models for the provider", () => {
	const registry = { getAll: () => [] as CloneableModel[] };
	const staticModels = cloneFromList([FAKE_OPUS5], 4);
	const result = cloneModelsLive(registry, "anthropic", 4, () => staticModels);

	assert.ok(result.length > 0, "fallback must return non-empty model list when registry yields nothing");
	assert.equal(result[0].name, "Claude Opus 5 (#4)");
});
