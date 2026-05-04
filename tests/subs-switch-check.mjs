import assert from "node:assert/strict";
import { normalizeEntries, mergeConfigs, normalizeAllowedProviderNames, subProviderName } from "../extensions/multi-pass-core.mjs";

function normalizeSwitchAllowedProviderNames(projectConfig) {
  return normalizeAllowedProviderNames(projectConfig?.allowedSubs);
}

function getSwitchableProviderNames({ baseProviders, subscriptions, hasAuth, allowedProviderNames }) {
  const allSubs = normalizeEntries(mergeConfigs({ subscriptions }, []));
  const allowed = allowedProviderNames ? new Set(allowedProviderNames) : undefined;
  const names = [];
  const seen = new Set();

  const push = (providerName) => {
    if (allowed && !allowed.has(providerName)) return;
    if (!hasAuth(providerName)) return;
    if (seen.has(providerName)) return;
    seen.add(providerName);
    names.push(providerName);
  };

  for (const providerName of baseProviders) {
    push(providerName);
  }
  for (const entry of allSubs) {
    push(subProviderName(entry));
  }
  return names;
}

function resolveSwitchTargetModel({ providerName, preferredModelId, hasAuth, providerModels, baseProviderLookup }) {
  if (!hasAuth(providerName)) return undefined;
  const models = providerModels[providerName] || [];
  if (preferredModelId && models.some((model) => model.id === preferredModelId)) {
    return models.find((model) => model.id === preferredModelId);
  }
  const baseProvider = baseProviderLookup(providerName);
  if (!baseProvider) return undefined;
  const baseModels = providerModels[baseProvider] || [];
  for (const baseModel of baseModels) {
    const candidate = models.find((model) => model.id === baseModel.id);
    if (candidate) return candidate;
  }
  return undefined;
}

function runAllowedProviderFilteringCheck() {
  const providerNames = getSwitchableProviderNames({
    baseProviders: ["openai-codex"],
    subscriptions: [{ provider: "openai-codex", index: 2 }],
    hasAuth: (providerName) => providerName === "openai-codex" || providerName === "openai-codex-2",
    allowedProviderNames: normalizeSwitchAllowedProviderNames({ allowedSubs: ["openai-codex-2"] }),
  });

  assert.deepEqual(providerNames, ["openai-codex-2"]);
}

function runPreferredModelCheck() {
  const model = resolveSwitchTargetModel({
    providerName: "openai-codex-2",
    preferredModelId: "gpt-5.4",
    hasAuth: () => true,
    providerModels: {
      "openai-codex": [{ id: "gpt-5.4" }, { id: "gpt-5.3-codex" }],
      "openai-codex-2": [{ id: "gpt-5.4" }, { id: "gpt-5.3-codex" }],
    },
    baseProviderLookup: (providerName) => providerName.replace(/-\d+$/, ""),
  });

  assert.equal(model?.id, "gpt-5.4");
}

function runFallbackModelCheck() {
  const model = resolveSwitchTargetModel({
    providerName: "openai-codex-2",
    preferredModelId: "gpt-5.4",
    hasAuth: () => true,
    providerModels: {
      "openai-codex": [{ id: "gpt-5.4" }, { id: "gpt-5.3-codex" }],
      "openai-codex-2": [{ id: "gpt-5.3-codex" }],
    },
    baseProviderLookup: (providerName) => providerName.replace(/-\d+$/, ""),
  });

  assert.equal(model?.id, "gpt-5.3-codex");
}

runAllowedProviderFilteringCheck();
runPreferredModelCheck();
runFallbackModelCheck();
console.log("subs switch checks passed");
