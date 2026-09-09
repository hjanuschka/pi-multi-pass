import assert from "node:assert/strict";

function getChainEntryIssue(entry, config, modelRegistry) {
  const pool = config.pools.find((candidate) => candidate.name === entry.pool);
  if (!pool) return `invalid pool: ${entry.pool} missing`;
  if (!pool.enabled) return `invalid pool: ${pool.name} disabled`;
  const selectableModels = [...(modelRegistry.get(pool.baseProvider) || [])];
  if (selectableModels.length === 0) {
    return `invalid model: no selectable models for ${pool.baseProvider}`;
  }
  if (!selectableModels.includes(entry.model)) {
    return `invalid model: ${entry.model} unavailable for ${pool.name}`;
  }
  return null;
}

function classifyPoolMemberSkip(poolName, provider, authStorage, exhausted) {
  if (!authStorage.hasAuth(provider)) {
    return {
      type: "pool-member",
      poolName,
      reason: "no-auth",
      detail: `${provider} skipped (no auth)`,
    };
  }
  if (exhausted) {
    return {
      type: "pool-member",
      poolName,
      reason: "exhausted",
      detail: `${provider} skipped (cooldown active)`,
    };
  }
  return null;
}

function classifyChainEntrySkip(chain, chainIndex, entry, config) {
  if (!entry.enabled) {
    return {
      type: "chain-entry",
      poolName: entry.pool,
      reason: "disabled-entry",
      detail: `${entry.pool} -> ${entry.model} skipped (entry disabled)`,
      chainName: chain.name,
      chainIndex,
    };
  }
  const issue = getChainEntryIssue(entry, config, createModelCatalog());
  if (!issue) return null;
  const reason = issue.includes("missing")
    ? "missing-pool"
    : issue.includes("disabled")
      ? "disabled-pool"
      : "unavailable-model";
  return {
    type: "chain-entry",
    poolName: entry.pool,
    reason,
    detail: `${entry.pool} -> ${entry.model} skipped (${issue})`,
    chainName: chain.name,
    chainIndex,
  };
}

function formatFailoverTarget(candidate) {
  return `${candidate.provider} (${candidate.modelId})`;
}

function formatFailoverStatus(candidate, fallbackPoolName) {
  if (!candidate) {
    return fallbackPoolName
      ? `pool:${fallbackPoolName} | cascade exhausted | no eligible target`
      : "cascade exhausted | no eligible target";
  }
  const scope = candidate.source === "chain"
    ? `chain:${candidate.chainName}#${(candidate.chainIndex ?? 0) + 1}`
    : `pool:${candidate.poolName}`;
  return `${scope} | active ${formatFailoverTarget(candidate)}`;
}

function formatFailoverContinuation(nextCandidate) {
  if (!nextCandidate) {
    return "cascade exhausted; no later eligible target";
  }
  const phase = nextCandidate.source === "chain"
    ? `continuing forward to chain ${nextCandidate.chainName}#${(nextCandidate.chainIndex ?? 0) + 1}`
    : `continuing within pool ${nextCandidate.poolName}`;
  return `${phase} -> ${formatFailoverTarget(nextCandidate)}`;
}

function formatFailoverTransition(poolName, currentProvider, nextCandidate) {
  const phase = nextCandidate.source === "chain"
    ? `advancing to chain ${nextCandidate.chainName}#${(nextCandidate.chainIndex ?? 0) + 1}`
    : `rotating within pool ${poolName}`;
  return `[pool:${poolName}] Rate limited on ${currentProvider}; ${phase}; active ${formatFailoverTarget(nextCandidate)}`;
}

function formatFailoverExhausted(poolName, currentProvider) {
  return `[pool:${poolName}] Failover exhausted after ${currentProvider}; no eligible target remained in this cascade.`;
}

const NON_RETRYABLE_PROVIDER_LIMIT_PATTERNS = [
  /usage.?limit/i,
  /limit.*reached/i,
  /quota/i,
  /out of budget/i,
  /billing/i,
  /GoUsageLimitError/i,
  /FreeUsageLimitError/i,
  /Monthly usage limit reached/i,
  /available balance/i,
  /insufficient_quota/i,
];

