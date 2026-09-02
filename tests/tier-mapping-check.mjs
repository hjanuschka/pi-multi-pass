/**
 * When failover crosses from one pool to another, does the session keep the
 * TIER of the model it was using?
 *
 * A chain entry says "pool + the model to use there", so a hop used entry.model
 * verbatim regardless of what the session was on. Same-pool rotation already
 * kept currentModel.id; only the chain hop threw it away, seventy lines further
 * down the same function.
 *
 * What that costs, on the live roster: `implementer` and `tester` run
 * anthropic/claude-sonnet-5, and the chain's codex entry names gpt-5.6-sol. Both
 * agents get silently promoted to a flagship model the moment the anthropic pool
 * dries up, and the only signal is the bill. The reverse is worse to debug - a
 * flagship session quietly demoted mid-task and answering worse.
 *
 * The tier table is explicit on purpose. Do not infer tiers from model names:
 * "-mini", "-opus" and "sol" are vendor marketing and they change.
 *
 *   node tests/tier-mapping-check.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const here = new URL(".", import.meta.url).pathname;
const extPath = join(here, "..", "extensions", "multi-sub.ts");

const TIERS = [
	{ name: "flagship", models: { anthropic: "claude-opus-5", "openai-codex": "gpt-5.6-sol" } },
	{ name: "mid", models: { anthropic: "claude-sonnet-5", "openai-codex": "gpt-5.4" } },
	{ name: "cheap", models: { anthropic: "claude-haiku-4-5", "openai-codex": "gpt-5.4-mini" } },
];

function writeConfig(agentDir, { tiers }) {
	writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
		subscriptions: [{ provider: "anthropic", index: 2 }],
		pools: [
			{ name: "anthropic", baseProvider: "anthropic", members: ["anthropic", "anthropic-2"], enabled: true },
			{ name: "codex", baseProvider: "openai-codex", members: ["openai-codex"], enabled: true },
		],
		chains: [{
			name: "all",
			enabled: true,
			entries: [
				{ pool: "anthropic", model: "claude-opus-5", enabled: true },
				{ pool: "codex", model: "gpt-5.6-sol", enabled: true },
			],
		}],
		presets: [],
		...(tiers ? { tiers } : {}),
	}, null, 2));
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
		anthropic: { type: "oauth", access: "fake-anthropic" },
		"anthropic-2": { type: "oauth", access: "fake-anthropic-2" },
		"openai-codex": { type: "oauth", access: "fake-codex" },
	}, null, 2));
}

/**
 * One extension instance with its own config, driven through a real cascade.
 * jiti caches by path, so each scenario gets a fresh jiti to keep the module's
 * top-level state (registryRef, pool cooldowns) from leaking between them.
 */
async function scenario({ tiers, startModel, models }) {
	const agentDir = mkdtempSync(join(tmpdir(), "multipass-tier-"));
	mkdirSync(join(agentDir, ".pi"), { recursive: true });
	writeConfig(agentDir, { tiers });
	process.env.MULTIPASS_TEST_AGENT_DIR = agentDir;
	delete process.env.MULTI_SUB;

	const jiti = createJiti(import.meta.url, {
		interopDefault: true,
		moduleCache: false,
		alias: {
			"@earendil-works/pi-coding-agent": join(here, "stubs", "coding-agent.mjs"),
			"@earendil-works/pi-ai/compat": join(here, "stubs", "pi-ai-failover.mjs"),
			"@earendil-works/pi-ai/oauth": join(here, "stubs", "pi-ai-failover.mjs"),
			"@earendil-works/pi-ai": join(here, "stubs", "pi-ai-failover.mjs"),
			"@earendil-works/pi-tui": join(here, "stubs", "pi-tui.mjs"),
		},
	});
	const mod = await jiti.import(extPath, {});

	const catalog = new Map(models.map((m) => [`${m.provider}:${m.id}`, { ...m, api: "fake" }]));
	const handlers = new Map();
	const statuses = [];
	const notifications = [];
	let currentModel = catalog.get(startModel);
	assert.ok(currentModel, `start model ${startModel} missing from the test catalog`);

	const pi = {
		on(type, handler) {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
		},
		registerProvider() {},
		registerCommand() {},
		async setModel(model) {
			currentModel = model;
			return true;
		},
		sendUserMessage() {},
	};
	mod.default(pi);

	const ctx = {
		cwd: agentDir,
		get model() {
			return currentModel;
		},
		modelRegistry: {
			find(provider, modelId) {
				return catalog.get(`${provider}:${modelId}`);
			},
			getProviderAuthStatus(provider) {
				const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
				return { configured: provider in auth, source: "stored" };
			},
			getProvider() {
				return undefined;
			},
			refresh() {
				return Promise.resolve({});
			},
		},
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
			setStatus(_key, value) {
				statuses.push(value);
			},
		},
	};

	const emit = async (type, event) => {
		for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
	};
	const prompt = "trace the bounce pipeline";
	const fail = (provider) => emit("agent_end", {
		type: "agent_end",
		messages: [{
			role: "assistant",
			provider,
			model: currentModel.id,
			stopReason: "error",
			errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached"}}',
			content: [],
		}],
	});

	await emit("session_start", { type: "session_start", reason: "startup" });
	await emit("before_agent_start", {
		type: "before_agent_start",
		prompt,
		systemPrompt: "",
		systemPromptOptions: { cwd: agentDir },
	});

	return { mod, fail, statuses, notifications, current: () => currentModel };
}

