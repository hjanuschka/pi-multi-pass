<p align="center">
  <img src="docs/header-v2.svg" alt="pi-multi-pass" width="800"/>
</p>

<p align="center">
  <em>leeloo dallas. multi-pass.</em>
</p>

<p align="center">
  Multi-subscription extension for <a href="https://github.com/earendil-works/pi">pi</a> -- use multiple OAuth
  accounts per provider with automatic rate-limit rotation and project-level affinity.
</p>

---

## Install

```bash
pi install npm:pi-multi-pass
```

Or via git:

```bash
pi install git:github.com/hjanuschka/pi-multi-pass
```

## Features

- **Multiple subscriptions**: Add extra OAuth accounts for any provider
- **Rotation pools**: Group subscriptions and auto-rotate on rate limits
- **Smart pool strategies**: `round-robin`, `quota-first`, `scheduled` (time windows), `custom` (JS script hook)
- **Fallback chains**: Define ordered cross-pool/model failover via `/pool chain`
- **Opt-in routing trace**: Record recent selection, skip, and failover decisions only when requested
- **Model presets**: Named routing shortcuts across providers (`/mp-preset coding-premium`)
- **Built-in limits checks**: Inspect subscription headroom across accounts with `/subs limits` (Anthropic, Codex, Google)
- **Experimental offline OAuth sharing**: Copy one selected account using QR frames or a single copy/paste export string (no network required)
- **Opt-in token keeper**: One OAuth refresh per machine instead of one per pi process, so parallel sessions cannot burn each other's rotating refresh tokens (`/subs keeper`)
- **Smarter retries**: Preserve failover progress across internal replay retries
- **Project affinity**: Restrict which subs/pools/chains are used per project
- **TUI management**: `/subs`, `/pool`, and `/mp-preset` commands -- no config files needed
- **Labels**: Tag subscriptions (e.g. "work", "personal")
- **Live model catalogs**: Subscription providers mirror the base provider's
  merged model catalog (static builtin + pi.dev remote overlay from
  `models-store.json`) on every model refresh, so newly catalogued models
  (e.g. `gpt-6-astra` for Codex) reach extra accounts without a
  pi-multi-pass release

For MiniMax, `/subs model`, new pool-chain entries, and new preset entries prefer
`MiniMax-M3.1-Flash`, then `MiniMax-M3`, when supplied by the host catalog. Older
catalog text models stay registered for saved chains, presets, explicit switches,
and the current selection. Explicit `models.json` model/provider overrides and
other extensions' model registrations remain available. If the host cannot expose
registration provenance, choices are kept rather than hiding potentially custom
models. This does not change pi's native `/model` picker or add model metadata to
an older host catalog; a host with only M3 offers M3.

## Quick start

```
/subs add              Pick a provider, add a subscription
/login                 Authenticate the new subscription
/subs switch           Manually switch to another subscription/provider
/subs limits           Check built-in quota support (Anthropic + Codex + Google)
/pool create           Group subs into a rotation pool (with strategy selection)
/pool chain create     Build an ordered fallback chain across pools
/pool trace start      Start recording routing decisions for this session
/mp-preset create         Create a named routing preset across providers
/mp-preset coding-premium Activate a preset by name
```

When one account hits a rate limit during an assistant turn, multi-pass automatically switches to the next eligible target and retries.

## Commands

### `/subs` -- Subscription management

```
/subs              Open menu
/subs add          Add a new subscription
/subs remove       Remove a subscription
/subs login        Login or re-authenticate a subscription
/subs logout       Logout from a subscription
/subs switch       Manually switch to a subscription/provider now
/subs list         List subscriptions with auth status; select one for quick actions
/subs status       Detailed status (token expiry, pool membership)
/subs limits       Check built-in quota/usage support (Anthropic + Codex + Google)
/subs share        Show offline QR frames or a full copyable export string (experimental)
/subs receive      Paste the full string or frame URIs into another pi
/subs keeper       Toggle the shared OAuth token keeper (off by default)
```