const PI_RETRYABLE_STATUSES = new Set([408, 409, 429]);

const RETRYABLE_PROVIDER_PATTERNS = [
  /overloaded/i,
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /\b524\b/,
  /service.?unavailable/i,
  /server.?error/i,
  /internal.?error/i,
  /provider.?returned.?error/i,
  /exceeded request buffer limit while retrying upstream/i,
  /network.?error/i,
  /connection.?error/i,
  /connection.?refused/i,
  /connection.?lost/i,
  /other side closed/i,
  /fetch failed/i,
  /socket hang up/i,
  /timed? out/i,
  /timeout/i,
  /terminated/i,
  /ResourceExhausted/i,
];

function piWillRetryTurn(errorMessage, retrySettings = { enabled: true }) {
  if (!retrySettings.enabled) return false;

  if (NON_RETRYABLE_PROVIDER_LIMIT_PATTERNS.some((p) => p.test(errorMessage))) {
    return false;
  }

  const leading = errorMessage.match(/^\s*(?:Error:\s*)?(\d{3})\b/);
  const field = errorMessage.match(/"status"\s*:\s*(\d{3})\b/);
  const status = leading ? Number(leading[1]) : field ? Number(field[1]) : undefined;
  if (status !== undefined && (status >= 500 || PI_RETRYABLE_STATUSES.has(status))) {
    return true;
  }
  return RETRYABLE_PROVIDER_PATTERNS.some((p) => p.test(errorMessage));
}

class RuntimeHarness {
  constructor(config, authenticatedProviders) {
    this.config = config;
    this.providerToPool = new Map();
    this.exhausted = new Set();
    this.authStorage = createAuthStorage(authenticatedProviders);
    this.modelCatalog = createModelCatalog();
    this.notifications = [];
    this.statuses = [];
    this.sentPrompts = [];
    this.sentPromptOptions = [];
    this.setModelCalls = [];
    this.cascadeState = null;
    this.suppressNextStartTurn = false;

    for (const pool of config.pools) {
      if (!pool.enabled) continue;
      for (const member of pool.members) this.providerToPool.set(member, pool.name);
    }
  }

  getPoolForProvider(provider) {
    const poolName = this.providerToPool.get(provider);
    return this.config.pools.find((pool) => pool.name === poolName);
  }

  isMemberExhausted(pool, provider) {
    return this.exhausted.has(`${pool.name}:${provider}`);
  }

  markExhausted(provider) {
    const pool = this.getPoolForProvider(provider);
    if (!pool) return;
    this.exhausted.add(`${pool.name}:${provider}`);
  }

  findApplicableChain(poolName) {
    for (const chain of this.config.chains.filter((candidate) => candidate.enabled)) {
      const index = chain.entries.findIndex((entry) => entry.pool === poolName);
      if (index >= 0) return { chain, index };
    }
    return undefined;
  }

  startTurn(prompt, currentModel) {
    if (this.suppressNextStartTurn) {
      this.suppressNextStartTurn = false;
      return;
    }
    if (!prompt) {
      this.cascadeState = null;
      return;
    }
    if (!this.cascadeState || this.cascadeState.prompt !== prompt) {
      this.cascadeState = {
        prompt,
        attemptedProviders: new Set(currentModel ? [currentModel.provider] : []),
        visitedChainIndexes: new Set(),
      };
      return;
    }
    if (currentModel) {
      this.cascadeState.attemptedProviders.add(currentModel.provider);
    }
  }

  ensureCascadeState(prompt, currentModel) {
    if (!prompt) {
      this.cascadeState = {
        prompt: "",
        attemptedProviders: new Set([currentModel.provider]),
        visitedChainIndexes: new Set(),
      };
      return this.cascadeState;
    }
    if (!this.cascadeState || this.cascadeState.prompt !== prompt) {
      this.cascadeState = {
        prompt,
        attemptedProviders: new Set([currentModel.provider]),
        visitedChainIndexes: new Set(),
      };
    } else {
      this.cascadeState.attemptedProviders.add(currentModel.provider);
    }
    return this.cascadeState;
  }