const FULL_CATALOG = [
	{ provider: "anthropic", id: "claude-opus-5" },
	{ provider: "anthropic", id: "claude-sonnet-5" },
	{ provider: "anthropic-2", id: "claude-opus-5" },
	{ provider: "anthropic-2", id: "claude-sonnet-5" },
	{ provider: "openai-codex", id: "gpt-5.6-sol" },
	{ provider: "openai-codex", id: "gpt-5.4" },
	{ provider: "openai-codex", id: "gpt-5.4-mini" },
];

// ── 1. The pure resolver ──────────────────────────────────────────────────
{
	const { mod } = await scenario({
		tiers: TIERS,
		startModel: "anthropic:claude-sonnet-5",
		models: FULL_CATALOG,
	});
	const resolve = mod.resolveTierEquivalent;
	assert.equal(typeof resolve, "function", "resolveTierEquivalent must be exported for tests");

	assert.equal(resolve(TIERS, "anthropic", "claude-sonnet-5", "openai-codex"), "gpt-5.4");
	assert.equal(resolve(TIERS, "openai-codex", "gpt-5.4-mini", "anthropic"), "claude-haiku-4-5");
	assert.equal(
		resolve(TIERS, "anthropic", "claude-fable-5", "openai-codex"),
		undefined,
		"a model in no tier has no equivalent - the caller falls back to entry.model",
	);
	assert.equal(
		resolve(TIERS, "anthropic", "claude-sonnet-5", "google-gemini-cli"),
		undefined,
		"a tier that names no model for the target provider has no equivalent",
	);
	assert.equal(resolve(undefined, "anthropic", "claude-sonnet-5", "openai-codex"), undefined);
	assert.equal(resolve([], "anthropic", "claude-sonnet-5", "openai-codex"), undefined);

	// The pool holds anthropic and anthropic-2, which share a catalogue. Keying
	// by provider (not pool) is what makes the second one resolvable.
	assert.equal(resolve(TIERS, "anthropic-2", "claude-sonnet-5", "openai-codex"), undefined,
		"anthropic-2 is not in the table, so it has no tier of its own");

	// A model listed twice is a config error; first match wins, deterministically.
	const dupes = [
		{ name: "mid", models: { anthropic: "claude-sonnet-5", "openai-codex": "gpt-5.4" } },
		{ name: "cheap", models: { anthropic: "claude-sonnet-5", "openai-codex": "gpt-5.4-mini" } },
	];
	assert.equal(resolve(dupes, "anthropic", "claude-sonnet-5", "openai-codex"), "gpt-5.4");
	console.log("  resolver checks passed");
}

// ── 2. A mid-tier session must not be promoted on a chain hop ─────────────
{
	const s = await scenario({
		tiers: TIERS,
		startModel: "anthropic:claude-sonnet-5",
		models: FULL_CATALOG,
	});
	await s.fail("anthropic");
	assert.equal(s.current().provider, "anthropic-2");
	assert.equal(
		s.current().id,
		"claude-sonnet-5",
		"same-pool rotation already preserved the model and must keep doing so",
	);

	await s.fail("anthropic-2");
	assert.equal(s.current().provider, "openai-codex");
	assert.equal(
		s.current().id,
		"gpt-5.4",
		"the chain hop must land on the codex model at the SAME tier, not on the entry's gpt-5.6-sol",
	);
	assert.match(
		s.statuses.at(-1),
		/tier: mid/,
		"the status line must say the model came from the tier table, not the chain entry",
	);
	console.log("  mid-tier hop checks passed");
}

// ── 3. No tiers key: byte-identical to the old behaviour ──────────────────
{
	const s = await scenario({
		tiers: undefined,
		startModel: "anthropic:claude-sonnet-5",
		models: FULL_CATALOG,
	});
	await s.fail("anthropic");
	await s.fail("anthropic-2");
	assert.equal(s.current().id, "gpt-5.6-sol", "without a tiers table the chain entry decides, as before");
	assert.equal(
		s.statuses.at(-1),
		"chain:all#2 | active openai-codex (gpt-5.6-sol)",
		"the status line must not grow a suffix for configs that have no tiers",
	);
	console.log("  no-tiers compatibility checks passed");
}

// ── 4. A model in no tier falls back, and says so ─────────────────────────
{
	const s = await scenario({
		tiers: TIERS,
		startModel: "anthropic:claude-fable-5",
		models: [...FULL_CATALOG, { provider: "anthropic", id: "claude-fable-5" }, { provider: "anthropic-2", id: "claude-fable-5" }],
	});
	await s.fail("anthropic");
	await s.fail("anthropic-2");
	assert.equal(s.current().id, "gpt-5.6-sol", "an untiered model falls back to the chain entry");
	assert.match(s.statuses.at(-1), /chain default/, "and the status line says the tier table did not decide");
	console.log("  untiered fallback checks passed");
}

// ── 5. A tier naming a model the provider does not have falls back ────────
//
// Without this the candidate reaches handleError, ctx.modelRegistry.find returns
// undefined, and the whole cascade aborts with "model missing at runtime" - one
// typo in the tier table would disable failover entirely.
{
	const s = await scenario({
		tiers: [
			{ name: "flagship", models: { anthropic: "claude-opus-5", "openai-codex": "gpt-5.7-does-not-exist" } },
			...TIERS.slice(1),
		],
		startModel: "anthropic:claude-opus-5",
		models: FULL_CATALOG,
	});
	await s.fail("anthropic");
	await s.fail("anthropic-2");
	assert.equal(
		s.current().id,
		"gpt-5.6-sol",
		"a tier pointing at a model the target provider does not serve must fall back, not strand the cascade",
	);
	console.log("  unknown-mapped-model fallback checks passed");
}

console.log("tier mapping checks passed");