### `/subs keeper` -- shared OAuth token keeper (opt-in)

Anthropic and OpenAI rotate the refresh token on every refresh and reject the
previous one (`refresh_token_reused`, `invalid_grant`). A rotation that never
reaches `auth.json` therefore costs the login. With many pi processes sharing
one `auth.json`, pi's per-process refresh loses that race often enough to
matter: its refresh deadline (15s) or its credential lock (30s stale) can
expire after the provider has already rotated.

Enabled with `/subs keeper` (or `"tokenKeeper": true` in
`~/.pi/agent/multi-pass.json`), multi-pass takes over refreshes:

- renews tokens 15 minutes before expiry, ahead of pi's own 5-minute window
- holds the same `auth.json` lock pi uses, re-reads inside it, and skips the
  network when another process already stored a usable token
- writes the rotated credential in that same locked transaction, so a slow
  provider or a cancelled request cannot drop it
- covers built-in logins (`anthropic`, `openai-codex`, ...) as well as extra
  subscriptions

Off by default: it changes who refreshes your credentials, so enable it only
if you actually run several pi sessions at once.

### `/pool` -- Rotation pool and chain management

```
/pool              Open menu
/pool create       Create a pool (pick provider, select members)
/pool list         Show pools; select one for quick actions
/pool chain        Open chain manager
/pool toggle       Enable/disable a pool
/pool remove       Delete a pool (keeps subscriptions; prunes linked chain entries)
/pool status       Member health (logged in, rate limited, cooling down)
/pool trace        Manage the opt-in routing decision trace
/pool project      Project-level config (restrict subs, override pools/chains)
```

### `/pool trace` -- Opt-in routing decisions

Tracing is disabled by default and stores nothing until explicitly started. Entries
are kept only in memory for the current pi session, with the newest 100 retained.
Prompt contents are not recorded.

```
/pool trace start   Clear old entries and begin recording
/pool trace show    Inspect selections, skipped candidates, and failovers
/pool trace status  Show whether recording is active
/pool trace stop    Stop recording while retaining captured entries
/pool trace clear   Delete captured entries
```

### `/pool chain` -- Ordered fallback chain management

```
/pool chain             Open chain manager
/pool chain create      Create a chain
/pool chain list        Show all chains
/pool chain toggle      Enable/disable a chain
/pool chain remove      Delete a chain
/pool chain status      Inspect chain entries and validity
```

### `/mp-preset` -- Model presets (named routing)

```
/mp-preset                 Open menu
/mp-preset activate        Switch to a preset's best available entry
/mp-preset <name>          Activate a preset by name directly
/mp-preset create          Create a new preset
/mp-preset list            Show all presets
/mp-preset toggle          Enable/disable a preset
/mp-preset remove          Delete a preset
```

## Project-level configuration

Use `/pool project` to configure per-project subscription affinity. This creates `.pi/multi-pass.json` in your project directory.

When `allowedSubs` is set, multi-pass now treats it as an exact allow-list for this project: active routing, pool membership, and chain traversal are all constrained to those provider names.

### Use case: separate work and personal accounts

```
# Global: you have 3 Codex accounts
/subs add   -> openai-codex-2 (label: work)
/subs add   -> openai-codex-3 (label: personal)

# Corp project: restrict to team accounts only
cd ~/work/corp-project
/pool project -> restrict -> select openai-codex-2 only

# Side project: allow everything (no restriction)
cd ~/side-project
# No .pi/multi-pass.json needed -- uses all global subs
```

### What project config can do

| Feature | Description |
|---|---|
| **Restrict subs** | Only allow specific provider names in this project (for example `openai-codex-2` or `openai-codex`) |
| **Override pools** | Use different pools than global (or disable some) |
| **Override chains** | Use different fallback chains than global |
| **Clear** | Remove project config, fall back to global |
| **Info** | Show effective config (which pools/chains/subs are active) |