  buildFailoverPlan(currentModel) {
    const attemptedProviders = this.cascadeState?.attemptedProviders || new Set();
    const visitedChainIndexes = this.cascadeState?.visitedChainIndexes || new Set();
    const pool = this.getPoolForProvider(currentModel.provider);
    if (!pool) return { candidates: [], skips: [] };

    const skips = [];
    const candidates = [];
    const currentIndex = pool.members.indexOf(currentModel.provider);
    const startIndex = currentIndex >= 0 ? currentIndex : 0;

    for (let step = 1; step <= pool.members.length; step += 1) {
      const candidateIndex = (startIndex + step) % pool.members.length;
      const candidate = pool.members[candidateIndex];
      if (candidate === currentModel.provider) continue;
      if (attemptedProviders.has(candidate)) {
        skips.push({
          type: "pool-member",
          poolName: pool.name,
          reason: "already-attempted",
          detail: `${candidate} skipped (already attempted this turn)`,
        });
        continue;
      }
      const skip = classifyPoolMemberSkip(
        pool.name,
        candidate,
        this.authStorage,
        this.isMemberExhausted(pool, candidate),
      );
      if (skip) {
        skips.push(skip);
        continue;
      }
      candidates.push({
        poolName: pool.name,
        provider: candidate,
        modelId: currentModel.id,
        source: "pool",
      });
    }

    const applicable = this.findApplicableChain(pool.name);
    if (!applicable) return { pool, candidates, skips };

    for (let chainIndex = applicable.index + 1; chainIndex < applicable.chain.entries.length; chainIndex += 1) {
      const entry = applicable.chain.entries[chainIndex];
      if (visitedChainIndexes.has(chainIndex)) {
        skips.push({
          type: "chain-entry",
          poolName: entry.pool,
          reason: "already-visited-chain-entry",
          detail: `${entry.pool} -> ${entry.model} skipped (chain entry already visited this turn)`,
          chainName: applicable.chain.name,
          chainIndex,
        });
        continue;
      }
      const entrySkip = classifyChainEntrySkip(applicable.chain, chainIndex, entry, this.config);
      if (entrySkip) {
        skips.push(entrySkip);
        continue;
      }
      const targetPool = this.config.pools.find((candidate) => candidate.name === entry.pool);
      if (!targetPool) continue;

      let foundEligible = false;
      for (const member of targetPool.members) {
        if (attemptedProviders.has(member)) {
          skips.push({
            type: "pool-member",
            poolName: targetPool.name,
            reason: "already-attempted",
            detail: `${member} skipped (already attempted this turn)`,
            chainName: applicable.chain.name,
            chainIndex,
          });
          continue;
        }
        const memberSkip = classifyPoolMemberSkip(
          targetPool.name,
          member,
          this.authStorage,
          this.isMemberExhausted(targetPool, member),
        );
        if (memberSkip) {
          skips.push({ ...memberSkip, chainName: applicable.chain.name, chainIndex });
          continue;
        }
        foundEligible = true;
        candidates.push({
          poolName: targetPool.name,
          provider: member,
          modelId: entry.model,
          source: "chain",
          chainName: applicable.chain.name,
          chainIndex,
        });
      }
      if (!foundEligible) {
        skips.push({
          type: "chain-entry",
          poolName: targetPool.name,
          reason: "no-eligible-members",
          detail: `${targetPool.name} -> ${entry.model} skipped (no eligible members)`,
          chainName: applicable.chain.name,
          chainIndex,
        });
      }
    }

    return {
      pool,
      chain: applicable.chain,
      currentChainIndex: applicable.index,
      candidates,
      skips,
    };
  }

  findModel(provider, modelId) {
    const baseProvider = provider.replace(/-\d+$/, "");
    const models = this.modelCatalog.get(baseProvider) || [];
    return models.includes(modelId) ? { provider, id: modelId } : undefined;
  }

  async setModel(model) {
    this.setModelCalls.push(`${model.provider}:${model.id}`);
    this.currentModel = model;
    return this.authStorage.hasAuth(model.provider);
  }

