# Handoff: tier-preserving failover across chain hops

**Status: implemented 2026-09-02.** `resolveTierEquivalent` + the chain-hop mapping, guarded by
`tests/tier-mapping-check.mjs`, documented in the README under "Tiers". Live evidence, a
mid-tier session on an exhausted anthropic pool:

```
advancing to chain all#2; active openai-codex (gpt-5.5) [tier: mid]
```

and a flagship one on the same config landing on `gpt-5.6-sol [tier: flagship]`.

One correction to the plan below, found while building it: the table must be keyed by the
pool's **baseProvider**, not by the account. By the time a cascade reaches a chain hop it has
usually rotated within the pool, so `currentModel.provider` is `anthropic-2`, which no table
lists. Keying by account silently disabled every mapping; there is a planted-defect test for
exactly that.

The rest of the file is kept as written, because the reasoning still applies.

Written 2026-09-02 for an agent that will implement this in `~/MYNE/Projects/tools/pi-multi-pass`, branch `fix/pi-0.84-model-runtime`.

Read this whole file before changing anything. Every line number below was checked against the working tree on 2026-09-02; re-verify them before editing, the file is 5,886 lines and moves.

---

## Correction, 2026-09-02, added after the first version shipped

**The first version of this handoff got the priority wrong, and it is worth knowing why before you trust the rest of it.**

Joel's actual ask, in his words, was: *"if something does not work with the agents, it should fall back to the other accounts using the pool and the chain, no?"* Tier preservation was the **refinement** he added afterwards (*"it shouldn't change back to the default used by the pool... it should change to the same model but in the other account"*). The first version of this file promoted the refinement to the headline and left the primary ask - failover happening at all - as an unexamined aside: *"it did not roll to the codex entry... I have not investigated it."*

That aside was the bug. Investigated on 2026-09-02:

`PoolManager.handleError` (line ~2789) exits on its second line unless `isRateLimitError(errorMessage)` is true. Anthropic reports subscription exhaustion as **HTTP 400 `invalid_request_error`** with the body `You're out of extra usage. Ask your workspace admin to add more so you can keep going.` That string matches **none** of the eight original `RATE_LIMIT_PATTERNS` - no `limit`, no `quota`, no `429`. So `handleError` returned `false`, `buildFailoverPlan` was never called, and the pool and the chain were never consulted. Verified by evaluating the eight regexes against the verbatim provider string.

**Consequence for the work described below:** the chain hop was not "the hot path", it was **dead code for this error**. Tier mapping at the chain-hop site would have changed nothing observable, and the acceptance criteria in this file would have been satisfied by unit tests while Joel's real session kept dying exactly as before.

**Fixed** in the same change that added this correction: three patterns added to `RATE_LIMIT_PATTERNS` (`out of (extra )?usage`, `credit balance is too low`, `insufficient[_ ]credit`), with a comment at the definition saying the list means *"rotate to another account"* and not *"was this a 429"*. Guarded by `tests/error-classification-check.mjs`, which parses the array out of the source rather than copying it, asserts 9 real provider strings rotate and 5 real non-quota errors do not, and was confirmed to fail when the new pattern is deleted.

**The lesson for whoever writes the next handoff:** a precisely-located finding is not the same as the user's problem. The asymmetry at lines 2445/2516 was real, exact, and second in line. Order the work by what the user observed, not by what you found first.

---

## The one-sentence goal

When failover crosses from one pool to another, keep the **tier** of the model the user was actually using, instead of jumping to whatever single model the chain entry hardcodes.

---

## Why this matters, concretely

Joel's live config (`~/.pi/agent/multi-pass.json`):

```json
"pools": [
  { "name": "anthropic", "baseProvider": "anthropic",     "members": ["anthropic", "anthropic-2"] },
  { "name": "codex",     "baseProvider": "openai-codex",  "members": ["openai-codex"] }
],
"chains": [
  { "name": "all", "entries": [
      { "pool": "anthropic", "model": "claude-opus-5", "enabled": true },
      { "pool": "codex",     "model": "gpt-5.6-sol",   "enabled": true }
  ]}
]
```