### Project config file

`.pi/multi-pass.json`:

```json
{
  "allowedSubs": ["openai-codex-2", "anthropic-2"],
  "pools": [
    {
      "name": "work-codex",
      "baseProvider": "openai-codex",
      "members": ["openai-codex-2"],
      "enabled": true
    }
  ],
  "chains": [
    {
      "name": "work-fallback",
      "enabled": true,
      "entries": [
        { "pool": "work-codex", "model": "gpt-5-mini", "enabled": true }
      ]
    }
  ]
}
```

- `allowedSubs`: whitelist of exact provider names. If set, only those exact providers are available in this project. Omit to allow all.
- `pools`: if set, replaces global pools for this project. Omit to inherit global pools.
- `chains`: if set, replaces global chains for this project. Omit to inherit global chains.

## How pools work

1. You're using `openai-codex` and hit a rate limit
2. Multi-pass detects the error, marks `openai-codex` as exhausted
3. Switches to `openai-codex-2` (same model ID, different account)
4. Retries your last prompt automatically
5. After a 5-minute cooldown, `openai-codex` becomes available again

### Pool selection strategy

Each pool has a `strategy` that controls how the next member is chosen on failover:

| Strategy | Behavior |
|---|---|
| `round-robin` | Rotate sequentially through members (default) |
| `quota-first` | Query built-in quota checkers and prefer the member with the most remaining quota |
| `scheduled` | Use per-member time windows and priority roles |
| `custom` | Delegate to a user-provided JS selector script |

Set the strategy during pool creation (`/pool create`) or change it later via `/pool list` -> select pool -> `strategy`.

All strategies fall back to round-robin when their specific data is unavailable.

#### `quota-first`

You have 3 Codex accounts in a pool. Account A has 80% of its 5-hour window left, account B has 20%, account C has 60%. On failover, `quota-first` picks account A first instead of just the next one in rotation order.

Uses the same built-in quota checkers as `/subs limits` (currently Codex and Google providers).

```json
{
  "name": "codex-pool",
  "baseProvider": "openai-codex",
  "members": ["openai-codex", "openai-codex-2", "openai-codex-3"],
  "enabled": true,
  "strategy": "quota-first"
}
```

#### `scheduled`

Assign each member a role and optional time windows:

- **preferred**: only used during its active windows. When multiple preferred members are active, the one whose window ends soonest goes first (burn that quota before the window closes).
- **default** (no role): always available, used after preferred members.
- **overflow**: last resort, used when preferred and default members are exhausted.

```json
{
  "name": "codex-pool",
  "baseProvider": "openai-codex",
  "members": ["openai-codex", "openai-codex-2", "openai-codex-3"],
  "enabled": true,
  "strategy": "scheduled",
  "memberSchedule": {
    "openai-codex": {
      "role": "preferred",
      "windows": [{ "hours": [9, 17], "days": ["mon", "tue", "wed", "thu", "fri"] }]
    },
    "openai-codex-2": {
      "role": "preferred",
      "windows": [{ "hours": [17, 9] }]
    },
    "openai-codex-3": {
      "role": "overflow"
    }
  }
}
```

Window format:
- `hours`: `[start, end)` in 24h local time. Wraps midnight when start > end (e.g. `[22, 6]` = 22:00-05:59).
- `days`: array of `"mon"`, `"tue"`, ..., `"sun"`. Omit for every day.
- `dateRange`: `{ "from": "2025-06-01", "to": "2025-06-30" }` for temporary windows.

During pool creation or via the `strategy` quick action, you can configure schedules interactively with human-friendly input like `9-17 mon-fri`.

#### `custom`

Point to a JS script that decides which member to try first. The script receives full context and returns the preferred provider name (or an ordered array).