  notify(message, level) {
    this.notifications.push({ message, level });
  }

  setStatus(_key, value) {
    this.statuses.push(value);
  }

  sendUserMessage(prompt, options) {
    this.sentPrompts.push(prompt);
    this.sentPromptOptions.push(options);
  }

  async handleError(errorMessage, currentModel, prompt) {
    if (!currentModel) return false;
    if (!/limit|429|too many requests|quota/i.test(errorMessage)) return false;

    const pool = this.getPoolForProvider(currentModel.provider);
    if (!pool) return false;

    const cascade = this.ensureCascadeState(prompt, currentModel);
    this.markExhausted(currentModel.provider);
    const plan = this.buildFailoverPlan(currentModel);

    const continuation = formatFailoverContinuation(plan.candidates[0]);
    for (const skip of plan.skips) {
      this.notify(`[pool:${skip.poolName}] ${skip.detail}; ${continuation}`, "warning");
    }

    const nextCandidate = plan.candidates[0];
    if (!nextCandidate) {
      this.notify(formatFailoverExhausted(pool.name, currentModel.provider), "warning");
      this.setStatus("multi-pass", formatFailoverStatus(null, pool.name));
      return false;
    }

    const nextModel = this.findModel(nextCandidate.provider, nextCandidate.modelId);
    if (!nextModel) {
      this.notify(
        `[pool:${nextCandidate.poolName}] ${nextCandidate.provider} -> ${nextCandidate.modelId} skipped (model missing at runtime); cascade exhausted; no later eligible target`,
        "warning",
      );
      this.notify(formatFailoverExhausted(pool.name, currentModel.provider), "warning");
      this.setStatus("multi-pass", formatFailoverStatus(null, pool.name));
      return false;
    }

    const success = await this.setModel(nextModel);
    if (!success) {
      this.notify(
        `[pool:${nextCandidate.poolName}] ${nextCandidate.provider} skipped (authentication unavailable during switch); cascade exhausted; no later eligible target`,
        "warning",
      );
      this.notify(formatFailoverExhausted(pool.name, currentModel.provider), "warning");
      this.setStatus("multi-pass", formatFailoverStatus(null, pool.name));
      return false;
    }

    cascade.attemptedProviders.add(nextCandidate.provider);
    if (typeof nextCandidate.chainIndex === "number") {
      cascade.visitedChainIndexes.add(nextCandidate.chainIndex);
    }

    this.notify(formatFailoverTransition(pool.name, currentModel.provider, nextCandidate), "info");
    this.setStatus("multi-pass", formatFailoverStatus(nextCandidate));
    const promptToReplay = prompt?.trim() ? prompt : "continue";
    if (!piWillRetryTurn(errorMessage)) {
      this.suppressNextStartTurn = true;
      this.sendUserMessage(promptToReplay, { deliverAs: "followUp" });
    }
    return true;
  }

  snapshot() {
    return {
      attemptedProviders: [...(this.cascadeState?.attemptedProviders || [])],
      visitedChainIndexes: [...(this.cascadeState?.visitedChainIndexes || [])],
      setModelCalls: [...this.setModelCalls],
      sentPrompts: [...this.sentPrompts],
      sentPromptOptions: [...this.sentPromptOptions],
      notifications: [...this.notifications],
      statuses: [...this.statuses],
    };
  }
}

function createAuthStorage(authenticatedProviders) {
  const authed = new Set(authenticatedProviders);
  return {
    hasAuth(provider) {
      return authed.has(provider);
    },
  };
}

function createModelCatalog() {
  return new Map([
    ["anthropic", ["claude-sonnet-4", "claude-opus-4.1"]],
    ["openai-codex", ["gpt-5", "gpt-5-mini"]],
    ["google-gemini-cli", ["gemini-2.5-pro"]],
    ["google-antigravity", []],
  ]);
}

