import assert from "node:assert/strict";
import { normalizeEntries, mergeConfigs, normalizeAllowedProviderNames, subProviderName } from "../extensions/multi-pass-core.mjs";

function normalizeQuotaAllowedProviderNames(projectConfig) {
  return normalizeAllowedProviderNames(projectConfig?.allowedSubs);
}

function collectQuotaProviderNames({ checkers, subscriptions, hasAuth, allowedProviderNames }) {
  const allSubs = normalizeEntries(mergeConfigs({ subscriptions }, []));
  const allowed = allowedProviderNames ? new Set(allowedProviderNames) : undefined;
  const seen = new Set();
  const providerNames = [];

  const push = (providerName) => {
    if (allowed && !allowed.has(providerName)) return;
    if (seen.has(providerName)) return;
    seen.add(providerName);
    providerNames.push(providerName);
  };

  for (const checker of checkers) {
    if (hasAuth(checker.baseProvider)) {
      push(checker.baseProvider);
    }
    for (const entry of allSubs) {
      if (entry.provider !== checker.baseProvider) continue;
      push(subProviderName(entry));
    }
  }

  return providerNames;
}

function runRestrictedExtraSubscriptionCheck() {
  const providerNames = collectQuotaProviderNames({
    checkers: [{ baseProvider: "openai-codex" }],
    subscriptions: [{ provider: "openai-codex", index: 2, label: "mw" }],
    hasAuth: (providerName) => providerName === "openai-codex" || providerName === "openai-codex-2",
    allowedProviderNames: normalizeQuotaAllowedProviderNames({ allowedSubs: ["openai-codex-2"] }),
  });

  assert.deepEqual(providerNames, ["openai-codex-2"]);
}

function runRestrictedBaseProviderCheck() {
  const providerNames = collectQuotaProviderNames({
    checkers: [{ baseProvider: "openai-codex" }],
    subscriptions: [{ provider: "openai-codex", index: 2 }],
    hasAuth: (providerName) => providerName === "openai-codex" || providerName === "openai-codex-2",
    allowedProviderNames: normalizeQuotaAllowedProviderNames({ allowedSubs: ["openai-codex"] }),
  });

  assert.deepEqual(providerNames, ["openai-codex"]);
}

function runUnrestrictedCheck() {
  const providerNames = collectQuotaProviderNames({
    checkers: [{ baseProvider: "openai-codex" }],
    subscriptions: [{ provider: "openai-codex", index: 2 }],
    hasAuth: (providerName) => providerName === "openai-codex" || providerName === "openai-codex-2",
    allowedProviderNames: undefined,
  });

  assert.deepEqual(providerNames, ["openai-codex", "openai-codex-2"]);
}

runRestrictedExtraSubscriptionCheck();
runRestrictedBaseProviderCheck();
runUnrestrictedCheck();
console.log("project-aware limits checks passed");
