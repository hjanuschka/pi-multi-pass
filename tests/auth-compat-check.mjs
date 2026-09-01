/**
 * Regression test for the pi 0.84.4 model-runtime port.
 *
 * The bug class here is "method silently absent": the extension called
 * ctx.modelRegistry.authStorage.{hasAuth,get,logout}, which no longer exists.
 * The other tests in this directory re-implement logic locally and never load
 * extensions/multi-sub.ts, so they cannot see this at all. This one loads the
 * real file and drives the real shim against a fake ModelRegistry.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const here = new URL(".", import.meta.url).pathname;
const extPath = join(here, "..", "extensions", "multi-sub.ts");
const source = readFileSync(extPath, "utf-8");
// Strip comments so the API checks below test CODE, not the shim's own
// explanatory prose (which necessarily names the removed APIs).
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// --- static assertions: the removed pi APIs must not come back -------------
// Any `.authStorage` member access is the removed API. The shim's own type is
// named AuthCompat precisely so this check can stay this blunt.
const authStorageHits = code.match(/\.authStorage\b/g) ?? [];
assert.deepEqual(
	authStorageHits,
	[],
	`extension still references .authStorage (${authStorageHits.length} site(s)); removed in pi 0.84.4`,
);
for (const gone of [
	"anthropicOAuthProvider",
	"loginAnthropic",
	"refreshAnthropicToken",
	"loginOpenAICodex",
	"loginGitHubCopilot",
	"OAuthProviderInterface",
]) {
	assert.equal(
		new RegExp(`^\\s*${gone},`, "m").test(code),
		false,
		`extension still imports ${gone} from pi-ai/oauth, which is type-only in pi 0.84.4`,
	);
}
assert.equal(
	/from "@earendil-works\/pi-ai";/.test(code),
	false,
	'getModels must come from "@earendil-works/pi-ai/compat" in pi 0.84.4',
);
assert.equal(
	/Use \/login and select/.test(code),
	false,
	"subscription login actions must start OAuth directly, not send the user to /login",
);
// --- behavioural: drive the real shim -------------------------------------
const agentDir = mkdtempSync(join(tmpdir(), "multipass-authcompat-"));
const authPath = join(agentDir, "auth.json");
writeFileSync(
	authPath,
	JSON.stringify({
		anthropic: { type: "oauth", access: "a-tok", refresh: "a-ref", expires: Date.now() + 3600_000 },
		"anthropic-2": { type: "oauth", access: "b-tok", refresh: "b-ref", expires: Date.now() + 3600_000 },
	}),
);

const refreshCalls = [];
const registry = {
	getProviderAuthStatus(provider) {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		return provider in data ? { configured: true, source: "stored" } : { configured: false };
	},
	refresh(options) {
		refreshCalls.push(options);
		return Promise.resolve({});
	},
	getProvider() {
		return undefined;
	},
};

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": join(here, "stubs", "coding-agent.mjs"),
		"@earendil-works/pi-ai/compat": join(here, "stubs", "pi-ai.mjs"),
		"@earendil-works/pi-ai/oauth": join(here, "stubs", "pi-ai.mjs"),
		"@earendil-works/pi-ai": join(here, "stubs", "pi-ai.mjs"),
		"@earendil-works/pi-tui": join(here, "stubs", "pi-tui.mjs"),
	},
});
process.env.MULTIPASS_TEST_AGENT_DIR = agentDir;

const mod = await jiti.import(extPath, {});
const internals = mod.__testHooks;
assert.ok(internals, "extension must export __testHooks for this test");

const auth = internals.createAuthCompat(registry);

// hasAuth maps the AuthStatus object to a boolean, not the object itself.
assert.equal(auth.hasAuth("anthropic"), true, "hasAuth must be true for a stored provider");
assert.equal(auth.hasAuth("nope"), false, "hasAuth must be false for an unknown provider");

// get returns the RAW stored credential (access/refresh/expires), not a
// resolved AuthResult, and it must be synchronous.
const cred = auth.get("anthropic");
assert.ok(cred && typeof cred.then !== "function", "get must be synchronous, not a Promise");
assert.equal(cred.type, "oauth");
assert.equal(cred.access, "a-tok", "get must return the raw stored credential");
assert.equal(auth.get("nope"), undefined);

// set persists the raw OAuth credential under the selected cloned provider,
// preserving every other provider, then refreshes exactly that provider.
auth.set("anthropic-2", {
	type: "oauth",
	access: "new-a-tok",
	refresh: "new-a-ref",
	expires: Date.now() + 7200_000,
});
const afterSet = JSON.parse(readFileSync(authPath, "utf-8"));
assert.equal(afterSet["anthropic-2"].access, "new-a-tok");
assert.equal(afterSet.anthropic.access, "a-tok", "set must preserve other providers");
assert.deepEqual(refreshCalls.at(-1), { providers: ["anthropic-2"] }, "set must refresh that provider");

// logout removes exactly one provider and asks the registry to refresh it.
auth.logout("anthropic-2");
const after = JSON.parse(readFileSync(authPath, "utf-8"));
assert.equal("anthropic-2" in after, false, "logout must delete the provider entry");
assert.equal("anthropic" in after, true, "logout must not touch other providers");
assert.equal(auth.hasAuth("anthropic-2"), false, "hasAuth must be false after logout");
assert.deepEqual(refreshCalls.at(-1), { providers: ["anthropic-2"] }, "logout must refresh that provider");

// logout on an absent provider is a no-op, not a crash or a rewrite.
const before = readFileSync(authPath, "utf-8");
auth.logout("not-there");
assert.equal(readFileSync(authPath, "utf-8"), before, "logout of an unknown provider must be a no-op");

assert.ok(existsSync(authPath));
console.log("auth-compat-check: all assertions passed");