A cheap recon agent runs on `openai-codex/gpt-5.4-mini`. Its pool is exhausted. Failover hops to the next chain entry and lands on... whatever `entry.model` says. A `gpt-5.4-mini` session gets upgraded to a flagship model, silently, and the cost of a "fast, cheap" step multiplies.

The same in reverse: a flagship `claude-opus-5` session can hop to a chain entry naming a cheap model and quietly lose capability mid-task.

**Neither is a crash. Both are silent.** The user sees the work continue and finds out from the bill or from a suddenly worse answer.

## Where it actually goes wrong

`extensions/multi-sub.ts`, class `PoolManager`, method `buildFailoverPlan(currentModel: Model<Api>, ...)` at **line 2402**.

The method builds two kinds of candidate, and they disagree with each other:

```ts
// ~line 2445 — SAME-POOL failover, another member of the same pool
candidates.push({
  poolName: pool.name,
  provider: candidate,
  modelId: currentModel.id,     // ← keeps the model the user was on. Correct.
  source: "pool",
});

// ~line 2516 — CHAIN HOP, crossing into a different pool
candidates.push({
  poolName: targetPool.name,
  provider: member,
  modelId: entry.model,         // ← discards it for the chain entry's hardcoded model.
  source: "chain",
});
```

Seventy lines apart, in one function. Same-pool rotation already does the right thing. Only the chain hop throws the model away, because a chain entry was designed as "pool + the model to use there" rather than "pool + how to translate into it".

That is the whole bug.

---

## What to build

### A tier table, and `entry.model` demoted to a fallback

Add an optional top-level `tiers` array to `MultiPassConfig` (interface at **line 1695**):

```json
"tiers": [
  { "name": "flagship", "models": { "anthropic": "claude-opus-5",    "openai-codex": "gpt-5.6-sol"  } },
  { "name": "mid",      "models": { "anthropic": "claude-sonnet-5",  "openai-codex": "gpt-5.4"      } },
  { "name": "cheap",    "models": { "anthropic": "claude-haiku-4-5", "openai-codex": "gpt-5.4-mini" } }
]
```

Resolution order at the chain-hop site:

1. Find the tier whose `models[currentModel.provider] === currentModel.id`.
2. If found, and that tier names a model for the candidate `member`'s provider, use it.
3. Otherwise fall back to `entry.model`, exactly as today.

Step 3 is what makes this **backwards compatible**: a config with no `tiers` key behaves exactly as it does now, and every existing test keeps passing. Do not make `tiers` required.

Keyed by **provider name**, not by pool name, because a pool can hold several providers (`anthropic` and `anthropic-2`) that share a model catalogue.

### Suggested shape

```ts
interface TierConfig {
  /** Tier name, user-defined. Cosmetic — used in log lines. */
  name: string;
  /** provider name → model id for that provider at this tier. */
  models: Record<string, string>;
}
```

A small pure resolver, exported for tests:

```ts
export function resolveTierEquivalent(
  tiers: TierConfig[] | undefined,
  fromProvider: string,
  fromModelId: string,
  toProvider: string,
): string | undefined
```

Then at the chain-hop candidate push:

```ts
const mapped = resolveTierEquivalent(config.tiers, currentModel.provider, currentModel.id, member);
candidates.push({
  poolName: targetPool.name,
  provider: member,
  modelId: mapped ?? entry.model,
  source: "chain",
  chainName: applicable.chain.name,
  chainIndex,
});
```

Keep it a pure function. It is the whole testable surface of this change.

### Tell the user which happened

The failover status lines are built by `formatFailoverTransition` (**line 4565**) and friends around **4532–4576**. A tier-mapped hop and a fallback hop must be distinguishable in the status line, because "why am I suddenly on a different model" is exactly the question this feature exists to answer. Something like `codex/gpt-5.4-mini (tier: cheap)` versus `codex/gpt-5.6-sol (chain default)`.

---

## Ambiguities to settle before coding — do not guess

