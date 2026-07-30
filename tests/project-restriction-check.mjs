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

function normalizeAllowedProviderNames(allowedSubs) {
  if (!allowedSubs || allowedSubs.length === 0) return undefined;
  const normalized = [...new Set(allowedSubs.map((value) => value.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function filterPoolsByAllowedProviders(pools, allowedProviderNames) {
  if (!allowedProviderNames || allowedProviderNames.length === 0) {
    return pools;
  }
  const allowed = new Set(allowedProviderNames);
  return pools
    .map((pool) => ({
      ...pool,
      members: pool.members.filter((member) => allowed.has(member)),
    }))
    .filter((pool) => pool.members.length > 0);
}

function filterChainsByAvailablePools(chains, pools) {
  const poolNames = new Set(pools.map((pool) => pool.name));
  return chains
    .map((chain) => ({
      ...chain,
      entries: chain.entries.filter((entry) => poolNames.has(entry.pool)),
    }))
    .filter((chain) => chain.entries.length > 0);
}

function buildEffectiveConfig(globalConfig, projectConfig, envEntries = []) {
  const mergedSubscriptions = normalizeEntries(mergeConfigs(globalConfig, envEntries));
  if (!projectConfig) {
    return {
      subscriptions: mergedSubscriptions,
      pools: globalConfig.pools,
      chains: globalConfig.chains,
      allowedProviderNames: undefined,
    };
  }

  const allowedProviderNames = normalizeAllowedProviderNames(projectConfig.allowedSubs);
  let subscriptions = mergedSubscriptions;
  if (allowedProviderNames) {
    const allowed = new Set(allowedProviderNames);
    subscriptions = mergedSubscriptions.filter((entry) => allowed.has(subProviderName(entry)));
  }

  let pools = projectConfig.pools !== undefined ? projectConfig.pools : globalConfig.pools;
  let chains = projectConfig.chains !== undefined ? projectConfig.chains : globalConfig.chains;
  if (allowedProviderNames) {
    pools = filterPoolsByAllowedProviders(pools, allowedProviderNames);
    chains = filterChainsByAvailablePools(chains, pools);
  }

  return { subscriptions, pools, chains, allowedProviderNames };
}

function runExactProviderRestrictionCheck() {
  const globalConfig = {
    subscriptions: [{ provider: "openai-codex", index: 2, label: "mw" }],
    pools: [
      {
        name: "codex-work",
        baseProvider: "openai-codex",
        members: ["openai-codex", "openai-codex-2"],
        enabled: true,
      },
      {
        name: "copilot-backup",
        baseProvider: "github-copilot",
        members: ["github-copilot"],
        enabled: true,
      },
    ],
    chains: [
      {
        name: "primary",
        enabled: true,
        entries: [
          { pool: "codex-work", model: "gpt-5", enabled: true },
          { pool: "copilot-backup", model: "gpt-5", enabled: true },
        ],
      },
    ],
  };

  const effective = buildEffectiveConfig(globalConfig, { allowedSubs: ["openai-codex-2"] });

  assert.deepEqual(effective.allowedProviderNames, ["openai-codex-2"]);
  assert.deepEqual(effective.subscriptions.map(subProviderName), ["openai-codex-2"]);
  assert.deepEqual(effective.pools, [
    {
      name: "codex-work",
      baseProvider: "openai-codex",
      members: ["openai-codex-2"],
      enabled: true,
    },
  ]);
  assert.deepEqual(effective.chains, [
    {
      name: "primary",
      enabled: true,
      entries: [{ pool: "codex-work", model: "gpt-5", enabled: true }],
    },
  ]);
}

function runBaseProviderAllowedCheck() {
  const globalConfig = {
    subscriptions: [{ provider: "openai-codex", index: 2 }],
    pools: [
      {
        name: "codex-base",
        baseProvider: "openai-codex",
        members: ["openai-codex"],
        enabled: true,
      },
    ],
    chains: [],
  };

  const effective = buildEffectiveConfig(globalConfig, { allowedSubs: ["openai-codex"] });
  assert.deepEqual(effective.allowedProviderNames, ["openai-codex"]);
  assert.deepEqual(effective.subscriptions.map(subProviderName), []);
  assert.deepEqual(effective.pools[0].members, ["openai-codex"]);
}

function runUnrestrictedEnvMergeCheck() {
  const globalConfig = {
    subscriptions: [],
    pools: [],
    chains: [],
  };
  const envEntries = [{ provider: "openai-codex", index: 0 }];

  const effective = buildEffectiveConfig(globalConfig, undefined, envEntries);
  assert.deepEqual(effective.subscriptions.map(subProviderName), ["openai-codex-2"]);
  assert.equal(effective.allowedProviderNames, undefined);
}


function runKiroRestrictionCheck() {
  const globalConfig = {
    subscriptions: [{ provider: "kiro", index: 2 }],
    pools: [{
      name: "kiro-pool",
      baseProvider: "kiro",
      members: ["kiro", "kiro-2"],
      enabled: true,
    }],
    chains: [],
  };
  const effective = buildEffectiveConfig(globalConfig, { allowedSubs: ["kiro-2"] });
  assert.deepEqual(effective.subscriptions.map(subProviderName), ["kiro-2"]);
  assert.deepEqual(effective.pools[0].members, ["kiro-2"]);
}

runExactProviderRestrictionCheck();
runBaseProviderAllowedCheck();
runUnrestrictedEnvMergeCheck();
runKiroRestrictionCheck();
console.log("project restriction checks passed");