function createConfig() {
  return {
    pools: [
      {
        name: "primary",
        baseProvider: "anthropic",
        members: ["anthropic", "anthropic-2", "anthropic-3"],
        enabled: true,
      },
      {
        name: "backup",
        baseProvider: "openai-codex",
        members: ["openai-codex", "openai-codex-2"],
        enabled: true,
      },
      {
        name: "solo",
        baseProvider: "google-gemini-cli",
        members: ["google-gemini-cli"],
        enabled: true,
      },
      {
        name: "disabled-pool",
        baseProvider: "anthropic",
        members: ["anthropic-9"],
        enabled: false,
      },
    ],
    chains: [
      {
        name: "ordered-fallback",
        enabled: true,
        entries: [
          { pool: "primary", model: "claude-sonnet-4", enabled: true },
          { pool: "backup", model: "gpt-5-mini", enabled: true },
          { pool: "solo", model: "gemini-2.5-pro", enabled: true },
        ],
      },
    ],
  };
}

function runCoreChecks() {
  const config = createConfig();
  const harness = new RuntimeHarness(config, [
    "anthropic",
    "anthropic-2",
    "anthropic-3",
    "openai-codex",
    "openai-codex-2",
    "google-gemini-cli",
  ]);

  harness.startTurn("draft release notes", { provider: "anthropic", id: "claude-sonnet-4" });
  harness.markExhausted("anthropic");
  const plan = harness.buildFailoverPlan({ provider: "anthropic", id: "claude-sonnet-4" });

  assert.equal(plan.pool.name, "primary");
  assert.equal(plan.chain.name, "ordered-fallback");
  assert.equal(plan.currentChainIndex, 0);
  assert.deepEqual(
    plan.candidates.map((candidate) => `${candidate.source}:${candidate.poolName}:${candidate.provider}:${candidate.modelId}`),
    [
      "pool:primary:anthropic-2:claude-sonnet-4",
      "pool:primary:anthropic-3:claude-sonnet-4",
      "chain:backup:openai-codex:gpt-5-mini",
      "chain:backup:openai-codex-2:gpt-5-mini",
      "chain:solo:google-gemini-cli:gemini-2.5-pro",
    ],
  );
}

async function runPoolOnlyChecks() {
  const config = createConfig();
  config.chains = [];
  const harness = new RuntimeHarness(config, ["anthropic", "anthropic-2", "anthropic-3"]);
  const prompt = "summarize incident";

  harness.startTurn(prompt, { provider: "anthropic", id: "claude-sonnet-4" });
  const rotated = await harness.handleError("429 rate limit", { provider: "anthropic", id: "claude-sonnet-4" }, prompt);
  assert.equal(rotated, true);

  const snapshot = harness.snapshot();
  assert.deepEqual(snapshot.setModelCalls, ["anthropic-2:claude-sonnet-4"]);
  assert.deepEqual(snapshot.sentPrompts, []);
  assert.equal(snapshot.statuses.at(-1), "pool:primary | active anthropic-2 (claude-sonnet-4)");
  assert.equal(
    snapshot.notifications.at(-1).message,
    "[pool:primary] Rate limited on anthropic; rotating within pool primary; active anthropic-2 (claude-sonnet-4)",
  );
  assert.equal(snapshot.attemptedProviders.includes("anthropic"), true);
  assert.equal(snapshot.attemptedProviders.includes("anthropic-2"), true);
  assert.equal(snapshot.visitedChainIndexes.length, 0);

  console.log("pool-only checks passed");
}