```json
{
  "name": "codex-pool",
  "baseProvider": "openai-codex",
  "members": ["openai-codex", "openai-codex-2", "openai-codex-3"],
  "enabled": true,
  "strategy": "custom",
  "selectorScript": "selectors/my-codex-selector.js"
}
```

Script paths are resolved relative to `~/.pi/agent/`. Absolute paths and `~/` paths also work.

**Selector script interface:**

```js
// ~/.pi/agent/selectors/my-codex-selector.js
module.exports = async function select(ctx) {
  // ctx.members:         string[]  -- available (non-exhausted, authenticated) members
  // ctx.currentProvider: string    -- the provider that just hit a rate limit
  // ctx.modelId:         string    -- the model ID being used
  // ctx.pool:            object    -- { name, baseProvider, members }
  // ctx.timestamp:       number    -- current Unix timestamp (ms)
  // ctx.hour:            number    -- current hour (0-23, local time)
  // ctx.day:             string    -- current day of week ("mon".."sun")
  // ctx.prompt:          string?   -- last user prompt, if available
  //
  // Return: string (provider name), string[] (ordered preference), or undefined (fall back)

  // Example: prefer a specific account during business hours
  if (ctx.hour >= 9 && ctx.hour < 17) {
    return ctx.members.find(m => m === "openai-codex-2");
  }
  return ctx.members[0];
};
```

If the script throws, returns an invalid provider name, or the file is missing, the pool falls back to round-robin.

## How chains work

1. You define an ordered chain of pool/model entries (for example `primary -> backup -> solo`)
2. If the current pool has no eligible members, multi-pass continues forward in the chain
3. It skips disabled or invalid entries and reports why in warnings
4. During retry replays for the same prompt, it preserves cascade state and avoids re-trying already attempted providers
5. Session status shows the active chain start entry: `chain:<name> | starts <pool> -> <model>`

## Model presets

Presets are named routing shortcuts that map to an ordered list of provider+model entries across different providers. Think of them as intent-based routing: `coding-premium`, `coding-budget`, `fastest`, etc.

### Commands

```
/mp-preset              Open menu
/mp-preset activate     Switch to a preset's best available entry
/mp-preset <name>       Activate a preset by name directly
/mp-preset create       Create a new preset
/mp-preset list         Show all presets
/mp-preset toggle       Enable/disable a preset
/mp-preset remove       Delete a preset
```

### Example

```
/mp-preset create
  Name: coding-premium
  Entries:
    1. anthropic / claude-sonnet-4-20250514
    2. openai-codex / o3
    3. google-gemini-cli / gemini-2.5-pro

/mp-preset coding-premium
  -> Tries anthropic first. If not logged in, tries openai-codex. Then gemini.
```

### Config

Presets are stored in `~/.pi/agent/multi-pass.json`:

```json
{
  "presets": [
    {
      "name": "coding-premium",
      "enabled": true,
      "entries": [
        { "provider": "anthropic", "model": "claude-sonnet-4-20250514", "enabled": true },
        { "provider": "openai-codex", "model": "o3", "enabled": true },
        { "provider": "google-gemini-cli", "model": "gemini-2.5-pro", "enabled": true }
      ]
    },
    {
      "name": "coding-budget",
      "enabled": true,
      "entries": [
        { "provider": "openai-codex", "model": "gpt-4.1-mini", "enabled": true },
        { "provider": "google-gemini-cli", "model": "gemini-2.5-flash", "enabled": true }
      ]
    }
  ]
}
```

Presets work with pools: if an entry's provider belongs to a pool, rate-limit failover still rotates within that pool before trying the next preset entry.

## Supported providers

| Provider key | Service |
|---|---|
| `anthropic` | Claude Pro/Max |
| `openai-codex` | ChatGPT Plus/Pro (Codex) |
| `github-copilot` | GitHub Copilot |
| `google-gemini-cli` | Google Cloud Code Assist |
| `google-antigravity` | Antigravity |

