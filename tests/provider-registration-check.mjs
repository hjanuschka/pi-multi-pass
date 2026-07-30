import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cloneNativeProvider, createDeferredNativeProvider } from "../lib/provider-helpers.ts";

async function runNativeProviderCloneChecks() {
  const auth = { oauth: { login() {}, refresh() {}, toAuth() {} } };
  const headers = { "x-test": "kept" };
  let models = [{
    id: "gpt-test",
    name: "GPT Test",
    provider: "openai-codex",
    api: "openai-codex-responses",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    unknownMetadata: { kept: true },
  }];
  const calls = [];
  const base = {
    id: "openai-codex",
    name: "ChatGPT Codex",
    baseUrl: "https://example.test",
    headers,
    auth,
    getModels: () => models,
    async refreshModels(context) {
      calls.push(["refresh", context]);
      models = [{ ...models[0], id: "gpt-refreshed" }];
    },
    filterModels(input, credential) {
      calls.push(["filter", input, credential]);
      assert.ok(input.every((model) => model.provider === "openai-codex"));
      return input.slice(0, 1);
    },
    stream(model, context, options) {
      calls.push(["stream", model, context, options]);
      assert.equal(model.provider, "openai-codex");
      return "stream-result";
    },
    streamSimple(model, context, options) {
      calls.push(["streamSimple", model, context, options]);
      assert.equal(model.provider, "openai-codex");
      return "simple-result";
    },
  };

  const clone = cloneNativeProvider(base, "openai-codex-2", "ChatGPT Codex #2", 2);
  assert.equal(clone.id, "openai-codex-2");
  assert.equal(clone.name, "ChatGPT Codex #2");
  assert.equal(clone.baseUrl, base.baseUrl);
  assert.equal(clone.auth, auth);
  assert.equal(clone.headers, headers);

  const clonedModel = clone.getModels()[0];
  assert.equal(clonedModel.id, "gpt-test");
  assert.equal(clonedModel.name, "GPT Test (#2)");
  assert.equal(clonedModel.provider, "openai-codex-2");
  assert.deepEqual(clonedModel.unknownMetadata, { kept: true });

  assert.equal(clone.stream(clonedModel, { messages: [] }, { apiKey: "token" }), "stream-result");
  assert.equal(clone.streamSimple(clonedModel, { messages: [] }, { apiKey: "token" }), "simple-result");
  assert.equal(clone.filterModels(clone.getModels(), { access: "account-2" })[0].provider, "openai-codex-2");

  const refreshContext = { credential: { access: "account-2" } };
  await clone.refreshModels(refreshContext);
  assert.equal(calls.find(([kind]) => kind === "refresh")[1], refreshContext);
  assert.equal(clone.getModels()[0].id, "gpt-refreshed");
  assert.equal(clone.getModels()[0].provider, "openai-codex-2");
}


async function runDeferredProviderChecks() {
  const staticModel = {
    id: "gpt-static",
    name: "GPT Static",
    provider: "openai-codex",
    api: "openai-codex-responses",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  const deferred = createDeferredNativeProvider(
    "openai-codex",
    [staticModel],
    "openai-codex-2",
    "ChatGPT Codex #2",
    2,
  );
  assert.equal(deferred.provider.getModels()[0].provider, "openai-codex-2");
  assert.deepEqual(deferred.provider.filterModels(deferred.provider.getModels(), { access: "account-2" }), deferred.provider.getModels());
  assert.throws(() => deferred.provider.stream(deferred.provider.getModels()[0], { messages: [] }), /not available/);

  const credential = { access: "account-2" };
  let liveModels = [{ ...staticModel, id: "gpt-live" }];
  const base = {
    id: "openai-codex",
    name: "ChatGPT Codex",
    baseUrl: "https://codex.native",
    auth: {
      oauth: {
        name: "Codex",
        login: async () => credential,
        refresh: async (value) => value,
        toAuth: async (value) => ({ apiKey: value.access }),
      },
    },
    getModels: () => liveModels,
    async refreshModels() {
      liveModels = [{ ...staticModel, id: "gpt-refreshed" }];
    },
    stream: (model) => model.baseUrl ?? model.id,
    streamSimple: (model) => model.baseUrl ?? model.id,
  };
  deferred.bind(base);
  assert.equal(deferred.provider.getModels()[0].id, "gpt-live");
  assert.equal(deferred.provider.baseUrl, "https://codex.native");
  assert.equal(await deferred.provider.auth.oauth.login({}), credential);
  assert.deepEqual(await deferred.provider.auth.oauth.toAuth(credential), { apiKey: "account-2" });
  assert.equal(deferred.provider.stream(deferred.provider.getModels()[0], { messages: [] }), "gpt-live");
  assert.equal(
    deferred.provider.stream({ ...deferred.provider.getModels()[0], baseUrl: "https://copilot.enterprise" }, { messages: [] }),
    "https://copilot.enterprise",
  );
  await deferred.provider.refreshModels({});
  assert.equal(deferred.provider.getModels()[0].id, "gpt-refreshed");
}

async function runSourceCompatibilityChecks() {
  const sourcePath = fileURLToPath(new URL("../extensions/multi-sub.ts", import.meta.url));
  const source = await readFile(sourcePath, "utf8");
  assert.doesNotMatch(source, /from\s+["']@earendil-works\/pi-ai\/oauth["']/);
  for (const provider of [
    "anthropic",
    "openai-codex",
    "github-copilot",
    "google-gemini-cli",
    "google-antigravity",
  ]) {
    assert.ok(source.includes(provider), `missing provider template: ${provider}`);
  }


  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  assert.notEqual(packageJson.type, "module", "Pi package discovery does not load this extension as type=module");
}

await runNativeProviderCloneChecks();
await runDeferredProviderChecks();
await runSourceCompatibilityChecks();
console.log("provider registration checks passed");
