/**
 * After a rotation, does the turn actually run again?
 *
 * pi only retries a failed turn when the provider error is retryable, and its
 * rule is narrow (pi 0.84.4, `isRetryableProviderError`):
 *
 *     408, 409, 429, >= 500, or an x-should-retry: true header
 *
 * A 400 is never retried. Anthropic reports subscription exhaustion as exactly
 * that - `400 {"type":"error","error":{"type":"invalid_request_error", ...
 * "You're out of extra usage"}}`, captured verbatim from a real agent_end event
 * on 2026-09-02 - so multi-pass switches the account and then nothing resumes.
 * A human presses Enter again. A sub-agent has nobody to press Enter: it lands
 * on a healthy account with its task unexecuted and the pane goes idle.
 *
 * So the replay is conditional, and both halves are load-bearing:
 *
 *   - error pi WILL retry      -> rotate only. Replaying would send the prompt
 *     twice, once by us and once by pi's own retry. That regression is why
 *     c9f4b3f removed the unconditional replay; tests/failover-turn-integrity-check.mjs
 *     guards that direction.
 *   - error pi will NOT retry  -> replay exactly once per rotation.
 *
 * This file guards the second direction, plus the "exactly once" part.
 *
 *   node tests/failover-replay-check.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const here = new URL(".", import.meta.url).pathname;
const extPath = join(here, "..", "extensions", "multi-sub.ts");
const agentDir = mkdtempSync(join(tmpdir(), "multipass-replay-"));
const originalPrompt = "map the bounce classification pipeline and write docs/bounces.md";

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
		setStatus() {},
	},
};

async function emit(type, event) {
	for (const handler of handlers.get(type) ?? []) {
		await handler(event, ctx);
	}
}

/**
 * Verbatim from a real agent_end event, 2026-09-02, `anthropic` account.
 * The leading "400 " is how pi formats `${status} ${body}` into errorMessage;
 * the assistant message carries no separate status field, so the status has to
 * be read off this string.
 */
function creditExhaustedEvent(provider, model = "claude-opus-5") {
	return {
		type: "agent_end",
		messages: [{
			role: "assistant",
			provider,
			model,
			stopReason: "error",
			errorMessage:
				'400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Ask your workspace admin to add more so you can keep going."},"request_id":"req_011CeeWqkhoUWwzFFQR8Xazb"}',
			content: [],
		}],
	};
}

/** A 429, which pi retries on its own. Rotate, do not replay. */
function rateLimitedEvent(provider, model = "claude-opus-5") {
	return {
		type: "agent_end",
		messages: [{
			role: "assistant",
			provider,
			model,
			stopReason: "error",
			errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached"}}',
			content: [],
		}],
	};
}

function replayTurn() {
	return emit("before_agent_start", {
		type: "before_agent_start",
		prompt: originalPrompt,
		systemPrompt: "",
		systemPromptOptions: { cwd: agentDir },
	});
}

await emit("session_start", { type: "session_start", reason: "startup" });
await emit("input", { type: "input", text: originalPrompt, source: "interactive" });
await emit("before_agent_start", {
	type: "before_agent_start",
	prompt: originalPrompt,
	systemPrompt: "",
	systemPromptOptions: { cwd: agentDir },
});

// ── First failure: a 429, which pi retries itself. Rotate, do not replay. ──
//
// This case comes first on purpose. Run it at the end of the cascade instead
// and it passes for the wrong reason: with every account already attempted,
// handleError returns false before it ever reaches the replay, so a build that
// replays unconditionally would still show zero replays here. Caught 2026-09-02
// by planting exactly that defect and watching this file stay green.
await emit("agent_end", rateLimitedEvent("anthropic"));
assert.equal(currentModel.provider, "anthropic-2", "a 429 must still rotate the account");
assert.equal(
	injectedUserMessages.length,
	0,
	"pi retries a 429 itself; replaying it would send the prompt twice",
);

await replayTurn();

// ── Second failure: out of credit on a 400, which pi will not retry ──
await emit("agent_end", creditExhaustedEvent("anthropic-2"));
assert.equal(currentModel.provider, "openai-codex", "must hop the chain to codex");
assert.equal(
	injectedUserMessages.length,
	1,
	"pi does not retry a 400, so the rotation must replay the turn itself",
);
assert.equal(
	injectedUserMessages[0].content,
	originalPrompt,
	"the replay must carry the original prompt, not a summary of it",
);
assert.equal(
	injectedUserMessages[0].options?.deliverAs,
	"followUp",
	'"followUp", not "steer": the replay is a new turn on the new provider, not an injection into the turn that just failed',
);

assert.deepEqual(modelSwitches, ["anthropic-2:claude-opus-5", "openai-codex:gpt-5.6-sol"]);

// ── Third failure: nothing left to rotate to, so nothing to replay ──
//
// pi re-emits before_agent_start for the replayed turn; the cascade must
// survive it, or this failure starts a fresh cascade and retries the account
// that just died.
await replayTurn();
await emit("agent_end", creditExhaustedEvent("openai-codex", "gpt-5.6-sol"));
assert.equal(
	currentModel.provider,
	"openai-codex",
	"cascade is exhausted, the model must stay put",
);
assert.equal(
	injectedUserMessages.length,
	1,
	"a failed rotation must not replay - that would loop the prompt forever on a dead cascade",
);

console.log(
	`failover replay checks passed (${modelSwitches.length} rotations, ${injectedUserMessages.length} replays)`,
);