## Built-in limits support

`/subs limits` uses a provider-specific checker registry.

Currently implemented:

- `anthropic`: fetches Claude subscription usage from `https://api.anthropic.com/api/oauth/usage`, then summarizes the 5-hour and 7-day windows plus any model-scoped weekly limits (for example Opus) for the base account and extra Anthropic subscriptions. Plan and email come from the OAuth profile endpoint.
- `openai-codex`: fetches ChatGPT/Codex usage from `https://chatgpt.com/backend-api/wham/usage` (or `CHATGPT_BASE_URL`), then summarizes the 5-hour and 7-day subscription windows for the base account and any configured extra Codex subscriptions.
- `google-gemini-cli`: refreshes the saved Google OAuth session when needed, then queries `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` and summarizes the returned Gemini quota buckets by their bottleneck family (for example `Pro` or `Flash`).
- `google-antigravity`: refreshes the saved Antigravity OAuth session when needed, then queries `v1internal:fetchAvailableModels` on the Google Cloud Code Assist endpoints with Antigravity-style headers and summarizes the returned model-level bottleneck.

Google quota is not a single flat subscription bucket, so the details view shows one line per returned Gemini family or Antigravity model with its remaining headroom and reset time.

`/subs limits` is an on-demand snapshot. It helps you see which account looks healthiest right now. Automatic switching still happens when the active provider returns a rate-limit-style runtime error and that provider belongs to an enabled pool or chain.

When a pool uses the `quota-first` strategy, the same quota checkers are used automatically during failover to pick the healthiest member instead of just round-robin.

When a project defines `.pi/multi-pass.json` with `allowedSubs`, `/subs limits` only shows accounts allowed in that project.

Future providers can add another checker without changing the `/subs` command surface.

## Experimental: share an OAuth account

`/subs share` picks one authenticated OAuth account and renders it as one or more numbered QR frames. Scan every frame in any order with a compatible receiver; use `n`/`p` to advance/backtrack, `u` to reveal a frame URI, or `c` to open a **single copyable export string** in pi's editor for pi-to-pi transfer. On the other computer, run `/subs receive` and choose `Paste one full export string` (or paste QR frame URIs individually). Line breaks from terminal wrapping are accepted in the full string. No network, listener, relay, or source computer uptime is required after capture. The receiver imports under a new extra-subscription name, never overwrites an existing credential, and must restart pi to register the new provider. Omarchy on the *same* machine already reads pi's local auth and does not need this transfer.

**Security:** The frames contain the **entire OAuth access and refresh credential**. Base64 and compression are not encryption. Anyone who captures all frames can use the account; the frames do **not expire or self-destruct** when you close the display. Only share in a private setting with a device you trust. To invalidate leaked credentials, revoke them at the provider. Do not screenshot, log, or upload the QR URIs or full string. Copying to a system clipboard may sync the credential to other devices or retain it in clipboard history; clear it after import. See [offline QR protocol](docs/share-protocol.md) for the v2 frame and text formats.

**Provider caveat:** OAuth refresh credentials can be rotated or bound to one device/client. Copying a credential can break the source or receiver's next refresh; durability is **not yet validated provider by provider**. This is experimental, not a guarantee of two simultaneously working logins. If either device stops authenticating, log in again on that device. The command does not copy pools, chains, presets or project config. Mobile receivers still need to implement the offline QR decoder and provider-specific secure credential storage; no mobile receiver ships in this package yet.

## Environment variable (optional)

```bash
export MULTI_SUB="openai-codex:2,anthropic:1"
```

Env entries merge with saved config.

## Config files

| File | Scope | Contains |
|---|---|---|
| `~/.pi/agent/multi-pass.json` | Global | Subscriptions + pools + chains |
| `.pi/multi-pass.json` | Project | Pool/chain overrides + sub restrictions |

## License

MIT