async function runNoLoopChecks() {
  const config = createConfig();
  const harness = new RuntimeHarness(config, [
    "anthropic",
    "anthropic-2",
    "anthropic-3",
    "openai-codex",
    "openai-codex-2",
    "google-gemini-cli",
  ]);
  const prompt = "write migration guide";

  harness.startTurn(prompt, { provider: "anthropic", id: "claude-sonnet-4" });
  const first = await harness.handleError("429 rate limit", { provider: "anthropic", id: "claude-sonnet-4" }, prompt);
  assert.equal(first, true);

  harness.startTurn(prompt, { provider: "anthropic-2", id: "claude-sonnet-4" });
  const second = await harness.handleError("429 rate limit", { provider: "anthropic-2", id: "claude-sonnet-4" }, prompt);
  assert.equal(second, true);

  harness.startTurn(prompt, { provider: "anthropic-3", id: "claude-sonnet-4" });
  const third = await harness.handleError("429 rate limit", { provider: "anthropic-3", id: "claude-sonnet-4" }, prompt);
  assert.equal(third, true);

  harness.startTurn(prompt, { provider: "openai-codex", id: "gpt-5-mini" });
  const fourth = await harness.handleError("429 rate limit", { provider: "openai-codex", id: "gpt-5-mini" }, prompt);
  assert.equal(fourth, true);

  harness.startTurn(prompt, { provider: "openai-codex-2", id: "gpt-5-mini" });
  const fifth = await harness.handleError("429 rate limit", { provider: "openai-codex-2", id: "gpt-5-mini" }, prompt);
  assert.equal(fifth, true);

  harness.startTurn(prompt, { provider: "google-gemini-cli", id: "gemini-2.5-pro" });
  const exhausted = await harness.handleError("429 rate limit", { provider: "google-gemini-cli", id: "gemini-2.5-pro" }, prompt);
  assert.equal(exhausted, false);

  const snapshot = harness.snapshot();
  assert.deepEqual(snapshot.setModelCalls, [
    "anthropic-2:claude-sonnet-4",
    "anthropic-3:claude-sonnet-4",
    "openai-codex:gpt-5-mini",
    "openai-codex-2:gpt-5-mini",
    "google-gemini-cli:gemini-2.5-pro",
  ]);
  assert.deepEqual(snapshot.visitedChainIndexes, [1, 2]);
  assert.deepEqual(snapshot.sentPrompts, []);

  const warningMessages = snapshot.notifications
    .filter((entry) => entry.level === "warning")
    .map((entry) => entry.message);
  assert.equal(
    warningMessages.some((message) => message.includes("anthropic skipped (already attempted this turn)")),
    true,
  );
  assert.equal(
    warningMessages.some((message) => message.includes("openai-codex skipped (already attempted this turn)")),
    true,
  );
  assert.equal(snapshot.statuses.at(-2), "chain:ordered-fallback#3 | active google-gemini-cli (gemini-2.5-pro)");
  assert.equal(snapshot.statuses.at(-1), "pool:solo | cascade exhausted | no eligible target");
  assert.equal(
    snapshot.notifications.find((entry) => entry.level === "info" && entry.message.includes("ordered-fallback#3")).message,
    "[pool:backup] Rate limited on openai-codex-2; advancing to chain ordered-fallback#3; active google-gemini-cli (gemini-2.5-pro)",
  );

  console.log("no-loop checks passed");
}

