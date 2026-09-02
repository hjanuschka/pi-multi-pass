/**
 * Does one pi process teach the others which accounts are dead?
 *
 * Cooldown used to live in `state.exhausted`, a Map inside PoolManager, so every
 * process learned the same fact the only way it could: by spending a request and
 * failing. A parent plus five sub-agents against two exhausted accounts is a
 * dozen wasted calls per wave, and the parent already knew.
 *
 * markExhausted now also writes `multi-pass-exhausted.json` next to the config,
 * and the exhaustion checks read it. This test drives two independent extension
 * instances - separate module state, same agent dir - which is exactly the
 * parent/sub-agent shape.
 *
 *   node tests/exhaustion-ledger-check.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const here = new URL(".", import.meta.url).pathname;
const extPath = join(here, "..", "extensions", "multi-sub.ts");
const agentDir = mkdtempSync(join(tmpdir(), "multipass-ledger-"));
const ledgerPath = join(agentDir, "multi-pass-exhausted.json");

const POOLS = [
	{ name: "anthropic", baseProvider: "anthropic", members: ["anthropic", "anthropic-2"], enabled: true },
	{ name: "codex", baseProvider: "openai-codex", members: ["openai-codex"], enabled: true },
];

writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
	subscriptions: [{ provider: "anthropic", index: 2 }],
	pools: POOLS,
	chains: [{
		name: "all",
		enabled: true,
		entries: [
			{ pool: "anthropic", model: "claude-opus-5", enabled: true },
			{ pool: "codex", model: "gpt-5.6-sol", enabled: true },
		],
	}],
	presets: [],
}, null, 2));
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
	anthropic: { type: "oauth", access: "a" },
	"anthropic-2": { type: "oauth", access: "b" },
	"openai-codex": { type: "oauth", access: "c" },
}, null, 2));

process.env.MULTIPASS_TEST_AGENT_DIR = agentDir;
delete process.env.MULTI_SUB;

const models = new Map([
	["anthropic:claude-opus-5", { provider: "anthropic", id: "claude-opus-5", api: "fake" }],
	["anthropic-2:claude-opus-5", { provider: "anthropic-2", id: "claude-opus-5", api: "fake" }],
	["openai-codex:gpt-5.6-sol", { provider: "openai-codex", id: "gpt-5.6-sol", api: "fake" }],
]);

/** A whole independent pi process, as far as module state is concerned. */
async function spawnInstance(label) {
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
	const handlers = new Map();
	let currentModel = models.get("anthropic:claude-opus-5");
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
			find: (provider, id) => models.get(`${provider}:${id}`),
			getProviderAuthStatus(provider) {
				const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
				return { configured: provider in auth, source: "stored" };
			},
			getProvider: () => undefined,
			refresh: () => Promise.resolve({}),
		},
		ui: { notify() {}, setStatus() {} },
	};
	const emit = async (type, event) => {
		for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
	};
	await emit("session_start", { type: "session_start", reason: "startup" });
	await emit("before_agent_start", {
		type: "before_agent_start",
		prompt: `work from ${label}`,
		systemPrompt: "",
		systemPromptOptions: { cwd: agentDir },
	});
	return {
		emit,
		current: () => currentModel,
		fail: (provider) => emit("agent_end", {
			type: "agent_end",
			messages: [{
				role: "assistant",
				provider,
				model: "claude-opus-5",
				stopReason: "error",
				errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached"}}',
				content: [],
			}],
		}),
	};
}

// ── The parent burns the anthropic pool down ──────────────────────────────
const parent = await spawnInstance("parent");
assert.ok(!existsSync(ledgerPath), "no ledger before anything fails");

await parent.fail("anthropic");
assert.equal(parent.current().provider, "anthropic-2");
await parent.fail("anthropic-2");
assert.equal(parent.current().provider, "openai-codex");

const ledger = JSON.parse(readFileSync(ledgerPath, "utf-8"));
assert.deepEqual(
	Object.keys(ledger).sort(),
	["anthropic", "anthropic-2"],
	"both dead accounts must be published, not just the first",
);
assert.ok(
	Object.values(ledger).every((at) => typeof at === "number" && Date.now() - at < 10_000),
	"entries carry a fresh timestamp so the cooldown can expire them",
);

// ── A freshly started process must inherit that knowledge ─────────────────
const child = await spawnInstance("child");

// Drive it through the same public surface a real cascade uses: with both
// anthropic members already known-dead, the first failure must skip straight to
// the codex chain entry instead of trying anthropic-2 first.
await child.fail("anthropic");
assert.equal(
	child.current().provider,
	"openai-codex",
	"the child must skip anthropic-2 - the parent already proved it is dead",
);

// ── An expired entry stops counting ───────────────────────────────────────
const stale = { anthropic: Date.now() - 6 * 60 * 1000, "anthropic-2": Date.now() - 6 * 60 * 1000 };
writeFileSync(ledgerPath, JSON.stringify(stale), "utf-8");
await new Promise((resolve) => setTimeout(resolve, 1100)); // outlive the 1s read cache

const later = await spawnInstance("after-cooldown");
await later.fail("anthropic");
assert.equal(
	later.current().provider,
	"anthropic-2",
	"past the 5 minute cooldown the account is worth trying again",
);

// ── A corrupt ledger must not break failover ──────────────────────────────
writeFileSync(ledgerPath, "{ this is not json", "utf-8");
await new Promise((resolve) => setTimeout(resolve, 1100));
const resilient = await spawnInstance("corrupt-ledger");
await resilient.fail("anthropic");
assert.equal(
	resilient.current().provider,
	"anthropic-2",
	"an unreadable ledger degrades to today's behaviour, it does not throw",
);

console.log("exhaustion ledger checks passed");
