import assert from "node:assert/strict";
import { normalizeEntries, mergeConfigs, normalizeAllowedProviderNames, filterPoolsByAllowedProviders, filterChainsByAvailablePools, subProviderName } from "../extensions/multi-pass-core.mjs";

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

runExactProviderRestrictionCheck();
runBaseProviderAllowedCheck();
runUnrestrictedEnvMergeCheck();
console.log("project restriction checks passed");