async function runFailurePathChecks() {
  const config = createConfig();
  config.chains[0].entries = [
    { pool: "primary", model: "claude-sonnet-4", enabled: true },
    { pool: "disabled-pool", model: "claude-sonnet-4", enabled: true },
    { pool: "missing-pool", model: "claude-sonnet-4", enabled: true },
    { pool: "backup", model: "claude-ghost", enabled: false },
    { pool: "solo", model: "gemini-2.5-pro", enabled: true },
  ];
  const runtimeHarness = new RuntimeHarness(config, ["anthropic", "google-gemini-cli"]);

  runtimeHarness.startTurn("debug retries", { provider: "anthropic", id: "claude-sonnet-4" });
  runtimeHarness.markExhausted("google-gemini-cli");
  const rotated = await runtimeHarness.handleError("429 rate limit", { provider: "anthropic", id: "claude-sonnet-4" }, "debug retries");
  assert.equal(rotated, false);

  const snapshot = runtimeHarness.snapshot();
  const warningMessages = snapshot.notifications
    .filter((entry) => entry.level === "warning")
    .map((entry) => entry.message);

  assert.deepEqual(
    warningMessages,
    [
      "[pool:primary] anthropic-2 skipped (no auth); cascade exhausted; no later eligible target",
      "[pool:primary] anthropic-3 skipped (no auth); cascade exhausted; no later eligible target",
      "[pool:disabled-pool] disabled-pool -> claude-sonnet-4 skipped (invalid pool: disabled-pool disabled); cascade exhausted; no later eligible target",
      "[pool:missing-pool] missing-pool -> claude-sonnet-4 skipped (invalid pool: missing-pool missing); cascade exhausted; no later eligible target",
      "[pool:backup] backup -> claude-ghost skipped (entry disabled); cascade exhausted; no later eligible target",
      "[pool:solo] google-gemini-cli skipped (cooldown active); cascade exhausted; no later eligible target",
      "[pool:solo] solo -> gemini-2.5-pro skipped (no eligible members); cascade exhausted; no later eligible target",
      "[pool:primary] Failover exhausted after anthropic; no eligible target remained in this cascade.",
    ],
  );
  assert.deepEqual(snapshot.statuses.at(-1), "pool:primary | cascade exhausted | no eligible target");
  assert.deepEqual(snapshot.setModelCalls, []);
  assert.deepEqual(snapshot.sentPrompts, []);

  const plannerHarness = new RuntimeHarness(config, ["anthropic", "google-gemini-cli"]);
  plannerHarness.startTurn("debug retries", { provider: "anthropic", id: "claude-sonnet-4" });
  plannerHarness.markExhausted("anthropic");
  plannerHarness.markExhausted("google-gemini-cli");
  const plan = plannerHarness.buildFailoverPlan({ provider: "anthropic", id: "claude-sonnet-4" });
  assert.deepEqual(
    plan.skips.map((skip) => `${skip.reason}:${skip.detail}`),
    [
      "no-auth:anthropic-2 skipped (no auth)",
      "no-auth:anthropic-3 skipped (no auth)",
      "disabled-pool:disabled-pool -> claude-sonnet-4 skipped (invalid pool: disabled-pool disabled)",
      "missing-pool:missing-pool -> claude-sonnet-4 skipped (invalid pool: missing-pool missing)",
      "disabled-entry:backup -> claude-ghost skipped (entry disabled)",
      "exhausted:google-gemini-cli skipped (cooldown active)",
      "no-eligible-members:solo -> gemini-2.5-pro skipped (no eligible members)",
    ],
  );
  assert.deepEqual(plan.candidates, []);

  console.log("failure-path checks passed");
}

function renderSessionStatus(config) {
  const enabledChains = config.chains.filter((chain) => chain.enabled);
  const activeChain = enabledChains[0];
  if (activeChain) {
    const firstEnabledEntry = activeChain.entries.find((entry) => entry.enabled);
    if (firstEnabledEntry) {
      return `chain:${activeChain.name} | starts ${firstEnabledEntry.pool} -> ${firstEnabledEntry.model}`;
    }
  }

  return null;
}

function runSessionStatusChecks() {
  const config = createConfig();
  assert.equal(
    renderSessionStatus(config),
    "chain:ordered-fallback | starts primary -> claude-sonnet-4",
  );

  config.chains[0].enabled = false;
  assert.equal(renderSessionStatus(config), null);

  config.chains[0].enabled = true;
  config.chains[0].entries[0].enabled = false;
  assert.equal(
    renderSessionStatus(config),
    "chain:ordered-fallback | starts backup -> gpt-5-mini",
  );

  config.chains[0].entries.forEach((entry) => {
    entry.enabled = false;
  });
  assert.equal(renderSessionStatus(config), null);

  console.log("session-status checks passed");
}