1. **A model in no tier.** A user on `claude-fable-5` with no tier entry. Fall back to `entry.model` (proposed), or refuse to hop? Proposal: fall back, and say so in the status line.
2. **A tier with no model for the target provider.** `cheap` names anthropic and codex, target pool is a third provider. Fall back to `entry.model`.
3. **A model listed in two tiers.** Config error. Proposal: first match wins, and surface a warning at config load rather than silently picking.
4. **Interaction with `presets`** (`PresetConfig`, ~line 1636, `entries: PresetEntry[]`). Presets are a separate ordered route list. Decide explicitly whether tier mapping applies to preset traversal too, or only to chains. Proposal: chains only in this change; note it in the README.
5. **Does `--model` on the CLI pin the tier or the exact model?** Today it pins the exact model. Tier mapping should not override an explicitly requested model on the *first* attempt — only on failover. Verify that is what happens.

---

## Acceptance criteria

Observable, not "it looks right":

1. With the `tiers` table above and both anthropic members exhausted, a session on **`openai-codex/gpt-5.4-mini`** that fails over lands on the **cheap** anthropic model, not on `claude-opus-5`. Paste the failover status line.
2. Same table, a session on **`anthropic/claude-opus-5`** lands on **`gpt-5.6-sol`**. Paste the line.
3. A config with **no `tiers` key** produces byte-identical failover behaviour to `main`. Every existing test in `tests/` passes unchanged.
4. A model absent from every tier falls back to `entry.model` and the status line says so.
5. Same-pool rotation is untouched — it already preserves `currentModel.id` and must keep doing so.

## Tests

`tests/` holds plain `.mjs` checks run directly with `node` (there is **no** npm script — `package.json` has no `scripts` key). `tests/runtime-failover-check.mjs` is the closest existing harness; extend it or add `tests/tier-mapping-check.mjs` alongside.

Cover at minimum: mapped hop, unmapped model falls back, tier missing the target provider falls back, no-`tiers` config unchanged, and same-pool rotation still preserves the model.

**Plant a defect and confirm the test catches it.** Revert `modelId: mapped ?? entry.model` to `modelId: entry.model` and the mapped-hop test must fail. A test that has never failed proves nothing.

---

## The other half of Joel's intent, which lives in the subagents repo

This was filed as "out of scope, tracked separately" in the first version. Nothing tracked it. It is now tracked in `~/MYNE/Projects/tools/pi-interactive-subagents/docs/INTENT-subagent-failover.md`, and it is the half Joel asked for first.

**Sub-agents do not load multi-pass at all.** `pi-interactive-subagents` launches every restricted child with `--no-extensions` (`pi-extension/subagents/index.ts:922`) and then re-enables only the extensions backing that child's whitelisted *tools*. Multi-pass backs no tool, so nothing re-enables it — a sub-agent gets a bare `--model <provider>/<id>`, one account, no pool, no chain.

Verified 2026-09-02: a sub-agent pinned to `anthropic/claude-opus-5` died in 2s with `400 ... "You're out of extra usage"` and `exitCode: 1`, while the parent session on `chain:all` kept running.

That fix belongs in the subagents repo, not here. Note it because **tier-preserving failover buys sub-agents nothing until that lands** — but the two changes are independent and can be built in either order.

---

## Evidence behind this handoff

- `extensions/multi-sub.ts:2402` `buildFailoverPlan`, the two candidate pushes at ~2445 and ~2516.
- `MultiPassConfig` interface at line 1695; `ChainEntryConfig` at 1677; `PoolConfig` at 1655; `PresetConfig` at ~1636.
- Failover status formatting, lines 4532–4576.
- Joel's live `~/.pi/agent/multi-pass.json`: two pools, one chain `all`, entries `anthropic/claude-opus-5` then `codex/gpt-5.6-sol`, no `presets`.
- Observed on 2026-09-02: `anthropic` returns `400 invalid_request_error "You're out of extra usage"`; `anthropic-2` reports `not_ready`; `openai-codex` is the only live account. So the anthropic pool is exhausted on both members, which is what makes the chain hop the hot path rather than a rarity.

## What not to do

- Do not make `tiers` required, and do not rewrite existing configs. Absent key = today's behaviour.
- Do not move the tier lookup inside the member loop's skip classification — it is a pure mapping, keep it at the candidate push.
- Do not touch same-pool rotation. It is already correct.
- Do not infer tiers from model names by string matching (`*-mini`, `*-opus`). Naming is a vendor decision and it will break. The table is explicit on purpose.
