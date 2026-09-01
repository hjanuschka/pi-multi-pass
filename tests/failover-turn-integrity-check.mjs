import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const here = new URL(".", import.meta.url).pathname;
const extPath = join(here, "..", "extensions", "multi-sub.ts");
const agentDir = mkdtempSync(join(tmpdir(), "multipass-turn-integrity-"));
const originalPrompt = "I created some files on this repo a while ago for getting the base of Oportunidades de Motor. domain into a CSV. Can you find it?";

writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
	subscriptions: [{ provider: "anthropic", index: 2 }],
	pools: [
		{
			name: "anthropic",
			baseProvider: "anthropic",
			members: ["anthropic", "anthropic-2"],
			enabled: true,
		},
		{
			name: "codex",
			baseProvider: "openai-codex",
			members: ["openai-codex"],
			enabled: true,
		},
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
}, null, 2));
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
	anthropic: { type: "oauth", access: "fake-anthropic" },
	"anthropic-2": { type: "oauth", access: "fake-anthropic-2" },
	"openai-codex": { type: "oauth", access: "fake-codex" },
}, null, 2));

process.env.MULTIPASS_TEST_AGENT_DIR = agentDir;
delete process.env.MULTI_SUB;

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": join(here, "stubs", "coding-agent.mjs"),
		"@earendil-works/pi-ai/compat": join(here, "stubs", "pi-ai-failover.mjs"),
		"@earendil-works/pi-ai/oauth": join(here, "stubs", "pi-ai-failover.mjs"),
		"@earendil-works/pi-ai": join(here, "stubs", "pi-ai-failover.mjs"),
		"@earendil-works/pi-tui": join(here, "stubs", "pi-tui.mjs"),
	},
});
const mod = await jiti.import(extPath, {});
const multiSub = mod.default;

const models = new Map([
	["anthropic:claude-opus-5", { provider: "anthropic", id: "claude-opus-5", api: "fake" }],
	["anthropic-2:claude-opus-5", { provider: "anthropic-2", id: "claude-opus-5", api: "fake" }],
	["openai-codex:gpt-5.6-sol", { provider: "openai-codex", id: "gpt-5.6-sol", api: "fake" }],
]);
const handlers = new Map();
const injectedUserMessages = [];
const modelSwitches = [];
let currentModel = models.get("anthropic:claude-opus-5");

const pi = {
	on(type, handler) {
		const entries = handlers.get(type) ?? [];
		entries.push(handler);
		handlers.set(type, entries);
	},
	registerProvider() {},
	registerCommand() {},
	async setModel(model) {
		modelSwitches.push(`${model.provider}:${model.id}`);
		currentModel = model;
		return true;
	},
	sendUserMessage(content, options) {
		injectedUserMessages.push({ content, options });
	},
};

multiSub(pi);

const notifications = [];
const statuses = [];
const modelRegistry = {
	find(provider, modelId) {
		return models.get(`${provider}:${modelId}`);
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
};
const ctx = {
	cwd: agentDir,
	get model() {
		return currentModel;
	},
	modelRegistry,
	ui: {
		notify(message, level) {
			notifications.push({ message, level });
		},
		setStatus(_key, value) {
			statuses.push(value);
		},
	},
};

async function emit(type, event) {
	for (const handler of handlers.get(type) ?? []) {
		await handler(event, ctx);
	}
}

function overloadedEvent(provider) {
	return {
		type: "agent_end",
		messages: [{
			role: "assistant",
			provider,
			model: "claude-opus-5",
			stopReason: "error",
			errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			content: [],
		}],
	};
}

await emit("session_start", { type: "session_start", reason: "startup" });
await emit("input", {
	type: "input",
	text: originalPrompt,
	source: "interactive",
});
await emit("before_agent_start", {
	type: "before_agent_start",
	prompt: originalPrompt,
	systemPrompt: "",
	systemPromptOptions: { cwd: agentDir },
});

// pi 0.84.4 emits agent_end for each failed low-level run, then automatically
// retries that same turn with agent.continue(). These fake events model two
// overloaded providers before the third provider takes over.
await emit("agent_end", overloadedEvent("anthropic"));
assert.equal(currentModel.provider, "anthropic-2");
await emit("agent_end", overloadedEvent("anthropic-2"));
assert.equal(currentModel.provider, "openai-codex");

assert.deepEqual(modelSwitches, [
	"anthropic-2:claude-opus-5",
	"openai-codex:gpt-5.6-sol",
]);
assert.deepEqual(
	injectedUserMessages,
	[],
	"account/provider failover must rely on pi's retry of the current turn, not enqueue the original prompt as steering or follow-up",
);
assert.equal(
	notifications.filter((entry) => entry.level === "info" && entry.message.includes("Rate limited")).length,
	2,
);
assert.equal(statuses.at(-1), "chain:all#2 | active openai-codex (gpt-5.6-sol)");

console.log("failover turn integrity checks passed");
