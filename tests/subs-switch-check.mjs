import assert from "node:assert/strict";

function subProviderName(entry) {
  return `${entry.provider}-${entry.index}`;
}

function normalizeEntries(entries) {
  const byProvider = new Map();
  for (const entry of entries) {
    if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, []);
    byProvider.get(entry.provider).push(entry);
  }

  const normalized = [];
  for (const [provider, list] of byProvider.entries()) {
    const usedIndices = new Set(list.filter((e) => e.index > 0).map((e) => e.index));
    if (list.some((e) => e.index === 0)) {
      let nextIndex = 2;
      while (usedIndices.has(nextIndex)) nextIndex += 1;
      normalized.push({ provider, index: nextIndex });
      usedIndices.add(nextIndex);
    }
    for (const entry of list.filter((e) => e.index > 0).sort((a, b) => a.index - b.index)) {
      normalized.push(entry);
    }
  }
  return normalized;
}

function mergeConfigs(fileConfig, envEntries) {
  const merged = [...fileConfig.subscriptions];
  for (const envEntry of envEntries) {
    const existingCount = merged.filter((s) => s.provider === envEntry.provider).length;
    const envCountForProvider = envEntries.filter((e) => e.provider === envEntry.provider).length;
    if (existingCount < envCountForProvider) {
      const usedIndices = merged
        .filter((s) => s.provider === envEntry.provider)
        .map((s) => s.index);
      let nextIndex = 2;
      while (usedIndices.includes(nextIndex)) nextIndex += 1;
      merged.push({ provider: envEntry.provider, index: nextIndex });
    }
  }
  return merged;
}

function normalizeSwitchAllowedProviderNames(projectConfig) {
  if (!projectConfig?.allowedSubs || projectConfig.allowedSubs.length === 0) return undefined;
  const normalized = [...new Set(projectConfig.allowedSubs.map((value) => value.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
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

function computeNextCyclableProviderName({ providerNames, currentProvider, preferredModelId, canResolveModel }) {
  const currentIndex = currentProvider ? providerNames.findIndex((providerName) => providerName === currentProvider) : -1;

  for (let offset = 1; offset <= providerNames.length; offset += 1) {
    const providerName = providerNames[(Math.max(currentIndex, -1) + offset) % providerNames.length];
    if (!providerName || providerName === currentProvider) continue;
    if (!canResolveModel(providerName, preferredModelId)) continue;
    return providerName;
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

function runCycleNextProviderCheck() {
  const providerName = computeNextCyclableProviderName({
    providerNames: ["openai-codex", "openai-codex-2", "openai-codex-3"],
    currentProvider: "openai-codex-2",
    preferredModelId: "gpt-5.4",
    canResolveModel: (providerName) => providerName !== "openai-codex-3",
  });

  assert.equal(providerName, "openai-codex");
}

function runCycleFromUnknownProviderCheck() {
  const providerName = computeNextCyclableProviderName({
    providerNames: ["openai-codex", "openai-codex-2"],
    currentProvider: "anthropic",
    preferredModelId: "gpt-5.4",
    canResolveModel: () => true,
  });

  assert.equal(providerName, "openai-codex");
}

runAllowedProviderFilteringCheck();
runPreferredModelCheck();
runFallbackModelCheck();
runCycleNextProviderCheck();
runCycleFromUnknownProviderCheck();
console.log("subs switch checks passed");