async function runReplayDeliveryChecks() {
  const config = createConfig();
  const harness = new RuntimeHarness(config, ["anthropic", "anthropic-2"]);
  const prompt = "finish the migration";

  harness.startTurn(prompt, { provider: "anthropic", id: "claude-sonnet-4" });
  const rotated = await harness.handleError(
    '400 {"error":{"message":"usage limit reached"}}',
    { provider: "anthropic", id: "claude-sonnet-4" },
    prompt,
  );

  assert.equal(rotated, true);
  const snapshot = harness.snapshot();
  assert.deepEqual(snapshot.sentPrompts, [prompt]);
  assert.deepEqual(snapshot.sentPromptOptions, [{ deliverAs: "followUp" }]);

  // Test Codex usage limit without HTTP status code
  const harnessCodex = new RuntimeHarness(config, ["openai-codex", "openai-codex-2"]);
  harnessCodex.startTurn(prompt, { provider: "openai-codex", id: "gpt-5-mini" });
  const rotatedCodex = await harnessCodex.handleError(
    "Codex error: The usage limit has been reached",
    { provider: "openai-codex", id: "gpt-5-mini" },
    prompt,
  );
  assert.equal(rotatedCodex, true);
  assert.deepEqual(harnessCodex.snapshot().sentPrompts, [prompt]);
  assert.deepEqual(harnessCodex.snapshot().sentPromptOptions, [{ deliverAs: "followUp" }]);

  // Test Antigravity quota reset message without HTTP status code
  const harnessQuota = new RuntimeHarness(config, ["openai-codex", "openai-codex-2"]);
  harnessQuota.startTurn(prompt, { provider: "openai-codex", id: "gpt-5-mini" });
  const rotatedQuota = await harnessQuota.handleError(
    "Quota reached. Please wait 4h 12m for reset. Next: switch models or try again after reset.",
    { provider: "openai-codex", id: "gpt-5-mini" },
    prompt,
  );
  assert.equal(rotatedQuota, true);
  assert.deepEqual(harnessQuota.snapshot().sentPrompts, [prompt]);

  // Test 429 quota error (which Pi classifies as non-retryable)
  const harness429Quota = new RuntimeHarness(config, ["openai-codex", "openai-codex-2"]);
  harness429Quota.startTurn(prompt, { provider: "openai-codex", id: "gpt-5-mini" });
  const rotated429 = await harness429Quota.handleError(
    "429 You exceeded your current quota, please check your plan and billing details.",
    { provider: "openai-codex", id: "gpt-5-mini" },
    prompt,
  );
  assert.equal(rotated429, true);
  assert.deepEqual(harness429Quota.snapshot().sentPrompts, [prompt]);

  // Test null prompt falls back to "continue"
  const harnessNull = new RuntimeHarness(config, ["openai-codex", "openai-codex-2"]);
  harnessNull.startTurn(null, { provider: "openai-codex", id: "gpt-5-mini" });
  const rotatedNull = await harnessNull.handleError(
    "Codex error: The usage limit has been reached",
    { provider: "openai-codex", id: "gpt-5-mini" },
    null,
  );
  assert.equal(rotatedNull, true);
  assert.deepEqual(harnessNull.snapshot().sentPrompts, ["continue"]);

  console.log("replay-delivery checks passed");
}

async function runRetryStartTurnChecks() {
  const config = createConfig();
  const harness = new RuntimeHarness(config, [
    "anthropic",
    "anthropic-2",
    "anthropic-3",
    "openai-codex",
    "openai-codex-2",
    "google-gemini-cli",
  ]);
  const prompt = "what model are you?";

  harness.startTurn(prompt, { provider: "anthropic", id: "claude-sonnet-4" });
  const first = await harness.handleError("429 rate limit", { provider: "anthropic", id: "claude-sonnet-4" }, prompt);
  assert.equal(first, true);

  harness.startTurn(prompt, { provider: "anthropic-2", id: "claude-sonnet-4" });
  const second = await harness.handleError("429 rate limit", { provider: "anthropic-2", id: "claude-sonnet-4" }, prompt);
  assert.equal(second, true);

  const snapshot = harness.snapshot();
  assert.deepEqual(snapshot.setModelCalls, [
    "anthropic-2:claude-sonnet-4",
    "anthropic-3:claude-sonnet-4",
  ]);
  assert.equal(
    snapshot.notifications.some(
      (entry) => entry.level === "warning" && entry.message.includes("openai-codex skipped (already attempted this turn)"),
    ),
    false,
  );

  console.log("retry-start-turn checks passed");
}

runCoreChecks();
runSessionStatusChecks();
await runReplayDeliveryChecks();

if (process.argv.includes("--retry-start-turn")) {
  await runRetryStartTurnChecks();
}

if (process.argv.includes("--pool-only")) {
  await runPoolOnlyChecks();
}

if (process.argv.includes("--no-loop")) {
  await runNoLoopChecks();
}

if (process.argv.includes("--failure-path")) {
  runFailurePathChecks();
}

console.log("runtime failover checks passed");
